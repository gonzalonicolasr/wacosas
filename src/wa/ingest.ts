// Cola de ingest: TODO lo que emite Baileys entra por acá y sale escrito en la
// base (contrato de design §5.7, flujo §6.2, concurrencia §8.3).
//
// El problema que resuelve: `bun:sqlite` es SÍNCRONO y corre en el mismo proceso
// que la TUI. Un sync inicial de WhatsApp manda cientos de mensajes de golpe; si
// se escribieran todos en el mismo tick, el teclado quedaría congelado ese rato
// entero (RNF-5). De ahí las tres reglas:
//
//   1. `push()` no escribe NADA: encola y vuelve. Es O(1), nunca async y NUNCA
//      lanza — lo llama un handler de evento del socket y una excepción ahí
//      voltea la conexión entera.
//   2. El drenador escribe de a chunks con `setTimeout(0)` en el medio, así el
//      event loop respira entre vuelta y vuelta.
//   3. Cada chunk va en UNA transacción: 400 inserts sueltos son 400 commits.
//
// Dos desvíos del diseño que hay que conocer (los dos anotados por la tarea 7):
//
//   · **El revoke se pregunta con `isRevoke()` en LAS DOS ramas** (`messages` y
//     `msg-updates`), no sólo en la de updates. `mapMessage` devuelve `null` para
//     todo `protocolMessage`, así que nadie más produce `kind:'revoked'`: si esta
//     cola no lo detecta, el borrado se pierde para siempre. La forma cruda llega
//     por `messages.upsert` (`Socket/chats.js:918` emite el sobre entero) y la
//     aplanada por `messages.update` (`Utils/process-message.js:298`).
//   · **Además de las 400 filas hay un tope de TIEMPO por vuelta.** Medido en
//     esta máquina: 400 filas sobre una base recién creada son ~14 ms, pero sobre
//     una base con 50.000 mensajes ya indexados una vuelta llegó a **38 ms**
//     porque el commit de una transacción grande dispara un merge del índice FTS.
//     Con el corte por tiempo las transacciones quedan más chicas, los merges
//     también, y el peor tick de esa misma prueba bajó a **9,6 ms**. `400` sigue
//     siendo el techo de filas; el tiempo es el otro techo.
import {
  ACCOUNT_RESTRICTED_TEXT,
  getContentType,
  isJidGroup,
  isLidUser,
  jidDecode,
  jidNormalizedUser,
  normalizeMessageContent,
  proto,
  toNumber,
} from "baileys";
import type {
  Chat,
  ChatUpdate,
  Contact,
  GroupMetadata,
  LIDMapping,
  MessageUserReceiptUpdate,
  WAMessage,
  WAMessageUpdate,
} from "baileys";

import type { Logger } from "../boot/log";
import type { Repo } from "../db/repo";
import type { MessageStatus } from "../db/types";
import { oneLine } from "../lib/fmt";
import type { Cancelar, Store } from "../state/store";

import { isRevoke, isSystemJid, mapMessage, previewFor, resolveChatName, type MapCtx } from "./map";
import type { ReadTarget } from "./read";

/** Techo de filas por vuelta del drenador (design §5.7, D4). */
export const MAX_ROWS_PER_TICK = 400;
/**
 * Techo de TIEMPO por vuelta. No está en el diseño: lo agrega esta tarea porque
 * con el índice FTS grande las 400 filas se pasaban del presupuesto de 20 ms del
 * done-when (ver el encabezado). La primera fila de cada vuelta se aplica
 * siempre, aunque el reloj ya esté vencido: así la cola siempre avanza.
 */
export const MAX_MS_PER_TICK = 8;
/** Techo de trabajos encolados; pasado eso se descartan los `history` (§5.7). */
export const MAX_QUEUE_JOBS = 10_000;
/**
 * Espera antes de reintentar una vuelta que NO avanzó. Tampoco está en el
 * diseño: sin espera el reintento sería un busy-loop al 100% de CPU contra una
 * base que no responde, y sin reintento la cola quedaría trabada hasta el
 * próximo `push` (con el `⟳ sincronizando… N` del §6.2 pegado en pantalla).
 */
export const MS_REINTENTO_TRABADO = 250;
/**
 * Reintentos SEGUIDOS sin avance antes de soltar la cola: 20 × 250 ms ≈ 5 s de
 * insistencia. Alcanza para lo transitorio (un `SQLITE_BUSY` de otro proceso
 * mirando la base); si la base está muerta de verdad, seguir intentando cada
 * 250 ms para siempre no la arregla. Al agotarse queda la línea en el log y el
 * próximo `push` reabre la ventana de reintentos.
 */
export const MAX_REINTENTOS_TRABADO = 20;

/** Un lote de trabajo tal como lo emite el socket (design §5.7). */
export type IngestJob =
  | { kind: "messages"; msgs: WAMessage[]; source: "notify" | "append" | "history" }
  | { kind: "chats"; chats: Chat[] }
  | { kind: "contacts"; contacts: Contact[] }
  | { kind: "chat-updates"; updates: ChatUpdate[] }
  | { kind: "msg-updates"; updates: WAMessageUpdate[] }
  | { kind: "receipts"; receipts: MessageUserReceiptUpdate[] }
  /**
   * `groups.upsert` / `groups.update`, y la respuesta del `groupMetadata` a
   * demanda. Lo único que se aprovecha hoy es el **subject**: es el nombre del
   * grupo, y sin él la bandeja muestra "grupo sin nombre" (CA-4.8).
   */
  | { kind: "groups"; groups: Partial<GroupMetadata>[] }
  /**
   * Pares LID ↔ número: las dos caras del mismo humano. Llegan por
   * `messaging-history.set` (`lidPnMappings`), por `lid-mapping.update` y por la
   * respuesta del store de baileys que pide `wa/identity.ts`. No fusionan nada:
   * sólo dejan que el nombre de la agenda se vea desde las dos identidades.
   */
  | { kind: "aliases"; pairs: LIDMapping[] }
  /**
   * La lista COMPLETA de bloqueados (`blocklist.set`, o la respuesta de
   * `sock.fetchBlocklist()`). Se aplica como UN solo ítem —no de a un jid— porque
   * su significado es el conjunto entero: los que no están dejan de estar
   * bloqueados. Partirla entre dos vueltas del drenador dejaría un instante con
   * media lista aplicada.
   */
  | { kind: "blocklist"; jids: string[] }
  /** Altas y bajas sueltas del bloqueo (`blocklist.update`, con su `type`). */
  | { kind: "block-updates"; jids: string[]; op: "add" | "remove" }
  /**
   * Chat Lock (`chats.lock`): el chat que el usuario escondió detrás de un código
   * secreto. NO es lo mismo que bloquear a alguien y por eso viaja aparte.
   */
  | { kind: "chat-lock"; locks: Array<{ jid: string; locked: boolean }> };

export type Ingest = {
  /** Encola. O(1), nunca async, nunca lanza. */
  push(job: IngestJob): void;
  /** Vacía la cola de una, sin timers. Lo usa el cierre ordenado (CA-17.1). */
  drainNow(): void;
  /** Filas todavía sin aplicar: el `⟳ sincronizando… N` del encabezado (§6.2). */
  pendingRows(): number;
};

export type IngestDeps = {
  repo: Repo;
  store: Store;
  log: Logger;
  /** Jid propio; puede devolver `""` mientras no haya sesión. */
  selfJid(): string;
  /** Chat abierto: define a quién NO sumarle no leídos (CA-11.7). */
  openChatJid(): string | null;
  /**
   * Subject de un grupo, a demanda (`sock.groupMetadata`). Es el ÚLTIMO recurso
   * para el grupo que aparece por un mensaje en vivo y nunca pasó por el
   * `messaging-history.set`: sin esto se queda como "grupo sin nombre" para
   * siempre. Opcional — sin ella el ingest funciona igual, sólo que sin fallback.
   *
   * Es una llamada de RED, así que el contrato es estricto: se pide **fuera** de
   * la transacción, **una sola vez por grupo** (también si falla: martillar a
   * WhatsApp por cada mensaje es el riesgo de ban R2/R8) y **nunca** puede
   * lanzar hacia adentro del drenador.
   */
  groupSubject?(jid: string): Promise<string>;
  /**
   * Recibo de lectura de los mensajes que acaban de entrar al chat ABIERTO
   * (`pushReadReceipt` de §6.2). Opcional: sin ella el chat se marca leído en
   * local igual, sólo que el otro lado no ve el tilde azul.
   *
   * Mismo contrato que `groupSubject`: es RED, así que se llama **fuera** de la
   * transacción y **una sola vez por vuelta** con todas las claves juntas —una
   * llamada por mensaje sería una ráfaga de stanzas en el sync inicial, justo el
   * ritmo que evita R8—.
   */
  pushReadReceipt?(chatJid: string, msgs: ReadTarget[]): void;
  /**
   * Identidades `@lid` que TIENEN nombre en la agenda y cuya hermana
   * `@s.whatsapp.net` todavía no conocemos (`wa/identity.ts` la resuelve contra
   * el store de baileys y devuelve el par por esta misma cola). Opcional: sin
   * ella el ingest funciona igual, sólo que sin el rescate a demanda.
   *
   * Mismo contrato que `groupSubject`: se llama **fuera** de la transacción,
   * **una sola vez por identidad** y **nunca** puede lanzar hacia adentro del
   * drenador. Va con todas las identidades de la vuelta juntas —una llamada por
   * contacto sería una ráfaga durante el sync inicial—.
   *
   * Sólo se reportan `@lid`: la vuelta contraria (número → LID) es una consulta
   * USync a WhatsApp (`Signal/lid-mapping.js`, `pnToLIDFunc`) y no sirve para
   * nada acá, porque los nombres de la agenda viven del lado del LID.
   */
  requestAlias?(lids: string[]): void;
  /** Reloj en ms. Default `Date.now` (mismo criterio que `state/store.ts`). */
  now?: () => number;
  /** Agendador del drenador. Default `setTimeout`; el test le pasa uno manual. */
  schedule?: (fn: () => void, ms: number) => Cancelar;
};

const agendarReal = (fn: () => void, ms: number): Cancelar => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

// ── helpers puros ───────────────────────────────────────────────────────────

/** Texto no vacío o `""`: nunca `undefined`, nunca `null`, nunca un objeto. */
function texto(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function motivo(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Todo lo que llega es ENTRADA REMOTA: un campo que debería ser lista puede no serlo. */
function lista<T>(v: T[] | null | undefined): T[] {
  return Array.isArray(v) ? v : [];
}

/** Los ítems de un trabajo, sea del tipo que sea. */
function itemsDe(job: IngestJob): readonly unknown[] {
  switch (job?.kind) {
    case "messages":
      return lista(job.msgs);
    case "chats":
      return lista(job.chats);
    case "contacts":
      return lista(job.contacts);
    case "chat-updates":
      return lista(job.updates);
    case "msg-updates":
      return lista(job.updates);
    case "receipts":
      return lista(job.receipts);
    case "groups":
      return lista(job.groups);
    case "aliases":
      return lista(job.pairs);
    // UN ítem: la lista completa se aplica de una (ver el tipo). Y así una lista
    // VACÍA —"ya no hay nadie bloqueado"— tampoco se descarta por largo 0.
    case "blocklist":
      return [lista(job.jids)];
    case "block-updates":
      return lista(job.jids);
    case "chat-lock":
      return lista(job.locks);
    default:
      return [];
  }
}

/** Sólo el sync de historial se puede descartar cuando la cola se llena (§5.7). */
function esHistorial(job: IngestJob): boolean {
  return job?.kind === "messages" && job.source === "history";
}

/** Epoch en segundos usable, o `0` si lo que llegó no sirve. */
function segundos(v: unknown): number {
  let n: number;
  try {
    n = Number(toNumber(v as never));
  } catch {
    return 0;
  }
  return Number.isFinite(n) && n > 0 && n < 8.64e12 ? Math.floor(n) : 0;
}

/** Entero ≥ 0 o `null`: el `unreadCount` que manda WhatsApp puede ser cualquier cosa. */
function cuenta(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
}

/**
 * `status` del proto → nuestro `MessageStatus` (§4.3). `PLAYED` (audio
 * escuchado) se guarda como `read`: la interfaz no distingue esos dos.
 */
const ESTADO_POR_ACK: Record<number, MessageStatus> = {
  [proto.WebMessageInfo.Status.ERROR]: "failed",
  [proto.WebMessageInfo.Status.PENDING]: "pending",
  [proto.WebMessageInfo.Status.SERVER_ACK]: "sent",
  [proto.WebMessageInfo.Status.DELIVERY_ACK]: "delivered",
  [proto.WebMessageInfo.Status.READ]: "read",
  [proto.WebMessageInfo.Status.PLAYED]: "read",
};

function estadoDe(v: unknown): MessageStatus | null {
  const n = typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) && Object.hasOwn(ESTADO_POR_ACK, n) ? ESTADO_POR_ACK[n]! : null;
}

/** Lo que el usuario lee al lado del `✗` cuando WhatsApp rechazó el mensaje. */
export const MOTIVO_ACK_RECHAZO = "WhatsApp rechazó el mensaje";
export const MOTIVO_ACK_RESTRINGIDA = "cuenta restringida por WhatsApp";

/**
 * El motivo del ERROR ack, sacado de `messageStubParameters`.
 *
 * Baileys emite el rechazo como `messages.update` con `status: ERROR` y
 * `messageStubParameters: [attrs.error]` —o `[attrs.error, ACCOUNT_RESTRICTED_TEXT]`
 * cuando la cuenta quedó limitada— desde un solo lugar
 * (`Socket/messages-recv.js:1563`). Sin esto la fila queda con `error = null` y
 * el usuario ve el `✗` sin ninguna explicación: sabe que no salió, no sabe si
 * fue un 403, un 479 o que WhatsApp le limitó la cuenta (lo segundo cambia qué
 * hacer: reintentar con `Ctrl-Y` no arregla una restricción).
 *
 * El texto sale corto a propósito: `ui/MessageRow.tsx` lo recorta a 40.
 */
export function motivoAckError(params: unknown): string {
  const partes = lista(params as unknown[])
    .map((p) => oneLine(texto(p)))
    .filter((p) => p !== "");
  const restringida = partes.some((p) => p.includes(ACCOUNT_RESTRICTED_TEXT));
  const base = restringida ? MOTIVO_ACK_RESTRINGIDA : MOTIVO_ACK_RECHAZO;
  // El primero es el código (`403`, `479`); si el que vino es el texto de la
  // restricción, no hay código que mostrar y el motivo va pelado.
  const codigo = partes[0] && partes[0] !== ACCOUNT_RESTRICTED_TEXT ? partes[0] : "";
  return codigo ? `${base} (${codigo})` : base;
}

/**
 * Tipos de contenido que NO se persisten aunque `mapMessage` los mapee a
 * `unsupported`. `encReactionMessage` es la reacción cifrada de grupos y
 * comunidades: misma familia que `reactionMessage`, que §5.4 ya descarta.
 * Guardarla dejaría "❔ mensaje no soportado" como preview del chat y sumaría un
 * no leído por algo que en el teléfono es un corazoncito sobre otro mensaje.
 */
const SIN_RENDER = new Set(["encReactionMessage"]);

/**
 * ¿El sobre trae algo para mostrar? (decisión abierta (c) de la tarea 7)
 *
 * `getContentType` devuelve `undefined` cuando no hay ningún contenido de
 * usuario: los avisos de sistema del grupo ("se unió", cambio de asunto), los
 * `messageStubType` y los sobres que sólo traen `senderKeyDistributionMessage`
 * (la propia función lo excluye, `Utils/messages.js:628`). Esos caen hoy en
 * `kind:"unsupported"` y **no se persisten**: el ingest los filtra acá en vez de
 * que `map` emita `system`, porque cambiar `map` es tocar la tarea 5 y `system`
 * hoy no tiene productor ni pantalla.
 *
 * Además del preview feo y del no leído fantasma, persistirlos rompe un caso
 * concreto: un mensaje que no se pudo descifrar llega como stub `CIPHERTEXT`,
 * baileys pide el reenvío y el mensaje REAL vuelve con el MISMO `key.id`
 * (`Socket/messages-recv.js:1299`). Si el stub ya está en la base, el
 * `ON CONFLICT DO NOTHING` se come la versión buena y el mensaje queda para
 * siempre como "no soportado".
 */
function tieneContenidoRenderizable(m: WAMessage): boolean {
  const tipo = getContentType(normalizeMessageContent(m?.message));
  return !!tipo && !SIN_RENDER.has(tipo);
}

// ── cola ────────────────────────────────────────────────────────────────────

/** Un trabajo encolado con su largo congelado al momento del `push`. */
type Entrada = { job: IngestJob; largo: number };

/**
 * Entrada neutra: reemplaza a la ya consumida o descartada. No es cosmético —
 * suelta la referencia al array de mensajes, que puede pesar megas. Se comparte
 * porque nadie muta una entrada de largo 0.
 */
const VACIA: Entrada = { job: { kind: "messages", msgs: [], source: "history" }, largo: 0 };

export function createIngest(deps: IngestDeps): Ingest {
  const { repo, store, log, selfJid, openChatJid } = deps;
  const ahora = deps.now ?? Date.now;
  const agendar = deps.schedule ?? agendarReal;
  const pedirSubjectRemoto = deps.groupSubject;
  const mandarRecibo = deps.pushReadReceipt;
  const pedirHermanaRemota = deps.requestAlias;

  /** Trabajos, consumidos por índice: `shift()` sería O(n) por trabajo. */
  let cola: Entrada[] = [];
  /** Índice del trabajo en curso. */
  let cabeza = 0;
  /** Ítems ya aplicados del trabajo en curso. */
  let pos = 0;
  /** Ítems pendientes en toda la cola (lo que devuelve `pendingRows`). */
  let filas = 0;
  /**
   * Por dónde va la búsqueda del próximo descartable. SÓLO avanza: el costo de
   * todos los descartes de la sesión es lineal en la cantidad de trabajos, o sea
   * O(1) amortizado por `push` (lo que pide §5.7).
   */
  let escaneo = 0;
  /** Filas descartadas desde el último aviso al log. */
  let descartadas = 0;
  /** Veces que la cola pasó el tope sin tener nada descartable. */
  let desbordes = 0;
  /** Vueltas SEGUIDAS que no movieron la cola (ver `MAX_REINTENTOS_TRABADO`). */
  let trabada = 0;

  let cancelarTick: Cancelar | null = null;
  /** Contexto de mapeo de la vuelta en curso (se rearma en cada `vuelta`). */
  let ctx: MapCtx = { selfJid: "", nowSec: 0 };

  /**
   * Grupos que ya no hay que volver a preguntar: o se les vio el nombre, o ya se
   * pidió el `groupMetadata` (haya salido bien o mal). Sin esta memoria, un grupo
   * sin subject dispararía una llamada de red **por cada mensaje** que llegue.
   */
  const gruposResueltos = new Set<string>();
  /** Grupos a preguntar cuando cierre la transacción de la vuelta en curso. */
  let subjectsPendientes: string[] = [];

  /**
   * Pares LID ↔ número ya escritos en esta sesión. La equivalencia no cambia, y
   * sin esta memoria un chat con 5.000 mensajes haría 5.000 escrituras idénticas
   * (cada sobre trae `remoteJidAlt`).
   */
  const paresVistos = new Set<string>();
  /** Identidades ya reportadas a `requestAlias`: se pregunta UNA vez por sesión. */
  const hermanasPedidas = new Set<string>();
  /** Identidades a reportar cuando cierre la transacción de la vuelta en curso. */
  let hermanasPendientes: string[] = [];

  /**
   * Mensajes del chat ABIERTO que entraron en esta vuelta y todavía no tienen
   * recibo (§6.2). Como el chat abierto sólo lo cambia la interfaz —y la
   * interfaz no puede correr en el medio de una vuelta, que es sincrónica de
   * punta a punta—, todos los de una misma vuelta son del mismo chat.
   */
  let recibosPendientes: ReadTarget[] = [];
  let recibosChat: string | null = null;

  // Slices a marcar sucios. Se juntan durante la vuelta y se avisan UNA vez, ya
  // cerrada la transacción: el store coalesce igual (D3), pero así el flush
  // nunca puede leer la base a mitad de un chunk.
  let sucioInbox = false;
  let sucioConvo = false;

  const hayPendiente = (): boolean => cabeza < cola.length;

  // ── aplicadores (todos corren DENTRO de la transacción de la vuelta) ──────

  function marcar(chatJid: string, convo: boolean): void {
    sucioInbox = true;
    if (convo && chatJid === openChatJid()) sucioConvo = true;
  }

  // ── identidad doble: LID ↔ número ────────────────────────────────────────
  //
  // WhatsApp está migrando a un identificador que no es el teléfono (el LID) y
  // manda los nombres de la AGENDA pegados a él (`lidContactAction`,
  // `Utils/chat-utils.js:833`), mientras que el CHAT viene muchas veces bajo el
  // número. Como `listChats` resuelve el nombre con
  // `LEFT JOIN contacts ON contacts.jid = chats.jid`, ese chat no encontraba
  // nunca su nombre y la bandeja mostraba el número.
  //
  // Se arregla acá, en el ingest, y no al pintar la fila: resolverlo al leer
  // costaría una consulta por fila y por frame, y el pedido al store de baileys
  // es asíncrono (el render no puede esperar). Todo lo que sigue corre DENTRO de
  // la transacción salvo `pedirHermanas()`.

  /** Los dos jids normalizados de un par, o `null` si el par no tiene sentido. */
  function parNormalizado(unJid: string, otroJid: string): [string, string] | null {
    const a = jidNormalizedUser(unJid || undefined);
    const b = jidNormalizedUser(otroJid || undefined);
    if (!a || !b || a === b) return null;
    // Un grupo no tiene identidad hermana, y un par tiene que ser entre
    // identidades de DISTINTO tipo (lid ↔ número): dos números o dos lids es
    // basura que llegó de afuera.
    if (isJidGroup(a) || isJidGroup(b)) return null;
    if (!!isLidUser(a) === !!isLidUser(b)) return null;
    return [a, b];
  }

  /**
   * Anota que dos jids son la misma persona. Devuelve `true` sólo la PRIMERA
   * vez que se ve el par: el llamador aprovecha eso para no repetir el trabajo
   * de propagar el nombre en cada mensaje.
   */
  function vincular(unJid: string, otroJid: string): boolean {
    const par = parNormalizado(unJid, otroJid);
    if (!par) return false;
    const clave = par[0] < par[1] ? `${par[0]}|${par[1]}` : `${par[1]}|${par[0]}`;
    if (paresVistos.has(clave)) return false;
    paresVistos.add(clave);
    repo.linkJids(par[0], par[1]);
    return true;
  }

  /**
   * El nombre de la agenda también se copia a `chats.name` —además de quedar en
   * `contacts`— porque hay una pantalla que lee esa columna a pelo, sin el JOIN:
   * los resultados de la búsqueda global (`repo.searchMessages`).
   *
   * Sólo si el chat EXISTE (upsertear crearía un chat por cada contacto de la
   * agenda, que es justo lo que §5.1 prohíbe) y sólo si todavía no tiene nombre
   * propio: un subject o un `pushName` que ya está no se pisa.
   */
  function ponerNombreEnChat(jid: string, nombre: string): boolean {
    if (!nombre) return false;
    const chat = repo.getChat(jid);
    if (!chat || chat.name) return false;
    repo.upsertChat({ jid, name: nombre });
    return true;
  }

  /**
   * Le presta el nombre de la agenda a la identidad que no lo tiene. Nunca al
   * revés y nunca pisando: si las dos ya tienen nombre, cada una se queda con el
   * suyo (el de la otra puede ser de otra época o de otra fuente).
   */
  function propagarNombre(a: string, b: string): boolean {
    const nombreA = oneLine(texto(repo.getContact(a)?.name));
    const nombreB = oneLine(texto(repo.getContact(b)?.name));
    if (nombreA === nombreB) return false; // los dos igual, o los dos vacíos
    if (nombreA && nombreB) return false; // cada uno con el suyo: no se toca
    const nombre = nombreA || nombreB;
    const destino = nombreA ? b : a;
    repo.upsertContact(destino, nombre, "");
    // Los DOS lados: el que recibió el nombre y el que ya lo tenía (su chat
    // puede seguir con `chats.name` vacío, y de ahí sale el título de un hit de
    // la búsqueda global).
    ponerNombreEnChat(a, nombre);
    ponerNombreEnChat(b, nombre);
    return true;
  }

  /**
   * Propaga usando la hermana que ya esté anotada en la base. `pedirSiFalta`
   * sólo lo pone `aplicarContacto`: es el único que sabe si hay un nombre que
   * valga la pena rescatar.
   */
  function propagarDe(jid: string, pedirSiFalta = false): void {
    const hermana = repo.altJid(jid);
    if (!hermana) {
      if (pedirSiFalta) anotarSinHermana(jid);
      return;
    }
    if (propagarNombre(jid, hermana)) sucioInbox = true;
  }

  /**
   * Anota una identidad `@lid` con nombre y sin hermana conocida. Corre DENTRO
   * de la transacción (sólo empuja a una lista); el pedido sale en
   * `pedirHermanas()`, ya cerrado el chunk.
   *
   * El `Set` se marca acá y no cuando vuelve la respuesta: así se pregunta una
   * sola vez aunque el contacto llegue diez veces, y también si el store no
   * tenía nada.
   */
  function anotarSinHermana(jid: string): void {
    if (!pedirHermanaRemota || hermanasPedidas.has(jid) || !isLidUser(jid)) return;
    hermanasPedidas.add(jid);
    hermanasPendientes.push(jid);
  }

  /** `aliases`: el par que resolvió el store de baileys, el history o el app-state. */
  function aplicarAlias(par: LIDMapping): void {
    const p = parNormalizado(texto(par?.lid), texto(par?.pn));
    if (!p) return;
    vincular(p[0], p[1]);
    if (propagarNombre(p[0], p[1])) sucioInbox = true;
  }

  /** Borrado por su autor (CA-6.9): NO inserta, ACTUALIZA el mensaje original. */
  function aplicarRevoke(chatJid: string, targetWaId: string): void {
    repo.revokeMessage(chatJid, targetWaId);
    marcar(chatJid, true);
  }

  /** El camino caliente: un mensaje entrante o el eco de uno propio (§6.2). */
  function aplicarMensaje(m: WAMessage, source: "notify" | "append" | "history"): void {
    // Primero el revoke: `mapMessage` devuelve `null` para todo
    // `protocolMessage`, así que si no se pregunta acá el borrado se pierde.
    const rev = isRevoke(m);
    if (rev) {
      aplicarRevoke(rev.chatJid, rev.targetWaId);
      return;
    }

    const fila = mapMessage(m, ctx);
    if (!fila) return;
    // El filtro sólo se aplica a lo que ya cayó en `unsupported`: un tipo nuevo
    // de WhatsApp con contenido real se sigue persistiendo (CA-7.5).
    if (fila.kind === "unsupported" && !tieneContenidoRenderizable(m)) return;

    // El chat va primero SIEMPRE: la FK de `messages.chat_jid` aborta si no
    // existe (§8.4). El nombre sólo se toca con mensajes ENTRANTES: en un eco
    // propio el `pushName` soy yo y el chat pasaría a llamarse como yo.
    //
    // Y sólo si el mensaje trae un `pushName` DE VERDAD: sin él
    // `resolveChatName` cae al número formateado (§5.4), que acá pisaría un
    // nombre bueno —el chat que vino del `messaging-history.set` como "Ana
    // Gómez" quedaría "+5491133445566"— porque para el upsert un número es un
    // string no vacío como cualquier otro. Y `pushName` sale de
    // `stanza.attrs.notify` (`Utils/decode-wa-message.js:176`), que puede no
    // venir. Un nombre bueno nunca se pisa con uno peor: mejor mandar nada y
    // que la bandeja formatee el jid al mostrarlo.
    const push = oneLine(texto(m?.pushName));
    // En un grupo `resolveChatName` devuelve `""` igual (CA-4.8).
    const nombre = !fila.fromMe && push ? resolveChatName({ pushName: push, jid: fila.chatJid }) : "";
    repo.upsertChat({
      jid: fila.chatJid,
      isGroup: !!isJidGroup(fila.chatJid),
      ...(nombre ? { name: nombre } : {}),
    });
    // Un grupo que entra por un mensaje EN VIVO no pasó por el
    // `messaging-history.set`, así que nadie le trajo el subject: se anota para
    // preguntarlo al cerrar la transacción.
    anotarGrupoSinNombre(fila.chatJid);

    // `key.remoteJidAlt` es la OTRA identidad del mismo chat 1:1, y viene en el
    // sobre (`Utils/decode-wa-message.js:180`): la fuente de mapeo más barata que
    // hay —sincrónica, sin red y sin base—. Sólo se propaga la PRIMERA vez que
    // se ve el par; el nombre que llegue después lo reparte `aplicarContacto`.
    // El `if` de afuera es por el camino caliente: la mayoría de los sobres no
    // trae identidad alternativa y no hay por qué normalizar dos jids de gusto.
    const hermana = texto(m?.key?.remoteJidAlt);
    if (hermana && vincular(fila.chatJid, hermana)) propagarDe(fila.chatJid);

    const { inserted, id } = repo.insertMessage(fila);
    // Ya estaba: re-sync o eco de un envío propio. NO se vuelve a tocar la
    // actividad ni los contadores (CA-14.2, CA-14.4).
    if (!inserted) return;

    repo.touchChatActivity(fila.chatJid, fila.ts, previewFor(fila), fila.fromMe);

    if (!fila.fromMe && source !== "history") {
      // Con el chat abierto el contador se mantiene en 0 y el `last_read_id`
      // avanza: nunca hay un bump que después haya que deshacer (CA-11.7).
      if (fila.chatJid === openChatJid()) {
        repo.clearUnread(fila.chatJid, id);
        // Y como nunca figuró sin leer, `markRead` no tiene de dónde sacarlo
        // después: el recibo de ESTE mensaje se anota acá y sale al cerrar la
        // transacción (§6.2). Sólo `notify`/`append`, nunca el historial: un
        // recibo por un mensaje viejo le mentiría al otro sobre cuándo lo leíste.
        if (mandarRecibo) {
          recibosChat = fila.chatJid;
          recibosPendientes.push({ waId: fila.waId, senderJid: fila.senderJid });
        }
      } else repo.bumpUnread(fila.chatJid, 1);
    }

    marcar(fila.chatJid, true);
  }

  // ── lo que no se muestra: bloqueados y candados ──────────────────────────
  //
  // Los dos estados se ANOTAN, nunca se borra nada (§5.1): el chat sigue en la
  // base con todos sus mensajes y vuelve a la bandeja solo en cuanto WhatsApp
  // avisa que el bloqueo o el candado se levantaron. Quien los esconde es el
  // repo, en la consulta (ver `VISIBLE` en `db/repo.ts`).

  /** `blocklist.set` / `fetchBlocklist`: la lista COMPLETA, con sus bajas. */
  function aplicarBlocklist(jids: unknown): void {
    const normalizados: string[] = [];
    for (const j of lista(jids as string[])) {
      const jid = jidNormalizedUser(texto(j) || undefined);
      if (jid) normalizados.push(jid);
    }
    repo.setBlocklist(normalizados);
    sucioInbox = true;
  }

  /** `blocklist.update`: una alta o una baja. El `type` lo tradujo el socket. */
  function aplicarBloqueo(jid: unknown, bloqueado: boolean): void {
    const j = jidNormalizedUser(texto(jid) || undefined);
    if (!j) return;
    repo.setBlocked(j, bloqueado);
    sucioInbox = true;
  }

  /**
   * `chats.lock`: el candado del chat. El `id` que trae el evento es el jid del
   * chat tal como lo nombra app-state (`syncAction.index[1]`), que puede ser el
   * `@lid` o el número — de eso se ocupa el cruce con `jid_aliases` al consultar.
   */
  function aplicarCandado(l: { jid: string; locked: boolean }): void {
    const jid = jidNormalizedUser(texto(l?.jid) || undefined);
    if (!jid) return;
    repo.setLocked(jid, !!l?.locked);
    sucioInbox = true;
  }

  /** `chats.upsert` / `messaging-history.set`: la ficha del chat, sin mensajes. */
  function aplicarChat(c: Chat): void {
    const jid = jidNormalizedUser(c?.id ?? undefined);
    // Los pseudo-chats de WhatsApp no entran (§5.4 y el `+0` de `isSystemJid`):
    // el MISMO criterio que usa `mapMessage`, para que no pueda pasar que el
    // mensaje se descarte y la ficha del chat quede igual.
    if (isSystemJid(jid)) return;

    // `name` acá es el subject del grupo o el nombre del contacto, según el
    // chat. Vacío NO se manda: el upsert pisaría un nombre bueno con nada.
    const nombre = oneLine(texto(c?.name));
    const ts = segundos(c?.conversationTimestamp);
    // CA-11.7: el chat que se está MIRANDO se queda en 0. El contador del sync
    // de historial es el del servidor, que no sabe que lo tenés abierto: sin
    // esta línea, estar parado en un chat mientras entra el sync te lo dejaba
    // con 7 sin leer (reproducido). Vale para el `0` también, así que se fuerza
    // en vez de mirar lo que vino.
    const noLeidos = jid === openChatJid() ? 0 : cuenta(c?.unreadCount);

    repo.upsertChat({
      jid,
      isGroup: !!isJidGroup(jid),
      ...(nombre ? { name: nombre } : {}),
      ...(ts > 0 ? { lastMessageAt: ts } : {}),
      // El contador viene del servidor y es ABSOLUTO. Por eso los mensajes del
      // sync de historial no suman de a uno: se contarían dos veces.
      ...(noLeidos !== null ? { unreadCount: noLeidos } : {}),
    });
    sucioInbox = true;

    // La conversación del history sync trae las dos identidades al lado
    // (`Utils/history.js:67`): gratis, sin red. Las dos llamadas se evalúan
    // siempre —nada de `||` con corto circuito—: una conversación puede traer
    // las dos y perder una sería perder el mapeo.
    const porLid = vincular(jid, texto(c?.lidJid));
    const porPn = vincular(jid, texto(c?.pnJid));
    if (porLid || porPn) propagarDe(jid);
  }

  /**
   * `groups.upsert` / `groups.update` (y la respuesta del `groupMetadata`): lo
   * único que se usa es el **subject**.
   *
   * Un `groups.update` de participantes o de settings viene SIN subject: eso no
   * es "el grupo se quedó sin nombre", es "este evento no habla del nombre" ⇒ se
   * ignora. Mandar `name: ""` al upsert borraría el nombre bueno, que es el mismo
   * cuidado que ya tienen `aplicarChat` y `aplicarMensaje`.
   */
  function aplicarGrupo(g: Partial<GroupMetadata>): void {
    const jid = jidNormalizedUser(g?.id ?? undefined);
    if (!jid || !isJidGroup(jid)) return;
    const subject = oneLine(texto(g?.subject));
    if (!subject) return;

    repo.upsertChat({ jid, isGroup: true, name: subject });
    // Ya tiene nombre: no hay nada que preguntarle a WhatsApp nunca más.
    gruposResueltos.add(jid);
    sucioInbox = true;
  }

  /** La agenda: sólo alimenta `contacts`, que es de donde sale `contactName`. */
  function aplicarContacto(c: Contact): void {
    const jid = jidNormalizedUser(c?.id ?? undefined);
    if (!jid) return;
    const nombre = oneLine(texto(c?.name) || texto(c?.notify) || texto(c?.verifiedName));
    const tel = texto(c?.phoneNumber) || texto(jidDecode(jid)?.user);
    if (!nombre && !tel) return;
    repo.upsertContact(jid, nombre, tel);

    // La ficha suele traer LAS DOS identidades adentro (`lid` y `phoneNumber`
    // son jids enteros, `Utils/sync-action-utils.js:18`): otro mapeo gratis. Se
    // prueban las dos porque una de ellas es el propio `id` del contacto.
    vincular(jid, texto(c?.lid));
    vincular(jid, texto(c?.phoneNumber));

    // Y acá SIEMPRE se propaga, aunque el par ya estuviera anotado: este evento
    // es justo el que puede traer un nombre que antes no existía.
    if (nombre && ponerNombreEnChat(jid, nombre)) sucioInbox = true;
    propagarDe(jid, nombre !== "");
  }

  /**
   * `chats.update`. Se aplica SÓLO el "quedó en cero" (CA-11.6, otro dispositivo
   * marcó leído): un `unreadCount` POSITIVO acá es un DELTA, no un absoluto
   * (`Utils/process-message.js:196` emite `unreadCount: 1` por mensaje, y
   * `Utils/event-buffer.js:613` los SUMA al mergear), y tomarlo como absoluto
   * pisaría el contador real.
   *
   * Y no se manda ningún recibo de vuelta: si el chat quedó leído es porque otro
   * dispositivo de la cuenta ya lo acusó (CA-11.6). El contador ABSOLUTO del
   * servidor no llega por acá sino por `chats.upsert` (`aplicarChat`).
   */
  function aplicarChatUpdate(u: ChatUpdate): void {
    const jid = jidNormalizedUser(u?.id ?? undefined);
    if (!jid) return;
    if (u?.unreadCount !== 0) return;
    repo.setUnread(jid, 0);
    sucioInbox = true;
  }

  /** `messages.update`: el borrado (CA-6.9) y el avance del estado de envío. */
  function aplicarMsgUpdate(u: WAMessageUpdate): void {
    if (!u?.key) return;

    // ORDEN EXACTO: `key` DESPUÉS del spread. Al revés, el `key` que trae el
    // update (el del `protocolMessage`) pisa al de la víctima y se borraría el
    // mensaje equivocado — o ninguno.
    const rev = isRevoke({ ...u.update, key: u.key } as WAMessage);
    if (rev) {
      aplicarRevoke(rev.chatJid, rev.targetWaId);
      return;
    }

    const estado = estadoDe(u.update?.status);
    if (!estado) return;
    const chatJid = jidNormalizedUser(u.key.remoteJid ?? undefined);
    const waId = texto(u.key.id);
    if (!chatJid || !waId) return;

    // El MOTIVO sólo viaja en el rechazo: en cualquier otro estado el cuarto
    // argumento va `null` y limpia el error de un intento anterior (un `Ctrl-Y`
    // que salió bien no puede quedar con el texto del que falló).
    repo.setMessageStatus(
      chatJid,
      waId,
      estado,
      estado === "failed" ? motivoAckError(u.update?.messageStubParameters) : null,
    );
    if (chatJid === openChatJid()) sucioConvo = true;
  }

  /**
   * `message-receipt.update`: recibos por participante (grupos). Se aplica sólo
   * el "leído": el recibo de ENTREGA de un integrante llegaría después del
   * "leído" de otro y bajaría el estado del mensaje. El detalle fino de los
   * tildes es de la tarea 14.
   */
  function aplicarRecibo(r: MessageUserReceiptUpdate): void {
    if (!r?.key) return;
    const leido = segundos(r.receipt?.readTimestamp) > 0 || segundos(r.receipt?.playedTimestamp) > 0;
    if (!leido) return;
    const chatJid = jidNormalizedUser(r.key.remoteJid ?? undefined);
    const waId = texto(r.key.id);
    if (!chatJid || !waId) return;

    repo.setMessageStatus(chatJid, waId, "read");
    if (chatJid === openChatJid()) sucioConvo = true;
  }

  function aplicar(job: IngestJob, item: unknown): void {
    switch (job.kind) {
      case "messages":
        return aplicarMensaje(item as WAMessage, job.source);
      case "chats":
        return aplicarChat(item as Chat);
      case "contacts":
        return aplicarContacto(item as Contact);
      case "chat-updates":
        return aplicarChatUpdate(item as ChatUpdate);
      case "msg-updates":
        return aplicarMsgUpdate(item as WAMessageUpdate);
      case "receipts":
        return aplicarRecibo(item as MessageUserReceiptUpdate);
      case "groups":
        return aplicarGrupo(item as Partial<GroupMetadata>);
      case "aliases":
        return aplicarAlias(item as LIDMapping);
      case "blocklist":
        return aplicarBlocklist(item);
      case "block-updates":
        return aplicarBloqueo(item, job.op !== "remove");
      case "chat-lock":
        return aplicarCandado(item as { jid: string; locked: boolean });
    }
  }

  // ── subject de grupo a demanda (`sock.groupMetadata`) ─────────────────────

  /**
   * Anota un grupo cuyo nombre todavía no conocemos. Corre DENTRO de la
   * transacción (por eso sólo lee la base y empuja a una lista): el pedido de red
   * lo dispara `pedirSubjects()` recién cuando el chunk cerró.
   *
   * El `Set` se marca acá y no cuando vuelve la respuesta: así el grupo se
   * pregunta **una sola vez** aunque entren diez mensajes seguidos, y también
   * aunque la llamada falle.
   *
   * Y se dispara SÓLO desde `aplicarMensaje`, nunca desde `aplicarChat`: los
   * grupos del `messaging-history.set` ya vienen con su subject, y preguntarle a
   * WhatsApp por cada uno sería una ráfaga de decenas de consultas al vincular —
   * justo el ritmo que el diseño evita por el riesgo de ban (R2/R8).
   */
  function anotarGrupoSinNombre(jid: string): void {
    if (!pedirSubjectRemoto || gruposResueltos.has(jid) || !isJidGroup(jid)) return;
    gruposResueltos.add(jid);
    // El chat lo acaba de escribir `aplicarMensaje`: si ya trae nombre (vino por
    // el historial o por un `groups.update` anterior) no hay nada que pedir.
    if (repo.getChat(jid)?.name) return;
    subjectsPendientes.push(jid);
  }

  /**
   * Dispara los pedidos anotados. **Fuera** de la transacción y sin `await`: el
   * drenador no espera a la red, y la respuesta vuelve a entrar por la cola como
   * un job `groups` cualquiera —un solo camino de escritura—.
   */
  function pedirSubjects(): void {
    if (subjectsPendientes.length === 0) return;
    const jids = subjectsPendientes;
    subjectsPendientes = [];
    for (const jid of jids) pedirSubject(jid);
  }

  /**
   * Dispara el recibo de lectura anotado en la vuelta. **Fuera** de la
   * transacción, sin `await` y con la lista vaciada ANTES de llamar: si el hook
   * lanzara (no debería: `wa/read.ts` atrapa todo), el próximo chunk no tiene
   * que reintentar un recibo que ya se pidió.
   */
  function mandarRecibos(): void {
    const msgs = recibosPendientes;
    const chat = recibosChat;
    recibosPendientes = [];
    recibosChat = null;
    if (!mandarRecibo || !chat || msgs.length === 0) return;
    try {
      mandarRecibo(chat, msgs);
    } catch (e) {
      log.warn("ingest.recibo_fallido", { motivo: motivo(e) });
    }
  }

  /**
   * Reporta las identidades sin hermana anotadas en la vuelta. **Fuera** de la
   * transacción, en UNA sola llamada con todas juntas y con la lista vaciada
   * ANTES de llamar: si el hook lanzara, el próximo chunk no tiene que
   * reintentar un pedido que ya salió. Quien decide cuándo y en qué lotes se
   * consulta de verdad es `wa/identity.ts`.
   */
  function pedirHermanas(): void {
    const lids = hermanasPendientes;
    hermanasPendientes = [];
    if (!pedirHermanaRemota || lids.length === 0) return;
    try {
      pedirHermanaRemota(lids);
    } catch (e) {
      log.warn("ingest.alias_pedido_fallido", { motivo: motivo(e) });
    }
  }

  function pedirSubject(jid: string): void {
    const pedir = pedirSubjectRemoto;
    if (!pedir) return;
    let pendiente: Promise<string>;
    try {
      // El `try` cubre la función que LANZA en vez de rechazar (un socket que ya
      // no está, por ejemplo): esto cuelga del drenador y no puede tirarlo.
      pendiente = Promise.resolve(pedir(jid));
    } catch (e) {
      log.warn("ingest.group_subject_fallido", { jid, motivo: motivo(e) });
      return;
    }
    pendiente.then(
      (subject) => {
        const nombre = oneLine(texto(subject));
        if (!nombre) return;
        encolar({ kind: "groups", groups: [{ id: jid, subject: nombre }] });
      },
      (e: unknown) => log.warn("ingest.group_subject_fallido", { jid, motivo: motivo(e) }),
    );
  }

  // ── drenador ──────────────────────────────────────────────────────────────

  /**
   * Una vuelta: hasta `MAX_ROWS_PER_TICK` filas o `MAX_MS_PER_TICK` ms —lo que
   * pase primero— dentro de UNA transacción.
   *
   * Un ítem que explota no se lleva puesto al chunk: se cuenta, se sigue con el
   * siguiente y al final se loguea uno solo con el total. Un `WAMessage` roto no
   * puede costar 399 mensajes buenos.
   *
   * Devuelve cuánto avanzó (filas aplicadas + trabajos cerrados). `0` significa
   * que la vuelta no movió la cola, y de eso se agarra `drainNow` para no
   * quedarse girando en falso.
   */
  function vuelta(): number {
    const t0 = performance.now();
    let aplicados = 0;
    let cerrados = 0;
    let fallos = 0;
    let primerFallo = "";

    try {
      ctx = { selfJid: selfJid(), nowSec: Math.floor(ahora() / 1000) };
      repo.tx(() => {
        bucle: while (cabeza < cola.length) {
          const entrada = cola[cabeza]!;
          const items = itemsDe(entrada.job);
          while (pos < entrada.largo) {
            if (aplicados >= MAX_ROWS_PER_TICK) break bucle;
            // La primera fila se aplica siempre: si no, una base lenta dejaría
            // la cola parada para siempre.
            if (aplicados > 0 && performance.now() - t0 >= MAX_MS_PER_TICK) break bucle;
            const item = items[pos];
            pos++;
            aplicados++;
            filas--;
            try {
              aplicar(entrada.job, item);
            } catch (e) {
              fallos++;
              if (!primerFallo) primerFallo = motivo(e);
            }
          }
          // Trabajo terminado: se suelta la referencia a sus mensajes.
          cola[cabeza] = VACIA;
          cabeza++;
          cerrados++;
          pos = 0;
        }
      });
    } catch (e) {
      // La transacción entera falló (base bloqueada, disco lleno): SQLite hizo
      // rollback y la cola ya avanzó. Se pierde ese chunk, pero no se entra en
      // un loop reintentando lo mismo para siempre.
      log.error("ingest.chunk_fallido", { filas: aplicados, motivo: motivo(e) });
      // Y los recibos de ese chunk se tiran: esos mensajes no quedaron en la
      // base, así que el usuario NO los vio. Avisarle al otro que los leíste
      // sería mentirle sobre algo que él ve en su teléfono.
      recibosPendientes = [];
      recibosChat = null;
    }

    // La cola se vacía sola en cuanto se alcanza: es el caso normal y evita
    // tener que compactar. El `slice` cubre el otro caso, el flujo continuo.
    if (!hayPendiente()) {
      cola = [];
      cabeza = 0;
      escaneo = 0;
      filas = 0;
    } else if (cabeza >= 1024 && cabeza * 2 >= cola.length) {
      cola = cola.slice(cabeza);
      escaneo = Math.max(0, escaneo - cabeza);
      cabeza = 0;
    }

    // La red va DESPUÉS de la transacción, siempre (ver `pedirSubjects`).
    pedirSubjects();
    pedirHermanas();
    mandarRecibos();

    if (fallos > 0) log.warn("ingest.items_fallidos", { fallos, motivo: primerFallo });
    // Los avisos de la cola llena se juntan y salen acá: `push` no puede pagar
    // un `appendFileSync` por evento.
    //
    // El descarte tiene evento PROPIO y nivel `error`: lo que se tira son
    // mensajes del historial, y esos **no vuelven** —WhatsApp los mandó una vez—.
    // Mezclarlo con el desborde genérico en un `warn` hacía que una pérdida de
    // datos real pasara por "la cola se llenó un rato".
    if (descartadas > 0) {
      log.error("ingest.historial_descartado", { filas: descartadas, pendientes: filas });
      descartadas = 0;
    }
    if (desbordes > 0) {
      log.warn("ingest.cola_llena", { desbordes, pendientes: filas });
      desbordes = 0;
    }

    if (sucioInbox || sucioConvo) {
      // §6.2: la conversación sólo se marca si el chat abierto es el que cambió.
      store.markDirty(sucioInbox ? "inbox" : null, sucioConvo ? "convo" : null);
      sucioInbox = false;
      sucioConvo = false;
    }

    return aplicados + cerrados;
  }

  function tick(): void {
    cancelarTick = null;
    const avance = vuelta();
    if (!hayPendiente()) {
      trabada = 0;
      return;
    }
    // Una vuelta que no movió nada (la transacción ni siquiera abrió: base
    // cerrada, disco lleno) NO se reagenda con `setTimeout(0)`: sería un
    // busy-loop al 100% de CPU contra una base que no responde. Pero tampoco se
    // corta en seco, porque sin un `push` nuevo la cola no se drenaría nunca.
    // El punto medio son reintentos espaciados y contados.
    if (avance === 0) {
      trabada++;
      if (trabada > MAX_REINTENTOS_TRABADO) {
        log.error("ingest.drenado_trabado", { pendientes: filas, intentos: trabada });
        return;
      }
      agendarTick(MS_REINTENTO_TRABADO);
      return;
    }
    trabada = 0;
    agendarTick();
  }

  /**
   * `setTimeout(0)`: le devuelve el turno al event loop entre chunk y chunk (D4).
   * Con `ms > 0` es el reintento de una vuelta que no avanzó; un `push` que
   * llegue en el medio NO lo adelanta, se cuelga del que ya está agendado.
   */
  function agendarTick(ms = 0): void {
    if (cancelarTick) return;
    cancelarTick = agendar(tick, ms);
  }

  /**
   * Descarta el trabajo de HISTORIAL más viejo que quede. Nunca un `notify`: el
   * sync de historial lo vuelve a mandar WhatsApp, un mensaje que llegó en vivo
   * no vuelve. El único intocable es el trabajo A MEDIO APLICAR, porque `pos`
   * apunta adentro.
   */
  function descartarViejo(): void {
    if (escaneo < cabeza) escaneo = cabeza;
    for (; escaneo < cola.length; escaneo++) {
      const e = cola[escaneo]!;
      if (escaneo === cabeza && pos > 0) continue;
      if (e.largo === 0 || !esHistorial(e.job)) continue;
      filas -= e.largo;
      descartadas += e.largo;
      cola[escaneo] = VACIA;
      escaneo++;
      return;
    }
    // No quedó nada descartable: la cola pasa el tope antes que perder algo que
    // llegó en vivo. El aviso sale por vuelta, nunca desde `push`.
    desbordes++;
  }

  /** El `push` del contrato. Con nombre porque el fallback de subject lo reusa. */
  function encolar(job: IngestJob): void {
    try {
      const largo = itemsDe(job).length;
      if (largo === 0) return;
      if (cola.length - cabeza >= MAX_QUEUE_JOBS) descartarViejo();
      cola.push({ job, largo });
      filas += largo;
      // Trabajo nuevo = ventana de reintentos nueva: si el drenador ya se
      // había dado por vencido, este `push` lo vuelve a poner a intentar.
      trabada = 0;
      agendarTick();
    } catch (e) {
      // Último seguro: `push` cuelga de un handler del socket y una excepción
      // acá se lleva puesta la conexión. Mejor perder un evento que el socket.
      log.error("ingest.push_fallido", { motivo: motivo(e) });
    }
  }

  return {
    push: encolar,

    drainNow() {
      cancelarTick?.();
      cancelarTick = null;
      // Sin timers en el medio: acá ya no hay interfaz que congelar (CA-17.1).
      // Si una vuelta no avanza (la transacción ni siquiera abre), se corta: el
      // cierre no puede quedar girando contra una base que no responde.
      while (hayPendiente()) {
        if (vuelta() === 0) {
          log.error("ingest.drenado_trabado", { pendientes: filas });
          return;
        }
      }
    },

    pendingRows() {
      return filas;
    },
  };
}
