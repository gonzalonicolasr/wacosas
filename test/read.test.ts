// Tests de marcar como leído y recibos de lectura (tarea 15): CA-10.1, CA-11.1
// a CA-11.7 y CA-14.3.
//
// ⚠️ **NADA de esto toca la cuenta real de WhatsApp.** Un recibo de lectura es la
// única acción de este proyecto —además de enviar— que la otra persona VE en su
// teléfono, así que en todo el archivo `readMessages` es un doble que anota las
// claves y no manda nada. Las aserciones importantes son NEGATIVAS ("con los
// recibos apagados no salió ni una llamada"), y cada una va con su control
// positivo: "no se llamó" no significa nada si con la bandera prendida tampoco
// se llamaba.
//
// Cómo está armado:
//
//   · **La base es real** (`:memory:`, salvo el test de reinicio que usa un
//     archivo): los contadores se afirman leyendo la base, no un mock.
//   · **El reloj y el agendador son virtuales** (mismo criterio que
//     `send.test.ts`): el store publica sus snapshots cuando el test lo pide.
//   · **El ingest es el de verdad**: los mensajes entrantes y el sync de
//     historial entran por donde entran en vivo.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WAMessage, WAMessageKey } from "baileys";

import type { Fields, Logger } from "../src/boot/log";
import { openDb } from "../src/db/open";
import { createRepo, type Repo } from "../src/db/repo";
import { commands, configureCommands, type CommandDeps } from "../src/state/commands";
import { createStore, type Store } from "../src/state/store";
import { createIngest, type Ingest } from "../src/wa/ingest";
import { createReadReceipts, MAX_CLAVES_RECIBO, type ReadReceipts } from "../src/wa/read";

const ANTO = "549115000001@s.whatsapp.net";
const GRUPO = "120000999-1600000000@g.us";
const MELI = "549116000002@s.whatsapp.net";
const SELF = "5491133445566:12@s.whatsapp.net";

const tmp = mkdtempSync(join(tmpdir(), "wacosas-read-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// ── arnés ───────────────────────────────────────────────────────────────────

type Linea = { nivel: string; ev: string; f: Fields };

type Arnes = {
  repo: Repo;
  store: Store;
  read: ReadReceipts;
  ingest: Ingest;
  /** Cada llamada a `readMessages`, con las claves tal cual salieron. */
  llamadas: WAMessageKey[][];
  lineas: Linea[];
  /** La conexión que ven los recibos (`wa.isOpen()`). */
  abierta: { valor: boolean };
  /** Lo que `readMessages` hace: `null` = anda bien. */
  falla: { modo: null | "lanza" | "rechaza" };
  /** El contador de no leídos que hay AHORA en la base. */
  sinLeer(jid: string): number;
  /** El `last_read_id` que hay AHORA en la base. */
  leidoHasta(jid: string): number;
  /**
   * Corre el flush del store, que es lo que refresca el snapshot de la bandeja.
   * Hace falta porque `getSnapshot` está CACHEADO hasta el próximo flush (D3) y
   * los comandos que resuelven la selección (`markSelectedRead`) leen de ahí.
   */
  publicar(): void;
};

function armar(opts: { recibos?: boolean; db?: string } = {}): Arnes {
  const repo = createRepo(openDb(opts.db ?? ":memory:"));
  repo.upsertChat({ jid: ANTO, name: "anto 🌻" });
  repo.upsertChat({ jid: GRUPO, name: "Grupo mañana", isGroup: true });

  const lineas: Linea[] = [];
  const anotar =
    (nivel: string) =>
    (ev: string, f: Fields = {}) => {
      lineas.push({ nivel, ev, f });
    };
  const log: Logger = {
    info: anotar("info"),
    warn: anotar("warn"),
    error: anotar("error"),
    path: "/tmp/wacosas-test.log",
  };

  const llamadas: WAMessageKey[][] = [];
  const abierta = { valor: true };
  const falla: Arnes["falla"] = { modo: null };
  const sock = {
    async readMessages(keys: WAMessageKey[]) {
      // Se anota SIEMPRE, incluso cuando después falla: lo que se está midiendo
      // es si la llamada existió (CA-11.3), no si salió bien.
      llamadas.push(keys);
      if (falla.modo === "lanza") throw new Error("el socket ya no está");
      if (falla.modo === "rechaza") return Promise.reject(new Error("timeout del socket"));
      return undefined;
    },
  };

  // Agendador manual: el flush del store corre cuando el test lo pide, nunca
  // solo. Un agendador que ejecutara en el acto además rompería el store —
  // `flush` limpia `cancelarFlush` y el `markDirty` que lo llamó se lo vuelve a
  // escribir después, dejándolo colgado para siempre—.
  const timers: Array<() => void> = [];
  const store = createStore({
    now: () => 1_700_000_000_000,
    schedule: (fn) => {
      timers.push(fn);
      return () => {
        const i = timers.indexOf(fn);
        if (i >= 0) timers.splice(i, 1);
      };
    },
  });
  // Sin esto el store no tiene base y las proyecciones salen vacías: es lo que
  // hace el entry antes del primer frame (CA-13.1).
  store.bootstrap(repo);

  const read = createReadReceipts({
    repo,
    log,
    wa: {
      isOpen: () => abierta.valor,
      socket: () => (abierta.valor ? (sock as never) : null),
    },
    enabled: opts.recibos ?? true,
  });
  const ingest = createIngest({
    repo,
    store,
    log,
    selfJid: () => SELF,
    openChatJid: () => store.openChatJid(),
    pushReadReceipt: read.pushReadReceipt,
  });

  configureCommands({
    repo,
    wa: {} as CommandDeps["wa"],
    store,
    log,
    read,
    shutdown() {},
  });

  return {
    repo,
    store,
    read,
    ingest,
    llamadas,
    lineas,
    abierta,
    falla,
    sinLeer: (jid) => repo.getChat(jid)?.unreadCount ?? -1,
    leidoHasta: (jid) => repo.getChat(jid)?.lastReadId ?? -1,
    publicar() {
      for (let i = 0; i < 20 && timers.length > 0; i++) (timers.shift() as () => void)();
    },
  };
}

/** Un mensaje entrante con la forma real de un `WAMessage`. */
function entrante(jid: string, id: string, texto: string, participant?: string): WAMessage {
  return {
    key: { remoteJid: jid, fromMe: false, id, ...(participant ? { participant } : {}) },
    message: { conversation: texto },
    messageTimestamp: 1_700_000_000,
    pushName: "anto 🌻",
  } as WAMessage;
}

/** Mete `n` mensajes entrantes SIN chat abierto: quedan sin leer (CA-10.1). */
function llegan(a: Arnes, jid: string, n: number, desde = 1, participant?: string): void {
  a.ingest.push({
    kind: "messages",
    msgs: Array.from({ length: n }, (_, i) => entrante(jid, `IN${desde + i}`, `hola ${desde + i}`, participant)),
    source: "notify",
  });
  a.ingest.drainNow();
}

/** Deja correr los microtasks/macrotasks reales que el recibo tenga en vuelo. */
async function asentar(vueltas = 4): Promise<void> {
  for (let i = 0; i < vueltas; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Los ids de WhatsApp de la última llamada a `readMessages`. */
function idsDelRecibo(a: Arnes, i = 0): string[] {
  return (a.llamadas[i] ?? []).map((k) => String(k.id));
}

// ── CA-11.3: con los recibos apagados no sale NADA ───────────────────────────

describe("recibos deshabilitados (CA-11.3)", () => {
  test("cero llamadas a readMessages, y el chat queda leído igual", () => {
    const a = armar({ recibos: false });
    llegan(a, ANTO, 3);
    expect(a.sinLeer(ANTO)).toBe(3);

    commands.markRead(ANTO);

    // Lo local pasó igual: el contador en 0 y el tope de lectura movido.
    expect(a.sinLeer(ANTO)).toBe(0);
    expect(a.leidoHasta(ANTO)).toBeGreaterThan(0);
    // Y a WhatsApp no le llegó nada. Esto es lo que la otra persona NO ve.
    expect(a.llamadas.length).toBe(0);
  });

  test("tampoco por el chat abierto, que es el otro camino (CA-11.7)", () => {
    const a = armar({ recibos: false });
    commands.openChat(ANTO);
    llegan(a, ANTO, 2);
    expect(a.sinLeer(ANTO)).toBe(0);
    expect(a.llamadas.length).toBe(0);
  });

  test("control positivo: el MISMO camino con la bandera prendida sí llama", () => {
    const a = armar({ recibos: true });
    llegan(a, ANTO, 3);
    commands.markRead(ANTO);
    expect(a.llamadas.length).toBe(1);
  });
});

// ── CA-11.1 / CA-11.2: abrir un chat ─────────────────────────────────────────

describe("marcar leído con recibo (CA-11.1, CA-11.2)", () => {
  test("una sola llamada, con las claves desde `last_read_id`", () => {
    const a = armar();
    llegan(a, ANTO, 5);
    // Ya se habían leído los dos primeros: el recibo NO los repite.
    const filas = a.repo.lastMessages(ANTO, 10);
    a.repo.clearUnread(ANTO, filas[1]!.id);
    a.repo.setUnread(ANTO, 3);

    commands.openChat(ANTO);

    expect(a.sinLeer(ANTO)).toBe(0);
    expect(a.llamadas.length).toBe(1);
    expect(idsDelRecibo(a)).toEqual(["IN3", "IN4", "IN5"]);
  });

  test("los mensajes PROPIOS no van en el recibo", () => {
    const a = armar();
    llegan(a, ANTO, 1);
    a.repo.insertMessage({
      chatJid: ANTO,
      waId: "MIO1",
      fromMe: true,
      senderJid: SELF,
      senderName: "",
      ts: 1_700_000_050,
      kind: "text",
      body: "yo también",
      attachment: null,
      status: "sent",
    });
    llegan(a, ANTO, 1, 2);

    commands.markRead(ANTO);
    expect(idsDelRecibo(a)).toEqual(["IN1", "IN2"]);
  });

  test("en un grupo la clave lleva `participant`; en un 1:1 no", () => {
    const a = armar();
    llegan(a, GRUPO, 1, 1, MELI);
    llegan(a, ANTO, 1, 9);

    commands.markRead(GRUPO);
    commands.markRead(ANTO);

    expect(a.llamadas[0]).toEqual([
      { remoteJid: GRUPO, id: "IN1", fromMe: false, participant: MELI },
    ]);
    expect(a.llamadas[1]).toEqual([{ remoteJid: ANTO, id: "IN9", fromMe: false }]);
  });

  test("sin nada sin leer no se manda ningún recibo", () => {
    const a = armar();
    llegan(a, ANTO, 2);
    commands.markRead(ANTO);
    expect(a.llamadas.length).toBe(1);
    // Segunda pasada: el contador ya está en 0, no hay nada que acusar. Sin esta
    // guarda, cada vez que se abre un chat viejo salen 200 claves de mensajes
    // que el otro ya vio en azul (R8).
    commands.markRead(ANTO);
    expect(a.llamadas.length).toBe(1);
  });

  test("el recibo se acota a MAX_CLAVES_RECIBO", () => {
    const a = armar();
    llegan(a, ANTO, MAX_CLAVES_RECIBO + 25);
    commands.markRead(ANTO);
    expect(a.llamadas.length).toBe(1);
    expect(idsDelRecibo(a).length).toBe(MAX_CLAVES_RECIBO);
    // Y son los MÁS NUEVOS: el tilde azul lo dispara el último mensaje.
    expect(idsDelRecibo(a).at(-1)).toBe(`IN${MAX_CLAVES_RECIBO + 25}`);
  });
});

// ── CA-11.4: el recibo es best effort ────────────────────────────────────────

describe("el recibo falla (CA-11.4)", () => {
  test("un readMessages que LANZA deja el chat leído y una línea en el log", async () => {
    const a = armar();
    a.falla.modo = "lanza";
    llegan(a, ANTO, 4);

    commands.markRead(ANTO);

    // Lo local NO espera a la red: ya está hecho al volver de la llamada.
    expect(a.sinLeer(ANTO)).toBe(0);
    expect(a.leidoHasta(ANTO)).toBeGreaterThan(0);

    await asentar();
    const fallo = a.lineas.filter((l) => l.ev === "read.recibo_fallido");
    expect(fallo.length).toBe(1);
    expect(String(fallo[0]!.f.motivo)).toContain("el socket ya no está");
  });

  test("un readMessages que RECHAZA hace lo mismo (la promesa no se pierde)", async () => {
    const a = armar();
    a.falla.modo = "rechaza";
    llegan(a, ANTO, 4);

    commands.markRead(ANTO);
    await asentar();

    expect(a.sinLeer(ANTO)).toBe(0);
    const fallo = a.lineas.filter((l) => l.ev === "read.recibo_fallido");
    expect(fallo.length).toBe(1);
    expect(String(fallo[0]!.f.motivo)).toContain("timeout del socket");
  });

  test("un recibo que SALE BIEN deja su línea y no rompe nada", async () => {
    const a = armar();
    llegan(a, ANTO, 2);
    commands.markRead(ANTO);
    await asentar();
    const ok = a.lineas.filter((l) => l.ev === "read.recibo");
    expect(ok.length).toBe(1);
    expect(ok[0]!.f).toEqual({ claves: 2, chat_grupo: false });
  });

  test("sin conexión no se manda ni se encola, y el chat queda leído", () => {
    const a = armar();
    llegan(a, ANTO, 2);
    a.abierta.valor = false;

    commands.markRead(ANTO);

    expect(a.sinLeer(ANTO)).toBe(0);
    expect(a.llamadas.length).toBe(0);
    expect(a.lineas.some((l) => l.ev === "read.sin_conexion")).toBe(true);

    // Y al volver la conexión NO sale el recibo atrasado: el `last_read_id`
    // local ya refleja la verdad y un recibo diferido miente sobre CUÁNDO se
    // leyó (§8.5).
    a.abierta.valor = true;
    commands.markRead(ANTO);
    expect(a.llamadas.length).toBe(0);
  });
});

// ── CA-11.5: `Ctrl-L`, sin abrir el chat ─────────────────────────────────────

describe("Ctrl-L sobre la bandeja (CA-11.5)", () => {
  test("pone el contador en 0 y manda el recibo SIN abrir el chat", () => {
    const a = armar();
    llegan(a, ANTO, 3);
    a.publicar();
    commands.selectChat(ANTO);

    commands.markSelectedRead();

    expect(a.sinLeer(ANTO)).toBe(0);
    expect(a.llamadas.length).toBe(1);
    expect(idsDelRecibo(a)).toEqual(["IN1", "IN2", "IN3"]);
    // Lo que lo distingue de `openChat`: no hay conversación abierta.
    expect(a.store.openChatJid()).toBe(null);
  });

  test("sin selección no hace nada", () => {
    const a = armar();
    llegan(a, ANTO, 3);
    a.publicar();
    // La bandeja arranca con el primer chat de la lista seleccionado, así que
    // para "sin selección" hay que filtrar hasta que no quede ninguno.
    commands.setInboxQuery("no existe ningún chat así");

    commands.markSelectedRead();

    expect(a.sinLeer(ANTO)).toBe(3);
    expect(a.llamadas.length).toBe(0);
  });
});

// ── CA-11.6: otro dispositivo ────────────────────────────────────────────────

describe("otro dispositivo marca leído (CA-11.6)", () => {
  test("un `chats.update` con unreadCount 0 pone el contador local en 0", () => {
    const a = armar();
    llegan(a, ANTO, 4);
    expect(a.sinLeer(ANTO)).toBe(4);

    a.ingest.push({ kind: "chat-updates", updates: [{ id: ANTO, unreadCount: 0 }] });
    a.ingest.drainNow();

    expect(a.sinLeer(ANTO)).toBe(0);
    // Y NO se le manda un recibo a WhatsApp: el otro dispositivo ya lo mandó.
    expect(a.llamadas.length).toBe(0);
  });

  test("un unreadCount POSITIVO es un delta y NO se toma como absoluto", () => {
    const a = armar();
    llegan(a, ANTO, 4);
    // `Utils/process-message.js:196` emite `unreadCount: 1` POR MENSAJE, y
    // `event-buffer.js:613` los suma al mergear: tomarlo como absoluto dejaría
    // el contador en 1 con cuatro mensajes sin leer.
    a.ingest.push({ kind: "chat-updates", updates: [{ id: ANTO, unreadCount: 1 }] });
    a.ingest.drainNow();
    expect(a.sinLeer(ANTO)).toBe(4);
  });
});

// ── CA-11.7: el chat abierto se queda en 0 ───────────────────────────────────

describe("chat abierto (CA-11.7)", () => {
  test("los mensajes que entran no suman, y sale UN recibo por vuelta", () => {
    const a = armar();
    commands.openChat(ANTO);
    // Abrir un chat sin no leídos no manda nada: lo que se mide abajo es el
    // recibo de los mensajes NUEVOS.
    expect(a.llamadas.length).toBe(0);

    llegan(a, ANTO, 3);

    expect(a.sinLeer(ANTO)).toBe(0);
    // Una sola llamada con las tres claves, no tres llamadas de una clave: el
    // recibo se junta y sale al cerrar la transacción de la vuelta (§6.2).
    expect(a.llamadas.length).toBe(1);
    expect(idsDelRecibo(a)).toEqual(["IN1", "IN2", "IN3"]);
    // Y el tope de lectura avanzó, así que un `markRead` posterior no los repite.
    commands.markRead(ANTO);
    expect(a.llamadas.length).toBe(1);
  });

  test("un mensaje al chat que NO está abierto suma y no manda recibo (CA-10.1)", () => {
    const a = armar();
    commands.openChat(ANTO);
    llegan(a, GRUPO, 2, 1, MELI);

    expect(a.sinLeer(GRUPO)).toBe(2);
    expect(a.llamadas.length).toBe(0);
  });

  test("el sync de historial NO deja el chat abierto con no leídos", () => {
    const a = armar();
    commands.openChat(ANTO);

    // Así llega el sync: los mensajes por un lado (sin sumar de a uno) y la
    // ficha del chat con el contador ABSOLUTO del servidor por el otro. El
    // servidor no sabe que lo estás mirando: sin la guarda de CA-11.7 el chat
    // abierto quedaba en 7.
    a.ingest.push({
      kind: "messages",
      msgs: Array.from({ length: 7 }, (_, i) => entrante(ANTO, `H${i}`, `viejo ${i}`)),
      source: "history",
    });
    a.ingest.push({ kind: "chats", chats: [{ id: ANTO, unreadCount: 7 }] as never });
    a.ingest.drainNow();

    expect(a.sinLeer(ANTO)).toBe(0);
    // Y no se le acusa recibo a nada del historial: son mensajes viejos y el
    // recibo le diría al otro que los leíste recién ahora.
    expect(a.llamadas.length).toBe(0);
  });

  test("el mismo sync sobre un chat CERRADO sí trae su contador absoluto", () => {
    const a = armar();
    commands.openChat(ANTO);
    a.ingest.push({ kind: "chats", chats: [{ id: GRUPO, unreadCount: 7 }] as never });
    a.ingest.drainNow();
    expect(a.sinLeer(GRUPO)).toBe(7);
  });
});

// ── CA-14.3: los contadores sobreviven al reinicio ───────────────────────────

test("reiniciar el proceso deja los contadores como estaban (CA-14.3)", () => {
  const ruta = join(tmp, "reinicio.sqlite");

  const a = armar({ db: ruta });
  llegan(a, ANTO, 5);
  llegan(a, GRUPO, 2, 1, MELI);
  commands.markRead(GRUPO);
  const antes = {
    anto: a.sinLeer(ANTO),
    grupo: a.sinLeer(GRUPO),
    tope: a.leidoHasta(GRUPO),
  };
  expect(antes).toEqual({ anto: 5, grupo: 0, tope: expect.any(Number) });
  expect(antes.tope).toBeGreaterThan(0);
  a.repo.close();

  // Otro proceso: la misma base, todo de cero (esto es lo que hace `bootstrap`
  // antes del primer frame, CA-10.5).
  const b = armar({ db: ruta });
  expect(b.sinLeer(ANTO)).toBe(antes.anto);
  expect(b.sinLeer(GRUPO)).toBe(antes.grupo);
  expect(b.leidoHasta(GRUPO)).toBe(antes.tope);
  // Y el recibo tampoco se repite al arrancar: lo que ya se acusó quedó
  // guardado en `last_read_id`.
  commands.markRead(GRUPO);
  expect(b.llamadas.length).toBe(0);
  b.repo.close();
});
