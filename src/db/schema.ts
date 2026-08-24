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

-- Las DOS identidades del mismo humano: el LID (\`…@lid\`) y el número
-- (\`…@s.whatsapp.net\`). No es cosmético — es la razón por la que casi ningún
-- chat mostraba nombre: WhatsApp manda los nombres de la agenda pegados al LID
-- (\`lidContactAction\`, \`Utils/chat-utils.js:833\`) y los chats muchas veces
-- vienen bajo el número, así que el \`LEFT JOIN contacts ON contacts.jid =
-- chats.jid\` de \`listChats\` no encontraba nada. Medido sobre la cuenta real:
-- 463 contactos con número, NINGUNO con nombre; los 32 nombres, todos en filas
-- \`@lid\`.
--
-- Se guarda en las DOS direcciones (dos filas por par) para que buscar la
-- hermana de un jid sea siempre un golpe a la PK.
--
-- Lo que esta tabla **no** hace: fusionar chats. Los mensajes siguen colgando de
-- su \`chat_jid\` original y las dos identidades siguen siendo dos filas de
-- \`chats\` (R7); acá sólo se comparte el NOMBRE.
CREATE TABLE IF NOT EXISTS jid_aliases (
  jid        TEXT PRIMARY KEY,
  alt_jid    TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Los dos motivos por los que un chat **no se muestra** (y que NO son lo mismo):
--
--   · \`blocked\` — el contacto está **bloqueado** en WhatsApp. Llega por
--     \`blocklist.set\`/\`blocklist.update\` (y por \`sock.fetchBlocklist()\`, ver
--     \`wa/socket.ts\`).
--   · \`locked\`  — el chat tiene **candado** (Chat Lock): el usuario lo escondió
--     detrás de un código secreto y en el teléfono sólo aparece si escribe ese
--     código en el buscador. Llega por \`chats.lock\` (app-state,
--     \`Utils/chat-utils.js:818\`). En wacosas no hay código que pedir, así que un
--     chat con candado sencillamente NO se lista.
--
-- Los dos estados viven en la MISMA fila pero son independientes: desbloquear a
-- alguien no le saca el candado a su chat, y sacar el candado no lo desbloquea.
--
-- Por qué una tabla aparte y no dos columnas en \`chats\`:
--   · un jid bloqueado puede **no tener chat** (bloqueás a alguien con quien
--     nunca hablaste) y upsertear \`chats\` para anotarlo crearía la fila fantasma
--     que §5.1 justamente prohíbe;
--   · el estado llega pegado a UNA de las dos identidades del humano (el \`@lid\` o
--     el número) y el chat puede estar bajo la otra: por eso las consultas cruzan
--     esta tabla con \`jid_aliases\` (ver \`db/repo.ts\`).
--
-- Nada se borra nunca por estar oculto: el historial queda intacto y vuelve a
-- verse solo en cuanto WhatsApp avisa que el candado o el bloqueo se levantaron.
CREATE TABLE IF NOT EXISTS jid_flags (
  jid        TEXT PRIMARY KEY,
  blocked    INTEGER NOT NULL DEFAULT 0,
  locked     INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- El TERCER motivo por el que un chat no se muestra, y el único que NO viene de
-- WhatsApp: **el usuario lo escondió a mano desde wacosas** (la tecla \`^X\`).
--
-- Se comporta igual que un candado: no se lista en ninguna de las cuatro puertas
-- y se revela con el MISMO código (\`boot/lockcode.ts\`). Lo que cambia es de dónde
-- viene, y por eso vive en su propia tabla y no en una columna de \`jid_flags\`:
--
--   · \`jid_flags\` es el espejo de lo que dice WhatsApp (\`chats.lock\`,
--     \`blocklist.*\`) y sus escrituras PISAN el valor anterior — así tiene que ser:
--     si el teléfono dice que el candado se levantó, se levanta. Un ocultamiento
--     del usuario no puede depender de eso: WhatsApp no sabe que existe;
--   · con dos orígenes en la misma columna, sacar uno borraría el otro. Acá
--     desmarcar a mano es \`DELETE\` de esta fila y no toca \`jid_flags\`, y un
--     \`chats.lock\` con \`locked: false\` no toca esta tabla;
--   · la fila EXISTE o no existe: no hace falta \`0\`/\`1\` ni barrido.
--
-- Se guarda bajo el jid que el usuario tenía a la vista; el cruce con
-- \`jid_aliases\` (ver \`db/repo.ts\`) hace que esconda también a la identidad
-- hermana, igual que el candado y el bloqueo.
CREATE TABLE IF NOT EXISTS jid_hides (
  jid        TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
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
 * El jid de los avisos oficiales de WhatsApp (`PSA_WID` = `0@c.us`, que
 * `jidNormalizedUser` deja en `0@s.whatsapp.net`). **No es una persona**: la
 * bandeja lo pintaba como `+0` porque el número del jid es literalmente `0`.
 *
 * Las tres formas están en el `DELETE` porque el normalizado depende de por dónde
 * entró la fila; `messages` se va sola con el `ON DELETE CASCADE` y el trigger
 * `messages_ad` saca el texto del índice FTS.
 */
export const JIDS_PSA = ["0@s.whatsapp.net", "0@c.us", "0@lid"] as const;

/**
 * La v3 agrega `jid_flags` —que no necesita migración, es un `CREATE TABLE IF NOT
 * EXISTS` más y `migrate()` corre el `SCHEMA_SQL` entero en cada arranque— y sí
 * necesita esta: **borrar el chat `+0` que ya está en la base**. Filtrarlo en el
 * ingest (`isSystemJid`, `wa/map.ts`) impide que vuelva a entrar, pero no saca el
 * que se coló antes, y ese se sigue viendo en la bandeja.
 *
 * Es idempotente (un `DELETE` que no encuentra nada es un no-op), así que corre
 * también sobre una base nueva sin costo.
 */
export const MIGRATIONS: Migracion[] = [
  {
    v: 3,
    sql: `DELETE FROM chats WHERE jid IN (${JIDS_PSA.map((j) => `'${j}'`).join(", ")});`,
  },
];

/**
 * v3: `jid_flags` (bloqueado / con candado) + el borrado del chat `+0`.
 * v4: `jid_hides` (los chats que el usuario escondió a mano con `^X`).
 *
 * La v4 no tiene entrada en `MIGRATIONS` y no es un olvido: es una tabla NUEVA,
 * o sea un `CREATE TABLE IF NOT EXISTS` más, y `migrate()` corre el `SCHEMA_SQL`
 * entero en cada arranque —así que la base que venía de la v3 la crea igual—. Lo
 * que SÍ necesitaría una migración es cambiar una tabla que ya existe (un
 * `ALTER TABLE` no es idempotente y acá las migraciones corren también sobre una
 * base nueva, donde la columna ya vendría del `SCHEMA_SQL`): ése es justamente
 * uno de los motivos por los que el ocultamiento manual es una tabla aparte.
 */
export const CURRENT_VERSION = 4;

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
