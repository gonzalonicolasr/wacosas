// Tests del cierre ordenado (`boot/shutdown.ts`, §6.6, CA-17.1 … CA-17.7) y de
// la única tecla que lo dispara (`ui/App.tsx`).
//
// Los tres invariantes que se miran acá, porque son los que hacen la diferencia
// entre "salió" y "quedó colgado":
//
//  · el ORDEN. `store.stop()` va después del drenador, del worker y del socket:
//    los tres marcan el store al terminar y eso rearma el timer de 33 ms;
//  · el TOPE. Es uno solo y global (2 s): un envío que no vuelve nunca no puede
//    dejar el proceso adentro de la pantalla alternativa para siempre (CA-17.4);
//  · la SALIDA. Ningún paso que falle puede impedir los que siguen —sobre todo
//    `renderer.destroy()`, que es el que devuelve la terminal (CA-17.2)—.
import { expect, test } from "bun:test";

import { cerrarEnviosAbiertos, createShutdown, MOTIVO_CIERRE } from "../src/boot/shutdown";
import { openDb } from "../src/db/open";
import { createRepo } from "../src/db/repo";
import type { MappedMessage } from "../src/db/types";
import { createStore } from "../src/state/store";
import { teclaDeSalida } from "../src/ui/App";
import { createSendQueue } from "../src/wa/send";

const LOG = { info() {}, warn() {}, error() {}, path: "/dev/null" };

const ANA = "5491150000001@s.whatsapp.net";

/** Un agendador manual: nada de timers reales en los tests (§7.4). */
function relojFalso() {
  const pendientes = new Map<number, { fn: () => void; ms: number }>();
  let id = 0;
  return {
    schedule: (fn: () => void, ms: number) => {
      const mio = ++id;
      pendientes.set(mio, { fn, ms });
      return () => pendientes.delete(mio);
    },
    /** Dispara todo lo agendado (el tope del cierre es lo único que hay). */
    disparar() {
      for (const [k, v] of [...pendientes]) {
        pendientes.delete(k);
        v.fn();
      }
    },
    pendientes: () => pendientes.size,
  };
}

/** Todas las piezas del cierre, anotando en qué orden las tocaron. */
function armar(opts: { enVuelo?: Promise<void> | null; repo?: never } = {}) {
  const pasos: string[] = [];
  const salidas: number[] = [];
  const reloj = relojFalso();

  const shutdown = createShutdown({
    log: LOG,
    schedule: reloj.schedule,
    exit: (code) => {
      pasos.push("exit");
      salidas.push(code);
    },
    store: { stop: () => void pasos.push("store.stop") },
    repo: {
      openSends: () => (pasos.push("repo.openSends"), []),
      setMessageStatus: () => {},
      close: () => void pasos.push("repo.close"),
    },
    renderer: { destroy: () => void pasos.push("renderer.destroy") },
    lock: { release: () => void pasos.push("lock.release") },
    maquina: () => ({
      ingest: {
        stop: () => void pasos.push("ingest.stop"),
        drainNow: () => void pasos.push("ingest.drainNow"),
      },
      send: {
        stop: () => void pasos.push("send.stop"),
        inFlight: () => opts.enVuelo ?? null,
      },
      wa: { stop: async () => void pasos.push("wa.stop") },
      appstate: { stop: () => void pasos.push("appstate.stop") },
      identity: { stop: () => void pasos.push("identity.stop") },
    }),
  });

  return { shutdown, pasos, salidas, reloj };
}

test("sin envío en vuelo el cierre entero es sincrónico y en el orden de §6.6", () => {
  const { shutdown, pasos, salidas } = armar();

  shutdown(0, "tecla ^C");

  expect(pasos).toEqual([
    // 2. nadie acepta trabajo nuevo
    "send.stop",
    "ingest.stop",
    "appstate.stop",
    "identity.stop",
    // 4. lo que no salió queda `failed`
    "repo.openSends",
    // 5-6. se escribe lo encolado y se corta el socket (sin logout)
    "ingest.drainNow",
    "wa.stop",
    // 7-10. y recién ahí se apaga lo que sostiene la pantalla
    "store.stop",
    "repo.close",
    "renderer.destroy",
    "lock.release",
    "exit",
  ]);
  expect(salidas).toEqual([0]); // CA-17.3
});

test("store.stop() va DESPUÉS del drenador, del worker y del socket (⚠️ tarea 6)", () => {
  const { shutdown, pasos } = armar();
  shutdown();

  const i = (p: string) => pasos.indexOf(p);
  expect(i("store.stop")).toBeGreaterThan(i("ingest.stop"));
  expect(i("store.stop")).toBeGreaterThan(i("ingest.drainNow"));
  expect(i("store.stop")).toBeGreaterThan(i("send.stop"));
  expect(i("store.stop")).toBeGreaterThan(i("wa.stop"));
  // Y la base se cierra después del drenado, nunca antes: si no, lo que quedaba
  // en la cola se perdería (CA-14.2).
  expect(i("repo.close")).toBeGreaterThan(i("ingest.drainNow"));
});

test("con un envío en vuelo espera a que termine y recién ahí cierra (CA-17.7)", async () => {
  let resolver!: () => void;
  const enVuelo = new Promise<void>((r) => (resolver = r));
  const { shutdown, pasos, salidas, reloj } = armar({ enVuelo });

  shutdown();
  // Paró todo, pero NO cerró: está esperando al que ya salió a la red.
  expect(pasos).toEqual(["send.stop", "ingest.stop", "appstate.stop", "identity.stop"]);
  expect(salidas).toEqual([]);
  expect(reloj.pendientes()).toBe(1); // el tope de 2 s, uno solo

  resolver();
  await Promise.resolve();
  await Promise.resolve();

  expect(salidas).toEqual([0]);
  expect(pasos).toContain("renderer.destroy");
  // El tope se canceló: el proceso no queda con un timer suelto.
  expect(reloj.pendientes()).toBe(0);
});

test("un envío que no vuelve nunca no cuelga el cierre: al tope sale igual (CA-17.4)", () => {
  const { shutdown, pasos, salidas, reloj } = armar({ enVuelo: new Promise<void>(() => {}) });

  shutdown();
  expect(salidas).toEqual([]);

  reloj.disparar(); // vencieron los 2 s

  expect(salidas).toEqual([0]);
  expect(pasos).toContain("renderer.destroy");
  expect(pasos).toContain("lock.release");
});

test("el segundo Ctrl-C sale YA con 1 y no repite ningún paso", () => {
  const { shutdown, pasos, salidas } = armar({ enVuelo: new Promise<void>(() => {}) });

  shutdown(0, "tecla ^C");
  const antes = [...pasos];

  shutdown(0, "tecla ^C");

  expect(salidas).toEqual([1]);
  // Lo único que se sumó es la salida: ni drenó, ni cerró la base, ni soltó la
  // marca (de eso se encarga el primer cierre si llega a terminar).
  expect(pasos).toEqual([...antes, "exit"]);
});

test("un paso que explota no impide los que siguen ni la salida", () => {
  const pasos: string[] = [];
  const salidas: number[] = [];
  const shutdown = createShutdown({
    log: LOG,
    exit: (c) => void salidas.push(c),
    // El que más importa: si el socket lanza, la terminal TIENE que volver igual.
    maquina: () => ({
      wa: {
        stop: () => {
          throw new Error("el socket ya estaba muerto");
        },
      },
    }),
    store: { stop: () => void pasos.push("store.stop") },
    renderer: {
      destroy: () => void pasos.push("renderer.destroy"),
    },
    lock: { release: () => void pasos.push("lock.release") },
  });

  shutdown(0, "SIGTERM");

  expect(pasos).toEqual(["store.stop", "renderer.destroy", "lock.release"]);
  expect(salidas).toEqual([0]);
});

test("sin máquina todavía (Ctrl-C mientras carga baileys) cierra igual", () => {
  const salidas: number[] = [];
  let destruido = false;
  const shutdown = createShutdown({
    log: LOG,
    exit: (c) => void salidas.push(c),
    renderer: { destroy: () => void (destruido = true) },
  });

  shutdown(0, "tecla ^C");

  expect(destruido).toBe(true);
  expect(salidas).toEqual([0]);
});

// ── CA-17.7: lo que quedó a medias no se queda en ⏳ ─────────────────────────

test("cerrarEnviosAbiertos deja `failed` sólo lo `pending`, con motivo", () => {
  const repo = createRepo(openDb(":memory:"));
  repo.upsertChat({ jid: ANA, name: "Ana" });
  const fila = (waId: string, status: MappedMessage["status"]): MappedMessage => ({
    chatJid: ANA,
    waId,
    fromMe: true,
    senderJid: "yo@s.whatsapp.net",
    senderName: "",
    ts: 1_700_000_000,
    kind: "text",
    body: "hola",
    attachment: null,
    status,
  });
  repo.insertMessage(fila("P1", "pending"));
  repo.insertMessage(fila("S1", "sent"));
  repo.insertMessage(fila("R1", "read"));

  const n = cerrarEnviosAbiertos(repo, MOTIVO_CIERRE);

  expect(n).toBe(1);
  expect(repo.getMessageByWaId(ANA, "P1")?.status).toBe("failed");
  expect(repo.getMessageByWaId(ANA, "P1")?.error).toBe(MOTIVO_CIERRE);
  // El que ya salió NO se toca: marcarlo fallado le pone al usuario un `Ctrl-Y`
  // adelante y lo manda dos veces.
  expect(repo.getMessageByWaId(ANA, "S1")?.status).toBe("sent");
  expect(repo.getMessageByWaId(ANA, "R1")?.status).toBe("read");
  repo.close();
});

test("con la cola de envío REAL: el que quedó en la red se espera y termina `failed`", async () => {
  // El camino completo de CA-17.7 con las piezas de verdad: `wa/send.ts` con un
  // `sendMessage` que no vuelve nunca (un socket que se colgó justo al cerrar).
  const repo = createRepo(openDb(":memory:"));
  repo.upsertChat({ jid: ANA, name: "Ana" });
  const reloj = relojFalso();
  const store = createStore({ schedule: reloj.schedule });
  store.bootstrap(repo);

  let enviados = 0;
  const send = createSendQueue({
    repo,
    store,
    log: LOG,
    schedule: reloj.schedule,
    now: () => 1_700_000_000_000,
    wa: {
      isOpen: () => true,
      selfJid: () => "yo:1@s.whatsapp.net",
      socket: () =>
        ({
          sendMessage: () =>
            new Promise(() => {
              enviados++;
            }),
        }) as never,
    },
  });

  const r = send.enqueue(ANA, "salió justo antes de cerrar");
  expect(r.ok).toBe(true);
  // El worker arranca un microtask después (ver `bombear`).
  await Promise.resolve();
  await Promise.resolve();
  expect(enviados).toBe(1);
  expect(send.inFlight()).not.toBe(null);

  const salidas: number[] = [];
  const shutdown = createShutdown({
    log: LOG,
    schedule: reloj.schedule,
    exit: (c) => void salidas.push(c),
    store,
    // Sin `close`: el test necesita leer la base DESPUÉS del cierre.
    repo: { openSends: repo.openSends, setMessageStatus: repo.setMessageStatus, close: () => {} },
    maquina: () => ({ send }),
  });

  shutdown(0, "tecla ^C");
  expect(salidas).toEqual([]); // esperando al que está en la red
  reloj.disparar(); // vencieron los 2 s (CA-17.4)

  expect(salidas).toEqual([0]);
  const fila = repo.getMessageByWaId(ANA, r.waId);
  expect(fila?.status).toBe("failed"); // CA-17.7: nunca queda en ⏳
  expect(fila?.error).toBe(MOTIVO_CIERRE);
  // Y con el cierre en marcha la cola no acepta nada más.
  expect(send.enqueue(ANA, "otro").ok).toBe(false);
  repo.close();
});

test("una base que no responde no voltea el cierre", () => {
  const roto = {
    openSends() {
      throw new Error("database is closed");
    },
    setMessageStatus() {},
  };
  expect(cerrarEnviosAbiertos(roto, MOTIVO_CIERRE, LOG)).toBe(0);
});

// ── el store queda TERMINAL (⚠️ de la revisión de la tarea 6) ────────────────

test("después de store.stop() ningún markDirty vuelve a armar el timer de 33 ms", () => {
  const reloj = relojFalso();
  const store = createStore({ schedule: reloj.schedule });
  let notifies = 0;
  store.subscribe("inbox", () => notifies++);

  store.markDirty("inbox");
  expect(reloj.pendientes()).toBe(1);

  store.stop();
  expect(reloj.pendientes()).toBe(0);

  // Esto es lo que hace `wa.stop()` al cerrar el socket, y lo que hacía que el
  // proceso quedara con un timer en vuelo cuando `store.stop()` iba primero.
  store.setConn({ state: "offline" });
  store.markDirty("inbox", "convo");
  store.toast("chau");
  store.flushNow();

  expect(reloj.pendientes()).toBe(0);
  expect(notifies).toBe(0);
});

// ── la tecla de salida (CA-17.1) ────────────────────────────────────────────
//
// El bug que cubren: la condición vieja era `key.ctrl && nombre-o-sequence in
// {c,q}`, sin mirar el resto de los modificadores. O sea que `Ctrl-Shift-C` —el
// copiar de media terminal—, `Ctrl-Alt-C` y `Ctrl-Super-C` cerraban wacosas.

/** Un evento como los que arma `lib/parse.keypress.ts` de OpenTUI. */
const tecla = (p: Partial<Record<string, unknown>>) =>
  ({
    name: "",
    sequence: "",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    eventType: "press",
    ...p,
  }) as never;

test("Ctrl-C y Ctrl-Q salen; una `c` sola no", () => {
  // Legacy: el byte 0x03, que el parser nombra `c`.
  expect(teclaDeSalida(tecla({ name: "c", sequence: "\x03", ctrl: true }))).toBe("^C");
  expect(teclaDeSalida(tecla({ name: "q", sequence: "\x11", ctrl: true }))).toBe("^Q");
  // Kitty: `CSI 99;5u`, con el texto asociado en `sequence`.
  expect(teclaDeSalida(tecla({ name: "c", sequence: "c", ctrl: true, source: "kitty" }))).toBe("^C");

  expect(teclaDeSalida(tecla({ name: "c", sequence: "c" }))).toBe(null);
  expect(teclaDeSalida(tecla({ name: "r", sequence: "\x12", ctrl: true }))).toBe(null);
  expect(teclaDeSalida(null)).toBe(null);
  expect(teclaDeSalida(undefined)).toBe(null);
});

test("Ctrl-Shift-C (copiar) NO cierra la aplicación", () => {
  const copiar = tecla({ name: "c", sequence: "C", ctrl: true, shift: true, source: "kitty" });
  expect(teclaDeSalida(copiar)).toBe(null);
});

test("ningún otro modificador encima de Ctrl-C cierra", () => {
  for (const mod of ["meta", "option", "super", "hyper", "shift"]) {
    const k = tecla({ name: "c", sequence: "c", ctrl: true, [mod]: true });
    expect(teclaDeSalida(k)).toBe(null);
  }
});

test("sólo cierra al APRETAR: soltar o repetir no (protocolo kitty)", () => {
  expect(teclaDeSalida(tecla({ name: "c", ctrl: true, eventType: "release" }))).toBe(null);
  // La repetición sí es un `press` (mantener apretado `Ctrl-C` sale, como siempre).
  expect(teclaDeSalida(tecla({ name: "c", ctrl: true, eventType: "press", repeated: true }))).toBe("^C");
});
