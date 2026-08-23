// Generador de datos sintéticos para los tests de performance (RNF-6, RNF-7) y
// para cualquier test que necesite una base con volumen.
//
// Es determinístico: misma `seed` ⇒ mismos chats, mismos cuerpos, mismos
// timestamps. Un bench que rinde distinto en cada corrida no sirve para nada.
//
// Escribe con sentencias propias adentro de UNA transacción en vez de pasar por
// `repo.insertMessage`: 50.000 filas con un `SELECT` de verificación cada una
// tardan de más y acá lo único que interesa es dejar la base poblada rápido.
//
// COSTO MEDIDO (bun 1.3.14, esta máquina): 50.000 mensajes tardan ~3,4 s, de los
// cuales ~3,2 s son los triggers que arman el índice FTS —los inserts pelados son
// 190 ms—. Se deja así a propósito: tocar la config del FTS (`automerge`) para
// cargar más rápido haría que el bench de RNF-7 midiera un índice distinto del
// que tiene la app en producción. Los tests que siembren a esta escala tienen que
// pasar su propio `timeout` (el default de `bun test` son 5 s y no alcanza).
import type { Database } from "bun:sqlite";

/**
 * Vocabulario de los cuerpos. Tiene acentos y eñes a propósito: así el bench de
 * búsqueda ejercita el `remove_diacritics 2` del tokenizer (CA-12.6) sobre
 * volumen y no sólo en el caso de juguete.
 */
export const VOCABULARIO = [
  "hola",
  "mañana",
  "reunión",
  "café",
  "gracias",
  "dale",
  "listo",
  "mandame",
  "la",
  "factura",
  "número",
  "cuándo",
  "podés",
  "tarde",
  "temprano",
  "acordate",
  "reservé",
  "camión",
  "quedamos",
  "después",
] as const;

export type SeedOpts = {
  /** Cantidad de chats a crear. Default 20. */
  chats?: number;
  /** Cantidad total de mensajes repartidos entre los chats. Default 1.000. */
  messages?: number;
  /** Semilla del PRNG. Default 1. */
  seed?: number;
  /** Epoch en SEGUNDOS del mensaje más viejo. Default 2024-01-01. */
  desde?: number;
};

export type SeedResult = {
  chatJids: string[];
  chats: number;
  messages: number;
};

/** mulberry32: 4 líneas, sin deps y con la misma secuencia en cualquier runtime. */
function prng(semilla: number): () => number {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Puebla `db` (ya migrada por `openDb`) con chats y mensajes sintéticos.
 * Uno de cada cinco chats es grupo y uno de cada siete queda con no leídos, así
 * los tres contadores de la bandeja dan distinto entre sí.
 */
export function seedDb(db: Database, opts: SeedOpts = {}): SeedResult {
  const nChats = opts.chats ?? 20;
  const nMsgs = opts.messages ?? 1000;
  const desde = opts.desde ?? 1704067200; // 2024-01-01T00:00:00Z
  const rnd = prng(opts.seed ?? 1);

  const chatJids: string[] = [];
  for (let i = 0; i < nChats; i++) {
    chatJids.push(i % 5 === 0 ? `12000000${i}-1600000000@g.us` : `54911${String(5000000 + i)}@s.whatsapp.net`);
  }

  const insChat = db.query(
    `INSERT INTO chats (jid, name, is_group, unread_count) VALUES (?, ?, ?, ?)
     ON CONFLICT(jid) DO NOTHING`,
  );
  const insMsg = db.query(
    `INSERT INTO messages (chat_jid, wa_id, from_me, sender_jid, sender_name, ts, kind, body, status)
     VALUES (?, ?, ?, ?, ?, ?, 'text', ?, ?)
     ON CONFLICT(chat_jid, wa_id) DO NOTHING`,
  );
  // Un solo UPDATE al final: recalcula actividad y preview desde lo insertado.
  const refrescarChats = db.query(
    `UPDATE chats SET
       last_message_at = COALESCE((SELECT MAX(ts) FROM messages m WHERE m.chat_jid = chats.jid), 0),
       last_preview    = COALESCE((SELECT m.body FROM messages m WHERE m.chat_jid = chats.jid
                                   ORDER BY m.ts DESC, m.id DESC LIMIT 1), ''),
       last_from_me    = COALESCE((SELECT m.from_me FROM messages m WHERE m.chat_jid = chats.jid
                                   ORDER BY m.ts DESC, m.id DESC LIMIT 1), 0)`,
  );

  db.transaction(() => {
    for (let i = 0; i < nChats; i++) {
      const esGrupo = i % 5 === 0;
      insChat.run(
        chatJids[i]!,
        esGrupo ? `Grupo ${i} — logística` : `Contacto ${i}`,
        esGrupo ? 1 : 0,
        i % 7 === 0 ? 1 + (i % 4) : 0,
      );
    }

    for (let n = 0; n < nMsgs; n++) {
      const iChat = Math.floor(rnd() * nChats);
      const jid = chatJids[iChat]!;
      const palabras: string[] = [];
      const largo = 6 + Math.floor(rnd() * 9);
      for (let w = 0; w < largo; w++) palabras.push(VOCABULARIO[Math.floor(rnd() * VOCABULARIO.length)]!);
      const propio = rnd() < 0.4;
      insMsg.run(
        jid,
        `SEED${n}`,
        propio ? 1 : 0,
        propio ? "self@s.whatsapp.net" : jid,
        propio ? "yo" : `Contacto ${iChat}`,
        desde + n * 37, // creciente: el orden de la bandeja queda determinístico
        palabras.join(" "),
        propio ? "sent" : "received",
      );
    }

    refrescarChats.run();
  })();

  return { chatJids, chats: nChats, messages: nMsgs };
}
