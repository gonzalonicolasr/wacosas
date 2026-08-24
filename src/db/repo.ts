// Repositorio: TODAS las sentencias preparadas del proyecto viven acá (design
// §5.2). Nadie fuera de este archivo escribe SQL.
//
// Es sincrónico a propósito: `bun:sqlite` lo es, y envolverlo en promesas sólo
// agregaría ticks de event loop sin ganar nada. Lo que mantiene la UI fluida no
// es la asincronía sino el chunking del ingest (D4) y los índices de §4.1.
//
// Convención: las columnas son snake_case, los tipos que salen de acá son
// camelCase con el `attachment` ya parseado. La traducción vive en `aChatRow` /
// `aMessageRow` y no se filtra a ningún otro módulo.
import type { Database } from "bun:sqlite";

import { fold } from "../lib/fmt";
import { parseSnippet } from "../lib/fts";

import type {
  AttachmentInfo,
  ChatRow,
  ContactRow,
  MappedMessage,
  MessageRow,
  MessageStatus,
  SearchHit,
} from "./types";

/**
 * Ventana fija de mensajes al abrir un chat (R2: 500, sin carga incremental
 * hacia arriba). Se exporta porque la usan la conversación (tarea 13) y el salto
 * desde la búsqueda (CA-12.3).
 */
export const VENTANA_DEFAULT = 500;

export type Counts = { all: number; unread: number; groups: number };

/**
 * Escalera del estado de entrega: sólo se sube, nunca se baja.
 *
 * ⚠️ Existe porque los acks de WhatsApp llegan FUERA DE ORDEN. La rama
 * `msg-updates` del ingest aplicaba el status a pelo, así que un `SERVER_ACK`
 * atrasado degradaba un mensaje ya leído (doble tilde azul → un tilde) y el
 * usuario veía el estado de su mensaje ir para atrás solo. Lo mismo pasa entre
 * `wa/send.ts` —que escribe `sent` cuando resuelve `sendMessage`— y un
 * `DELIVERY_ACK` que llegó antes de que la promesa volviera.
 *
 * `failed` y `pending` comparten escalón a propósito: son los dos extremos del
 * mismo intento y el reintento de `Ctrl-Y` (CA-9.3) tiene que poder volver de
 * `failed` a `pending`. Lo que NO se permite es que un ack viejo mande a
 * `pending` un mensaje que ya salió.
 *
 * ⚠️ `failed` es la EXCEPCIÓN de la escalera y por eso no se resuelve con el
 * número (ver `puedeAvanzar`): también se puede caer ahí desde `sent`. El
 * `messages.update` con `status: ERROR` sale de un solo lugar de Baileys
 * (`Socket/messages-recv.js`, el ack con `attrs.error`: 403, 479 `smax-invalid`,
 * "user is temporarily restricted") y es la ÚNICA señal de que WhatsApp rechazó
 * el mensaje o nos está limitando —justo lo que RNF-8 trata de evitar—. Como
 * `sock.sendMessage` NO espera el ack (`relayMessage` vuelve apenas manda la
 * stanza), nuestro `sent` se escribe SIEMPRE antes de que llegue ese ERROR: con
 * la escalera a secas, la señal se perdía siempre y el mensaje rechazado
 * quedaba en `✓ enviado` para siempre, sin motivo y sin `Ctrl-Y`.
 *
 * `delivered` y `read` sí lo bloquean: son prueba de que el mensaje llegó.
 *
 * Lo que esta función NO puede expresar —porque el repo no sabe quién la
 * llama— es el caso inverso: que `wa/send.ts` baje a `failed` un mensaje que
 * SÍ salió porque su promesa lanzó después de que el server acusó la stanza
 * (ahí el `Ctrl-Y` del usuario lo duplicaría). Esa guarda vive en `fallar()`,
 * que lee la fila antes de escribir.
 */
export const ORDEN_ESTADO: Record<MessageStatus, number> = {
  received: 0,
  pending: 1,
  failed: 1,
  sent: 2,
  delivered: 3,
  read: 4,
};

/** ¿El estado nuevo es un avance (o un movimiento dentro del mismo escalón)? */
export function puedeAvanzar(actual: MessageStatus, nuevo: MessageStatus): boolean {
  const a = ORDEN_ESTADO[actual];
  const b = ORDEN_ESTADO[nuevo];
  // Un estado desconocido (base tocada a mano, versión futura) no bloquea nada.
  if (a === undefined || b === undefined) return true;
  // El rechazo del servidor llega después del `sent` (ver arriba): se acepta
  // hasta ese escalón, nunca sobre un mensaje ya entregado o leído.
  if (nuevo === "failed") return a <= ORDEN_ESTADO.sent;
  return b >= a;
}

/**
 * Los dos motivos por los que un chat no se lista (§4.1, tabla `jid_flags`):
 * `blocked` = contacto bloqueado, `locked` = chat con candado (Chat Lock). Son
 * INDEPENDIENTES: sacar uno no saca el otro.
 */
export type JidFlags = { blocked: boolean; locked: boolean };

export type Repo = {
  // ── lectura (proyecciones del store) ──────────────────────────────────────
  /** SIN los ocultos: bloqueados y con candado no se listan (ver `VISIBLE`). */
  listChats(limit?: number): ChatRow[];
  /** Los tres contadores de la bandeja, también SIN los ocultos. */
  countsByFilter(): Counts;
  /**
   * La ficha de UN chat, esté oculto o no. No filtra a propósito: lo llaman el
   * ingest (para no pisar nombres) y `markRead`, que necesitan la fila aunque el
   * chat no se liste.
   */
  getChat(jid: string): ChatRow | null;
  /** Una fila de la agenda, o `null`. Se lee para prestarle el nombre a la otra identidad. */
  getContact(jid: string): ContactRow | null;
  /** La otra identidad del mismo humano (LID ↔ número), o `null` si no se conoce. */
  altJid(jid: string): string | null;
  /**
   * Los contactos que TIENEN nombre y cuya identidad hermana todavía no
   * conocemos: es la lista que el barrido de `wa/identity.ts` le pasa al store
   * de baileys. Sin límite a propósito — `contacts` son cientos de filas y se
   * consulta una vez por conexión, no por tecla.
   */
  contactsMissingAlias(): string[];
  /** Una fila por su id de WhatsApp: el estado para la escalera y el texto del reintento. */
  getMessageByWaId(chatJid: string, waId: string): MessageRow | null;
  lastMessages(jid: string, limit?: number): MessageRow[];
  messagesBefore(jid: string, beforeId: number, limit: number): MessageRow[];
  messagesAround(jid: string, anchorId: number, span?: number): MessageRow[];
  searchMessages(match: string, limit: number): SearchHit[];
  searchChats(query: string, limit: number): ChatRow[];
  openSends(): MessageRow[];

  // ── escritura (sólo desde wa/ingest.ts y wa/send.ts, dentro de una txn) ───
  /** `contactName` NO se acepta: es derivado del `LEFT JOIN` con la agenda. */
  upsertChat(c: Partial<Omit<ChatRow, "contactName">> & { jid: string }): void;
  upsertContact(jid: string, name: string, phone: string): void;
  /** Anota que estos dos jids son la misma persona. Escribe las DOS direcciones. */
  linkJids(a: string, b: string): void;
  /**
   * La lista COMPLETA de bloqueados (`blocklist.set` / `sock.fetchBlocklist()`):
   * los que no están **se desmarcan**. No toca el candado de nadie.
   */
  setBlocklist(jids: string[]): void;
  /** Alta o baja de UN bloqueado (`blocklist.update`). */
  setBlocked(jid: string, blocked: boolean): void;
  /** Candado de un chat (`chats.lock`). Independiente del bloqueo. */
  setLocked(jid: string, locked: boolean): void;
  /** Cómo está marcado un jid. Los dos en `false` si no tiene fila. */
  jidFlags(jid: string): JidFlags;
  insertMessage(m: MappedMessage): { inserted: boolean; id: number };
  touchChatActivity(jid: string, ts: number, preview: string, fromMe: boolean): void;
  bumpUnread(jid: string, delta: number): void;
  clearUnread(jid: string, lastReadId: number): void;
  setUnread(jid: string, n: number): void;
  /** Sólo AVANZA (ver `ORDEN_ESTADO`): un ack fuera de orden no baja el estado. */
  setMessageStatus(chatJid: string, waId: string, status: MessageStatus, error?: string | null): void;
  setMessageWaId(chatJid: string, oldWaId: string, newWaId: string): void;
  revokeMessage(chatJid: string, waId: string): void;

  tx<T>(fn: () => T): T;
  close(): void;
};

// ── filas crudas ────────────────────────────────────────────────────────────

type FilaChat = {
  jid: string;
  name: string;
  contact_name: string;
  is_group: number;
  last_message_at: number;
  last_preview: string;
  last_from_me: number;
  unread_count: number;
  last_read_id: number;
};

type FilaMensaje = {
  id: number;
  chat_jid: string;
  wa_id: string;
  from_me: number;
  sender_jid: string;
  sender_name: string;
  ts: number;
  kind: string;
  body: string;
  attachment: string | null;
  status: string;
  error: string | null;
};

type FilaHit = {
  id: number;
  chat_jid: string;
  chat_name: string;
  is_group: number;
  ts: number;
  from_me: number;
  frag: string;
};

// El `LEFT JOIN` con la agenda es la ÚNICA forma en que `contacts` llega a la
// pantalla: la tabla se llena con los eventos `contacts.*` de Baileys y hasta acá
// no la leía nadie. Se resuelve al LEER, nunca escribiendo `chats` (eso crearía
// un chat por cada contacto de la agenda). `contacts.jid` es la PK, así que es
// una búsqueda por índice por fila.
const COLS_CHAT =
  "c.jid, c.name, COALESCE(k.name, '') AS contact_name, c.is_group, c.last_message_at, c.last_preview, c.last_from_me, c.unread_count, c.last_read_id";
const FROM_CHAT = "FROM chats c LEFT JOIN contacts k ON k.jid = c.jid";
const COLS_MSG = "id, chat_jid, wa_id, from_me, sender_jid, sender_name, ts, kind, body, attachment, status, error";

// ── lo que NO se muestra: bloqueados y con candado (§4.1, `jid_flags`) ───────
//
// El filtro vive ACÁ, en el repo, y no en `filtrarChats`/`coincideChat`
// (`state/commands.ts`). Es una sola decisión que cubre las CUATRO puertas por
// las que un chat puede asomarse: la bandeja (`listChats`), los contadores de los
// tabs (`countsByFilter`), la búsqueda de chats de la global (`searchChats`, que
// reusa `qListChats`) y los mensajes de la global (`searchMessages`). Filtrando
// en la vista habría que acordarse en las cuatro, y la primera que se olvide es
// una fuga: un chat con candado que aparece en un resultado de `Ctrl-G` es
// exactamente lo que el usuario escondió detrás de un código.
//
// El cruce con `jid_aliases` no es adorno: el bloqueo llega pegado al `@lid`
// (`updateBlockStatus` de baileys manda `jid: lid`) y el chat puede estar bajo el
// número —o al revés—. Como `linkJids` escribe las dos direcciones, alcanza con
// UN salto: se mira la fila del propio jid y la de su hermana. Los dos joins son
// búsquedas por PK sobre una tabla de decenas de filas.
const JOIN_OCULTOS = `LEFT JOIN jid_aliases x ON x.jid = c.jid
     LEFT JOIN jid_flags   f ON f.jid = c.jid
     LEFT JOIN jid_flags   g ON g.jid = x.alt_jid`;
const VISIBLE = `COALESCE(f.blocked, 0) = 0 AND COALESCE(f.locked, 0) = 0
       AND COALESCE(g.blocked, 0) = 0 AND COALESCE(g.locked, 0) = 0`;

function aChatRow(f: FilaChat): ChatRow {
  return {
    jid: f.jid,
    name: f.name,
    contactName: f.contact_name,
    isGroup: f.is_group === 1,
    lastMessageAt: f.last_message_at,
    lastPreview: f.last_preview,
    lastFromMe: f.last_from_me === 1,
    unreadCount: f.unread_count,
    lastReadId: f.last_read_id,
  };
}

/** Un adjunto guardado a mano o de una versión vieja no puede voltear el render. */
function parsearAdjunto(raw: string | null): AttachmentInfo | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? (o as AttachmentInfo) : null;
  } catch {
    return null;
  }
}

function aMessageRow(f: FilaMensaje): MessageRow {
  return {
    id: f.id,
    chatJid: f.chat_jid,
    waId: f.wa_id,
    fromMe: f.from_me === 1,
    senderJid: f.sender_jid,
    senderName: f.sender_name,
    ts: f.ts,
    kind: f.kind as MessageRow["kind"],
    body: f.body,
    attachment: parsearAdjunto(f.attachment),
    status: f.status as MessageStatus,
    error: f.error,
  };
}

/** Orden de la conversación: cronológico ascendente, con el id de desempate (CA-6.1). */
function ordenarCronologico(filas: FilaMensaje[]): MessageRow[] {
  return filas.sort((a, b) => a.ts - b.ts || a.id - b.id).map(aMessageRow);
}

// ── helpers ────────────────────────────────────────────────────────────

const bit = (b: boolean | undefined): number | null => (b === undefined ? null : b ? 1 : 0);
const opt = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

// ── repo ────────────────────────────────────────────────────────────────────

export function createRepo(db: Database): Repo {
  // Todas las sentencias se preparan una sola vez, acá. `db.query()` además las
  // cachea en la conexión y las finaliza sola en el `close()`.
  const qListChats = db.query<FilaChat, [number]>(
    `SELECT ${COLS_CHAT} ${FROM_CHAT} ${JOIN_OCULTOS}
     WHERE ${VISIBLE}
     ORDER BY c.last_message_at DESC, c.jid LIMIT ?`,
  );
  // Los mismos joins que `qListChats`: un chat oculto tampoco puede contarse en
  // los tabs (si no, `Todos` diría 12 y se verían 11).
  const qCounts = db.query<Counts, []>(
    `SELECT COUNT(*)                                                     AS "all",
            COALESCE(SUM(CASE WHEN c.unread_count > 0 THEN 1 ELSE 0 END), 0) AS unread,
            COALESCE(SUM(CASE WHEN c.is_group = 1     THEN 1 ELSE 0 END), 0) AS groups
     FROM chats c ${JOIN_OCULTOS}
     WHERE ${VISIBLE}`,
  );
  const qGetChat = db.query<FilaChat, [string]>(`SELECT ${COLS_CHAT} ${FROM_CHAT} WHERE c.jid = ?`);
  const qGetContact = db.query<ContactRow, [string]>(
    "SELECT jid, name, phone FROM contacts WHERE jid = ?",
  );
  const qAltJid = db.query<{ alt_jid: string }, [string]>(
    "SELECT alt_jid FROM jid_aliases WHERE jid = ?",
  );
  // El `LEFT JOIN … IS NULL` es "los que todavía no tienen hermana". La tabla es
  // chica (cientos de filas) y esto se consulta una vez por conexión.
  const qSinAlias = db.query<{ jid: string }, []>(
    `SELECT k.jid FROM contacts k
     LEFT JOIN jid_aliases a ON a.jid = k.jid
     WHERE k.name <> '' AND a.jid IS NULL
     ORDER BY k.jid`,
  );
  // Por el índice único (chat_jid, wa_id): es una búsqueda puntual, no un scan.
  const qPorWaId = db.query<FilaMensaje, [string, string]>(
    `SELECT ${COLS_MSG} FROM messages WHERE chat_jid = ? AND wa_id = ?`,
  );

  const qLastMessages = db.query<FilaMensaje, [string, number]>(
    `SELECT ${COLS_MSG} FROM messages WHERE chat_jid = ? ORDER BY ts DESC, id DESC LIMIT ?`,
  );
  // El paginado y el salto anclan por `id` (no por `ts`) porque es el mismo
  // campo del predicado: así el ancla siempre queda adentro de la ventana.
  const qBefore = db.query<FilaMensaje, [string, number, number]>(
    `SELECT ${COLS_MSG} FROM messages WHERE chat_jid = ? AND id < ? ORDER BY id DESC LIMIT ?`,
  );
  const qHasta = db.query<FilaMensaje, [string, number, number]>(
    `SELECT ${COLS_MSG} FROM messages WHERE chat_jid = ? AND id <= ? ORDER BY id DESC LIMIT ?`,
  );
  const qDesde = db.query<FilaMensaje, [string, number, number]>(
    `SELECT ${COLS_MSG} FROM messages WHERE chat_jid = ? AND id > ? ORDER BY id ASC LIMIT ?`,
  );
  const qOpenSends = db.query<FilaMensaje, []>(
    `SELECT ${COLS_MSG} FROM messages WHERE status IN ('pending','failed') ORDER BY id`,
  );

  const qSearch = db.query<FilaHit, [string, number]>(
    `SELECT m.id, m.chat_jid, c.name AS chat_name, c.is_group, m.ts, m.from_me,
            snippet(messages_fts, 0, char(1), char(2), '…', 10) AS frag
     FROM messages_fts
     JOIN messages m ON m.id  = messages_fts.rowid
     JOIN chats    c ON c.jid = m.chat_jid
     ${JOIN_OCULTOS}
     WHERE messages_fts MATCH ? AND ${VISIBLE}
     ORDER BY bm25(messages_fts), m.ts DESC
     LIMIT ?`,
  );

  // `name`/`last_preview` vacíos NO pisan lo que ya había: un `chats.upsert` de
  // Baileys llega muchas veces sin nombre y no puede borrar el que resolvimos.
  // Los `NULL` (campo ausente en el `Partial`) tampoco tocan nada.
  const qUpsertChat = db.query(
    `INSERT INTO chats (jid, name, is_group, last_message_at, last_preview, last_from_me, unread_count, last_read_id)
     VALUES ($jid, COALESCE($name, ''), COALESCE($is_group, 0), COALESCE($last_message_at, 0),
             COALESCE($last_preview, ''), COALESCE($last_from_me, 0), COALESCE($unread_count, 0),
             COALESCE($last_read_id, 0))
     ON CONFLICT(jid) DO UPDATE SET
       name            = CASE WHEN $name        IS NOT NULL AND $name        <> '' THEN $name        ELSE chats.name         END,
       last_preview    = CASE WHEN $last_preview IS NOT NULL AND $last_preview <> '' THEN $last_preview ELSE chats.last_preview END,
       is_group        = COALESCE($is_group, chats.is_group),
       last_message_at = MAX(chats.last_message_at, COALESCE($last_message_at, 0)),
       last_from_me    = COALESCE($last_from_me, chats.last_from_me),
       unread_count    = COALESCE($unread_count, chats.unread_count),
       last_read_id    = COALESCE($last_read_id, chats.last_read_id),
       updated_at      = unixepoch()`,
  );

  const qUpsertContact = db.query<null, [string, string, string]>(
    `INSERT INTO contacts (jid, name, phone) VALUES (?, ?, ?)
     ON CONFLICT(jid) DO UPDATE SET
       name       = CASE WHEN excluded.name  <> '' THEN excluded.name  ELSE contacts.name  END,
       phone      = CASE WHEN excluded.phone <> '' THEN excluded.phone ELSE contacts.phone END,
       updated_at = unixepoch()`,
  );

  // La equivalencia se pisa si cambió: WhatsApp puede rehacer el mapeo de una
  // identidad, y quedarnos con el viejo sería mostrar el nombre de otro.
  const qUpsertAlias = db.query<null, [string, string]>(
    `INSERT INTO jid_aliases (jid, alt_jid) VALUES (?, ?)
     ON CONFLICT(jid) DO UPDATE SET alt_jid = excluded.alt_jid, updated_at = unixepoch()`,
  );

  // Los dos estados se escriben por SEPARADO —y con su propio `excluded`— para
  // que marcar uno no pueda pisar el otro: el que no viene en el INSERT toma el
  // default 0 sólo cuando la fila NO existía.
  const qSetBlocked = db.query<null, [string, number]>(
    `INSERT INTO jid_flags (jid, blocked) VALUES (?, ?)
     ON CONFLICT(jid) DO UPDATE SET blocked = excluded.blocked, updated_at = unixepoch()`,
  );
  const qSetLocked = db.query<null, [string, number]>(
    `INSERT INTO jid_flags (jid, locked) VALUES (?, ?)
     ON CONFLICT(jid) DO UPDATE SET locked = excluded.locked, updated_at = unixepoch()`,
  );
  // `blocklist.set` trae la lista COMPLETA: lo que no está en ella dejó de estar
  // bloqueado. Se limpia todo primero y se vuelve a marcar; el candado no se toca.
  const qLimpiarBloqueos = db.query<null, []>(
    "UPDATE jid_flags SET blocked = 0, updated_at = unixepoch() WHERE blocked = 1",
  );
  // Una fila sin ninguna marca no dice nada: se barre para que la tabla tenga
  // tantas filas como jids ocultos, no como jids que alguna vez lo estuvieron.
  const qBarrerFlags = db.query<null, []>("DELETE FROM jid_flags WHERE blocked = 0 AND locked = 0");
  const qFlags = db.query<{ blocked: number; locked: number }, [string]>(
    "SELECT blocked, locked FROM jid_flags WHERE jid = ?",
  );

  const qInsertMessage = db.query<{ id: number }, any>(
    `INSERT INTO messages (chat_jid, wa_id, from_me, sender_jid, sender_name, ts, kind, body, attachment, status, error)
     VALUES ($chat_jid, $wa_id, $from_me, $sender_jid, $sender_name, $ts, $kind, $body, $attachment, $status, $error)
     ON CONFLICT(chat_jid, wa_id) DO NOTHING
     RETURNING id`,
  );
  const qIdDe = db.query<{ id: number }, [string, string]>(
    "SELECT id FROM messages WHERE chat_jid = ? AND wa_id = ?",
  );

  // El CASE mira el valor VIEJO de last_message_at (SQLite evalúa todo el SET
  // contra la fila original), así un mensaje viejo del history sync no pisa el
  // preview con algo anterior.
  const qTouch = db.query<null, [number, string, number, string]>(
    `UPDATE chats SET
       last_message_at = MAX(last_message_at, ?1),
       last_preview    = CASE WHEN ?1 >= last_message_at THEN ?2 ELSE last_preview END,
       last_from_me    = CASE WHEN ?1 >= last_message_at THEN ?3 ELSE last_from_me END,
       updated_at      = unixepoch()
     WHERE jid = ?4`,
  );
  const qBumpUnread = db.query<null, [number, string]>(
    "UPDATE chats SET unread_count = MAX(0, unread_count + ?), updated_at = unixepoch() WHERE jid = ?",
  );
  const qClearUnread = db.query<null, [number, string]>(
    "UPDATE chats SET unread_count = 0, last_read_id = MAX(last_read_id, ?), updated_at = unixepoch() WHERE jid = ?",
  );
  const qSetUnread = db.query<null, [number, string]>(
    "UPDATE chats SET unread_count = MAX(0, ?), updated_at = unixepoch() WHERE jid = ?",
  );

  // No toca `body` ⇒ el trigger `AFTER UPDATE OF body` no dispara y el índice
  // FTS ni se entera. Es el camino caliente: pasa en cada recibo de envío.
  const qSetStatus = db.query<null, [string, string | null, string, string]>(
    "UPDATE messages SET status = ?, error = ? WHERE chat_jid = ? AND wa_id = ?",
  );
  const qSetWaId = db.query<null, [string, string, string]>(
    "UPDATE messages SET wa_id = ? WHERE chat_jid = ? AND wa_id = ?",
  );
  // Este SÍ toca `body` ⇒ reindexa y el texto borrado deja de ser buscable (CA-6.9).
  const qRevoke = db.query<null, [string, string]>(
    "UPDATE messages SET kind = 'revoked', body = '', attachment = NULL WHERE chat_jid = ? AND wa_id = ?",
  );

  // Una sola transacción preparada, reusada por todos los `tx()`. Anidarla es
  // seguro: bun:sqlite usa SAVEPOINT cuando ya hay una abierta.
  const correrTx = db.transaction((fn: () => unknown) => fn());

  return {
    listChats(limit) {
      // `LIMIT -1` en SQLite es "sin límite".
      return qListChats.all(limit ?? -1).map(aChatRow);
    },

    countsByFilter() {
      return qCounts.get() ?? { all: 0, unread: 0, groups: 0 };
    },

    getChat(jid) {
      const f = qGetChat.get(jid);
      return f ? aChatRow(f) : null;
    },

    getContact(jid) {
      return qGetContact.get(jid) ?? null;
    },

    altJid(jid) {
      return qAltJid.get(jid)?.alt_jid ?? null;
    },

    contactsMissingAlias() {
      return qSinAlias.all().map((f) => f.jid);
    },

    getMessageByWaId(chatJid, waId) {
      const f = qPorWaId.get(chatJid, waId);
      return f ? aMessageRow(f) : null;
    },

    lastMessages(jid, limit = VENTANA_DEFAULT) {
      return ordenarCronologico(qLastMessages.all(jid, limit));
    },

    messagesBefore(jid, beforeId, limit) {
      return ordenarCronologico(qBefore.all(jid, beforeId, limit));
    },

    messagesAround(jid, anchorId, span = VENTANA_DEFAULT) {
      const mitad = Math.max(1, Math.floor(span / 2));
      return ordenarCronologico([...qHasta.all(jid, anchorId, mitad), ...qDesde.all(jid, anchorId, mitad)]);
    },

    searchMessages(match, limit) {
      // Una MATCH vacía es error de sintaxis en FTS5: `buildFtsQuery` devuelve
      // '' cuando no queda ningún término y acá se corta sin llegar al motor.
      if (match.trim() === "") return [];
      return qSearch.all(match, limit).map((f) => ({
        messageId: f.id,
        chatJid: f.chat_jid,
        chatName: f.chat_name,
        isGroup: f.is_group === 1,
        ts: f.ts,
        fromMe: f.from_me === 1,
        parts: parseSnippet(f.frag),
      }));
    },

    // Por nombre O por número: el jid arranca con el número, así que alcanza con
    // mirar las dos columnas. Va por `fold` + `includes` y NO por FTS (R1: no
    // existe `chats_fts`). El filtrado es en JS y no en SQL porque bun:sqlite no
    // deja registrar funciones propias —así que `LIKE` no sabría de acentos— y
    // la tabla `chats` es chica por naturaleza: son cientos de filas, no miles.
    searchChats(query, limit) {
      const aguja = fold(query.trim());
      if (aguja === "") return [];
      const out: ChatRow[] = [];
      for (const f of qListChats.all(-1)) {
        if (
          fold(f.name).includes(aguja) ||
          fold(f.contact_name).includes(aguja) ||
          fold(f.jid).includes(aguja)
        ) {
          out.push(aChatRow(f));
          if (out.length >= limit) break;
        }
      }
      return out;
    },

    openSends() {
      return qOpenSends.all().map(aMessageRow);
    },

    upsertChat(c) {
      qUpsertChat.run({
        $jid: c.jid,
        $name: opt(c.name),
        $is_group: bit(c.isGroup),
        $last_message_at: opt(c.lastMessageAt),
        $last_preview: opt(c.lastPreview),
        $last_from_me: bit(c.lastFromMe),
        $unread_count: opt(c.unreadCount),
        $last_read_id: opt(c.lastReadId),
      });
    },

    upsertContact(jid, name, phone) {
      qUpsertContact.run(jid, name, phone);
    },

    // Las dos direcciones, siempre: quien pregunta tiene un jid en la mano y no
    // sabe si es el LID o el número.
    linkJids(a, b) {
      qUpsertAlias.run(a, b);
      qUpsertAlias.run(b, a);
    },

    // En UNA transacción: entre el `UPDATE` que limpia y los `INSERT` que marcan,
    // la base diría que no hay nadie bloqueado. El `tx` anida por SAVEPOINT, así
    // que llamarla desde adentro del chunk del ingest es seguro.
    setBlocklist(jids) {
      correrTx(() => {
        qLimpiarBloqueos.run();
        for (const jid of jids) if (jid) qSetBlocked.run(jid, 1);
        qBarrerFlags.run();
      });
    },

    setBlocked(jid, blocked) {
      if (!jid) return;
      qSetBlocked.run(jid, blocked ? 1 : 0);
      if (!blocked) qBarrerFlags.run();
    },

    setLocked(jid, locked) {
      if (!jid) return;
      qSetLocked.run(jid, locked ? 1 : 0);
      if (!locked) qBarrerFlags.run();
    },

    jidFlags(jid) {
      const f = qFlags.get(jid);
      return { blocked: f?.blocked === 1, locked: f?.locked === 1 };
    },

    // Si el chat no existe, el FK aborta: un mensaje huérfano sería invisible en
    // la bandeja y un bug carísimo de encontrar. El ingest hace `upsertChat`
    // primero, siempre (§6.2).
    insertMessage(m) {
      const fila = qInsertMessage.get({
        $chat_jid: m.chatJid,
        $wa_id: m.waId,
        $from_me: m.fromMe ? 1 : 0,
        $sender_jid: m.senderJid,
        $sender_name: m.senderName,
        $ts: m.ts,
        $kind: m.kind,
        $body: m.body,
        $attachment: m.attachment ? JSON.stringify(m.attachment) : null,
        $status: m.status,
        $error: m.error ?? null,
      });
      if (fila) return { inserted: true, id: fila.id };
      // Hubo conflicto por (chat_jid, wa_id): ya estaba. Se devuelve el id que
      // ya existía para que el llamador pueda seguir trabajando (CA-14.2/14.4).
      const previo = qIdDe.get(m.chatJid, m.waId);
      return { inserted: false, id: previo ? previo.id : 0 };
    },

    touchChatActivity(jid, ts, preview, fromMe) {
      qTouch.run(ts, preview, fromMe ? 1 : 0, jid);
    },

    bumpUnread(jid, delta) {
      qBumpUnread.run(delta, jid);
    },

    clearUnread(jid, lastReadId) {
      qClearUnread.run(lastReadId, jid);
    },

    setUnread(jid, n) {
      qSetUnread.run(n, jid);
    },

    // ⚠️ La guarda vive ACÁ y no en cada llamador (`wa/ingest.ts` tiene dos y
    // `wa/send.ts` otros dos): es el único punto por el que pasa TODO cambio de
    // estado, así que es el único lugar donde la escalera no se puede olvidar.
    // Leer antes de escribir cuesta una búsqueda por índice único; el `UPDATE`
    // que no se hace ahorra el write y el markDirty que venía atrás.
    setMessageStatus(chatJid, waId, status, error) {
      const previo = qPorWaId.get(chatJid, waId);
      // Sin fila el `UPDATE` sería un no-op igual: se corta antes.
      if (!previo) return;
      if (!puedeAvanzar(previo.status as MessageStatus, status)) return;
      qSetStatus.run(status, error ?? null, chatJid, waId);
    },

    setMessageWaId(chatJid, oldWaId, newWaId) {
      qSetWaId.run(newWaId, chatJid, oldWaId);
    },

    revokeMessage(chatJid, waId) {
      qRevoke.run(chatJid, waId);
    },

    tx<T>(fn: () => T): T {
      return correrTx(fn) as T;
    },

    close() {
      db.close();
    },
  };
}
