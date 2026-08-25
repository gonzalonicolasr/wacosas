// Mapeo PURO de un mensaje de Baileys a la fila que persiste el ingest
// (design §5.4, con la tabla de columnas de §4.3). Sin I/O, sin base, sin estado
// global: entra un `WAMessage` y sale un `MappedMessage` o `null`. Todo lo que
// necesita del mundo exterior —quién soy y qué hora es— viaja en `ctx`, así los
// tests no dependen del reloj ni de una sesión abierta.
//
// Por qué importa que sea tan desconfiado: `WAMessage` es ENTRADA REMOTA. El
// `messageTimestamp` es un uint64 del proto (llega como número, como `Long` o
// ausente), el `pushName` lo elige el otro y el tipo de contenido puede ser algo
// que WhatsApp inventó ayer. Cada campo se normaliza acá o ensucia la base para
// siempre.
//
// De baileys se usan sus propios helpers (`getContentType`,
// `normalizeMessageContent`, `jidNormalizedUser`, …) en vez de reimplementarlos:
// son las mismas funciones con las que el socket decodifica, y copiarlas sería
// garantizar que se desincronicen en la próxima versión. El import cuesta ~260 ms
// una sola vez, pero este módulo cuelga de `wa/ingest.ts`, que ya vive del lado
// de baileys: no toca el camino de arranque de la TUI (CA-13.1).
import {
  getContentType,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  jidDecode,
  jidNormalizedUser,
  normalizeMessageContent,
  proto,
  PSA_WID,
  toNumber,
  WAMessageStubType,
} from "baileys";
import type { WAMessage, WAMessageContent } from "baileys";

import type { AttachmentInfo, MappedMessage, MediaRef, MessageKind } from "../db/types";
import { oneLine } from "../lib/fmt";
import { placeholderFor } from "../lib/placeholder";

// El diseño declara `MappedMessage` como salida de este módulo (§5.4); vive en
// `db/types.ts` porque es el parámetro de `repo.insertMessage` y `db/` no puede
// depender de `wa/`. Se reexporta para que el contrato del §5.4 se cumpla.
export type { MappedMessage } from "../db/types";

/** Lo único que `mapMessage` necesita saber del proceso (design §5.4). */
export type MapCtx = {
  /** Jid propio, para el `sender_jid` de los mensajes salientes. */
  selfJid: string;
  /** "Ahora" en epoch SEGUNDOS: el reemplazo de un timestamp ausente o basura. */
  nowSec: number;
};

/**
 * Clave de contenido de Baileys → `MessageKind` (§4.3). Lo que no está acá cae
 * en `unsupported` y **se persiste igual** (CA-7.5).
 *
 * Los alias no son adorno: `ptvMessage` es la nota de video redonda (mismo
 * `IVideoMessage`), `liveLocationMessage` es la ubicación en vivo y
 * `contactsArrayMessage` son varios contactos en una tarjeta. Sin ellos, cosas
 * completamente normales se verían "no soportado".
 */
const KIND_POR_CONTENIDO: Record<string, MessageKind> = {
  conversation: "text",
  extendedTextMessage: "text",
  imageMessage: "image",
  videoMessage: "video",
  ptvMessage: "video",
  audioMessage: "audio",
  documentMessage: "document",
  stickerMessage: "sticker",
  locationMessage: "location",
  liveLocationMessage: "location",
  contactMessage: "contact",
  contactsArrayMessage: "contact",
};

/** El último instante que `Date` sabe representar, en segundos (igual que `lib/fmt.ts`). */
const TS_MAX_SEG = 8.64e12;

/** Tolerancia de reloj desfasado antes de considerar futuro a un timestamp. */
const SLACK_FUTURO_SEG = 86_400;

/**
 * Timestamp en epoch SEGUNDOS, o `nowSec` si lo que llegó no sirve (§8.4).
 *
 * `toNumber` de baileys resuelve el `Long` del proto (por `toNumber()` o por
 * `.low`), pero devuelve tal cual lo que no es objeto: un `"1700000000"` string
 * saldría string y terminaría en la columna INTEGER. De ahí el `Number()`.
 *
 * Se descarta —y se reemplaza por `now`— lo ausente, el `0`, lo negativo, lo no
 * finito, lo que se pasa del rango de `Date` y lo que quedó en el futuro por más
 * de un día. Este último no es paranoia gratuita: la bandeja ordena por
 * `last_message_at DESC`, así que un `ts` inflado clava el chat arriba de todo
 * para siempre y no hay forma de bajarlo desde la interfaz.
 */
function tsSeguro(crudo: WAMessage["messageTimestamp"], nowSec: number): number {
  const ahora =
    Number.isFinite(nowSec) && nowSec > 0 ? Math.floor(nowSec) : Math.floor(Date.now() / 1000);
  // `toNumber` es el ÚNICO punto de este módulo que puede lanzar: baileys hace
  // `t.toNumber()` sin chequear que sea función (`Utils/generics.js:72`), así que
  // un `{ toNumber: 5 }` propagaría la excepción. Hoy no es alcanzable desde la
  // red (protobufjs decodifica un uint64 a `number` o a `Long`, nunca a eso),
  // pero `mapMessage` no puede lanzar NUNCA: cuelga de un handler del socket.
  let n: number;
  try {
    n = Number(toNumber(crudo as never));
  } catch {
    return ahora;
  }
  if (!Number.isFinite(n) || n <= 0 || n > TS_MAX_SEG) return ahora;
  const seg = Math.floor(n);
  return seg > ahora + SLACK_FUTURO_SEG ? ahora : seg;
}

/**
 * Desenvuelve el contenido real: efímeros, ver-una-vez, editados y el
 * `documentWithCaptionMessage` los resuelve `normalizeMessageContent`.
 *
 * El `deviceSentMessage` va aparte porque baileys NO lo desenvuelve en
 * `normalizeMessageContent` (lo hace antes, al decodificar el nodo). Los que
 * llegan por el sync de historial pueden conservarlo, y sin este paso un
 * mensaje mandado desde el teléfono se vería "no soportado" en vez de propio
 * (CA-9.5).
 */
function contenidoReal(raw: WAMessageContent | null | undefined): WAMessageContent | undefined {
  const normalizado = normalizeMessageContent(raw);
  const interno = normalizado?.deviceSentMessage?.message;
  return interno ? normalizeMessageContent(interno) : normalizado;
}

/** Texto no vacío o `""`: nunca `undefined`, nunca `null`, nunca un objeto. */
function texto(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Duración en segundos sólo si es un número usable (CA-7.3). */
function segundosValidos(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** Bytes de un `Uint8Array`/`Buffer` del proto en base64, o `""` si no hay. */
function base64De(v: unknown): string {
  if (v instanceof Uint8Array) return v.length > 0 ? Buffer.from(v).toString("base64") : "";
  // protobufjs puede entregar el campo `bytes` como string base64 según cómo se
  // haya decodificado el nodo: se acepta tal cual.
  return typeof v === "string" ? v : "";
}

/**
 * La referencia para volver a bajar la imagen (`db/types.ts` → `MediaRef`).
 *
 * ⚠️ **Es lo que ENMIENDA CA-7.4 del lado de la recepción**, así que conviene
 * tener claro qué se guarda y qué no:
 *
 *  · se guarda la **referencia** (clave de descifrado + ruta del CDN + tamaño),
 *    que son unos 90 bytes de texto en la celda `attachment`;
 *  · **no** se guarda ni un byte del archivo, y **no** se baja nada acá: bajar
 *    es una decisión del usuario, una tecla sobre una imagen concreta
 *    (`wa/media.ts`, `^O`).
 *
 * Sin esto, "ver una imagen" sólo podría funcionar para lo que llegue con la
 * aplicación abierta: el proto crudo no se persiste (§8.6) y WhatsApp no
 * reenvía un mensaje viejo. Con esto funciona para todo lo que entre de acá en
 * adelante — el historial ANTERIOR a esta versión no tiene referencia y no se
 * puede bajar, y la interfaz lo dice con todas las letras.
 *
 * Devuelve `undefined` si falta la clave: sin ella no hay descarga posible y
 * guardar media referencia sólo sería basura en la base.
 */
function mediaDe(nodo: Record<string, unknown> | undefined): MediaRef | undefined {
  const key = base64De(nodo?.mediaKey);
  if (!key) return undefined;
  const directPath = texto(nodo?.directPath);
  const url = texto(nodo?.url);
  if (!directPath && !url) return undefined;
  let bytes: number | undefined;
  try {
    const n = Number(toNumber(nodo?.fileLength as never));
    if (Number.isFinite(n) && n > 0) bytes = Math.floor(n);
  } catch {
    // `fileLength` es un uint64 del proto: si viene con una forma rara se
    // ignora, que es exactamente lo mismo que si no viniera.
  }
  return {
    key,
    ...(directPath ? { directPath } : {}),
    ...(url ? { url } : {}),
    ...(bytes !== undefined ? { bytes } : {}),
  };
}

/**
 * El adjunto tal como se guarda: `label` ya resuelto (CA-7.1), los metadatos que
 * existen y —sólo en las imágenes— la referencia para poder bajarla a demanda.
 * Nada binario: en la base no entra un solo byte de archivo.
 *
 * Los campos opcionales se omiten cuando faltan en vez de quedar en `undefined`:
 * así el JSON de la celda es chico y nadie río abajo tiene que defenderse de un
 * `seconds: null`.
 */
function adjuntoDe(kind: MessageKind, nodo: Record<string, unknown> | undefined): AttachmentInfo | null {
  const mimetype = texto(nodo?.mimetype) || undefined;

  switch (kind) {
    case "image": {
      // La referencia va SÓLO en las imágenes: es el único tipo que wacosas sabe
      // mostrar (`^O`). Guardarla para un video de 80 MB sería guardar la llave
      // de algo que no hay cómo abrir.
      const media = mediaDe(nodo);
      return {
        label: placeholderFor(kind),
        ...(mimetype ? { mimetype } : {}),
        ...(media ? { media } : {}),
      };
    }

    case "sticker":
      return { label: placeholderFor(kind), ...(mimetype ? { mimetype } : {}) };

    case "audio":
    case "video": {
      const seconds = segundosValidos(nodo?.seconds);
      return {
        label: placeholderFor(kind, { seconds }),
        ...(seconds !== undefined ? { seconds } : {}),
        ...(mimetype ? { mimetype } : {}),
      };
    }

    case "document": {
      // `fileName` es lo normal; `title` es lo que manda WhatsApp Business y
      // algunos clientes viejos. Sin ninguno, el placeholder dice "documento".
      const filename = oneLine(texto(nodo?.fileName) || texto(nodo?.title));
      return {
        label: placeholderFor(kind, { filename }),
        ...(filename ? { filename } : {}),
        ...(mimetype ? { mimetype } : {}),
      };
    }

    case "location":
    case "contact":
      return { label: placeholderFor(kind) };

    // text / revoked / system / unsupported no tienen adjunto: el `label` que
    // les corresponde lo arma `previewFor` desde el `kind`.
    default:
      return null;
  }
}

/** Cuerpo del mensaje: texto o caption (§4.3). Es el ÚNICO campo del FTS. */
function cuerpoDe(tipo: string | undefined, nodo: Record<string, unknown> | undefined, contenido: WAMessageContent | undefined): string {
  if (tipo === "conversation") return texto(contenido?.conversation);
  if (tipo === "extendedTextMessage") return texto(nodo?.text);
  // imagen, video, documento y ubicación en vivo son los que traen caption; el
  // resto no tiene y queda en "" (el placeholder lo pone `previewFor`).
  return texto(nodo?.caption);
}

/** El usuario del `PSA_WID` de baileys (`0@c.us`): literalmente `"0"`. */
const USER_PSA = jidDecode(PSA_WID)?.user ?? "0";

/**
 * ¿Este jid es un pseudo-chat de WhatsApp y no una conversación con alguien?
 *
 * Es el único lugar donde se decide qué jid NO entra a la base — lo preguntan
 * `mapMessage` (el mensaje) y `wa/ingest.ts` (la ficha del chat), así que no hay
 * forma de que uno acepte lo que el otro descarta. Lo que se descarta:
 *
 *   · **el PSA de WhatsApp** (`0@c.us`, que `jidNormalizedUser` deja en
 *     `0@s.whatsapp.net`): son los avisos oficiales, llegan como tipos de
 *     contenido que no sabemos representar y la bandeja los mostraba como un chat
 *     llamado **`+0`** con "❔ mensaje no soportado" (7 de esos en la cuenta real);
 *   · **`status@broadcast`** (los estados) y **cualquier `@broadcast`**: una lista
 *     de difusión no es un chat —lo que se manda por ahí le llega a cada
 *     destinatario en su 1:1— y como chat quedaría vacía y sin nadie del otro
 *     lado. `isJidStatusBroadcast` cubría sólo el primero;
 *   · **los `@newsletter`** (canales), que ya estaban fuera por §5.4.
 *
 * Los grupos y los `@lid` NO son basura: entran normalmente.
 */
export function isSystemJid(jid: string | null | undefined): boolean {
  const j = texto(jid);
  if (!j) return true;
  if (isJidBroadcast(j) || isJidNewsletter(j)) return true;
  return jidDecode(j)?.user === USER_PSA;
}

/**
 * Detecta el borrado de un mensaje por su autor (CA-6.9) y devuelve a QUÉ
 * mensaje apunta. No produce fila: el revoke se aplica con
 * `repo.revokeMessage(chatJid, targetWaId)` sobre el mensaje original.
 *
 * Soporta las dos formas en las que aparece un revoke:
 *   · cruda — `message.protocolMessage.type === REVOKE`, con el id de la víctima
 *     en `protocolMessage.key.id` (así llega en un `messages.upsert`);
 *   · aplanada — baileys la reemite como `messages.update` con
 *     `messageStubType === REVOKE` y el id de la víctima YA en `key.id`
 *     (`Utils/process-message.js:298`), que es el camino de §8.4.
 */
export function isRevoke(m: WAMessage): { chatJid: string; targetWaId: string } | null {
  const chatJid = jidNormalizedUser(m?.key?.remoteJid ?? undefined);
  if (!chatJid) return null;

  const protocolo = contenidoReal(m?.message)?.protocolMessage;
  if (protocolo?.type === proto.Message.ProtocolMessage.Type.REVOKE) {
    const objetivo = texto(protocolo.key?.id);
    return objetivo ? { chatJid, targetWaId: objetivo } : null;
  }

  if (m?.messageStubType === WAMessageStubType.REVOKE) {
    const objetivo = texto(m?.key?.id);
    return objetivo ? { chatJid, targetWaId: objetivo } : null;
  }

  return null;
}

/**
 * Mensaje de Baileys → fila lista para `repo.insertMessage` (§4.3), o `null`
 * cuando no hay que persistir nada.
 *
 * Devuelve `null` para (§5.4): mensajes sin `key.remoteJid`, los pseudo-chats de
 * WhatsApp (ver `isSystemJid`: PSA, difusión, estados, canales),
 * `protocolMessage` (el revoke se resuelve con `isRevoke`, el resto son señales
 * internas que no se muestran) y `reactionMessage`.
 *
 * Cualquier otro tipo que no se sepa representar cae en `kind: "unsupported"` y
 * **se persiste igual**, para que no queden huecos en el historial (CA-7.5).
 */
export function mapMessage(m: WAMessage, ctx: MapCtx): MappedMessage | null {
  const key = m?.key;
  const chatJid = jidNormalizedUser(key?.remoteJid ?? undefined);
  if (isSystemJid(chatJid)) return null;

  // Sin id de WhatsApp no hay dedupe posible: el índice único es
  // (chat_jid, wa_id), así que un `wa_id` vacío haría que el PRIMER mensaje sin
  // id de ese chat se comiera a todos los siguientes (CA-14.2). Se descarta.
  const waId = texto(key?.id);
  if (!waId) return null;

  // El revoke se chequea antes que el tipo: en su forma aplanada viene sin
  // `message`, y sin este corte terminaría persistido como "unsupported".
  if (isRevoke(m)) return null;

  const contenido = contenidoReal(m?.message);
  const tipo = getContentType(contenido);
  if (tipo === "protocolMessage") return null;
  if (tipo === "reactionMessage") return null;

  // `hasOwn` y no `KIND_POR_CONTENIDO[tipo]` a secas: el lookup pelado resuelve
  // contra `Object.prototype` (mismo cuidado que en `lib/placeholder.ts`).
  const kind: MessageKind =
    tipo && Object.hasOwn(KIND_POR_CONTENIDO, tipo) ? KIND_POR_CONTENIDO[tipo] : "unsupported";
  const nodo = tipo ? (contenido as Record<string, any>)?.[tipo] : undefined;
  const nodoObj = nodo && typeof nodo === "object" ? (nodo as Record<string, unknown>) : undefined;

  const fromMe = key?.fromMe === true;
  const selfJid = jidNormalizedUser(ctx?.selfJid ?? undefined);

  // En un grupo el autor es `key.participant` (CA-6.3: sin él, todos los
  // mensajes parecerían del grupo). En un 1:1 no viene: el autor es el otro, o
  // yo si es propio.
  const participante = jidNormalizedUser(key?.participant ?? m?.participant ?? undefined);
  const senderJid = isJidGroup(chatJid)
    ? participante || (fromMe ? selfJid : "")
    : fromMe
      ? selfJid
      : chatJid;

  return {
    chatJid,
    waId,
    fromMe,
    senderJid,
    // Congelado al momento (CA-6.3) y aplastado a una línea: el `pushName` lo
    // elige el otro y un salto ahí rompería la fila de la conversación (CA-4.6).
    senderName: oneLine(texto(m?.pushName)),
    ts: tsSeguro(m?.messageTimestamp, ctx?.nowSec),
    kind,
    body: cuerpoDe(tipo, nodoObj, contenido),
    attachment: adjuntoDe(kind, nodoObj),
    // Propio = eco de otro dispositivo o de este mismo (CA-9.5): ya salió, así
    // que nace `sent`. Los envíos nuestros los inserta `wa/send.ts` en
    // `pending` ANTES de tocar la red (D7) y el eco los deduplica por wa_id.
    status: fromMe ? "sent" : "received",
  };
}

/**
 * Preview de una línea para la fila de la bandeja (CA-4.5): el placeholder del
 * adjunto y, si hay caption, el caption detrás. Un adjunto NUNCA deja la fila
 * vacía; un texto no lleva placeholder y muestra el cuerpo pelado.
 *
 * El recorte al ancho de la fila lo hace `clip()` en la interfaz (CA-4.6): acá
 * sólo se garantiza que sea UNA línea.
 */
export function previewFor(m: Pick<MappedMessage, "kind" | "body" | "attachment">): string {
  const etiqueta = oneLine(texto(m?.attachment?.label) || placeholderFor(m?.kind ?? "unsupported"));
  const cuerpo = oneLine(texto(m?.body));
  if (!etiqueta) return cuerpo;
  return cuerpo ? `${etiqueta} · ${cuerpo}` : etiqueta;
}

/** Número del jid como fallback de nombre: `+549111234567`, nunca `undefined`. */
function numeroDe(jid: string): string {
  const user = jidDecode(jid)?.user ?? "";
  if (!user) return texto(jid);
  return /^\d+$/.test(user) ? `+${user}` : user;
}

/**
 * Nombre a mostrar de un chat (§5.4): `subject` > nombre del contacto >
 * `pushName` > número formateado.
 *
 * `contactName` es la columna `contacts.name`, que ya viene resuelta como
 * `name || notify || verifiedName` (§4.1): por eso la precedencia del diseño
 * tiene cinco escalones y esta firma cuatro.
 *
 * En un GRUPO la cadena se corta en el subject: `pushName` y `contactName`
 * describen a QUIEN ESCRIBIÓ, no al grupo, y usarlos rebautizaría el grupo con
 * el nombre del último que habló (CA-4.8). Sin subject devuelve `""`, que es lo
 * correcto para `repo.upsertChat`: un nombre vacío no pisa el que ya está.
 */
export function resolveChatName(input: {
  groupSubject?: string;
  contactName?: string;
  pushName?: string;
  jid: string;
}): string {
  const subject = oneLine(texto(input?.groupSubject));
  if (subject) return subject;

  const jid = texto(input?.jid);
  if (isJidGroup(jid)) return "";

  const contacto = oneLine(texto(input?.contactName));
  if (contacto) return contacto;

  const push = oneLine(texto(input?.pushName));
  if (push) return push;

  return numeroDe(jid);
}
