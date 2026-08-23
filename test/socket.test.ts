// Tests del ciclo de vida del socket (design §5.6, §6.1, D5, D6): la máquina de
// cierre (CA-1.4, CA-1.8, CA-3.1, CA-15.2), el guard del socket viejo (CA-3.3,
// CA-15.6), el "nunca dos sockets" (CA-15.7, RNF-11), el reset del backoff al
// emitir un QR y el QR durante una reconexión (CA-3.4).
//
// Cómo está armado y por qué:
//
//   · **`makeWASocket` se inyecta.** El doble es un `EventEmitter` con la misma
//     superficie que usa el controlador (`ev`, `end`, `user`,
//     `requestPairingCode`), así que el test puede emitir cierres con el código
//     que quiera sin red ni cuenta de WhatsApp.
//   · **El agendador también** (mismo criterio que `state/store.ts` y
//     `wa/ingest.ts`): backoff, cooldown del wipe y tope de la versión pasan
//     todos por ahí, así que el test controla el tiempo y no espera ni un ms.
//   · **La base, el ingest, el store, el logger y el directorio de creds son
//     REALES.** "Un socket viejo no escribe nada" sólo significa algo si hay
//     dónde escribir: se mide contando filas en la base y mirando si
//     `creds.json` reaparece en disco. Cada aserción negativa va con su control
//     positivo (el socket VIGENTE sí escribe), porque una prueba que no puede
//     fallar no prueba nada.
import { afterAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Browsers } from "baileys";
import type { BaileysEventMap, UserFacingSocketConfig, WAMessage, WASocket, WAVersion } from "baileys";

import { createLogger } from "../src/boot/log";
import { openDb } from "../src/db/open";
import { createRepo } from "../src/db/repo";
import { RECONNECT_MAX_MS } from "../src/lib/backoff";
import { createStore } from "../src/state/store";
import { createIngest, type Ingest, type IngestJob } from "../src/wa/ingest";
import {
  COOLDOWN_WIPE_MS,
  createWaController,
  decideOnClose,
  MOTIVO_BAD_SESSION,
  MOTIVO_CONEXION_REEMPLAZADA,
  MOTIVO_CUENTA_RECHAZADA,
  MOTIVO_LOGGED_OUT,
  MOTIVO_QR_EN_RECONEXION,
  MOTIVO_VERSION,
  motivoWipeFallido,
  VERSION_TIMEOUT_MS,
  type WaController,
} from "../src/wa/socket";
import { JID_CONTACTO, SELF_JID } from "./fixtures/messages";

const tmp = mkdtempSync(join(tmpdir(), "wacosas-socket-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const VERSION: WAVersion = [2, 3000, 1_023_000];
const QR_FALSO = "2@abcdefghijklmnopqrstuvwxyz,ABCDEFGHIJKLMNOP=,ZYXWVUTSRQPONMLK=,1";

// ── agendador manual ────────────────────────────────────────────────────────

/**
 * Reemplaza a `setTimeout`. Multi-timer (a diferencia del de `ingest.test.ts`)
 * porque acá conviven dos: el tope de la versión y el backoff.
 */
function agendadorManual() {
  let id = 0;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  return {
    schedule(fn: () => void, ms: number) {
      const k = ++id;
      timers.set(k, { fn, ms });
      return () => {
        timers.delete(k);
      };
    },
    /** Los ms de los timers VIVOS, en orden de creación. */
    esperas: (): number[] => [...timers.values()].map((t) => t.ms),
    pendientes: (): number => timers.size,
    /** Dispara el timer más viejo. Devuelve `false` si no había ninguno. */
    correr(): boolean {
      const k = timers.keys().next().value;
      if (k === undefined) return false;
      const t = timers.get(k)!;
      timers.delete(k);
      t.fn();
      return true;
    },
  };
}

/** Deja correr los microtasks/macrotasks que el controlador tenga en vuelo. */
async function asentar(vueltas = 8): Promise<void> {
  for (let i = 0; i < vueltas; i++) await new Promise((r) => setTimeout(r, 0));
}

// ── doble de socket ─────────────────────────────────────────────────────────

type Falso = {
  cfg: UserFacingSocketConfig;
  ev: {
    on<T extends keyof BaileysEventMap>(e: T, l: (a: BaileysEventMap[T]) => void): void;
    off<T extends keyof BaileysEventMap>(e: T, l: (a: BaileysEventMap[T]) => void): void;
    removeAllListeners<T extends keyof BaileysEventMap>(e: T): void;
    emit<T extends keyof BaileysEventMap>(e: T, a: BaileysEventMap[T]): boolean;
  };
  end(err?: Error): Promise<void>;
  user?: { id: string };
  requestPairingCode(phone: string): Promise<string>;
  /** `end()` ya corrió: el socket está muerto. */
  terminado: boolean;
  /** Emite como si viniera de WhatsApp. */
  emitir<T extends keyof BaileysEventMap>(e: T, a: BaileysEventMap[T]): void;
  /** Handlers todavía enganchados a ese evento. */
  oyentes(e: keyof BaileysEventMap): number;
  /** Teléfonos que pidieron código de emparejamiento. */
  pairing: string[];
};

function falso(cfg: UserFacingSocketConfig): Falso {
  const em = new EventEmitter();
  const f: Falso = {
    cfg,
    ev: {
      on: (e, l) => void em.on(e, l as (a: unknown) => void),
      off: (e, l) => void em.off(e, l as (a: unknown) => void),
      removeAllListeners: (e) => void em.removeAllListeners(e),
      emit: (e, a) => em.emit(e, a),
    },
    async end() {
      f.terminado = true;
    },
    async requestPairingCode(phone: string) {
      f.pairing.push(phone);
      return "WACO5432";
    },
    terminado: false,
    emitir: (e, a) => void em.emit(e, a),
    oyentes: (e) => em.listenerCount(e),
    pairing: [],
  };
  return f;
}

/** Un cierre con el código que WhatsApp manda adentro de un Boom. */
function cierre(code: number | null): Partial<BaileysEventMap["connection.update"]> {
  const error =
    code === null ? new Error("se cayó el ws") : Object.assign(new Error(`close ${code}`), { output: { statusCode: code } });
  return { connection: "close", lastDisconnect: { error: error as Error, date: new Date() } };
}

/** Un mensaje entrante con la forma real de un `WAMessage`. */
function msg(id: string): WAMessage {
  return {
    key: { remoteJid: JID_CONTACTO, fromMe: false, id },
    message: { conversation: "hola desde el test" },
    messageTimestamp: 1_735_686_000,
    pushName: "Ana Gómez",
  };
}

const upsert = (m: WAMessage): BaileysEventMap["messages.upsert"] => ({ messages: [m], type: "notify" });

// ── banco de pruebas ────────────────────────────────────────────────────────

let nBanco = 0;

function banco(
  opts: {
    /** Sembrar `creds.json` con `registered:true` ⇒ el flujo arranca en `reconnect`. */
    vinculado?: boolean;
    version?: () => Promise<{ version: WAVersion; isLatest: boolean; error?: unknown }>;
    /** Envuelve la cola real (para romperla a propósito). */
    ingest?: (real: Ingest) => Ingest;
  } = {},
) {
  const dir = mkdtempSync(join(tmp, `banco-${nBanco++}-`));
  const credsDir = join(dir, "creds");
  const archivoCreds = join(credsDir, "creds.json");
  if (opts.vinculado) {
    mkdirSync(credsDir, { recursive: true, mode: 0o700 });
    writeFileSync(archivoCreds, JSON.stringify({ registered: true }), { mode: 0o600 });
  }

  const logPath = join(dir, "wa.log");
  const db = openDb(join(dir, "wa.sqlite"));
  const repo = createRepo(db);
  const log = createLogger(logPath);
  // El store con un agendador que nunca dispara: acá no se mide el coalescing
  // (eso es `store.test.ts`); los snapshots se leen con `getSnapshot`, que
  // reconstruye igual porque los slices `conn`/`link` se marcan sucios.
  const store = createStore({ schedule: () => () => {} });
  store.bootstrap(repo);

  let wa: WaController;
  const ingestReal = createIngest({
    repo,
    store,
    log,
    selfJid: () => wa?.selfJid() ?? "",
    openChatJid: () => store.openChatJid(),
    schedule: () => () => {}, // se drena a mano con `drainNow()`
  });
  const jobs: IngestJob[] = [];
  const espia: Ingest = {
    push: (j) => {
      jobs.push(j);
      ingestReal.push(j);
    },
    drainNow: () => ingestReal.drainNow(),
    pendingRows: () => ingestReal.pendingRows(),
  };
  const ingest = opts.ingest ? opts.ingest(espia) : espia;

  const creados: Falso[] = [];
  /** Veces que se creó un socket habiendo otro vivo. Tiene que quedar en 0. */
  let violaciones = 0;
  const agenda = agendadorManual();
  let reloj = 1_700_000_000_000;

  wa = createWaController({
    ingest,
    store,
    log,
    credsDir,
    now: () => reloj,
    schedule: agenda.schedule,
    makeSocket: (cfg) => {
      if (creados.some((f) => !f.terminado)) violaciones++;
      const f = falso(cfg);
      creados.push(f);
      return f as unknown as WASocket;
    },
    fetchVersion: opts.version ?? (async () => ({ version: VERSION, isLatest: true })),
  });

  const contar = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM messages");

  return {
    wa,
    store,
    agenda,
    creados,
    jobs,
    credsDir,
    archivoCreds,
    // `flushNow()` antes de leer: el snapshot está cacheado hasta el próximo
    // flush (requisito de `useSyncExternalStore`) y acá el agendador del store
    // no dispara nunca, así que sin esto se leería siempre el del bootstrap.
    conn: () => {
      store.flushNow();
      return store.getSnapshot("conn");
    },
    link: () => {
      store.flushNow();
      return store.getSnapshot("link");
    },
    vivos: () => creados.filter((f) => !f.terminado),
    ultimo: () => creados[creados.length - 1]!,
    violaciones: () => violaciones,
    filas: () => contar.get()!.n,
    drenar: () => espia.drainNow(),
    logTexto: () => readFileSync(logPath, "utf8"),
    avanzar: (ms: number) => {
      reloj += ms;
    },
    reloj: () => reloj,
    cerrar: () => {
      store.stop();
      repo.close();
    },
  };
}

type Banco = ReturnType<typeof banco>;

/** Arranca y espera a que el socket exista. */
async function arrancar(b: Banco): Promise<Falso> {
  b.wa.start();
  await asentar();
  return b.ultimo();
}

/** Dispara el timer más viejo (backoff / cooldown) y deja asentar el resultado. */
async function correrTimer(b: Banco): Promise<void> {
  b.agenda.correr();
  await asentar();
}

// ── decideOnClose (pura) ────────────────────────────────────────────────────

test("decideOnClose: 401 loggedOut ⇒ borrar creds y volver a vincular", () => {
  const a = decideOnClose(401, { attempt: 3, sawQr: true });
  expect(a.kind).toBe("wipe");
  expect(a).toMatchObject({ reason: MOTIVO_LOGGED_OUT });
});

test("decideOnClose: 500 badSession ⇒ borrar creds y volver a vincular", () => {
  const a = decideOnClose(500, { attempt: 0, sawQr: false });
  expect(a.kind).toBe("wipe");
  expect(a).toMatchObject({ reason: MOTIVO_BAD_SESSION });
});

test("decideOnClose: 515 restartRequired ⇒ respawn sin sumar intento", () => {
  const a = decideOnClose(515, { attempt: 4, sawQr: true });
  expect(a).toEqual({ kind: "respawn" });
  // La prueba de que no suma: la acción no trae `attempt` ninguno que aplicar.
  expect(a).not.toHaveProperty("attempt");
});

test("decideOnClose: 405 sin haber visto un QR ⇒ failed por versión desactualizada", () => {
  const a = decideOnClose(405, { attempt: 0, sawQr: false });
  expect(a.kind).toBe("failed");
  expect(a).toMatchObject({ reason: MOTIVO_VERSION });
});

test("decideOnClose: 405 con un QR ya emitido ⇒ la versión no es el problema, reconecta", () => {
  const a = decideOnClose(405, { attempt: 0, sawQr: true });
  expect(a).toEqual({ kind: "reconnect", attempt: 1, delayMs: 2_000 });
});

test("decideOnClose: 440 connectionReplaced ⇒ halt (no es un corte, es un desalojo)", () => {
  const a = decideOnClose(440, { attempt: 0, sawQr: true });
  expect(a.kind).toBe("halt");
  expect(a).toMatchObject({ reason: MOTIVO_CONEXION_REEMPLAZADA });
  // Ni con el contador alto se convierte en un reintento: reconectar echa al otro
  // cliente, que reconecta y nos echa a nosotros (ping-pong con las dos puntas rotas).
  expect(decideOnClose(440, { attempt: 7, sawQr: false }).kind).toBe("halt");
});

test("decideOnClose: 403 forbidden ⇒ halt con su propio motivo", () => {
  const a = decideOnClose(403, { attempt: 2, sawQr: true });
  expect(a.kind).toBe("halt");
  expect(a).toMatchObject({ reason: MOTIVO_CUENTA_RECHAZADA });
  expect(MOTIVO_CUENTA_RECHAZADA).not.toBe(MOTIVO_CONEXION_REEMPLAZADA);
});

test("decideOnClose: 408 ⇒ reconecta con 2 s (CA-15.2)", () => {
  expect(decideOnClose(408, { attempt: 0, sawQr: false })).toEqual({
    kind: "reconnect",
    attempt: 1,
    delayMs: 2_000,
  });
});

test("decideOnClose: el backoff crece 2/4/8/16/32/60 y ahí se planta", () => {
  const delays = [0, 1, 2, 3, 4, 5, 6, 7].map(
    (attempt) => (decideOnClose(428, { attempt, sawQr: false }) as { delayMs: number }).delayMs,
  );
  expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
  expect(delays.at(-1)).toBe(RECONNECT_MAX_MS);
});

test("decideOnClose: un cierre sin código (ws caído) también reconecta", () => {
  expect(decideOnClose(null, { attempt: 0, sawQr: false }).kind).toBe("reconnect");
  expect(decideOnClose(undefined, { attempt: 1, sawQr: true })).toEqual({
    kind: "reconnect",
    attempt: 2,
    delayMs: 4_000,
  });
});

// ── apertura: versión y opciones no negociables ─────────────────────────────

test("al conectar resuelve la versión de WhatsApp Web y la usa (CA-1.2, RNF-10)", async () => {
  const b = banco();
  const s = await arrancar(b);

  expect(s.cfg.version).toEqual(VERSION);
  expect(b.logTexto()).toContain("wa.version.ok");
  b.cerrar();
});

test("las opciones del socket son las del prior art (§5.6)", async () => {
  const b = banco();
  const { cfg } = await arrancar(b);

  expect(cfg.browser).toEqual(Browsers.ubuntu("Chrome"));
  expect(cfg.markOnlineOnConnect).toBe(false); // CA-15.8
  expect(cfg.syncFullHistory).toBe(false);
  expect(cfg.shouldSyncHistoryMessage?.(undefined as never)).toBe(false);
  expect(cfg.generateHighQualityLinkPreview).toBe(false);
  expect(typeof cfg.getMessage).toBe("function"); // §8.6
  expect(cfg.auth).toBeTruthy();
  // CA-16.2: el logger de baileys no puede escribir NADA en la terminal.
  expect((cfg.logger as { level?: string } | undefined)?.level).toBe("silent");
  b.cerrar();
});

test("si la versión no se puede resolver sigue con la bundleada y lo loguea (CA-1.3)", async () => {
  // `fetchLatestBaileysVersion` NO rechaza cuando falla: devuelve la bundleada
  // con un `error` adentro. Ese es el caso real, y el que se olvida de mirar.
  const b = banco({ version: async () => ({ version: VERSION, isLatest: false, error: new Error("sin red") }) });
  const s = await arrancar(b);

  expect(s.cfg.version).toBeUndefined(); // ⇒ makeWASocket usa la suya
  expect(b.logTexto()).toContain("wa.version.fallback");
  expect(b.logTexto()).not.toContain("wa.version.ok");
  b.cerrar();
});

test("una resolución de versión colgada no deja la vinculación sin QR", async () => {
  // Sin tope, un fetch que nunca contesta deja el proceso mudo para siempre.
  const b = banco({ version: () => new Promise(() => {}) });
  b.wa.start();
  await asentar();

  expect(b.creados.length).toBe(0); // todavía esperando la versión
  expect(b.agenda.esperas()).toContain(VERSION_TIMEOUT_MS);

  await correrTimer(b); // vence el tope
  expect(b.creados.length).toBe(1);
  expect(b.logTexto()).toContain("wa.version.fallback");
  b.cerrar();
});

test("el tope de la versión no queda vivo después de resolverla", async () => {
  const b = banco();
  await arrancar(b);
  // Si el timer del tope no se cancelara, quedaría uno de 8 s colgado y el
  // proceso no podría morir hasta que venciera.
  expect(b.agenda.esperas()).not.toContain(VERSION_TIMEOUT_MS);
  expect(b.agenda.pendientes()).toBe(0);
  b.cerrar();
});

// ── un solo socket ──────────────────────────────────────────────────────────

test("nunca hay dos sockets vivos: ni por arranques repetidos ni por reconexiones (CA-15.7, RNF-11)", async () => {
  const b = banco();

  // Tres `start()` seguidos, el segundo y el tercero en plena ventana async.
  b.wa.start();
  b.wa.start();
  await asentar();
  b.wa.start();
  await asentar();
  expect(b.creados.length).toBe(1);
  expect(b.vivos().length).toBe(1);

  // Un ciclo entero de cierres: transitorio, restart y manual.
  const s1 = b.ultimo();
  s1.emitir("connection.update", cierre(408));
  await asentar();
  expect(b.vivos().length).toBe(0); // el viejo muere ANTES de crear el nuevo
  await correrTimer(b);
  expect(b.vivos().length).toBe(1);

  b.ultimo().emitir("connection.update", cierre(515));
  await asentar();
  expect(b.vivos().length).toBe(0);
  await correrTimer(b);
  expect(b.vivos().length).toBe(1);

  b.wa.reconnectNow();
  await asentar();
  expect(b.vivos().length).toBe(1);

  expect(b.creados.length).toBe(4);
  expect(b.violaciones()).toBe(0);
  b.cerrar();
});

test("descartar un socket lo deja sin handlers y cerrado (D5)", async () => {
  const b = banco();
  const s1 = await arrancar(b);
  expect(s1.oyentes("messages.upsert")).toBe(1);
  expect(s1.oyentes("connection.update")).toBe(1);

  b.wa.reconnectNow();
  await asentar();

  expect(s1.terminado).toBe(true);
  expect(s1.oyentes("messages.upsert")).toBe(0);
  expect(s1.oyentes("connection.update")).toBe(0);
  expect(s1.oyentes("creds.update")).toBe(0);
  b.cerrar();
});

// ── guard del socket viejo (CA-3.3, CA-15.6) ────────────────────────────────

test("un socket viejo no escribe NADA: ni mensajes en la base ni credenciales en disco", async () => {
  const b = banco();
  const viejo = await arrancar(b);

  // Control positivo: el socket VIGENTE sí escribe las dos cosas.
  viejo.emitir("messages.upsert", upsert(msg("VIGENTE-1")));
  b.drenar();
  expect(b.filas()).toBe(1);
  viejo.emitir("creds.update", {});
  await asentar();
  expect(existsSync(b.archivoCreds)).toBe(true);

  // Reemplazo. A partir de acá el viejo no existe para nadie.
  b.wa.reconnectNow();
  await asentar();
  const nuevo = b.ultimo();
  expect(nuevo).not.toBe(viejo);

  // Escenario del prior art: las creds se borran y el socket moribundo las
  // reescribe ⇒ sesión inválida resucitada ⇒ loop de 401 eterno.
  rmSync(b.archivoCreds, { force: true });
  const filasAntes = b.filas();
  const jobsAntes = b.jobs.length;

  viejo.emitir("creds.update", {});
  viejo.emitir("messages.upsert", upsert(msg("VIEJO-1")));
  viejo.emitir("messages.update", [{ key: { remoteJid: JID_CONTACTO, id: "VIEJO-1" }, update: { status: 4 } }]);
  viejo.emitir("connection.update", { connection: "open" });
  viejo.emitir("connection.update", cierre(401));
  await asentar();
  b.drenar();

  expect(existsSync(b.archivoCreds)).toBe(false); // CA-3.3
  expect(b.filas()).toBe(filasAntes); // CA-15.6
  expect(b.jobs.length).toBe(jobsAntes); // ni siquiera llegó a la cola
  // Tampoco tocó el estado de la interfaz: el `open` del viejo no abrió nada y
  // el 401 del viejo no borró nada.
  expect(b.conn().state).not.toBe("open");
  expect(b.link().phase).not.toBe("need-link");
  expect(nuevo.terminado).toBe(false);
  expect(b.violaciones()).toBe(0);
  b.cerrar();
});

// ── flujo normal ────────────────────────────────────────────────────────────

test("el socket vigente alimenta la cola de ingest con todos los eventos", async () => {
  const b = banco();
  const s = await arrancar(b);

  s.emitir("messages.upsert", upsert(msg("A1")));
  s.emitir("chats.upsert", [{ id: JID_CONTACTO, name: "Ana", conversationTimestamp: 1_735_686_000 }] as never);
  s.emitir("contacts.upsert", [{ id: JID_CONTACTO, name: "Ana Gómez" }] as never);
  s.emitir("chats.update", [{ id: JID_CONTACTO, unreadCount: 0 }] as never);
  s.emitir("message-receipt.update", [] as never);
  s.emitir("messaging-history.set", { chats: [], contacts: [], messages: [msg("H1")] } as never);

  const kinds = b.jobs.map((j) => j.kind);
  expect(kinds).toContain("messages");
  expect(kinds).toContain("chats");
  expect(kinds).toContain("contacts");
  expect(kinds).toContain("chat-updates");
  // El history entra marcado como tal: no puede sumar no leídos (§6.2).
  expect(b.jobs.some((j) => j.kind === "messages" && j.source === "history")).toBe(true);

  b.drenar();
  expect(b.filas()).toBe(2);
  b.cerrar();
});

test("connection open: guarda estado, teléfono y deja la pantalla en la bandeja (CA-1.7, CA-15.4)", async () => {
  const b = banco();
  const s = await arrancar(b);

  s.emitir("connection.update", cierre(408)); // para que haya intentos que resetear
  await asentar();
  await correrTimer(b);
  expect(b.conn().attempt).toBe(1);

  const s2 = b.ultimo();
  s2.user = { id: SELF_JID };
  s2.emitir("connection.update", { connection: "open" });
  await asentar();

  expect(b.conn().state).toBe("open");
  expect(b.conn().attempt).toBe(0);
  expect(b.conn().nextAttemptAt).toBeNull();
  expect(b.conn().selfPhone).toBe("5491155667788");
  expect(b.link().phase).toBe("linked");
  expect(b.wa.isOpen()).toBe(true);
  expect(b.wa.selfJid()).toBe(SELF_JID);
  expect(b.logTexto()).toContain("wa.open");
  b.cerrar();
});

test("eventos con basura adentro no voltean la conexión", async () => {
  const b = banco();
  const s = await arrancar(b);

  // Todo lo que llega es entrada remota: puede venir `null` donde debería haber
  // un array. Una excepción en un handler de Baileys se lleva puesto el socket.
  s.emitir("messages.upsert", null as never);
  s.emitir("chats.upsert", null as never);
  s.emitir("messaging-history.set", null as never);
  s.emitir("connection.update", null as never);
  await asentar();

  expect(s.terminado).toBe(false);
  s.emitir("connection.update", { connection: "open" });
  await asentar();
  expect(b.conn().state).toBe("open");
  b.cerrar();
});

test("si un handler lanza, se loguea y el socket sigue vivo (ningún handler puede tirar)", async () => {
  const b = banco({
    ingest: (real) => ({
      ...real,
      push: () => {
        throw new Error("la cola explotó");
      },
    }),
  });
  const s = await arrancar(b);

  s.emitir("messages.upsert", upsert(msg("BOOM")));
  await asentar();

  expect(s.terminado).toBe(false);
  expect(b.logTexto()).toContain("wa.handler_fallido");
  // Y la conexión sigue funcionando para todo lo demás.
  s.emitir("connection.update", { connection: "open" });
  await asentar();
  expect(b.conn().state).toBe("open");
  b.cerrar();
});

// ── backoff (CA-15.2, CA-15.3, D6) ──────────────────────────────────────────

test("cierre transitorio: reintenta con 2/4/8 s y publica el próximo intento", async () => {
  const b = banco();
  await arrancar(b);

  const esperados = [2_000, 4_000, 8_000];
  for (let i = 0; i < esperados.length; i++) {
    const t0 = b.reloj();
    b.ultimo().emitir("connection.update", cierre(408));
    await asentar();

    expect(b.conn().state).toBe("reconnecting");
    expect(b.conn().attempt).toBe(i + 1);
    expect(b.conn().lastCode).toBe(408);
    expect(b.conn().nextAttemptAt).toBe(t0 + esperados[i]!);
    expect(b.agenda.esperas()).toEqual([esperados[i]!]);

    b.avanzar(esperados[i]!);
    await correrTimer(b);
    expect(b.vivos().length).toBe(1);
  }
  expect(b.violaciones()).toBe(0);
  b.cerrar();
});

test("un QR resetea el backoff: el 408 de después es 'no lo escanearon', no un error (D6)", async () => {
  const b = banco();
  await arrancar(b);

  // Dos caídas seguidas: el próximo reintento ya iría a 8 s.
  for (const _ of [1, 2]) {
    b.ultimo().emitir("connection.update", cierre(408));
    await asentar();
    await correrTimer(b);
  }
  expect(b.conn().attempt).toBe(2);

  b.ultimo().emitir("connection.update", { connection: "connecting", qr: QR_FALSO });
  await asentar();
  expect(b.conn().attempt).toBe(0);
  expect(b.link().phase).toBe("qr-shown");
  expect(b.link().qr).toBe(QR_FALSO);
  expect(b.logTexto()).toContain("wa.qr");

  // Sin el reset, este QR saldría a los 60 s y nadie llegaría a escanearlo.
  b.ultimo().emitir("connection.update", cierre(408));
  await asentar();
  expect(b.conn().attempt).toBe(1);
  expect(b.agenda.esperas()).toEqual([2_000]);
  b.cerrar();
});

test("el log NUNCA se lleva el payload del QR (CA-14.7)", async () => {
  const b = banco();
  const s = await arrancar(b);
  s.emitir("connection.update", { connection: "connecting", qr: QR_FALSO });
  await asentar();

  expect(b.logTexto()).not.toContain(QR_FALSO);
  b.cerrar();
});

test("reconnectNow saltea la espera del backoff (CA-15.5)", async () => {
  const b = banco();
  await arrancar(b);

  b.ultimo().emitir("connection.update", cierre(408));
  await asentar();
  expect(b.agenda.pendientes()).toBe(1);
  const antes = b.creados.length;

  b.wa.reconnectNow();
  await asentar();

  expect(b.creados.length).toBe(antes + 1);
  expect(b.vivos().length).toBe(1);
  expect(b.conn().attempt).toBe(0);
  expect(b.conn().nextAttemptAt).toBeNull();
  // El timer viejo no puede quedar vivo: dispararía un segundo socket.
  await correrTimer(b);
  expect(b.creados.length).toBe(antes + 1);
  expect(b.violaciones()).toBe(0);
  b.cerrar();
});

// ── 515: el cierre normal de después del escaneo (CA-1.8) ───────────────────

test("515 restartRequired: reabre en el acto, sin sumar intento ni pedir QR de nuevo", async () => {
  const b = banco();
  const s = await arrancar(b);
  s.emitir("connection.update", { connection: "connecting", qr: QR_FALSO });
  await asentar();

  s.emitir("connection.update", cierre(515));
  await asentar();

  expect(b.conn().attempt).toBe(0);
  expect(b.conn().state).toBe("connecting"); // no "reconnecting": no es un fallo
  expect(b.link().phase).toBe("restarting");
  expect(b.agenda.esperas()).toEqual([0]); // sin backoff
  expect(b.logTexto()).toContain("wa.restart_required");

  await correrTimer(b);
  expect(b.creados.length).toBe(2);
  expect(b.vivos().length).toBe(1);
  // Las creds del escaneo siguen ahí: reabre con ellas, no con un QR nuevo.
  expect(b.link().phase).not.toBe("need-link");
  b.cerrar();
});

// ── 405 sin QR (CA-1.4) ─────────────────────────────────────────────────────

test("405 sin haber emitido un QR: falla con motivo y NO se queda en 'conectando…'", async () => {
  const b = banco();
  const s = await arrancar(b);

  s.emitir("connection.update", cierre(405));
  await asentar();

  expect(b.link().phase).toBe("failed");
  expect(b.link().reason).toBe(MOTIVO_VERSION);
  expect(b.conn().state).toBe("offline");
  // Insistir con la misma versión daría el mismo 405: no se reintenta solo.
  expect(b.agenda.pendientes()).toBe(0);
  expect(b.creados.length).toBe(1);

  // Pero el usuario puede forzarlo a mano (Ctrl-R).
  b.wa.reconnectNow();
  await asentar();
  expect(b.creados.length).toBe(2);
  b.cerrar();
});

test("405 después de un QR: la versión ya está probada, reconecta con backoff", async () => {
  const b = banco();
  const s = await arrancar(b);
  s.emitir("connection.update", { connection: "connecting", qr: QR_FALSO });
  await asentar();

  s.emitir("connection.update", cierre(405));
  await asentar();

  expect(b.link().phase).not.toBe("failed");
  expect(b.conn().state).toBe("reconnecting");
  expect(b.agenda.esperas()).toEqual([2_000]);
  b.cerrar();
});

// ── 440 / 403: frenar en seco, sin reintento automático ─────────────────────

test("440 connectionReplaced: frena en seco, NO borra las creds y sale sólo con Ctrl-R", async () => {
  const b = banco({ vinculado: true });
  const s = await arrancar(b);
  s.user = { id: SELF_JID };
  s.emitir("connection.update", { connection: "open" });
  await asentar();
  expect(b.wa.isOpen()).toBe(true);

  // Otra sesión de WhatsApp Web tomó el slot. Reconectar la echaría a ella, que
  // reconecta y nos echa a nosotros: ping-pong a 2 s que el backoff NO frena
  // (cada conexión exitosa lo resetea, así que nunca escala a 60 s).
  s.emitir("connection.update", cierre(440));
  await asentar();

  expect(b.agenda.pendientes()).toBe(0); // cero timers agendados
  expect(b.agenda.esperas()).toEqual([]);
  expect(b.creados.length).toBe(1); // ni un socket más
  expect(s.terminado).toBe(true);
  expect(b.wa.isOpen()).toBe(false);
  expect(b.conn().state).toBe("offline");
  expect(b.conn().nextAttemptAt).toBeNull();
  expect(b.conn().lastCode).toBe(440);
  // Las creds SIGUEN sirviendo: no es un 401. Ni se borran ni se cambia la fase.
  expect(existsSync(b.archivoCreds)).toBe(true);
  expect(b.link().phase).toBe("linked");
  expect(b.link().reason).toBe(MOTIVO_CONEXION_REEMPLAZADA);
  expect(b.logTexto()).toContain("wa.halt");

  // Y el tiempo no lo saca solo: no hay nada agendado que correr.
  expect(b.agenda.correr()).toBe(false);
  expect(b.creados.length).toBe(1);

  // La salida es la manual, la misma ya probada en el 405.
  b.wa.reconnectNow();
  await asentar();
  expect(b.creados.length).toBe(2);
  expect(b.vivos().length).toBe(1);
  b.ultimo().emitir("connection.update", { connection: "open" });
  await asentar();
  expect(b.conn().state).toBe("open");
  expect(b.link().reason).toBeNull();
  expect(b.violaciones()).toBe(0);
  b.cerrar();
});

test("403 forbidden: mismo freno, con su propio motivo (reintentar no destraba la cuenta)", async () => {
  const b = banco({ vinculado: true });
  const s = await arrancar(b);

  s.emitir("connection.update", cierre(403));
  await asentar();

  expect(b.agenda.pendientes()).toBe(0);
  expect(b.creados.length).toBe(1);
  expect(b.conn().state).toBe("offline");
  expect(existsSync(b.archivoCreds)).toBe(true);
  expect(b.link().phase).toBe("linked");
  expect(b.link().reason).toBe(MOTIVO_CUENTA_RECHAZADA);

  b.wa.reconnectNow();
  await asentar();
  expect(b.creados.length).toBe(2);
  expect(b.vivos().length).toBe(1);
  b.cerrar();
});

// ── 401 / 500: borrar creds y volver a vincular (CA-3.1, CA-3.2) ────────────

test("401 loggedOut: borra SOLO las creds, conserva el historial y vuelve a vincular", async () => {
  const b = banco({ vinculado: true });
  const s = await arrancar(b);
  expect(b.link().phase).toBe("linked"); // con creds va derecho a la bandeja

  // Historial ya persistido: el borrado no lo puede tocar (CA-3.2).
  s.emitir("messages.upsert", upsert(msg("HIST-1")));
  b.drenar();
  expect(b.filas()).toBe(1);

  s.emitir("connection.update", cierre(401));
  await asentar();

  // La pantalla cambia YA; el borrado espera el cooldown del prior art.
  expect(b.link().phase).toBe("need-link");
  expect(b.link().reason).toBe(MOTIVO_LOGGED_OUT);
  expect(b.conn().state).toBe("unlinked");
  expect(s.terminado).toBe(true);
  expect(existsSync(b.archivoCreds)).toBe(true);
  expect(b.agenda.esperas()).toEqual([COOLDOWN_WIPE_MS]);

  await correrTimer(b); // vence el cooldown ⇒ borra y reconecta
  expect(existsSync(b.archivoCreds)).toBe(false);
  expect(b.filas()).toBe(1); // el historial sigue intacto (CA-3.2)
  expect(b.creados.length).toBe(2);
  expect(b.vivos().length).toBe(1);
  expect(b.logTexto()).toContain("wa.creds_borradas");
  expect(b.violaciones()).toBe(0);
  b.cerrar();
});

test("500 badSession: mismo camino, con su propio motivo", async () => {
  const b = banco({ vinculado: true });
  const s = await arrancar(b);

  s.emitir("connection.update", cierre(500));
  await asentar();
  expect(b.link().reason).toBe(MOTIVO_BAD_SESSION);
  await correrTimer(b);

  expect(existsSync(b.archivoCreds)).toBe(false);
  expect(b.creados.length).toBe(2);
  b.cerrar();
});

// ── un wipe que NO se puede hacer (riesgo R2: martillar a WhatsApp) ─────────

/**
 * Como root los permisos no frenan nada y `rmSync` borraría igual: el escenario
 * no se puede montar. Se saltea a la vista en vez de pasar sin probar nada.
 */
const sinRoot = process.getuid?.() !== 0;

test.skipIf(!sinRoot)(
  "si las creds no se pueden borrar, NO queda un loop de reconexión cada 1,5 s: frena en failed",
  async () => {
    const b = banco({ vinculado: true });
    const s = await arrancar(b);
    // Sin permiso de escritura en el padre, `rmSync` tira EACCES ⇒ `wipeCreds`
    // devuelve `false` (FS de sólo lectura, dir del usuario mal permisado, etc.).
    const padre = dirname(b.credsDir);
    chmodSync(padre, 0o500);

    try {
      s.emitir("connection.update", cierre(401));
      await asentar();
      expect(b.agenda.esperas()).toEqual([COOLDOWN_WIPE_MS]);

      // Seis vueltas de "vence el cooldown ⇒ borrar ⇒ reconectar ⇒ 401 de nuevo"
      // (las creds siguen muertas: WhatsApp devuelve lo mismo). Si el `ok` de
      // `wipeCreds` se ignorara, cada vuelta abriría un socket contra esa misma
      // sesión y volvería a agendar 1,5 s: el `intento` quedó en 0, así que el
      // backoff no crece NUNCA y queda un martilleo fijo cada 1,5 s (riesgo R2).
      const ciclos: Array<{ sockets: number; esperas: number[] }> = [];
      for (let i = 0; i < 6; i++) {
        b.agenda.correr();
        await asentar();
        const vivo = b.vivos()[0];
        if (vivo) {
          vivo.emitir("connection.update", cierre(401));
          await asentar();
        }
        ciclos.push({ sockets: b.creados.length, esperas: b.agenda.esperas() });
      }

      // Medido sin el fix: 7 sockets en 6 ciclos y `esperas` siempre `[1500]`.
      expect(ciclos).toEqual(Array.from({ length: 6 }, () => ({ sockets: 1, esperas: [] })));
      expect(existsSync(b.archivoCreds)).toBe(true); // no se pudieron borrar
      expect(b.creados.length).toBe(1); // ni un socket más
      expect(b.agenda.pendientes()).toBe(0); // ni un timer más
      expect(b.conn().state).toBe("offline");
      expect(b.link().phase).toBe("failed");
      expect(b.link().reason).toBe(motivoWipeFallido(b.credsDir));
      expect(b.link().reason).toContain(b.credsDir); // el path a revisar, no "algo falló"
      expect(b.logTexto()).toContain("wa.wipe_imposible");
    } finally {
      // Antes de `cerrar()`: la base y sus -wal viven en ese mismo directorio.
      chmodSync(padre, 0o700);
    }
    b.cerrar();
  },
);

test.skipIf(!sinRoot)("QR con creds y wipe imposible: tampoco entra en loop (mismo freno)", async () => {
  const b = banco({ vinculado: true });
  const s = await arrancar(b);
  const padre = dirname(b.credsDir);
  chmodSync(padre, 0o500);

  try {
    // CA-3.4 llega al mismo borrado: si falla, reconectar es volver a caer acá.
    s.emitir("connection.update", { connection: "connecting", qr: QR_FALSO });
    await asentar();
    for (let i = 0; i < 6; i++) {
      b.agenda.correr();
      await asentar();
      // Un socket nuevo volvería a arrancar en flujo `reconnect` (las creds
      // siguen ahí) y a recibir el mismo QR: la vuelta se repetiría sin fin.
      const vivo = b.vivos()[0];
      if (vivo) {
        vivo.emitir("connection.update", { connection: "connecting", qr: QR_FALSO });
        await asentar();
      }
    }

    expect(b.creados.length).toBe(1);
    expect(b.agenda.pendientes()).toBe(0);
    expect(b.link().phase).toBe("failed");
    expect(b.link().reason).toBe(motivoWipeFallido(b.credsDir));
  } finally {
    chmodSync(padre, 0o700);
  }
  b.cerrar();
});

// ── CA-3.4: un QR durante una reconexión ────────────────────────────────────

test("QR con creds vinculadas en disco: las creds no sirven ⇒ borrarlas y re-vincular (CA-3.4)", async () => {
  const b = banco({ vinculado: true });
  const s = await arrancar(b);

  s.emitir("connection.update", { connection: "connecting", qr: QR_FALSO });
  await asentar();

  // Ese QR NO se muestra como "escaneá esto y listo": primero hay que soltar la
  // sesión muerta, si no el usuario escanea contra creds que ya no valen.
  expect(b.link().phase).toBe("need-link");
  expect(b.link().reason).toBe(MOTIVO_QR_EN_RECONEXION);
  expect(b.link().qr).toBeNull();
  expect(s.terminado).toBe(true);
  expect(b.logTexto()).toContain("wa.qr_con_creds");

  await correrTimer(b); // cooldown ⇒ wipe + reconexión
  expect(existsSync(b.archivoCreds)).toBe(false);
  expect(b.creados.length).toBe(2);
  expect(b.vivos().length).toBe(1);

  // Y ahora sí: sin creds el flujo es `link` y el QR se muestra. Nunca en loop.
  b.ultimo().emitir("connection.update", { connection: "connecting", qr: QR_FALSO });
  await asentar();
  expect(b.link().phase).toBe("qr-shown");
  expect(b.link().qr).toBe(QR_FALSO);
  expect(b.creados.length).toBe(2);
  expect(b.violaciones()).toBe(0);
  b.cerrar();
});

// ── pairing (§5.6, CA-2.3) ──────────────────────────────────────────────────

test("requestPairingCode publica el código en el slice link", async () => {
  const b = banco();
  const s = await arrancar(b);

  await b.wa.requestPairingCode("5491155667788");
  expect(s.pairing).toEqual(["5491155667788"]);
  expect(b.link().phase).toBe("pairing-shown");
  expect(b.link().pairingCode).toBe("WACO5432");
  expect(b.link().pairingRequestedAt).toBe(b.reloj());
  b.cerrar();
});

test("la rotación del QR NO le borra de pantalla el código de emparejamiento", async () => {
  const b = banco();
  const s = await arrancar(b);

  await b.wa.requestPairingCode("5491155667788");
  expect(b.link().phase).toBe("pairing-shown"); // la interfaz ya lo está mostrando

  // Baileys sigue rotando el QR aunque se haya pedido un código de emparejamiento
  // (`Socket/socket.js:711`: `genPairQR` se re-arma cada 20-60 s). Sin el guard,
  // la primera rotación pisaba la fase con `qr-shown` y el código desaparecía a
  // los ~20 s. En una pane de 24×80 el QR ni siquiera entra (mide 34×67, RNF-3):
  // el código es EL camino de vinculación, y se le borraba solo.
  s.emitir("connection.update", { connection: "connecting", qr: QR_FALSO });
  s.emitir("connection.update", { connection: "connecting", qr: `${QR_FALSO},rot2` });
  await asentar();

  expect(b.link().phase).toBe("pairing-shown");
  expect(b.link().pairingCode).toBe("WACO5432");
  expect(b.link().pairingRequestedAt).toBe(b.reloj());
  // El payload igual se guarda: si vuelve al QR con `Tab` ve el vigente y no
  // tiene que esperar la próxima rotación.
  expect(b.link().qr).toBe(`${QR_FALSO},rot2`);
  // Y el reset del backoff que trae el QR sigue funcionando (D6).
  expect(b.conn().attempt).toBe(0);
  b.cerrar();
});

test("sin código en pantalla la rotación del QR sí manda a qr-shown (control positivo)", async () => {
  const b = banco();
  const s = await arrancar(b);
  expect(b.link().phase).toBe("qr-waiting");

  s.emitir("connection.update", { connection: "connecting", qr: QR_FALSO });
  await asentar();

  expect(b.link().phase).toBe("qr-shown");
  expect(b.link().qr).toBe(QR_FALSO);
  b.cerrar();
});

test("requestPairingCode sin socket avisa en vez de romper", async () => {
  const b = banco();
  expect(b.wa.requestPairingCode("5491155667788")).rejects.toThrow(/conexión/);
  b.cerrar();
});

test("si WhatsApp rechaza el pedido de código, el motivo queda en pantalla (CA-2.4)", async () => {
  const b = banco();
  const s = await arrancar(b);
  s.requestPairingCode = async () => {
    throw new Error("número inválido");
  };

  await expect(b.wa.requestPairingCode("999")).rejects.toThrow("número inválido");
  expect(b.link().phase).toBe("failed");
  expect(b.link().reason).toBe("número inválido");
  // El socket sigue vivo: se puede reintentar con otro número sin reiniciar.
  expect(s.terminado).toBe(false);
  b.cerrar();
});

// ── cierre ordenado (CA-17.1) ───────────────────────────────────────────────

test("stop cierra el socket sin logout y deja de reconectar", async () => {
  const b = banco({ vinculado: true });
  const s = await arrancar(b);

  await b.wa.stop({ timeoutMs: 2_000 });
  expect(s.terminado).toBe(true);
  expect(b.conn().state).toBe("offline");

  // Nada de lo que llegue después puede levantar un socket nuevo.
  b.wa.start();
  b.wa.reconnectNow();
  s.emitir("connection.update", cierre(408));
  await asentar();
  b.agenda.correr();
  await asentar();

  expect(b.creados.length).toBe(1);
  expect(b.vivos().length).toBe(0);
  // `stop()` NO desvincula: las creds tienen que seguir en disco (CA-17.1).
  expect(existsSync(b.archivoCreds)).toBe(true);
  b.cerrar();
});
