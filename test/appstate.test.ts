// Tests de la reparación de app-state (`src/wa/appstate.ts`): de esas colecciones
// salen los NOMBRES de la agenda, y en la cuenta real cuatro de las cinco nunca se
// sincronizaron (844 contactos, 32 con nombre).
//
// Lo que se verifica es el contrato que evita las dos formas de estar mal:
//
//   · **que repare cuando falta algo** — si una colección no tiene estado local,
//     se pide, y el resultado queda en el log;
//   · **que NO se dispare cuando no corresponde** — nada de reintentar en loop.
//     Son cinco cortes distintos, y cada uno tiene su test: colecciones completas,
//     resync que no trae novedades, tope de intentos, resync ya en vuelo y `stop`.
//
// El agendador es MANUAL (el mismo criterio que `test/identity.test.ts`): un
// agendador que ejecute en el acto rompe el store, y acá además hace falta poder
// afirmar que algo quedó agendado y todavía NO corrió.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeWASocket as makeWASocketReal } from "baileys";
import type { WAPatchName } from "baileys";

import { createLogger } from "../src/boot/log";
import {
  COLECCIONES,
  createAppStateSync,
  ESPERA_MANUAL_MS,
  ESPERA_TRAS_ABRIR_MS,
  MAX_REPARACIONES,
} from "../src/wa/appstate";
import { loadAuth } from "../src/wa/auth";
import { createBaileysLogger } from "../src/wa/socket";

const tmp = mkdtempSync(join(tmpdir(), "wacosas-appstate-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/**
 * Cómo quedó `creds/` en la cuenta real: la única colección con estado local es
 * `regular_high` (y encima estacionada por una clave que falta). Las otras cuatro
 * —incluida `critical_unblock_low`, la de `contactAction`— nunca se sincronizaron.
 */
const REAL: Record<string, { version: number } | undefined> = { regular_high: { version: 23 } };

const FALTAN_REAL: WAPatchName[] = ["critical_block", "critical_unblock_low", "regular_low", "regular"];

/** `REAL` más las colecciones que se vayan resolviendo. */
const conVersion = (...names: string[]) => ({
  ...REAL,
  ...Object.fromEntries(names.map((n) => [n, { version: 1 }])),
});

/**
 * Una reparación que SIEMPRE gana algo: cada resync resuelve una colección.
 *
 * `localState` se lee dos veces por reparación —antes de pedir y después, para
 * poder decir en el log qué entró—, así que cada estado va repetido: si no, el
 * "antes" de la vuelta siguiente vería el terreno ya ganado dos veces y la
 * reparación se cortaría sola por "sin novedades" antes de llegar al tope.
 */
const GANANDO = [
  REAL,
  conVersion("critical_block"),
  conVersion("critical_block"),
  conVersion("critical_block", "critical_unblock_low"),
  conVersion("critical_block", "critical_unblock_low"),
  conVersion("critical_block", "critical_unblock_low", "regular_low"),
];

// ── agendador manual ────────────────────────────────────────────────────────

function agendadorManual() {
  const pendientes: Array<{ fn: () => void; ms: number }> = [];
  return {
    schedule(fn: () => void, ms: number) {
      const item = { fn, ms };
      pendientes.push(item);
      return () => {
        const i = pendientes.indexOf(item);
        if (i >= 0) pendientes.splice(i, 1);
      };
    },
    hay: () => pendientes.length > 0,
    /** Los ms con los que se agendó cada tarea pendiente. */
    esperas: () => pendientes.map((p) => p.ms),
    correr(): boolean {
      const item = pendientes.shift();
      if (!item) return false;
      item.fn();
      return true;
    },
  };
}

/** Deja correr las promesas ya resueltas (la cadena de `reparar`). */
const microtareas = () => new Promise<void>((r) => setTimeout(r, 0));

// ── banco ───────────────────────────────────────────────────────────────────

let nBanco = 0;

type Opts = {
  /**
   * El estado local de cada vuelta. Se consume de a uno: la primera lectura usa
   * el primer elemento, la segunda el segundo, y el último se repite. Así se
   * modela "el resync trajo (o no trajo) las colecciones que faltaban".
   */
  estados?: Array<Record<string, { version: number } | undefined>>;
  /** Qué hace el resync. Por defecto, andar bien. */
  resync?: (names: readonly WAPatchName[]) => Promise<void>;
  /** El estado local LANZA (no hay socket, por ejemplo). */
  estadoLanza?: boolean;
};

function banco(opts: Opts = {}) {
  const logPath = join(tmp, `appstate-${nBanco++}.log`);
  const log = createLogger(logPath);
  const agenda = agendadorManual();
  // Reloj manual: el espaciado de la tecla se mide en minutos y el test no puede
  // esperarlos de verdad.
  let t = 1_000_000;
  const reloj = { avanzar: (ms: number) => (t += ms) };
  /** Cada llamada al resync, con las colecciones tal cual salieron. */
  const pedidos: WAPatchName[][] = [];
  const toasts: string[] = [];
  const estados = opts.estados ?? [REAL];
  let lecturas = 0;

  const app = createAppStateSync({
    log,
    localState: async () => {
      if (opts.estadoLanza) throw new Error("no hay conexión con WhatsApp");
      const i = Math.min(lecturas++, estados.length - 1);
      return estados[i]!;
    },
    resync: async (names) => {
      pedidos.push([...names]);
      if (opts.resync) await opts.resync(names);
    },
    schedule: agenda.schedule,
    now: () => t,
    toast: (texto) => toasts.push(texto),
  });

  return {
    app,
    agenda,
    reloj,
    pedidos,
    toasts,
    texto: () => readFileSync(logPath, "utf8"),
    /** Abre la conexión, corre lo agendado y deja asentar las promesas. */
    async abrirYCorrer() {
      app.onOpen();
      agenda.correr();
      await microtareas();
      await microtareas();
      await microtareas();
    },
  };
}

// ── SE DISPARA cuando corresponde ───────────────────────────────────────────

test("con colecciones sin estado local pide EXACTAMENTE esas, y no las que ya están", async () => {
  const b = banco({ estados: [REAL, {}] });
  await b.abrirYCorrer();

  expect(b.pedidos).toEqual([FALTAN_REAL]);
  // `regular_high` NO se pide sola: ya tiene estado, y encima está estacionada por
  // una clave que sólo puede mandar el teléfono. Pedirla sería una consulta que no
  // puede salir bien.
  expect(b.pedidos[0]).not.toContain("regular_high");
});

test("el chequeo NO corre en el acto: espera a que baileys termine su propio sync", async () => {
  const b = banco();
  b.app.onOpen();

  // Agendado, pero todavía sin pedir nada: los 20 s del `awaitingSyncTimeout` de
  // baileys (`Socket/chats.js:1099-1110`) tienen que caber adentro de esta espera.
  expect(b.agenda.hay()).toBe(true);
  expect(b.agenda.esperas()).toEqual([ESPERA_TRAS_ABRIR_MS]);
  expect(ESPERA_TRAS_ABRIR_MS).toBeGreaterThan(20_000);
  expect(b.pedidos).toEqual([]);
});

test("queda en el log qué se pidió y con qué resultado", async () => {
  // Segunda lectura: ya sólo falta `regular` ⇒ entraron tres de las cuatro.
  const b = banco({ estados: [REAL, { ...REAL, critical_block: { version: 1 }, critical_unblock_low: { version: 4 }, regular_low: { version: 2 } }] });
  await b.abrirYCorrer();

  const t = b.texto();
  expect(t).toContain("appstate.resync ");
  expect(t).toContain("origen=auto");
  expect(t).toContain("appstate.resync_ok");
  expect(t).toContain("resueltas=3");
  expect(t).toContain("faltan=regular");
});

test("un resync que falla deja el motivo y NO se lo come", async () => {
  const b = banco({
    resync: async () => {
      throw new Error("Connection Closed");
    },
  });
  await b.abrirYCorrer();

  expect(b.pedidos).toHaveLength(1);
  const t = b.texto();
  expect(t).toContain("appstate.resync_fallido");
  expect(t).toContain("Connection Closed");
});

// ── NO se dispara cuando no corresponde ─────────────────────────────────────

test("con las cinco colecciones sincronizadas no sale NI UNA consulta, nunca más", async () => {
  const todas = Object.fromEntries(COLECCIONES.map((n) => [n, { version: 7 }]));
  const b = banco({ estados: [todas] });
  await b.abrirYCorrer();

  expect(b.pedidos).toEqual([]);
  expect(b.texto()).toContain("appstate.completo");

  // Y una reconexión posterior tampoco agenda nada: el chequeo ya dio "completo".
  b.app.onOpen();
  expect(b.agenda.hay()).toBe(false);
});

test("si el resync anduvo pero no trajo NADA, no se vuelve a pedir en cada reconexión", async () => {
  // El estado local no cambia: para WhatsApp esas colecciones no tienen datos.
  const b = banco({ estados: [REAL] });
  await b.abrirYCorrer();
  expect(b.pedidos).toHaveLength(1);

  // Tres reconexiones más: ni una sola consulta nueva. Esto es lo que separa
  // "reparar" de "martillar" (R2).
  for (let i = 0; i < 3; i++) {
    await b.abrirYCorrer();
  }
  expect(b.pedidos).toHaveLength(1);
  expect(b.texto()).toContain("appstate.sin_novedades");
});

test("aunque cada intento traiga algo, el automático se topea en MAX_REPARACIONES", async () => {
  // Cada reparación resuelve UNA colección, así que nunca se cae por "sin
  // novedades": el corte lo tiene que poner el tope, que es la otra mitad de la
  // guarda. `GANANDO` va leyendo de a un paso por lectura (antes y después de
  // cada resync).
  const b = banco({ estados: GANANDO });
  for (let i = 0; i < MAX_REPARACIONES + 4; i++) {
    await b.abrirYCorrer();
  }

  expect(b.pedidos).toHaveLength(MAX_REPARACIONES);
  expect(b.texto()).toContain("appstate.tope_alcanzado");
  // Y de verdad fue ganando terreno: la última pedida ya era más chica.
  expect(b.pedidos[MAX_REPARACIONES - 1]!.length).toBeLessThan(b.pedidos[0]!.length);
});

test("sin poder leer el estado local no se manda un resync a ciegas", async () => {
  const b = banco({ estadoLanza: true });
  await b.abrirYCorrer();

  expect(b.pedidos).toEqual([]);
  expect(b.texto()).toContain("appstate.estado_local_fallido");
});

test("`stop` corta lo agendado y lo agendado después", async () => {
  const b = banco();
  b.app.onOpen();
  expect(b.agenda.hay()).toBe(true);

  b.app.stop();
  expect(b.agenda.hay()).toBe(false);
  b.app.onOpen();
  expect(b.agenda.hay()).toBe(false);

  b.app.force();
  await microtareas();
  expect(b.pedidos).toEqual([]);
});

// ── la tecla (`Ctrl-N` ⇒ `force`) ───────────────────────────────────────────

test("a mano se piden las CINCO, incluida la estacionada (es lo único que la destraba)", async () => {
  const b = banco({ estados: [REAL, REAL] });
  b.app.force();
  await microtareas();
  await microtareas();

  expect(b.pedidos).toEqual([[...COLECCIONES]]);
  expect(b.pedidos[0]).toContain("regular_high");
  expect(b.texto()).toContain("origen=manual");
  expect(b.toasts[0]).toContain("resincronizando");
});

test("dos veces la tecla no manda dos resyncs encimados", async () => {
  // El resync se queda colgado: el segundo `force` cae con uno en vuelo.
  let soltar: (() => void) | null = null;
  const b = banco({ resync: () => new Promise<void>((r) => (soltar = r)) });

  b.app.force();
  await microtareas();
  b.app.force();
  await microtareas();

  expect(b.pedidos).toHaveLength(1);
  expect(b.toasts.some((t) => t.includes("en curso"))).toBe(true);
  soltar?.();
});

test("la tecla está ESPACIADA: apretarla de nuevo enseguida no le pregunta nada a WhatsApp", async () => {
  // El resync termina rápido —o sea que la guarda de "en vuelo" ya no aplica— y
  // aun así el segundo `^N` no manda nada. Es el caso del usuario nervioso.
  const b = banco({ estados: [REAL, REAL] });
  b.app.force();
  await microtareas();
  await microtareas();
  expect(b.pedidos).toHaveLength(1);

  for (let i = 0; i < 10; i++) {
    b.reloj.avanzar(1_000); // diez pulsaciones repartidas en 10 s
    b.app.force();
    await microtareas();
  }
  expect(b.pedidos).toHaveLength(1);
  expect(b.toasts.some((t) => t.includes("probá de nuevo en"))).toBe(true);
  expect(b.texto()).toContain("appstate.manual_en_espera");

  // Pasado el espaciado, la tecla vuelve a servir.
  b.reloj.avanzar(ESPERA_MANUAL_MS);
  b.app.force();
  await microtareas();
  await microtareas();
  expect(b.pedidos).toHaveLength(2);
});

// ── el contrato con baileys ─────────────────────────────────────────────────

test("baileys sigue exponiendo lo que este módulo usa (`resyncAppState` + el estado local)", async () => {
  // Con el `makeWASocket` DE VERDAD y el ws contra un puerto muerto (127.0.0.1:1,
  // el mismo truco de `test/socket.test.ts`): no se le habla a WhatsApp. Esto es
  // lo que avisa el día que baileys renombre la API y la reparación se vuelva un
  // `catch` silencioso.
  const dir = mkdtempSync(join(tmp, "contrato-"));
  const { state } = await loadAuth(join(dir, "creds"));
  const sock = makeWASocketReal({
    auth: state,
    logger: createBaileysLogger(createLogger(join(dir, "wa.log"))),
    waWebSocketUrl: new URL("ws://127.0.0.1:1"),
  });

  expect(typeof sock.resyncAppState).toBe("function");
  const estado = await sock.authState.keys.get("app-state-sync-version", COLECCIONES as unknown as string[]);
  // ⚠️ Lo que falta vuelve como **`null`**, no como ausente: `useMultiFileAuthState`
  // rellena la clave igual (`readData` devuelve `null` cuando el archivo no está).
  // Por eso el filtro del módulo es `!estado[n]` y no `!(n in estado)`.
  expect(Object.keys(estado).sort()).toEqual([...COLECCIONES].sort());
  expect(COLECCIONES.every((n) => estado[n] === null)).toBe(true);

  await sock.end(undefined).catch(() => {});
});

test("una colección que vuelve en `null` cuenta como faltante", async () => {
  // La forma exacta que devuelve baileys para una sesión recién vinculada.
  const nulos = Object.fromEntries(COLECCIONES.map((n) => [n, null])) as Record<string, undefined>;
  const b = banco({ estados: [nulos, nulos] });
  await b.abrirYCorrer();

  expect(b.pedidos).toEqual([[...COLECCIONES]]);
});

// ── el costo, dicho en número ───────────────────────────────────────────────

test("el peor caso automático son MAX_REPARACIONES resyncs por proceso", async () => {
  // El peor caso es justamente el que NO se corta solo: cada vuelta trae algo, así
  // que lo único que lo frena es el tope. Veinte reconexiones.
  const b = banco({ estados: GANANDO });
  for (let i = 0; i < 20; i++) await b.abrirYCorrer();

  expect(b.pedidos).toHaveLength(MAX_REPARACIONES);
  console.log(
    `[appstate] peor caso automático: ${b.pedidos.length} resyncs por proceso ` +
      `(1 por conexión, ${ESPERA_TRAS_ABRIR_MS / 1000} s después de abrir) · ` +
      `cada resync = 1 stanza \`iq w:sync:app:state\` por vuelta, ` +
      `≤ MAX_SYNC_ATTEMPTS(2) vueltas + las que pida WhatsApp con has_more_patches ` +
      `⇒ ≤ ${MAX_REPARACIONES * 2} stanzas automáticas por proceso`,
  );
});
