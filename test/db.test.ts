// Tests de la capa de datos: esquema idempotente, dedupe, FK, FTS, contadores y
// base corrupta (CA-13.4, CA-13.5, CA-13.6, CA-14.1, CA-14.2, CA-14.4, CA-12.1,
// CA-12.6, CA-12.7, CA-4.2, CA-6.1, CA-10.5).
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { closeSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DbCorruptError, openDb } from "../src/db/open";
import { createRepo, VENTANA_DEFAULT, type Repo } from "../src/db/repo";
import { CURRENT_VERSION, migrate, SCHEMA_SQL } from "../src/db/schema";
import type { MappedMessage } from "../src/db/types";
import { seedDb } from "./fixtures/seed";

const tmp = mkdtempSync(join(tmpdir(), "wacosas-db-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Una base en memoria ya migrada, con su repo. */
function base(): { db: Database; repo: Repo } {
  const db = openDb(":memory:");
  return { db, repo: createRepo(db) };
}

const CHAT = "5491150000001@s.whatsapp.net";
const GRUPO = "120000000001-1600000000@g.us";

function mensaje(over: Partial<MappedMessage> = {}): MappedMessage {
  return {
    chatJid: CHAT,
    waId: "WA1",
    fromMe: false,
    senderJid: CHAT,
    senderName: "Ana",
    ts: 1700000000,
    kind: "text",
    body: "hola",
    attachment: null,
    status: "received",
    ...over,
  };
}

/**
 * Huella del índice FTS: son los bloques reales del índice invertido, no el
 * contenido (que vive en `messages`). Si cambia, hubo reindexado.
 */
function huellaFts(db: Database): { n: number; bytes: number } {
  return db
    .query<{ n: number; bytes: number }, []>(
      "SELECT count(*) AS n, COALESCE(sum(length(block)), 0) AS bytes FROM messages_fts_data",
    )
    .get()!;
}

/** `sqlite3_total_changes`: cuenta también las filas que tocan los triggers. */
function cambios(db: Database): number {
  return db.query<{ n: number }, []>("SELECT total_changes() AS n").get()!.n;
}

// ── 1. esquema idempotente ──────────────────────────────────────────────────

describe("esquema", () => {
  test("exec(SCHEMA_SQL) dos veces seguidas es un no-op (CA-13.4/CA-13.5)", () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    const objetos1 = db
      .query<{ type: string; name: string }, []>("SELECT type, name FROM sqlite_master ORDER BY name")
      .all();

    expect(() => db.exec(SCHEMA_SQL)).not.toThrow();
    const objetos2 = db
      .query<{ type: string; name: string }, []>("SELECT type, name FROM sqlite_master ORDER BY name")
      .all();

    expect(objetos2).toEqual(objetos1);
    db.close();
  });

  test("migrate() es idempotente y deja la versión guardada", () => {
    const db = openDb(":memory:");
    expect(db.query<{ value: string }, []>("SELECT value FROM meta WHERE key='schema_version'").get()!.value).toBe(
      String(CURRENT_VERSION),
    );

    expect(() => migrate(db)).not.toThrow();
    expect(db.query<{ value: string }, []>("SELECT value FROM meta WHERE key='schema_version'").get()!.value).toBe(
      String(CURRENT_VERSION),
    );
    db.close();
  });

  test("crea las tablas, los índices y los tres triggers del FTS", () => {
    const { db } = base();
    const nombres = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master")
      .all()
      .map((f) => f.name);

    for (const t of ["meta", "chats", "contacts", "messages", "messages_fts"]) expect(nombres).toContain(t);
    for (const i of ["idx_chats_activity", "idx_messages_waid", "idx_messages_chatts", "idx_messages_open"])
      expect(nombres).toContain(i);
    for (const g of ["messages_ai", "messages_ad", "messages_au"]) expect(nombres).toContain(g);

    // R1: NO existe chats_fts ni sus triggers.
    expect(nombres).not.toContain("chats_fts");
    expect(nombres.filter((n) => n.startsWith("chats_a"))).toEqual([]);
    db.close();
  });

  test("los PRAGMAs quedan aplicados en la conexión", () => {
    const db = openDb(join(tmp, "pragmas.sqlite"));
    expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()!.journal_mode).toBe("wal");
    expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()!.foreign_keys).toBe(1);
    expect(db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()!.timeout).toBe(3000);
    expect(db.query<{ synchronous: number }, []>("PRAGMA synchronous").get()!.synchronous).toBe(1); // NORMAL
    db.close();
  });
});

// ── 2 y 3. dedupe y foreign keys ────────────────────────────────────────────

describe("inserción de mensajes", () => {
  test("un INSERT duplicado por (chat_jid, wa_id) devuelve inserted:false (CA-14.2/CA-14.4)", () => {
    const { db, repo } = base();
    repo.upsertChat({ jid: CHAT, name: "Ana" });

    const a = repo.insertMessage(mensaje({ waId: "W1", body: "primero" }));
    expect(a).toEqual({ inserted: true, id: 1 });

    const b = repo.insertMessage(mensaje({ waId: "W1", body: "el mismo, reenviado por el re-sync" }));
    expect(b).toEqual({ inserted: false, id: 1 });

    // No se duplicó ni se pisó el cuerpo original.
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM messages").get()!.n).toBe(1);
    expect(repo.lastMessages(CHAT)[0]!.body).toBe("primero");
    db.close();
  });

  test("el mismo wa_id en OTRO chat sí entra (el único índice es el compuesto)", () => {
    const { db, repo } = base();
    repo.upsertChat({ jid: CHAT });
    repo.upsertChat({ jid: GRUPO, isGroup: true });

    expect(repo.insertMessage(mensaje({ waId: "W1" })).inserted).toBe(true);
    expect(repo.insertMessage(mensaje({ waId: "W1", chatJid: GRUPO })).inserted).toBe(true);
    db.close();
  });

  test("el FK aborta si el chat no existe", () => {
    const { db, repo } = base();
    expect(() => repo.insertMessage(mensaje({ chatJid: "fantasma@s.whatsapp.net" }))).toThrow(
      /FOREIGN KEY constraint failed/,
    );
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM messages").get()!.n).toBe(0);
    db.close();
  });

  test("borrar el chat arrastra sus mensajes (ON DELETE CASCADE)", () => {
    const { db, repo } = base();
    repo.upsertChat({ jid: CHAT });
    repo.insertMessage(mensaje({ waId: "W1" }));
    db.query("DELETE FROM chats WHERE jid = ?").run(CHAT);
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM messages").get()!.n).toBe(0);
    db.close();
  });

  test("persiste todos los campos de CA-14.1, con el adjunto ida y vuelta", () => {
    const { db, repo } = base();
    repo.upsertChat({ jid: GRUPO, isGroup: true });
    repo.insertMessage(
      mensaje({
        chatJid: GRUPO,
        waId: "W7",
        fromMe: true,
        senderJid: "yo@s.whatsapp.net",
        senderName: "yo",
        kind: "document",
        body: "ahí va",
        attachment: { label: "📎 informe.pdf", filename: "informe.pdf", mimetype: "application/pdf" },
        status: "pending",
      }),
    );

    const m = repo.lastMessages(GRUPO)[0]!;
    expect(m).toMatchObject({
      chatJid: GRUPO,
      waId: "W7",
      fromMe: true,
      senderJid: "yo@s.whatsapp.net",
      senderName: "yo",
      kind: "document",
      body: "ahí va",
      status: "pending",
      error: null,
    });
    expect(m.attachment).toEqual({ label: "📎 informe.pdf", filename: "informe.pdf", mimetype: "application/pdf" });
    db.close();
  });
});

// ── 4 y 5. FTS: acentos y qué reindexa ──────────────────────────────────────

describe("índice full-text", () => {
  test("buscar 'manana' encuentra 'Mañana' (CA-12.6)", () => {
    const { db, repo } = base();
    repo.upsertChat({ jid: CHAT, name: "Ana" });
    repo.insertMessage(mensaje({ waId: "W1", body: "nos vemos Mañana temprano" }));
    repo.insertMessage(mensaje({ waId: "W2", body: "otra cosa sin la palabra" }));

    const hits = repo.searchMessages('"manana"*', 20);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ messageId: 1, chatJid: CHAT, chatName: "Ana", isGroup: false, fromMe: false });
    // El fragmento viene ya partido, con el término marcado (CA-12.2).
    expect(hits[0]!.parts.filter((p) => p.hit).map((p) => p.text)).toEqual(["Mañana"]);
    expect(hits[0]!.parts.map((p) => p.text).join("")).toBe("nos vemos Mañana temprano");
    db.close();
  });

  test("un mensaje recién insertado ya es buscable, sin reabrir nada (CA-12.7)", () => {
    const { db, repo } = base();
    repo.upsertChat({ jid: CHAT, name: "Ana" });
    expect(repo.searchMessages('"presupuesto"*', 20)).toHaveLength(0);
    repo.insertMessage(mensaje({ waId: "W1", body: "te paso el presupuesto" }));
    expect(repo.searchMessages('"presupuesto"*', 20)).toHaveLength(1);
    db.close();
  });

  test("una query vacía devuelve [] en vez de romper la sintaxis de FTS5 (CA-12.5)", () => {
    const { db, repo } = base();
    expect(repo.searchMessages("", 20)).toEqual([]);
    expect(repo.searchMessages("   ", 20)).toEqual([]);
    db.close();
  });

  test("el trigger de UPDATE es 'AFTER UPDATE OF body', no 'AFTER UPDATE' pelado", () => {
    const { db } = base();
    const sql = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name='messages_au'").get()!.sql;
    expect(sql).toContain("AFTER UPDATE OF body ON messages");
    db.close();
  });

  test("UPDATE de status NO reindexa y UPDATE de body SÍ", () => {
    const { db, repo } = base();
    repo.upsertChat({ jid: CHAT, name: "Ana" });
    repo.insertMessage(mensaje({ waId: "W1", body: "confirmame el envío", status: "pending" }));

    const antes = huellaFts(db);
    const c0 = cambios(db);

    // (a) status: es el camino caliente (un UPDATE por cada recibo del envío).
    repo.setMessageStatus(CHAT, "W1", "delivered");
    expect(huellaFts(db)).toEqual(antes); // el índice ni se tocó
    expect(cambios(db) - c0).toBe(1); // una sola fila: la de `messages`
    expect(repo.searchMessages('"confirmame"*', 20)).toHaveLength(1);
    expect(repo.lastMessages(CHAT)[0]!.status).toBe("delivered");

    // (b) body: acá sí tiene que reindexar.
    const c1 = cambios(db);
    db.query("UPDATE messages SET body = ? WHERE wa_id = 'W1'").run("ahora dice otra cosa");
    expect(huellaFts(db)).not.toEqual(antes);
    expect(cambios(db) - c1).toBeGreaterThan(1); // la fila + los bloques del índice
    expect(repo.searchMessages('"confirmame"*', 20)).toHaveLength(0); // el texto viejo salió
    expect(repo.searchMessages('"otra"*', 20)).toHaveLength(1); // el nuevo entró
    db.close();
  });

  test("revokeMessage vacía el cuerpo y lo saca del índice (CA-6.9)", () => {
    const { db, repo } = base();
    repo.upsertChat({ jid: CHAT, name: "Ana" });
    repo.insertMessage(mensaje({ waId: "W1", body: "esto lo borro", attachment: { label: "📷 imagen" } }));

    repo.revokeMessage(CHAT, "W1");

    const m = repo.lastMessages(CHAT)[0]!;
    expect(m.kind).toBe("revoked");
    expect(m.body).toBe("");
    expect(m.attachment).toBeNull();
    expect(repo.searchMessages('"borro"*', 20)).toHaveLength(0);
    db.close();
  });
});

// ── 6. contadores y bandeja ─────────────────────────────────────────────────

describe("bandeja", () => {
  test("countsByFilter() da los tres números", () => {
    const { db, repo } = base();
    repo.upsertChat({ jid: "a@s.whatsapp.net", name: "Ana", unreadCount: 3 });
    repo.upsertChat({ jid: "b@s.whatsapp.net", name: "Beto" });
    repo.upsertChat({ jid: "g1@g.us", name: "Laburo", isGroup: true, unreadCount: 1 });
    repo.upsertChat({ jid: "g2@g.us", name: "Familia", isGroup: true });

    expect(repo.countsByFilter()).toEqual({ all: 4, unread: 2, groups: 2 });
    db.close();
  });

  test("countsByFilter() sobre una base vacía da tres ceros (no NULL)", () => {
    const { db, repo } = base();
    expect(repo.countsByFilter()).toEqual({ all: 0, unread: 0, groups: 0 });
    db.close();
  });

  test("listChats ordena por actividad descendente y respeta el límite (CA-4.2)", () => {
    const { db, repo } = base();
    repo.upsertChat({ jid: "viejo@s.whatsapp.net", name: "Viejo", lastMessageAt: 100 });
    repo.upsertChat({ jid: "nuevo@s.whatsapp.net", name: "Nuevo", lastMessageAt: 300 });
    repo.upsertChat({ jid: "medio@s.whatsapp.net", name: "Medio", lastMessageAt: 200 });

    expect(repo.listChats().map((c) => c.name)).toEqual(["Nuevo", "Medio", "Viejo"]);
    expect(repo.listChats(2).map((c) => c.name)).toEqual(["Nuevo", "Medio"]);
    db.close();
  });

  test("upsertChat no pisa nombre ni contadores con vacíos", () => {
    const { db, repo } = base();
    repo.upsertChat({ jid: CHAT, name: "Ana Gómez", unreadCount: 4, lastMessageAt: 500, lastPreview: "dale" });
    // Así llegan la mayoría de los `chats.upsert` de Baileys: sin nombre.
    repo.upsertChat({ jid: CHAT, name: "", lastPreview: "" });
    repo.upsertChat({ jid: CHAT });

    expect(repo.getChat(CHAT)).toEqual({
      jid: CHAT,
      name: "Ana Gómez",
      isGroup: false,
      lastMessageAt: 500,
      lastPreview: "dale",
      lastFromMe: false,
      unreadCount: 4,
      lastReadId: 0,
    });
    expect(repo.getChat("no-existe@s.whatsapp.net")).toBeNull();
    db.close();
  });

  test("touchChatActivity mueve el chat sólo hacia adelante", () => {
    const { db, repo } = base();
    repo.upsertChat({ jid: CHAT, name: "Ana" });

    repo.touchChatActivity(CHAT, 200, "el último", false);
    expect(repo.getChat(CHAT)).toMatchObject({ lastMessageAt: 200, lastPreview: "el último", lastFromMe: false });

    // Un mensaje viejo del history sync no puede pisar el preview.
    repo.touchChatActivity(CHAT, 100, "uno de hace meses", true);
    expect(repo.getChat(CHAT)).toMatchObject({ lastMessageAt: 200, lastPreview: "el último", lastFromMe: false });

    repo.touchChatActivity(CHAT, 300, "el mío", true);
    expect(repo.getChat(CHAT)).toMatchObject({ lastMessageAt: 300, lastPreview: "el mío", lastFromMe: true });
    db.close();
  });

  test("los contadores de no leídos sobreviven al proceso (CA-10.5/CA-14.3)", () => {
    const path = join(tmp, "unread.sqlite");
    {
      const db = openDb(path);
      const repo = createRepo(db);
      repo.upsertChat({ jid: CHAT, name: "Ana" });
      repo.bumpUnread(CHAT, 1);
      repo.bumpUnread(CHAT, 2);
      expect(repo.getChat(CHAT)!.unreadCount).toBe(3);
      repo.close();
    }
    {
      const repo = createRepo(openDb(path));
      expect(repo.getChat(CHAT)!.unreadCount).toBe(3);

      repo.clearUnread(CHAT, 42); // CA-11.1
      expect(repo.getChat(CHAT)).toMatchObject({ unreadCount: 0, lastReadId: 42 });

      repo.clearUnread(CHAT, 7); // last_read_id nunca retrocede
      expect(repo.getChat(CHAT)!.lastReadId).toBe(42);

      repo.setUnread(CHAT, 5); // CA-11.6: se leyó/marcó desde otro dispositivo
      expect(repo.getChat(CHAT)!.unreadCount).toBe(5);

      repo.bumpUnread(CHAT, -99); // nunca queda negativo
      expect(repo.getChat(CHAT)!.unreadCount).toBe(0);
      repo.close();
    }
  });
});

// ── ventana de conversación y búsqueda de chats ─────────────────────────────

describe("conversación", () => {
  test("lastMessages devuelve los últimos 500 por default, en orden ascendente (CA-6.1, R2)", () => {
    const { db, repo } = base();
    repo.upsertChat({ jid: CHAT, name: "Ana" });
    repo.tx(() => {
      for (let i = 0; i < 520; i++) repo.insertMessage(mensaje({ waId: `W${i}`, ts: 1000 + i, body: `n${i}` }));
    });

    const v = repo.lastMessages(CHAT);
    expect(VENTANA_DEFAULT).toBe(500);
    expect(v).toHaveLength(500);
    expect(v[0]!.body).toBe("n20");
    expect(v[499]!.body).toBe("n519");
    expect(repo.lastMessages(CHAT, 10)).toHaveLength(10);
    db.close();
  });

  test("messagesBefore pagina hacia atrás y messagesAround centra en el ancla (CA-12.3)", () => {
    const { db, repo } = base();
    repo.upsertChat({ jid: CHAT, name: "Ana" });
    repo.tx(() => {
      for (let i = 0; i < 100; i++) repo.insertMessage(mensaje({ waId: `W${i}`, ts: 1000 + i, body: `n${i}` }));
    });

    const antes = repo.messagesBefore(CHAT, 50, 10);
    expect(antes.map((m) => m.body)).toEqual(["n39", "n40", "n41", "n42", "n43", "n44", "n45", "n46", "n47", "n48"]);

    const alrededor = repo.messagesAround(CHAT, 50, 10);
    expect(alrededor).toHaveLength(10);
    expect(alrededor.map((m) => m.id)).toContain(50);
    expect(alrededor[0]!.id).toBe(46);
    expect(alrededor[9]!.id).toBe(55);
    db.close();
  });

  test("searchChats filtra por nombre o número, sin acentos ni mayúsculas (CA-5.2/CA-12.1)", () => {
    const { db, repo } = base();
    repo.upsertChat({ jid: "5491150000001@s.whatsapp.net", name: "Mañana Producciones", lastMessageAt: 300 });
    repo.upsertChat({ jid: "5491199999999@s.whatsapp.net", name: "Beto", lastMessageAt: 200 });
    repo.upsertChat({ jid: "120000000001-1600000000@g.us", name: "Logística", lastMessageAt: 100, isGroup: true });

    expect(repo.searchChats("manana", 10).map((c) => c.name)).toEqual(["Mañana Producciones"]);
    expect(repo.searchChats("MAÑANA", 10).map((c) => c.name)).toEqual(["Mañana Producciones"]);
    expect(repo.searchChats("logistica", 10).map((c) => c.name)).toEqual(["Logística"]);
    expect(repo.searchChats("9999999", 10).map((c) => c.name)).toEqual(["Beto"]);
    expect(repo.searchChats("", 10)).toEqual([]);
    expect(repo.searchChats("zzz", 10)).toEqual([]);
    db.close();
  });
});

// ── envíos y transacciones ──────────────────────────────────────────────────

describe("envíos", () => {
  test("openSends() lista lo que quedó pendiente o fallado (CA-17.7)", () => {
    const { db, repo } = base();
    repo.upsertChat({ jid: CHAT, name: "Ana" });
    repo.insertMessage(mensaje({ waId: "W1", status: "received" }));
    repo.insertMessage(mensaje({ waId: "W2", status: "pending", fromMe: true }));
    repo.insertMessage(mensaje({ waId: "W3", status: "sent", fromMe: true }));
    repo.setMessageStatus(CHAT, "W3", "failed", "sin conexión");

    const abiertos = repo.openSends();
    expect(abiertos.map((m) => m.waId)).toEqual(["W2", "W3"]);
    expect(abiertos[1]).toMatchObject({ status: "failed", error: "sin conexión" });
    db.close();
  });

  test("setMessageWaId reemplaza el id propio por el que confirma WhatsApp (D7)", () => {
    const { db, repo } = base();
    repo.upsertChat({ jid: CHAT, name: "Ana" });
    repo.insertMessage(mensaje({ waId: "PROPIO1", status: "pending", fromMe: true }));

    repo.setMessageWaId(CHAT, "PROPIO1", "3EB0ABCDEF");
    expect(repo.lastMessages(CHAT)[0]!.waId).toBe("3EB0ABCDEF");

    // Y el eco que llega con ese id ya no duplica nada (CA-9.4).
    expect(repo.insertMessage(mensaje({ waId: "3EB0ABCDEF", fromMe: true })).inserted).toBe(false);
    db.close();
  });

  test("tx() revierte todo el bloque si algo lanza", () => {
    const { db, repo } = base();
    repo.upsertChat({ jid: CHAT, name: "Ana" });

    expect(() =>
      repo.tx(() => {
        repo.insertMessage(mensaje({ waId: "W1" }));
        repo.insertMessage(mensaje({ waId: "W2", chatJid: "fantasma@s.whatsapp.net" }));
      }),
    ).toThrow();

    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM messages").get()!.n).toBe(0);
    db.close();
  });

  test("upsertContact no pisa el nombre con vacío", () => {
    const { db, repo } = base();
    repo.upsertContact(CHAT, "Ana Gómez", "5491150000001");
    repo.upsertContact(CHAT, "", "");
    expect(db.query<{ name: string; phone: string }, [string]>("SELECT name, phone FROM contacts WHERE jid=?").get(CHAT)).toEqual({
      name: "Ana Gómez",
      phone: "5491150000001",
    });
    db.close();
  });
});

// ── 7. base corrupta ────────────────────────────────────────────────────────

describe("base corrupta (CA-13.6)", () => {
  test("un archivo que no es una base ⇒ DbCorruptError con ruta y motivo", () => {
    const path = join(tmp, "basura.sqlite");
    writeFileSync(path, "esto no es una base de datos\n".repeat(200));

    expect(() => openDb(path)).toThrow(DbCorruptError);
    try {
      openDb(path);
      expect.unreachable();
    } catch (e) {
      const err = e as DbCorruptError;
      expect(err.name).toBe("DbCorruptError");
      expect(err.path).toBe(path);
      expect(err.reason).toMatch(/not a database/i);
      expect(err.message).toContain(path);
    }
  });

  /**
   * Deja una base sana y después le pisa `paginas` páginas a partir de la
   * fracción `desdeFrac` del archivo, sin tocar la primera (la cabecera): así
   * abre bien, el DDL pasa y el que se queja es el `quick_check`.
   */
  function baseRota(nombre: string, desdeFrac: number, paginas: number): string {
    const path = join(tmp, nombre);
    const sana = openDb(path);
    seedDb(sana, { chats: 5, messages: 800 });
    sana.close();

    const size = statSync(path).size;
    const desde = Math.max(4096, Math.floor((size * desdeFrac) / 4096) * 4096);
    const fd = openSync(path, "r+");
    writeSync(fd, Buffer.alloc(paginas * 4096, 0x5a), 0, paginas * 4096, desde);
    closeSync(fd);
    return path;
  }

  test("una página pisada que el quick_check REPORTA ⇒ DbCorruptError", () => {
    const path = baseRota("rota-reporta.sqlite", 0.6, 1);

    try {
      openDb(path);
      expect.unreachable();
    } catch (e) {
      const err = e as DbCorruptError;
      expect(err.name).toBe("DbCorruptError");
      expect(err.path).toBe(path);
      expect(err.reason).toContain("quick_check");
      expect(err.reason).toMatch(/wrong # of entries|btreeInitPage/);
    }
  });

  test("media base pisada, donde el quick_check LANZA ⇒ DbCorruptError igual", () => {
    const path = baseRota("rota-lanza.sqlite", 0.25, 40);

    try {
      openDb(path);
      expect.unreachable();
    } catch (e) {
      const err = e as DbCorruptError;
      expect(err.name).toBe("DbCorruptError");
      expect(err.path).toBe(path);
      expect(err.reason).toMatch(/malformed|not a database/i);
    }
  });

  test("un directorio en lugar de un archivo ⇒ DbCorruptError, no un crash", () => {
    expect(() => openDb(tmp)).toThrow(DbCorruptError);
  });
});

// ── fixture de volumen ──────────────────────────────────────────────────────

describe("fixture seedDb", () => {
  test("puebla la base de forma determinística y consistente", () => {
    const a = openDb(":memory:");
    const b = openDb(":memory:");
    const r = seedDb(a, { chats: 6, messages: 300, seed: 7 });
    seedDb(b, { chats: 6, messages: 300, seed: 7 });

    expect(r).toMatchObject({ chats: 6, messages: 300 });
    expect(r.chatJids).toHaveLength(6);

    const cuerpos = (db: Database) =>
      db
        .query<{ body: string }, []>("SELECT body FROM messages ORDER BY id")
        .all()
        .map((f) => f.body);
    expect(cuerpos(a)).toEqual(cuerpos(b));

    const repo = createRepo(a);
    expect(repo.countsByFilter().all).toBe(6);
    expect(repo.countsByFilter().groups).toBeGreaterThan(0);
    expect(repo.countsByFilter().unread).toBeGreaterThan(0);
    // La bandeja queda ordenada y con preview real, no vacío.
    const chats = repo.listChats();
    expect(chats[0]!.lastMessageAt).toBeGreaterThanOrEqual(chats[chats.length - 1]!.lastMessageAt);
    expect(chats[0]!.lastPreview.length).toBeGreaterThan(0);
    // Y lo sembrado es buscable con y sin acento.
    expect(repo.searchMessages('"manana"*', 5).length).toBeGreaterThan(0);
    repo.close();
    b.close();
  });
});
