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
  getContentType,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
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
  MessageUserReceiptUpdate,
  WAMessage,
  WAMessageUpdate,
} from "baileys";

import type { Logger } from "../boot/log";
import type { Repo } from "../db/repo";
import type { MessageStatus } from "../db/types";
import { oneLine } from "../lib/fmt";
import type { Cancelar, Store } from "../state/store";

import { isRevoke, mapMessage, previewFor, resolveChatName, type MapCtx } from "./map";

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
  | { kind: "receipts"; receipts: MessageUserReceiptUpdate[] };

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

    const { inserted, id } = repo.insertMessage(fila);
    // Ya estaba: re-sync o eco de un envío propio. NO se vuelve a tocar la
    // actividad ni los contadores (CA-14.2, CA-14.4).
    if (!inserted) return;

    repo.touchChatActivity(fila.chatJid, fila.ts, previewFor(fila), fila.fromMe);

    if (!fila.fromMe && source !== "history") {
      // Con el chat abierto el contador se mantiene en 0 y el `last_read_id`
      // avanza: nunca hay un bump que después haya que deshacer (CA-11.7).
      if (fila.chatJid === openChatJid()) repo.clearUnread(fila.chatJid, id);
      else repo.bumpUnread(fila.chatJid, 1);
    }

    marcar(fila.chatJid, true);
  }

  /** `chats.upsert` / `messaging-history.set`: la ficha del chat, sin mensajes. */
  function aplicarChat(c: Chat): void {
    const jid = jidNormalizedUser(c?.id ?? undefined);
    if (!jid || isJidStatusBroadcast(jid) || isJidNewsletter(jid)) return;

    // `name` acá es el subject del grupo o el nombre del contacto, según el
    // chat. Vacío NO se manda: el upsert pisaría un nombre bueno con nada.
    const nombre = oneLine(texto(c?.name));
    const ts = segundos(c?.conversationTimestamp);
    const noLeidos = cuenta(c?.unreadCount);

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
  }

  /** La agenda: sólo alimenta `contacts`, que es de donde sale `contactName`. */
  function aplicarContacto(c: Contact): void {
    const jid = jidNormalizedUser(c?.id ?? undefined);
    if (!jid) return;
    const nombre = oneLine(texto(c?.name) || texto(c?.notify) || texto(c?.verifiedName));
    const tel = texto(c?.phoneNumber) || texto(jidDecode(jid)?.user);
    if (!nombre && !tel) return;
    repo.upsertContact(jid, nombre, tel);
  }

  /**
   * `chats.update`. Se aplica SÓLO el "quedó en cero" (CA-11.6, otro dispositivo
   * marcó leído): un `unreadCount` POSITIVO acá es un DELTA, no un absoluto
   * (`Utils/process-message.js:196` emite `unreadCount: 1` por mensaje), y
   * tomarlo como absoluto pisaría el contador real. El resto de este evento lo
   * cablea la tarea 15.
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

    repo.setMessageStatus(chatJid, waId, estado);
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
    }
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

    if (fallos > 0) log.warn("ingest.items_fallidos", { fallos, motivo: primerFallo });
    // Los avisos de la cola llena se juntan y salen acá: `push` no puede pagar
    // un `appendFileSync` por evento.
    if (descartadas > 0 || desbordes > 0) {
      log.warn("ingest.cola_llena", { descartadas, desbordes, pendientes: filas });
      descartadas = 0;
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

  return {
    push(job) {
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
    },

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
