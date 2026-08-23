// Esquema de la base local (design §4.1) y migración idempotente (§4.2,
// CA-13.4/CA-13.5).
//
// Todo el DDL es `IF NOT EXISTS`: correr `db.exec(SCHEMA_SQL)` dos veces
// seguidas es un no-op, que es justamente lo que hace `migrate()` en cada
// arranque. La versión vive en `meta.schema_version` y `MIGRATIONS` arranca
// vacío a propósito: existe para que la v2 no tenga que inventar el mecanismo.
//
// Lo que NO está y no es un olvido: `chats_fts` y sus tres triggers (R1). El
// índice full-text cubre SÓLO `messages.body`; buscar chats por nombre lo
// resuelve el filtro de la bandeja con `fold()` sobre nombre y número (CA-5.2).
import type { Database } from "bun:sqlite";

/**
 * PRAGMAs de conexión, EN ESTE ORDEN y antes del DDL:
 *  - `WAL` para que el lector (la UI) y el escritor (el ingest) convivan;
 *  - `busy_timeout` porque con WAL igual hay momentos de lock (gotcha heredado);
 *  - `foreign_keys` porque el diseño se apoya en el `ON DELETE CASCADE` y en que
 *    un mensaje sin chat aborte en vez de quedar huérfano;
 *  - `synchronous = NORMAL`, que con WAL es durable ante un crash del proceso.
 */
export const PRAGMAS: readonly string[] = [
  "journal_mode = WAL",
  "busy_timeout = 3000",
  "foreign_keys = ON",
  "synchronous = NORMAL",
];

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  jid              TEXT PRIMARY KEY,
  name             TEXT    NOT NULL DEFAULT '',
  is_group         INTEGER NOT NULL DEFAULT 0,
  last_message_at  INTEGER NOT NULL DEFAULT 0,
  last_preview     TEXT    NOT NULL DEFAULT '',
  last_from_me     INTEGER NOT NULL DEFAULT 0,
  unread_count     INTEGER NOT NULL DEFAULT 0,
  last_read_id     INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at       INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_chats_activity ON chats(last_message_at DESC, jid);

CREATE TABLE IF NOT EXISTS contacts (
  jid        TEXT PRIMARY KEY,
  name       TEXT    NOT NULL DEFAULT '',
  phone      TEXT    NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_jid    TEXT    NOT NULL REFERENCES chats(jid) ON DELETE CASCADE,
  wa_id       TEXT    NOT NULL,
  from_me     INTEGER NOT NULL DEFAULT 0,
  sender_jid  TEXT    NOT NULL DEFAULT '',
  sender_name TEXT    NOT NULL DEFAULT '',
  ts          INTEGER NOT NULL,
  kind        TEXT    NOT NULL,
  body        TEXT    NOT NULL DEFAULT '',
  attachment  TEXT,
  status      TEXT    NOT NULL DEFAULT 'received',
  error       TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
-- Dedupe (CA-14.2/CA-14.4/CA-9.4): toda inserción va ON CONFLICT DO NOTHING contra esto.
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_waid   ON messages(chat_jid, wa_id);
-- Ventana de conversación (CA-6.1/CA-6.8) y salto desde la búsqueda (CA-12.3).
CREATE INDEX        IF NOT EXISTS idx_messages_chatts ON messages(chat_jid, ts, id);
-- Envíos en vuelo o fallados al arrancar (CA-17.7).
CREATE INDEX        IF NOT EXISTS idx_messages_open   ON messages(status) WHERE status IN ('pending','failed');

-- FTS5 sobre el cuerpo de los mensajes. Contenido externo: el índice no duplica
-- el texto, lo lee de \`messages\` por rowid.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  body, content='messages', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.id, old.body);
END;
-- OJO: \`AFTER UPDATE OF body\`, no \`AFTER UPDATE\` pelado. Cada confirmación de
-- envío hace UPDATE del status y no tiene por qué reindexar nada.
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF body ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.id, old.body);
  INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body);
END;
`;

/** Una migración: se aplica si `v` es mayor que la versión guardada. */
export type Migracion = { v: number; sql: string };

/**
 * Vacío en la v1. Cuando haga falta cambiar el esquema se agrega
 * `{ v: 2, sql: "ALTER TABLE …" }` y se sube `CURRENT_VERSION`.
 */
export const MIGRATIONS: Migracion[] = [];

export const CURRENT_VERSION = 1;

/** Lee `meta.schema_version`; si no está todavía, la base es nueva ⇒ 0. */
function versionGuardada(db: Database): number {
  const fila = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get();
  const n = fila ? Number(fila.value) : 0;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Crea lo que falte, aplica las migraciones pendientes y verifica la integridad.
 * Es idempotente: se puede llamar en cada arranque sin perder nada (CA-13.5).
 *
 * Lanza un `Error` común si `quick_check` no dice `ok`; el que lo convierte en
 * `DbCorruptError` (con la ruta) es `openDb`, que es el único que la conoce.
 */
export function migrate(db: Database): void {
  db.exec(SCHEMA_SQL);

  const desde = versionGuardada(db);
  for (const m of [...MIGRATIONS].sort((a, b) => a.v - b.v)) {
    if (m.v <= desde) continue;
    db.transaction(() => db.exec(m.sql))();
  }

  db.query("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    String(CURRENT_VERSION),
  );

  const problemas = db
    .query<{ quick_check: string }, []>("PRAGMA quick_check")
    .all()
    .map((f) => f.quick_check)
    .filter((t) => t !== "ok");
  if (problemas.length > 0) throw new Error(`quick_check: ${problemas.join("; ")}`);
}
