// Tests de la cola de ingest (design §5.7 + flujo §6.2): dedupe (CA-14.2,
// CA-14.4), no leídos (CA-10.1, CA-11.7), borrado por sus DOS caminos (CA-6.9),
// chunking que no congela la interfaz (RNF-5, RNF-6) e indexado inmediato en la
// búsqueda (CA-12.7).
//
// El agendador se INYECTA (mismo criterio que `lib/ratelimit.ts` y
// `state/store.ts`): el test corre las vueltas del drenador a mano y mide cada
// una con `performance.now()`, que es la única forma honesta de verificar el
// presupuesto de 20 ms por tick. Con `setTimeout` de verdad no se podría medir
// vuelta por vuelta.
//
// La base es un ARCHIVO y no `:memory:` a propósito: el costo real de una vuelta
// está en el commit (WAL + índice FTS), y en memoria ese costo no existe — el
// número mediría otra cosa.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database } from "bun:sqlite";

import { proto } from "baileys";
import type { WAMessage, WAMessageUpdate } from "baileys";

import { createLogger, type Logger } from "../src/boot/log";
import { openDb } from "../src/db/open";
import { createRepo, type Repo } from "../src/db/repo";
import { buildFtsQuery } from "../src/lib/fts";
import { createStore, type Slice, type Store } from "../src/state/store";
import {
  createIngest,
  MAX_QUEUE_JOBS,
  MAX_REINTENTOS_TRABADO,
  MAX_ROWS_PER_TICK,
  MS_REINTENTO_TRABADO,
  type Ingest,
  type IngestJob,
} from "../src/wa/ingest";
import { seedDb } from "./fixtures/seed";
import {
  AHORA,
  imagenConCaption,
  JID_CONTACTO,
  JID_GRUPO,
  JID_PARTICIPANTE,
  reaccion,
  revoke,
  SELF_JID,
  SELF_JID_NORMALIZADO,
  textoPlano,
  tipoInventado,
  TS_BASE,
} from "./fixtures/messages";

const tmp = mkdtempSync(join(tmpdir(), "wacosas-ingest-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Presupuesto por vuelta del drenador (done-when de la tarea 7). */
const TOPE_MS = 20;

// ── agendador manual ────────────────────────────────────────────────────────

/**
 * Reemplaza a `setTimeout`. El ingest agenda como mucho una vuelta a la vez, así
 * que alcanza con guardar la última.
 */
function agendadorManual() {
  let pendiente: (() => void) | null = null;
  /** Las esperas pedidas, en orden: con la base trabada dejan de ser 0. */
  const esperas: number[] = [];
  return {
    esperas,
    schedule(fn: () => void, ms: number) {
      pendiente = fn;
      esperas.push(ms);
      return () => {
        pendiente = null;
      };
    },
    hay: () => pendiente !== null,
    /** Corre UNA vuelta y devuelve lo que tardó en ms, o `null` si no había. */
    correr(): number | null {
      const fn = pendiente;
      if (!fn) return null;
      pendiente = null;
      const t0 = performance.now();
      fn();
      return performance.now() - t0;
    },
  };
}

// ── banco de pruebas ────────────────────────────────────────────────────────

let nBase = 0;

type Banco = {
  db: Database;
  repo: Repo;
  store: Store;
  ingest: Ingest;
  /** Los slices marcados sucios, en orden, una entrada por vuelta. */
  marcados: Slice[][];
  /** Los ms con los que se agendó cada vuelta, en orden. */
  esperas: number[];
  hayTick(): boolean;
  /** Corre UNA vuelta pendiente (o `null` si no había). */
  correrUna(): number | null;
  /** Corre todas las vueltas pendientes y devuelve los ms de cada una. */
  drenar(): number[];
  filas(): number;
  cerrar(): void;
};

function banco(opts: { repo?: (base: Repo) => Repo; log?: (base: Logger) => Logger } = {}): Banco {
  const db = openDb(join(tmp, `ingest-${nBase++}.sqlite`));
  const repo = opts.repo ? opts.repo(createRepo(db)) : createRepo(db);
  const logBase = createLogger(join(tmp, "ingest.log"));
  const log = opts.log ? opts.log(logBase) : logBase;

  // El store va con un agendador que NUNCA dispara: acá se mide el ingest, no
  // el coalescing del store (eso es `test/store.test.ts`). Los flush que el test
  // necesita los pide a mano con `flushNow()`.
  const store = createStore({ schedule: () => () => {} });
  store.bootstrap(repo);

  const marcados: Slice[][] = [];
  const espia: Store = {
    ...store,
    markDirty(...slices) {
      marcados.push(slices.filter((s): s is Slice => !!s));
      store.markDirty(...slices);
    },
  };

  const agenda = agendadorManual();
  const ingest = createIngest({
    repo,
    store: espia,
    log,
    selfJid: () => SELF_JID,
    openChatJid: () => store.openChatJid(),
    now: () => AHORA * 1000,
    schedule: agenda.schedule,
  });

  const contarFilas = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM messages");

  return {
    db,
    repo,
    store,
    ingest,
    marcados,
    esperas: agenda.esperas,
    hayTick: agenda.hay,
    correrUna: agenda.correr,
    drenar() {
      const ms: number[] = [];
      for (let vueltas = 0; agenda.hay(); vueltas++) {
        if (vueltas > 5_000) throw new Error("el drenador no termina");
        ms.push(agenda.correr()!);
      }
      return ms;
    },
    filas: () => contarFilas.get()!.n,
    cerrar: () => {
      store.stop();
      repo.close();
    },
  };
}

/** N mensajes entrantes del mismo chat, con la forma real de un `WAMessage`. */
function sintéticos(n: number, o: { jid?: string; prefijo?: string } = {}): WAMessage[] {
  const jid = o.jid ?? JID_CONTACTO;
  const out: WAMessage[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      key: { remoteJid: jid, fromMe: false, id: `${o.prefijo ?? "SINT"}${i}` },
      message: { conversation: `mensaje ${i} con unas cuantas palabras para el índice` },
      messageTimestamp: TS_BASE + i,
      pushName: "Ana Gómez",
    });
  }
  return out;
}

const lote = (msgs: WAMessage[], source: "notify" | "append" | "history" = "notify"): IngestJob => ({
  kind: "messages",
  msgs,
  source,
});

// ── volumen: el done-when de la tarea 7 ─────────────────────────────────────

test(
  "5.000 mensajes sintéticos quedan persistidos una sola vez (CA-14.1, CA-14.2)",
  () => {
    const b = banco();
    const msgs = sintéticos(5_000);
    for (let i = 0; i < msgs.length; i += 500) b.ingest.push(lote(msgs.slice(i, i + 500)));

    expect(b.ingest.pendingRows()).toBe(5_000);
    expect(b.filas()).toBe(0); // push() no escribió NADA todavía

    b.drenar();

    expect(b.filas()).toBe(5_000);
    expect(b.ingest.pendingRows()).toBe(0);
    expect(b.repo.getChat(JID_CONTACTO)!.unreadCount).toBe(5_000);
    // Ni un id repetido: el índice único (chat_jid, wa_id) es el que dedupea.
    const distintos = new Set(b.repo.lastMessages(JID_CONTACTO, 5_000).map((m) => m.waId));
    expect(distintos.size).toBe(5_000);
    b.cerrar();
  },
  30_000,
);

test(
  "ningún tick del drenador bloquea más de 20 ms con 5.000 mensajes (RNF-5, D4)",
  () => {
    const b = banco();
    b.ingest.push(lote(sintéticos(5_000)));

    const ms = b.drenar();
    const peor = Math.max(...ms);
    console.log(
      `[ingest] 5.000 mensajes en ${ms.length} vueltas · peor tick ${peor.toFixed(2)} ms · ` +
        `total ${ms.reduce((a, c) => a + c, 0).toFixed(0)} ms`,
    );

    expect(b.filas()).toBe(5_000);
    expect(ms.length).toBeGreaterThan(5_000 / MAX_ROWS_PER_TICK); // hubo chunking de verdad
    expect(peor).toBeLessThanOrEqual(TOPE_MS);
    b.cerrar();
  },
  30_000,
);

test(
  "el presupuesto por vuelta aguanta con 50.000 mensajes ya indexados (RNF-6)",
  () => {
    // Este es el caso que obligó a poner un tope de TIEMPO además del de filas:
    // con el índice FTS grande, el commit de una transacción de 400 filas dispara
    // un merge y la vuelta se iba a ~38 ms. Sembrar tarda ~3,4 s (casi todo son
    // los triggers del FTS), de ahí el timeout propio.
    const b = banco();
    seedDb(b.db, { chats: 20, messages: 50_000 });

    b.ingest.push(lote(sintéticos(2_000, { prefijo: "SOBRE_INDICE" })));
    const ms = b.drenar();
    const peor = Math.max(...ms);
    console.log(`[ingest] sobre 50.000 mensajes · peor tick ${peor.toFixed(2)} ms en ${ms.length} vueltas`);

    expect(peor).toBeLessThanOrEqual(TOPE_MS);
    expect(b.repo.lastMessages(JID_CONTACTO, 3_000).length).toBe(2_000);
    b.cerrar();
  },
  60_000,
);

test("una vuelta escribe como mucho MAX_ROWS_PER_TICK filas (D4)", () => {
  const b = banco();
  b.ingest.push(lote(sintéticos(1_000)));

  const antes = b.ingest.pendingRows();
  const ms = b.drenar().length;
  expect(antes).toBe(1_000);
  // Nunca menos vueltas que el techo de filas: si entrara todo en una, el
  // teclado se comería el bloqueo entero.
  expect(ms).toBeGreaterThanOrEqual(Math.ceil(1_000 / MAX_ROWS_PER_TICK));
  expect(b.filas()).toBe(1_000);
  b.cerrar();
});

test(
  "re-empujar los mismos 5.000 no inserta nada ni mueve los contadores (CA-14.4)",
  () => {
    const b = banco();
    const msgs = sintéticos(5_000);
    b.ingest.push(lote(msgs));
    b.drenar();

    const chat = b.repo.getChat(JID_CONTACTO)!;
    expect(b.filas()).toBe(5_000);

    // El re-sync de una reconexión: los MISMOS mensajes otra vez.
    for (let i = 0; i < msgs.length; i += 500) b.ingest.push(lote(msgs.slice(i, i + 500)));
    b.drenar();

    expect(b.filas()).toBe(5_000);
    const despues = b.repo.getChat(JID_CONTACTO)!;
    expect(despues.unreadCount).toBe(chat.unreadCount);
    expect(despues.lastMessageAt).toBe(chat.lastMessageAt);
    expect(despues.lastPreview).toBe(chat.lastPreview);
    b.cerrar();
  },
  30_000,
);

// ── no leídos (CA-10.1, CA-11.7) ────────────────────────────────────────────

test("con el chat abierto sus mensajes entrantes NO incrementan no leídos (CA-11.7)", () => {
  const b = banco();
  b.store.setOpenChat(JID_CONTACTO);

  b.ingest.push(lote(sintéticos(50)));
  b.drenar();

  const chat = b.repo.getChat(JID_CONTACTO)!;
  expect(chat.unreadCount).toBe(0);
  // Además queda leído hasta el último: al cerrar el chat no reaparece nada.
  expect(chat.lastReadId).toBe(b.repo.lastMessages(JID_CONTACTO, 1)[0]!.id);

  // Y el de al lado sí suma: el 0 es del chat ABIERTO, no de todos (CA-10.1).
  b.ingest.push(lote(sintéticos(3, { jid: JID_GRUPO, prefijo: "OTRO" })));
  b.drenar();
  expect(b.repo.getChat(JID_GRUPO)!.unreadCount).toBe(3);
  expect(b.repo.getChat(JID_CONTACTO)!.unreadCount).toBe(0);
  b.cerrar();
});

test("un mensaje propio (eco) nunca suma no leídos (CA-9.5, CA-10.1)", () => {
  const b = banco();
  b.ingest.push(
    lote([
      { ...textoPlano },
      {
        key: { remoteJid: JID_CONTACTO, fromMe: true, id: "3EB0ECO000000000001" },
        message: { conversation: "voy saliendo" },
        messageTimestamp: TS_BASE + 10,
        pushName: "Gon",
      },
    ]),
  );
  b.drenar();

  expect(b.filas()).toBe(2);
  expect(b.repo.getChat(JID_CONTACTO)!.unreadCount).toBe(1);
  // El eco propio NO rebautiza el chat: el `pushName` de un mensaje mío soy yo.
  expect(b.repo.getChat(JID_CONTACTO)!.name).toBe("Ana Gómez");
  expect(b.repo.getChat(JID_CONTACTO)!.lastFromMe).toBe(true);
  b.cerrar();
});

test("los mensajes del sync de historial no suman no leídos; el contador lo trae el chat", () => {
  const b = banco();
  // `messaging-history.set` manda las dos cosas: la ficha del chat con el
  // contador ABSOLUTO del servidor y los mensajes de backfill.
  b.ingest.push({
    kind: "chats",
    chats: [{ id: JID_CONTACTO, name: "Ana Gómez", unreadCount: 2, conversationTimestamp: TS_BASE }],
  });
  b.ingest.push(lote(sintéticos(40), "history"));
  b.drenar();

  expect(b.filas()).toBe(40);
  expect(b.repo.getChat(JID_CONTACTO)!.unreadCount).toBe(2);

  // Lo que llega en vivo sí suma, y lo que llegó mientras estábamos caídos
  // (`append`, `Socket/messages-recv.js:1432`) también.
  b.ingest.push(lote(sintéticos(1, { prefijo: "VIVO" }), "notify"));
  b.ingest.push(lote(sintéticos(1, { prefijo: "OFFLINE" }), "append"));
  b.drenar();
  expect(b.repo.getChat(JID_CONTACTO)!.unreadCount).toBe(4);
  b.cerrar();
});

test("chats.update con unreadCount 0 pone el contador local en 0 (CA-11.6)", () => {
  const b = banco();
  b.ingest.push(lote(sintéticos(5)));
  b.drenar();
  expect(b.repo.getChat(JID_CONTACTO)!.unreadCount).toBe(5);

  b.ingest.push({ kind: "chat-updates", updates: [{ id: JID_CONTACTO, unreadCount: 0 }] });
  b.drenar();
  expect(b.repo.getChat(JID_CONTACTO)!.unreadCount).toBe(0);

  // Un positivo NO se aplica: en `chats.update` es un delta, no un absoluto.
  b.ingest.push({ kind: "chat-updates", updates: [{ id: JID_CONTACTO, unreadCount: 1 }] });
  b.drenar();
  expect(b.repo.getChat(JID_CONTACTO)!.unreadCount).toBe(0);
  b.cerrar();
});

// ── borrado: LAS DOS RAMAS (CA-6.9) ─────────────────────────────────────────

test("revoke por messages.upsert: la fila original queda en kind revoked (CA-6.9)", () => {
  const b = banco();
  b.ingest.push(lote([textoPlano]));
  b.drenar();
  expect(b.repo.lastMessages(JID_CONTACTO)[0]!.kind).toBe("text");

  // La forma CRUDA, tal como la emite `Socket/chats.js:918`: el sobre entero con
  // su `protocolMessage`. `mapMessage` devuelve null acá, así que si el ingest
  // no preguntara `isRevoke` el borrado se perdería para siempre.
  b.ingest.push(lote([revoke]));
  b.drenar();

  const fila = b.repo.lastMessages(JID_CONTACTO)[0]!;
  expect(fila.waId).toBe("3EB0TEXTO0000000001");
  expect(fila.kind).toBe("revoked");
  expect(fila.body).toBe("");
  // El sobre del revoke NO se persiste como mensaje aparte.
  expect(b.filas()).toBe(1);
  b.cerrar();
});

test("revoke por messages.update: mismo resultado, con el key del sobre y no el del update (CA-6.9)", () => {
  const b = banco();
  b.ingest.push(lote([textoPlano]));
  b.drenar();

  // Copia textual de lo que emite baileys en `Utils/process-message.js:298`:
  // `key.id` es la VÍCTIMA y `update.key` es el sobre del protocolMessage.
  const u: WAMessageUpdate = {
    key: { remoteJid: JID_CONTACTO, fromMe: false, id: "3EB0TEXTO0000000001" },
    update: {
      message: null,
      messageStubType: proto.WebMessageInfo.StubType.REVOKE,
      key: { remoteJid: JID_CONTACTO, fromMe: false, id: "3EB0REVOKE0000000001" },
    },
  };
  // Los dos ids son distintos: con el spread al revés se borraría el equivocado.
  expect(u.update.key!.id).not.toBe(u.key.id);

  b.ingest.push({ kind: "msg-updates", updates: [u] });
  b.drenar();

  const fila = b.repo.lastMessages(JID_CONTACTO)[0]!;
  expect(fila.waId).toBe("3EB0TEXTO0000000001");
  expect(fila.kind).toBe("revoked");
  expect(b.filas()).toBe(1);
  b.cerrar();
});

test("un mensaje borrado deja de aparecer en la búsqueda (CA-6.9, CA-12.7)", () => {
  const b = banco();
  b.ingest.push(lote([textoPlano]));
  b.drenar();
  // Recién ingerido y ya indexado, sin reiniciar nada (CA-12.7).
  expect(b.repo.searchMessages(buildFtsQuery("como va"), 10).length).toBe(1);

  b.ingest.push(lote([revoke]));
  b.drenar();
  expect(b.repo.searchMessages(buildFtsQuery("como va"), 10).length).toBe(0);
  b.cerrar();
});

// ── qué se persiste y qué no ────────────────────────────────────────────────

test("los sobres sin contenido renderizable no se persisten (decisión (c) de la tarea 7)", () => {
  const b = banco();
  const stub = (id: string, tipo: number): WAMessage => ({
    key: { remoteJid: JID_GRUPO, fromMe: false, id, participant: JID_PARTICIPANTE },
    message: null,
    messageStubType: tipo,
    messageTimestamp: TS_BASE,
  });

  b.ingest.push(
    lote([
      stub("STUB_GRUPO", proto.WebMessageInfo.StubType.GROUP_PARTICIPANT_ADD),
      stub("STUB_CIFRADO", proto.WebMessageInfo.StubType.CIPHERTEXT),
      {
        key: { remoteJid: JID_CONTACTO, fromMe: false, id: "SOLO_SKDM" },
        message: { senderKeyDistributionMessage: { groupId: JID_GRUPO } },
        messageTimestamp: TS_BASE,
      },
      {
        key: { remoteJid: JID_CONTACTO, fromMe: false, id: "REACCION_CIFRADA" },
        message: { encReactionMessage: { targetMessageKey: { id: "X" } } },
        messageTimestamp: TS_BASE,
      },
      reaccion,
    ]),
  );
  b.drenar();

  expect(b.filas()).toBe(0);
  expect(b.repo.getChat(JID_CONTACTO)).toBeNull();
  b.cerrar();
});

test("un tipo desconocido CON contenido sí se persiste como unsupported (CA-7.5)", () => {
  const b = banco();
  b.ingest.push(lote([tipoInventado]));
  b.drenar();

  const fila = b.repo.lastMessages(JID_CONTACTO)[0]!;
  expect(fila.kind).toBe("unsupported");
  expect(b.repo.getChat(JID_CONTACTO)!.lastPreview).toBe("❔ mensaje no soportado");
  b.cerrar();
});

test("un chat que no existía se crea antes del mensaje, con preview y actividad (§8.4, CA-4.5)", () => {
  const b = banco();
  expect(b.repo.getChat(JID_CONTACTO)).toBeNull();

  b.ingest.push(lote([imagenConCaption]));
  b.drenar();

  const chat = b.repo.getChat(JID_CONTACTO)!;
  expect(chat.name).toBe("Ana Gómez");
  expect(chat.isGroup).toBe(false);
  expect(chat.lastMessageAt).toBe(TS_BASE);
  // El adjunto nunca deja la fila vacía (CA-4.5).
  expect(chat.lastPreview).toBe("📷 imagen · el asado de ayer");
  b.cerrar();
});

test("un mensaje de grupo no rebautiza el grupo con el nombre del que escribió (CA-4.8)", () => {
  const b = banco();
  b.ingest.push({ kind: "chats", chats: [{ id: JID_GRUPO, name: "Asado del sábado" }] });
  b.ingest.push(
    lote([
      {
        key: { remoteJid: JID_GRUPO, fromMe: false, id: "GRUPO1", participant: JID_PARTICIPANTE },
        message: { conversation: "¿a qué hora?" },
        messageTimestamp: TS_BASE,
        pushName: "Beto",
      },
    ]),
  );
  b.drenar();

  const chat = b.repo.getChat(JID_GRUPO)!;
  expect(chat.name).toBe("Asado del sábado");
  expect(chat.isGroup).toBe(true);
  expect(b.repo.lastMessages(JID_GRUPO)[0]!.senderJid).toBe(JID_PARTICIPANTE);
  b.cerrar();
});

test("un mensaje entrante sin pushName no rebautiza el chat con el número (CA-4.8)", () => {
  const b = banco();
  // 1. el `messaging-history.set` trae el chat ya con su nombre resuelto.
  b.ingest.push({ kind: "chats", chats: [{ id: JID_CONTACTO, name: "Ana Gómez" }] });
  b.drenar();
  expect(b.repo.getChat(JID_CONTACTO)!.name).toBe("Ana Gómez");

  // 2. llega un entrante SIN `pushName`: sale de `stanza.attrs.notify`
  //    (`Utils/decode-wa-message.js:176`) y ese atributo puede no venir.
  const sinPush: WAMessage = {
    key: { remoteJid: JID_CONTACTO, fromMe: false, id: "SIN_PUSHNAME" },
    message: { conversation: "che, ¿estás?" },
    messageTimestamp: TS_BASE + 1,
  };
  b.ingest.push(lote([sinPush]));
  b.drenar();

  // 3. el chat NO pasó a llamarse "+5491133445566": un nombre bueno nunca se
  //    pisa con uno peor, y un número formateado no es un nombre.
  expect(b.repo.getChat(JID_CONTACTO)!.name).toBe("Ana Gómez");
  expect(b.repo.lastMessages(JID_CONTACTO)[0]!.waId).toBe("SIN_PUSHNAME");

  // Y el chat que NACE de un mensaje sin `pushName` queda con `name` vacío: el
  // número lo pone la bandeja al mostrarlo (mismo caso que el chat creado por
  // un saliente, tarea 12), nunca la base.
  b.ingest.push(
    lote([
      {
        key: { remoteJid: JID_PARTICIPANTE, fromMe: false, id: "SIN_PUSHNAME_NUEVO" },
        message: { conversation: "hola" },
        messageTimestamp: TS_BASE + 2,
      },
    ]),
  );
  b.drenar();
  expect(b.repo.getChat(JID_PARTICIPANTE)!.name).toBe("");
  b.cerrar();
});

// ── estado de los envíos ────────────────────────────────────────────────────

test("messages.update con status avanza el estado del mensaje", () => {
  const b = banco();
  b.ingest.push(
    lote([
      {
        key: { remoteJid: JID_CONTACTO, fromMe: true, id: "PROPIO1" },
        message: { conversation: "ahí va" },
        messageTimestamp: TS_BASE,
      },
    ]),
  );
  b.drenar();
  expect(b.repo.lastMessages(JID_CONTACTO)[0]!.status).toBe("sent");

  b.ingest.push({
    kind: "msg-updates",
    updates: [
      {
        key: { remoteJid: JID_CONTACTO, fromMe: true, id: "PROPIO1" },
        update: { status: proto.WebMessageInfo.Status.DELIVERY_ACK },
      },
    ],
  });
  b.drenar();
  expect(b.repo.lastMessages(JID_CONTACTO)[0]!.status).toBe("delivered");

  b.ingest.push({
    kind: "receipts",
    receipts: [
      {
        key: { remoteJid: JID_CONTACTO, fromMe: true, id: "PROPIO1" },
        receipt: { userJid: JID_CONTACTO, readTimestamp: TS_BASE + 5 },
      },
    ],
  });
  b.drenar();
  expect(b.repo.lastMessages(JID_CONTACTO)[0]!.status).toBe("read");
  b.cerrar();
});

// ── contrato de push() y del drenador ───────────────────────────────────────

test("push() nunca lanza, ni con basura ni con la base cerrada", () => {
  const b = banco();
  const basura = [
    null,
    undefined,
    {},
    { kind: "messages" },
    { kind: "messages", msgs: null, source: "notify" },
    { kind: "inventado", cosas: [1, 2] },
    { kind: "msg-updates", updates: [null, { key: null }] },
    { kind: "chats", chats: [null, { id: "" }] },
    { kind: "contacts", contacts: [null] },
    { kind: "receipts", receipts: [null] },
  ] as unknown as IngestJob[];
  for (const j of basura) expect(() => b.ingest.push(j)).not.toThrow();
  expect(() => b.drenar()).not.toThrow();
  expect(b.filas()).toBe(0);

  b.repo.close();
  expect(() => b.ingest.push(lote(sintéticos(2)))).not.toThrow();
  // Con la base cerrada la vuelta tampoco puede lanzar: la cuelga un setTimeout
  // y una excepción ahí termina en `uncaughtException`.
  expect(() => b.drenar()).not.toThrow();
  b.store.stop();
});

test("un ítem que explota no se lleva puesto al resto del chunk", () => {
  const b = banco({
    repo: (base) => ({
      ...base,
      insertMessage(m) {
        if (m.waId === "SINT1") throw new Error("bomba");
        return base.insertMessage(m);
      },
    }),
  });

  b.ingest.push(lote(sintéticos(3)));
  expect(() => b.drenar()).not.toThrow();
  expect(b.filas()).toBe(2);
  b.cerrar();
});

test("drainNow() vacía la cola de una y no deja timers (CA-17.1)", () => {
  const b = banco();
  b.ingest.push(lote(sintéticos(900)));
  expect(b.hayTick()).toBe(true);

  b.ingest.drainNow();

  expect(b.ingest.pendingRows()).toBe(0);
  expect(b.filas()).toBe(900);
  expect(b.hayTick()).toBe(false);
  b.cerrar();
});

/** Un repo cuya transacción no abre nunca: la base trabada, el peor caso. */
function repoTrabado(rota: () => boolean) {
  return (base: Repo): Repo => ({
    ...base,
    tx<T>(fn: () => T): T {
      // Falla la transacción ENTERA, no un ítem: un ítem que explota lo absorbe
      // el try de la vuelta y la cola igual avanza.
      if (rota()) throw new Error("database is locked");
      return base.tx(fn);
    },
  });
}

test("una condición de error persistente no produce busy-loop: reintentos espaciados y con tope", () => {
  const eventos: string[] = [];
  const b = banco({
    repo: repoTrabado(() => true),
    log: (base) => ({
      ...base,
      error(ev, f) {
        eventos.push(ev);
        base.error(ev, f);
      },
    }),
  });

  b.ingest.push(lote(sintéticos(10)));
  const vueltas = b.drenar().length;

  // Un puñado de vueltas, no miles (el `drenar()` del banco corta a las 5.000).
  expect(vueltas).toBe(MAX_REINTENTOS_TRABADO + 1);
  // Y ninguna fue inmediata salvo la del `push`: las demás se agendaron a 250 ms
  // (20 × 250 ms ≈ 5 s de insistencia), que es lo que descarta el 100% de CPU.
  expect(b.esperas).toEqual([0, ...Array(MAX_REINTENTOS_TRABADO).fill(MS_REINTENTO_TRABADO)]);
  // Al agotar el tope se suelta la cola, pero queda constancia en el log.
  expect(eventos).toContain("ingest.drenado_trabado");
  expect(b.hayTick()).toBe(false);
  expect(b.ingest.pendingRows()).toBe(10);
  expect(b.filas()).toBe(0);
  b.cerrar();
});

test("después de una vuelta fallida la cola se reintenta sola, sin un push nuevo", () => {
  let rota = true;
  const b = banco({ repo: repoTrabado(() => rota) });

  b.ingest.push(lote(sintéticos(5)));
  b.correrUna();

  // La vuelta no aplicó nada y la cola sigue entera…
  expect(b.filas()).toBe(0);
  expect(b.ingest.pendingRows()).toBe(5);
  // …pero quedó una vuelta agendada SIN que nadie haya vuelto a hacer push: sin
  // esto el `⟳ sincronizando… 5` del encabezado se queda pegado para siempre.
  expect(b.hayTick()).toBe(true);
  expect(b.esperas.at(-1)).toBe(MS_REINTENTO_TRABADO);

  // Se cura la base y el reintento drena solo, sin ningún evento nuevo.
  rota = false;
  b.drenar();
  expect(b.filas()).toBe(5);
  expect(b.ingest.pendingRows()).toBe(0);
  b.cerrar();
});

test("la cola llena descarta el historial más viejo y nunca lo que llegó en vivo", () => {
  const b = banco();
  // Se llena SIN drenar: la cola queda al tope con historial y un notify en el
  // medio, que es el que no se puede perder.
  for (let i = 0; i < MAX_QUEUE_JOBS; i++) {
    b.ingest.push(lote(sintéticos(1, { prefijo: `H${i}_` }), "history"));
    if (i === 10) b.ingest.push(lote(sintéticos(1, { prefijo: "VIVO_" }), "notify"));
  }
  const antes = b.ingest.pendingRows();

  // Con la cola al tope, cada push nuevo descarta un historial viejo.
  for (let i = 0; i < 5; i++) b.ingest.push(lote(sintéticos(1, { prefijo: `N${i}_` }), "notify"));
  expect(b.ingest.pendingRows()).toBe(antes); // entraron 5, se fueron 5

  b.drenar();

  const filas = b.repo.lastMessages(JID_CONTACTO, MAX_QUEUE_JOBS + 10);
  const ids = new Set(filas.map((m) => m.waId));
  // Lo que llegó en vivo está entero: el notify del medio y los cinco últimos.
  expect(ids.has("VIVO_0")).toBe(true);
  for (let i = 0; i < 5; i++) expect(ids.has(`N${i}_0`)).toBe(true);
  // Lo descartado es historial, y el más viejo primero: se fueron seis (uno al
  // llenarse la cola y uno por cada push posterior).
  for (let i = 0; i < 6; i++) expect(ids.has(`H${i}_0`)).toBe(false);
  expect(ids.has("H6_0")).toBe(true);
  expect(filas.length).toBe(antes);
  b.cerrar();
});

// ── notificación al store (§6.2, CA-4.3) ────────────────────────────────────

test("marca inbox siempre y convo sólo cuando el chat que cambió es el abierto (§6.2)", () => {
  const b = banco();

  b.ingest.push(lote(sintéticos(2)));
  b.drenar();
  expect(b.marcados).toEqual([["inbox"]]);

  b.store.setOpenChat(JID_CONTACTO);
  b.marcados.length = 0;
  b.ingest.push(lote(sintéticos(2, { prefijo: "ABIERTO" })));
  b.drenar();
  expect(b.marcados).toEqual([["inbox", "convo"]]);

  // Una ráfaga de 300 mensajes avisa UNA vez por vuelta, no una por mensaje
  // (RNF-5, D3): con 300 avisos el store agendaría 300 flush.
  b.marcados.length = 0;
  b.ingest.push(lote(sintéticos(300, { prefijo: "RAFAGA" })));
  const vueltas = b.drenar().length;
  expect(b.marcados.length).toBe(vueltas);
  expect(vueltas).toBeLessThan(10);
  b.cerrar();
});

test("la bandeja proyectada refleja el mensaje entrante sin refrescar a mano (CA-4.3)", () => {
  const b = banco();
  b.ingest.push(lote([textoPlano]));
  b.drenar();
  b.store.flushNow();

  const inbox = b.store.getSnapshot("inbox");
  expect(inbox.counts).toEqual({ all: 1, unread: 1, groups: 0 });
  expect(inbox.chats[0]!.jid).toBe(JID_CONTACTO);
  expect(inbox.chats[0]!.lastPreview).toBe("hola, ¿cómo va?");
  b.cerrar();
});

test("los contactos van a su tabla y no crean chats fantasma", () => {
  const b = banco();
  b.ingest.push({
    kind: "contacts",
    contacts: [
      { id: JID_CONTACTO, name: "Ana Gómez", phoneNumber: "5491133445566" },
      { id: SELF_JID, notify: "Gon" },
    ],
  });
  b.drenar();

  expect(b.repo.listChats().length).toBe(0);
  const fila = b.store
    .getSnapshot("inbox")
    .chats.find((c) => c.jid === JID_CONTACTO);
  expect(fila).toBeUndefined();
  expect(b.repo.getChat(SELF_JID_NORMALIZADO)).toBeNull();
  b.cerrar();
});
