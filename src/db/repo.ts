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

export type Repo = {
  // ── lectura (proyecciones del store) ──────────────────────────────────────
  listChats(limit?: number): ChatRow[];
  countsByFilter(): Counts;
  getChat(jid: string): ChatRow | null;
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
  insertMessage(m: MappedMessage): { inserted: boolean; id: number };
  touchChatActivity(jid: string, ts: number, preview: string, fromMe: boolean): void;
  bumpUnread(jid: string, delta: number): void;
  clearUnread(jid: string, lastReadId: number): void;
  setUnread(jid: string, n: number): void;
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
    `SELECT ${COLS_CHAT} ${FROM_CHAT} ORDER BY c.last_message_at DESC, c.jid LIMIT ?`,
  );
  const qCounts = db.query<Counts, []>(
    `SELECT COUNT(*)                                                   AS "all",
            COALESCE(SUM(CASE WHEN unread_count > 0 THEN 1 ELSE 0 END), 0) AS unread,
            COALESCE(SUM(CASE WHEN is_group = 1     THEN 1 ELSE 0 END), 0) AS groups
     FROM chats`,
  );
  const qGetChat = db.query<FilaChat, [string]>(`SELECT ${COLS_CHAT} ${FROM_CHAT} WHERE c.jid = ?`);

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
     WHERE messages_fts MATCH ?
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

    setMessageStatus(chatJid, waId, status, error) {
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
