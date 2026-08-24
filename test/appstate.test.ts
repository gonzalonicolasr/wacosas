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
  leerAviso,
  leerAvisoSync,
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
  /**
   * Colecciones que baileys vuelve a ESTACIONAR en cada resync, avisándolo por el
   * logger tal como lo hace de verdad (`Socket/chats.js:522`). Es la simulación
   * de "la clave sigue sin llegar": el aviso cae DENTRO del `await resync`, que
   * es exactamente cuándo llega en producción.
   */
  trabadas?: WAPatchName[];
  /**
   * `creds.accountSyncCounter`. `undefined` = el banco NO cablea la reparación
   * de fondo (como los tests viejos); `null` = cableada pero sin creds cargadas.
   */
  contador?: number | null;
  /** La marca de `meta`: la reparación ya se intentó alguna vez. */
  yaReparado?: boolean;
  /** Qué contesta `resetSyncCounter` (por defecto, que pudo). */
  resetOk?: boolean;
  /** Borrar el estado local LANZA (no hay socket, permisos). */
  ceroLanza?: boolean;
};

/** El aviso literal de baileys cuando estaciona una colección. */
const parking = (col: string, v: number) =>
  `${col} blocked on missing key from v${v}, parking after 2 attempts`;

/** Las colecciones, en el orden en que las nombra `COLECCIONES`. */
const enOrden = (ns: readonly string[]): WAPatchName[] => COLECCIONES.filter((n) => ns.includes(n));

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

  /** Lo que hizo la reparación de fondo: resets pedidos, reconexiones y marcas. */
  const fondo = { resets: 0, reconexiones: 0, marcas: 0 };
  let reparadoEnMeta = opts.yaReparado === true;
  // Las cinco van juntas: sin `contador` el banco arma el módulo como antes de
  // la reparación (que es el caso de los tests viejos).
  const deFondo =
    opts.contador === undefined
      ? {}
      : {
          syncCounter: () => opts.contador ?? null,
          resetSyncCounter: async () => {
            fondo.resets++;
            return opts.resetOk !== false;
          },
          reconnect: () => {
            fondo.reconexiones++;
          },
          yaReparado: () => reparadoEnMeta,
          marcarReparado: () => {
            fondo.marcas++;
            reparadoEnMeta = true;
          },
        };

  /** Colecciones a las que se les borró el estado local, y con qué llamadas. */
  const ceros: WAPatchName[][] = [];
  const borradas = new Set<string>();

  const app = createAppStateSync({
    log,
    ...deFondo,
    resetLocalState: async (names) => {
      if (opts.ceroLanza) throw new Error("no se pudo borrar el estado local");
      ceros.push([...names]);
      for (const n of names) borradas.add(n);
    },
    localState: async () => {
      if (opts.estadoLanza) throw new Error("no hay conexión con WhatsApp");
      const i = Math.min(lecturas++, estados.length - 1);
      const base = estados[i]!;
      if (borradas.size === 0) return base;
      // Lo que de verdad pasa después de borrar el archivo: esa colección deja
      // de tener estado local.
      const out = { ...base };
      for (const n of borradas) delete out[n];
      return out;
    },
    resync: async (names) => {
      pedidos.push([...names]);
      for (const n of names) {
        // Como baileys: el `warn` de la colección trabada sale DURANTE el resync.
        if (opts.trabadas?.includes(n)) app.onAviso(parking(n, 23));
        // Y la que NO está trabada entra: si se había pedido desde cero, el
        // snapshot vuelve a dejarle estado local.
        else borradas.delete(n);
      }
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
    /** El mismo objeto que se pasó: se puede cambiar a mitad de un test. */
    opts,
    fondo,
    ceros,
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
  // `regular_high` NO se pide: ya tiene estado y —hasta donde este banco sabe— está
  // al día, así que WhatsApp la mantiene sola con los `server_sync`. Lo que sí la
  // vuelve a poner en la lista es enterarse de que quedó ESTACIONADA (los tests de
  // más abajo), que es un dato que sólo llega por el `warn` de baileys.
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

// ── colecciones ESTACIONADAS: el reporte que mentía ─────────────────────────
//
// La foto de la cuenta real: las cinco colecciones TIENEN estado local, pero dos
// quedaron trabadas por una clave que sólo puede mandar el teléfono. Antes eso se
// leía `resueltas=5 faltan=ninguna` y `appstate.completo` apagaba la reparación
// para todo el proceso.

/** Las cinco con estado local, como en la cuenta real después del `Ctrl-N`. */
const TODAS_CON_ESTADO = Object.fromEntries(COLECCIONES.map((n) => [n, { version: 7 }]));
const TRABADAS: WAPatchName[] = ["regular_high", "regular_low"];

test("`leerAviso` distingue las tres frases de baileys y se hace la sorda con el resto", () => {
  expect(leerAviso(parking("regular_high", 23))).toEqual({ name: "regular_high", estacionada: true });
  expect(leerAviso("synced regular_low to v69")).toEqual({ name: "regular_low", estacionada: false });
  expect(leerAviso("restored state of critical_block from snapshot to v3 with mutations")).toEqual({
    name: "critical_block",
    estacionada: false,
  });

  // Las otras líneas de baileys no dicen nada sobre estacionamiento. Ojo con la
  // tercera: nombra una colección y NO es un `synced`.
  for (const otra of [
    "Doing app state sync",
    "App state sync complete",
    "regular has more patches...",
    "resyncing regular_low from v68",
    // ⚠️ La trampa: el PRIMER fallo por clave que falta dice casi lo mismo y NO
    // es un estacionamiento (baileys todavía va a reintentar con snapshot,
    // `Socket/chats.js:528`). Está en el log de la cuenta real, tres líneas
    // arriba del `parking`.
    "regular_high blocked on missing key from v23, retrying with snapshot",
    "failed to sync regular from v2, giving up",
    "Closing stale open session for new outgoing prekey bundle",
    "",
  ]) {
    expect({ otra, leido: leerAviso(otra) }).toEqual({ otra, leido: null });
  }
  // Y un nombre inventado tampoco entra: el conjunto sólo puede tener las cinco.
  expect(leerAviso(parking("regular_altisimo", 1))).toBe(null);
});

test("con una colección estacionada NO hay `appstate.completo` (aunque las cinco tengan estado)", async () => {
  const b = banco({ estados: [TODAS_CON_ESTADO], trabadas: TRABADAS });
  // Como llega de verdad: baileys lo avisó durante SU sincronización, antes de
  // que este módulo mire nada.
  for (const n of TRABADAS) b.app.onAviso(parking(n, 23));

  await b.abrirYCorrer();

  const t = b.texto();
  // Esto es el bug: con las cinco "con estado" se daba por terminado.
  expect(t).not.toContain("appstate.completo");
  // Se piden justamente las trabadas: es lo único que puede destrabarlas.
  expect(b.pedidos).toEqual([enOrden(TRABADAS)]);
  // Y el log dice la verdad: ninguna resuelta, y con nombre y apellido.
  expect(t).toContain("appstate.estacionada coleccion=regular_high");
  expect(t).toContain("resueltas=0");
  expect(t).toContain(`faltan=${enOrden(TRABADAS).join(",")}`);
  expect(t).toContain(`estacionadas=${enOrden(TRABADAS).join(",")}`);
});

test("el reparador NO se apaga con una estacionada, pero se topea (nada de loop)", async () => {
  const b = banco({ estados: [TODAS_CON_ESTADO], trabadas: TRABADAS });
  for (const n of TRABADAS) b.app.onAviso(parking(n, 23));

  // Ocho reconexiones. Sin el arreglo, la primera decía "completo" y no salía
  // NINGUNA consulta; sin tope, saldrían ocho.
  for (let i = 0; i < 8; i++) await b.abrirYCorrer();

  expect(b.pedidos).toHaveLength(MAX_REPARACIONES);
  const t = b.texto();
  expect(t).toContain("appstate.tope_alcanzado");
  expect(t).toContain(`estacionadas=${enOrden(TRABADAS).join(",")}`);
  // El tope se dice CON la salida: a partir de acá la destraba el usuario.
  expect(t).toContain("salida=Ctrl-N");
  // Y "sin novedades" NO aplica: una estacionada que no trae nada es lo
  // esperado, no una colección vacía de la que no vale la pena preguntar más.
  expect(t).not.toContain("appstate.sin_novedades");
});

test("cuando la clave llega, la colección se destraba sola y ahí sí hay `completo`", async () => {
  const b = banco({ estados: [TODAS_CON_ESTADO], trabadas: TRABADAS });
  for (const n of TRABADAS) b.app.onAviso(parking(n, 23));
  await b.abrirYCorrer();
  expect(b.pedidos).toHaveLength(1);

  // El teléfono mandó el `APP_STATE_SYNC_KEY_SHARE`: baileys re-sincroniza las
  // trabadas por su cuenta (`Socket/chats.js:1115-1128`) y lo cuenta así.
  b.app.onAviso("app state sync key arrived, re-syncing blocked collections");
  for (const n of TRABADAS) b.app.onAviso(`synced ${n} to v${70}`);
  // Ya no se traban: la clave está.
  b.opts.trabadas = [];

  await b.abrirYCorrer();
  expect(b.texto()).toContain("appstate.destrabada coleccion=regular_high");
  // Se pide UNA vez más —el estado local se había borrado para pedirlas desde
  // cero— y ahí entran: `resueltas=2` y nada estacionado.
  expect(b.pedidos).toHaveLength(2);
  expect(b.texto()).toContain("resueltas=2 faltan=ninguna estacionadas=ninguna");

  // Y con todo al día no sale ninguna consulta más.
  await b.abrirYCorrer();
  expect(b.pedidos).toHaveLength(2);
});

test("a mano, el aviso del pie no dice `sincronizada` cuando quedó algo trabado", async () => {
  const b = banco({ estados: [TODAS_CON_ESTADO], trabadas: TRABADAS });
  b.app.force();
  await microtareas();
  await microtareas();

  expect(b.pedidos).toEqual([[...COLECCIONES]]);
  expect(b.toasts.some((t) => t.includes("sin la clave"))).toBe(true);
  expect(b.toasts.some((t) => t === "agenda sincronizada")).toBe(false);
});

test("un aviso de baileys nunca puede romper nada (lo llama el logger)", () => {
  const b = banco();
  // Basura, vacío y algo que no es un string: ninguno lanza ni ensucia el conjunto.
  for (const x of ["", "cualquier cosa", null as unknown as string, 42 as unknown as string]) {
    expect(() => b.app.onAviso(x)).not.toThrow();
  }
});

// ── la reparación de FONDO: rehabilitar el sync completo de baileys ─────────
//
// La causa raíz: el `awaitingSyncTimeout` de 20 s (hardcodeado) saltó en la
// primera conexión —899 chats tardan más en empezar a llegar— y baileys se
// auto-incrementó `accountSyncCounter`, que es el número que apaga para siempre
// su sincronización inicial completa. Poniéndolo en 0 y reconectando, la
// rehace. Los tests miran las dos mitades: que se dispare con el diagnóstico
// puesto, y que NO se dispare (ni se repita) en ningún otro caso.

test("con app-state incompleto y el contador en 1, resetea y reconecta (una vez)", async () => {
  const b = banco({ estados: [REAL, REAL], contador: 1 });
  await b.abrirYCorrer();

  expect(b.fondo.resets).toBe(1);
  expect(b.fondo.reconexiones).toBe(1);
  // La marca queda ANTES de tocar nada: el próximo arranque no lo repite.
  expect(b.fondo.marcas).toBe(1);
  // Y NO se pidió ningún resync: la reconexión se lo llevaría puesto igual.
  expect(b.pedidos).toEqual([]);

  const t = b.texto();
  expect(t).toContain("appstate.sync_completo_reparando");
  expect(t).toContain("contador=1");
  expect(t).toContain("appstate.sync_completo_reconectando");
  expect(b.toasts.some((x) => x.includes("sincronización inicial"))).toBe(true);
});

test("después de reconectar NO se vuelve a reparar: sigue el camino normal", async () => {
  const b = banco({ estados: [REAL, REAL], contador: 1 });
  await b.abrirYCorrer();
  expect(b.fondo.reconexiones).toBe(1);

  // La reconexión abre otra vez (es lo que hace el controlador de verdad).
  await b.abrirYCorrer();
  await b.abrirYCorrer();

  expect(b.fondo.resets).toBe(1);
  expect(b.fondo.reconexiones).toBe(1);
  // Ahora sí sale el resync de siempre, con su tope.
  expect(b.pedidos).toEqual([FALTAN_REAL]);
});

test("con todo al día NO se toca el contador (el falso positivo que hay que evitar)", async () => {
  const todas = Object.fromEntries(COLECCIONES.map((n) => [n, { version: 7 }]));
  const b = banco({ estados: [todas], contador: 3 });
  await b.abrirYCorrer();

  // Es el caso de la mayoría de las cuentas: el contador está en 1 porque el
  // sync SÍ se hizo. Resetearlo ahí sería un sync completo al pedo por arranque.
  expect(b.fondo.resets).toBe(0);
  expect(b.fondo.marcas).toBe(0);
  expect(b.fondo.reconexiones).toBe(0);
  expect(b.texto()).toContain("appstate.completo");
});

test("con el contador ya en 0 no hay nada que reparar (baileys va a intentarlo solo)", async () => {
  const b = banco({ estados: [REAL, REAL], contador: 0 });
  await b.abrirYCorrer();

  expect(b.fondo.resets).toBe(0);
  expect(b.fondo.marcas).toBe(0);
  // Y el camino de siempre sigue andando.
  expect(b.pedidos).toEqual([FALTAN_REAL]);
});

test("sin creds cargadas (contador `null`) no se toca nada a ciegas", async () => {
  const b = banco({ estados: [REAL, REAL], contador: null });
  await b.abrirYCorrer();
  expect(b.fondo.resets).toBe(0);
  expect(b.fondo.marcas).toBe(0);
});

test("la marca de `meta` la frena aunque el diagnóstico dé (no se repite por arranque)", async () => {
  const b = banco({ estados: [REAL, REAL], contador: 1, yaReparado: true });
  await b.abrirYCorrer();

  expect(b.fondo.resets).toBe(0);
  expect(b.fondo.reconexiones).toBe(0);
  expect(b.pedidos).toEqual([FALTAN_REAL]);
});

test("si el reset falla, queda marcado igual y NO se reconecta", async () => {
  const b = banco({ estados: [REAL, REAL], contador: 1, resetOk: false });
  await b.abrirYCorrer();

  expect(b.fondo.resets).toBe(1);
  // La marca va antes: un reset que no se pudo escribir no puede convertirse en
  // un intento por arranque.
  expect(b.fondo.marcas).toBe(1);
  expect(b.fondo.reconexiones).toBe(0);
  expect(b.texto()).toContain("appstate.sync_completo_no_reseteado");
  // Y como no hubo reconexión, la reparación de siempre sigue su curso.
  expect(b.pedidos).toEqual([FALTAN_REAL]);
});

test("la reparación tampoco corre con app-state estacionado si ya se hizo", async () => {
  // Estacionadas + contador en 1 = el diagnóstico completo de la cuenta real.
  const todas = Object.fromEntries(COLECCIONES.map((n) => [n, { version: 7 }]));
  const b = banco({ estados: [todas], trabadas: TRABADAS, contador: 1 });
  for (const n of TRABADAS) b.app.onAviso(parking(n, 23));

  await b.abrirYCorrer();
  expect(b.fondo.resets).toBe(1);
  expect(b.pedidos).toEqual([]);

  // La clave sigue sin llegar: después de la reconexión se vuelve a estacionar y
  // ahí ya es el camino normal (con su tope), sin más reconexiones.
  for (let i = 0; i < 5; i++) await b.abrirYCorrer();
  expect(b.fondo.reconexiones).toBe(1);
  expect(b.pedidos).toHaveLength(MAX_REPARACIONES);
  expect(b.texto()).toContain("appstate.tope_alcanzado");
});

// ── pedir una estacionada DESDE CERO (la misma stanza, otra pregunta) ───────

test("antes de reintentar una estacionada se borra su estado local", async () => {
  const todas = Object.fromEntries(COLECCIONES.map((n) => [n, { version: 7 }]));
  const b = banco({ estados: [todas], trabadas: TRABADAS });
  for (const n of TRABADAS) b.app.onAviso(parking(n, 23));

  await b.abrirYCorrer();

  // Se borró el estado local de las trabadas —y de NINGUNA otra— antes de pedir.
  expect(b.ceros).toEqual([enOrden(TRABADAS)]);
  expect(b.texto()).toContain(`appstate.desde_cero colecciones=${enOrden(TRABADAS).join(",")}`);
  // Y en el mismo intento se piden: no es una consulta extra, es la misma con la
  // versión en cero (que es lo que hace que WhatsApp mande el snapshot).
  expect(b.pedidos).toEqual([enOrden(TRABADAS)]);
});

test("el pedido desde cero es UNO por colección: si el snapshot tampoco entra, no se repite", async () => {
  const todas = Object.fromEntries(COLECCIONES.map((n) => [n, { version: 7 }]));
  const b = banco({ estados: [todas], trabadas: TRABADAS });
  for (const n of TRABADAS) b.app.onAviso(parking(n, 23));

  for (let i = 0; i < 5; i++) await b.abrirYCorrer();

  expect(b.ceros).toHaveLength(1);
  expect(b.pedidos).toHaveLength(MAX_REPARACIONES);
  // ⚠️ Sin el arreglo de `pendientes`, la colección borrada + estacionada se
  // leía como "WhatsApp no tiene nada acá" y la reparación se apagaba en la
  // primera vuelta por el corte de "sin novedades".
  expect(b.texto()).not.toContain("appstate.sin_novedades");
  expect(b.texto()).toContain("appstate.tope_alcanzado");
});

test("si no se puede borrar el estado local, se pide igual (desde la versión vieja)", async () => {
  const todas = Object.fromEntries(COLECCIONES.map((n) => [n, { version: 7 }]));
  const b = banco({ estados: [todas], trabadas: TRABADAS, ceroLanza: true });
  for (const n of TRABADAS) b.app.onAviso(parking(n, 23));

  await b.abrirYCorrer();

  expect(b.ceros).toEqual([]);
  expect(b.texto()).toContain("appstate.desde_cero_fallido");
  expect(b.pedidos).toEqual([enOrden(TRABADAS)]);
});

test("enterarse de que algo se trabó vuelve a agendar el chequeo (sin esperar otra conexión)", async () => {
  // Las cinco con estado y nada trabado: el chequeo da "completo" y se apaga.
  const todas = Object.fromEntries(COLECCIONES.map((n) => [n, { version: 7 }]));
  const b = banco({ estados: [todas] });
  await b.abrirYCorrer();
  expect(b.texto()).toContain("appstate.completo");
  expect(b.agenda.hay()).toBe(false);

  // Y AHORA WhatsApp empuja un cambio y baileys estaciona la colección. Es el
  // caso real: las tres del log de la cuenta se trabaron 10, 17 y 20 minutos
  // después de abrir, no en los primeros 30 s.
  b.app.onAviso(parking("regular_low", 68));
  b.app.onAviso(parking("regular_high", 23));
  // Un chequeo agendado, UNO solo (dos avisos no son dos chequeos).
  expect(b.agenda.esperas()).toEqual([ESPERA_TRAS_ABRIR_MS]);

  b.agenda.correr();
  await microtareas();
  await microtareas();
  await microtareas();
  expect(b.pedidos).toEqual([enOrden(["regular_high", "regular_low"])]);
});

test("`leerAvisoSync` reconoce cómo le fue a la sincronización inicial de baileys", () => {
  expect(leerAvisoSync("First connection, awaiting history sync notification with a 20s timeout.")).toBe(
    "esperando_historial",
  );
  expect(leerAvisoSync("Doing app state sync")).toBe("app_state_corriendo");
  expect(
    leerAvisoSync("App state sync complete, transitioning to Online state and flushing buffer"),
  ).toBe("app_state_ok");
  expect(leerAvisoSync("Timeout in AwaitingInitialSync, forcing state to Online and flushing buffer")).toBe(
    "timeout_sin_historial",
  );
  expect(
    leerAvisoSync("Reconnection with existing sync data, skipping history sync wait. Transitioning to Online."),
  ).toBe("salteado_por_contador");
  expect(leerAvisoSync("cualquier otra cosa")).toBe(null);
});

test("las fases de baileys quedan en el log (es lo que dice si la reparación sirvió)", () => {
  const b = banco({ contador: 1 });
  b.app.onAviso("Timeout in AwaitingInitialSync, forcing state to Online and flushing buffer");
  b.app.onAviso("Doing app state sync");
  b.app.onAviso("App state sync complete, transitioning to Online state and flushing buffer");

  const t = b.texto();
  expect(t).toContain("appstate.sync_baileys fase=timeout_sin_historial");
  expect(t).toContain("appstate.sync_baileys fase=app_state_corriendo");
  expect(t).toContain("appstate.sync_baileys fase=app_state_ok");
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

test("el aviso que leemos sigue siendo el que baileys escribe (y sigue sin haber otra forma)", () => {
  // Este módulo depende del TEXTO de un `logger.warn` de baileys, que es un
  // acoplamiento feo pero es el único que hay: si mañana cambia la frase, el que
  // avisa es este test y no un usuario mirando una bandeja con números.
  const chats = readFileSync(
    join(import.meta.dir, "..", "node_modules", "baileys", "lib", "Socket", "chats.js"),
    "utf8",
  );

  // Las tres frases, tal cual están en el fuente (con sus interpolaciones).
  expect(chats).toContain(
    "blocked on missing key from v${states[name].version}, parking after ${attemptsMap[name]} attempts",
  );
  expect(chats).toContain("synced ${name} to v${newState.version}");
  expect(chats).toContain("restored state of ${name} from snapshot to v${newState.version}");

  // Y la razón de leer un log en vez de preguntar: `blockedCollections` es un
  // `Set` LOCAL del closure y no sale en lo que devuelve el socket.
  expect(chats).toContain("const blockedCollections = new Set()");
  const devuelto = chats.slice(chats.lastIndexOf("return {"));
  expect(devuelto).not.toContain("blockedCollections");

  // Lo que arma nuestro parser tiene que matchear lo que arma esa plantilla.
  const comoLoEscribe = (name: string, version: number, attempts: number) =>
    `${name} blocked on missing key from v${version}, parking after ${attempts} attempts`;
  expect(leerAviso(comoLoEscribe("regular_low", 68, 2))).toEqual({
    name: "regular_low",
    estacionada: true,
  });
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
