// Tests de la cola de envío (tarea 14): el ritmo de RNF-8, los reintentos de
// RNF-9, el rechazo sin conexión de CA-8.7, el eco que no duplica (CA-9.4) y la
// escalera del estado de entrega (el ⚠️ del plan: un ack fuera de orden NO puede
// bajar un mensaje ya leído).
//
// Cómo está armado y por qué:
//
//   · **El reloj y el agendador son VIRTUALES.** `wa/send.ts` no llama nunca a
//     `setTimeout` ni a `Date.now` por su cuenta (mismo criterio que
//     `state/store.ts`, `wa/ingest.ts` y `wa/socket.ts`), así que el test mide un
//     minuto entero de ritmo de envío en microsegundos y las aserciones de tiempo
//     son EXACTAS, no "más o menos".
//   · **El socket es un doble** con la única función que usa el worker
//     (`sendMessage`), que anota a qué instante virtual se lo llamó. De ahí salen
//     los ≥ 1000 ms y los 1/3/9 s.
//   · **La base es REAL** (`:memory:`). "No inserta nada" sólo significa algo si
//     hay dónde insertar: cada aserción negativa va con su control positivo.
//   · **NADA toca la cuenta real de WhatsApp**: no hay socket de verdad en todo
//     el archivo.
import { beforeEach, describe, expect, test } from "bun:test";
import { ACCOUNT_RESTRICTED_TEXT, proto } from "baileys";
import type { WAMessageUpdate } from "baileys";

import type { Logger } from "../src/boot/log";
import { openDb } from "../src/db/open";
import { createRepo, ORDEN_ESTADO, puedeAvanzar, type Repo } from "../src/db/repo";
import { SEND_MAX_ATTEMPTS } from "../src/lib/backoff";
import { MAX_PER_WINDOW, MIN_GAP_MS } from "../src/lib/ratelimit";
import { createStore, type Store } from "../src/state/store";
import { createIngest, MOTIVO_ACK_RECHAZO, MOTIVO_ACK_RESTRINGIDA } from "../src/wa/ingest";
import {
  AVISO_EN_COLA,
  createSendQueue,
  LIMITE_IMAGEN_BYTES,
  MOTIVO_IMAGEN_NO_REINTENTABLE,
  MOTIVO_IMAGEN_VACIA,
  MOTIVO_NO_FALLADO,
  MOTIVO_SIN_CONEXION,
  MOTIVO_VACIO,
  motivoImagenGrande,
  type SendQueue,
} from "../src/wa/send";

const ANTO = "549115000001@s.whatsapp.net";
const GRUPO = "120000999-1600000000@g.us";
const SELF = "5491133445566:12@s.whatsapp.net";
const SELF_NORM = "5491133445566@s.whatsapp.net";

const LOG: Logger = { info() {}, warn() {}, error() {}, path: "/tmp/wacosas-test.log" };

// ── tiempo virtual ──────────────────────────────────────────────────────────

/**
 * Reloj + agendador virtuales. `avanzar()` dispara el timer más próximo y mueve
 * el reloj hasta él, así el tiempo del test es exactamente el que la cola pidió
 * esperar (y nunca un ms más).
 */
function relojVirtual() {
  let ahora = 1_700_000_000_000;
  let id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => ahora,
    schedule(fn: () => void, ms: number) {
      const k = ++id;
      timers.set(k, { at: ahora + Math.max(0, ms), fn });
      return () => {
        timers.delete(k);
      };
    },
    pendientes: () => timers.size,
    avanzar(): boolean {
      let elegido = -1;
      let at = Number.POSITIVE_INFINITY;
      for (const [k, t] of timers) {
        if (t.at < at) {
          at = t.at;
          elegido = k;
        }
      }
      if (elegido < 0) return false;
      const t = timers.get(elegido) as { at: number; fn: () => void };
      timers.delete(elegido);
      ahora = Math.max(ahora, t.at);
      t.fn();
      return true;
    },
  };
}

/** Deja correr los microtasks y macrotasks REALES que la cola tenga en vuelo. */
async function asentar(vueltas = 4): Promise<void> {
  for (let i = 0; i < vueltas; i++) await new Promise((r) => setTimeout(r, 0));
}

// ── doble de socket ─────────────────────────────────────────────────────────

/** Lo que le llega a `sock.sendMessage`: texto, o imagen con caption (`^V`). */
type ContenidoFalso = { text?: string; image?: Buffer; mimetype?: string; caption?: string };

type Enviado = {
  jid: string;
  /** El cuerpo visible: el texto, o el caption cuando va una imagen. */
  texto: string;
  waId: string;
  at: number;
  /** El contenido CRUDO, para poder afirmar sobre los bytes de la imagen. */
  contenido: ContenidoFalso;
};

function socketFalso(reloj: ReturnType<typeof relojVirtual>) {
  const enviados: Enviado[] = [];
  /** Motivo del rechazo mientras esté seteado; `null` = los envíos salen bien. */
  let falla: string | null = null;
  return {
    enviados,
    /** Todos los intentos, desde ahora, fallan con ese motivo. */
    fallarSiempre(motivo = "la red dijo que no") {
      falla = motivo;
    },
    /** Vuelve a andar (el `Ctrl-Y` de CA-9.3 tiene que poder salir). */
    curar() {
      falla = null;
    },
    sock: {
      async sendMessage(jid: string, contenido: ContenidoFalso, opts: { messageId: string }) {
        enviados.push({
          jid,
          texto: contenido.text ?? contenido.caption ?? "",
          waId: opts.messageId,
          at: reloj.now(),
          contenido,
        });
        if (falla) throw new Error(falla);
        return {
          key: { id: opts.messageId, remoteJid: jid, fromMe: true },
          // Baileys devuelve el proto que armó: para una imagen es un
          // `imageMessage`, nunca un `conversation`.
          message: contenido.image
            ? { imageMessage: { caption: contenido.caption ?? "", mimetype: contenido.mimetype } }
            : { conversation: contenido.text },
        };
      },
    },
  };
}

// ── arnés ───────────────────────────────────────────────────────────────────

type Arnes = {
  repo: Repo;
  store: Store;
  cola: SendQueue;
  reloj: ReturnType<typeof relojVirtual>;
  falso: ReturnType<typeof socketFalso>;
  /** La conexión que ve la cola (`wa.isOpen()`). */
  abierta: { valor: boolean };
  /** Todo lo que la cola pasó por `store.toast`, en orden (CA-19.5). */
  toasts: string[];
};

function armar(): Arnes {
  const repo = createRepo(openDb(":memory:"));
  repo.upsertChat({ jid: ANTO, name: "anto 🌻" });
  repo.upsertChat({ jid: GRUPO, name: "Grupo mañana", isGroup: true });

  const reloj = relojVirtual();
  const store = createStore({ now: reloj.now, schedule: reloj.schedule });
  const falso = socketFalso(reloj);
  const abierta = { valor: true };
  let n = 0;

  // Los toasts se espían sin dejar de pasarlos al store de verdad: lo que se
  // afirma es lo que el usuario ve en el pie (CA-19.5), no una llamada.
  const toasts: string[] = [];
  const toastReal = store.toast;
  store.toast = (t: string) => {
    toasts.push(t);
    toastReal(t);
  };

  const cola = createSendQueue({
    repo,
    store,
    log: LOG,
    wa: {
      isOpen: () => abierta.valor,
      socket: () => (abierta.valor ? (falso.sock as never) : null),
      selfJid: () => SELF,
    },
    now: reloj.now,
    schedule: reloj.schedule,
    // Ids deterministas: `generateMessageIDV2` es aleatorio y no se puede afirmar
    // nada sobre él. Lo que importa del id real (que sea el MISMO que persistimos
    // y el que viaja a WhatsApp) se prueba igual.
    newId: () => `LOCAL${++n}`,
  });

  return { repo, store, cola, reloj, falso, abierta, toasts };
}

/** Corre la cola hasta que no queden esperas pendientes (o se agote el tope). */
async function drenar(a: Arnes, tope = 400): Promise<void> {
  for (let i = 0; i < tope; i++) {
    await asentar();
    if (!a.reloj.avanzar()) break;
  }
  await asentar();
}

/** Los instantes virtuales de cada `sendMessage`, relativos al primero. */
function offsets(a: Arnes): number[] {
  const t0 = a.falso.enviados[0]?.at ?? 0;
  return a.falso.enviados.map((e) => e.at - t0);
}

// ── ritmo de envío (RNF-8) ──────────────────────────────────────────────────

describe("ritmo de envío", () => {
  test("cinco envíos seguidos salen espaciados al menos 1 s", async () => {
    const a = armar();
    for (let i = 1; i <= 5; i++) expect(a.cola.enqueue(ANTO, `mensaje ${i}`).ok).toBe(true);
    // Las cinco filas ya están en la base y en `⏳ enviando` ANTES de que salga
    // la primera (CA-9.1): la pantalla no espera a la red.
    expect(a.repo.lastMessages(ANTO).map((m) => m.status)).toEqual([
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);

    await drenar(a);

    expect(a.falso.enviados.length).toBe(5);
    expect(offsets(a)).toEqual([0, 1000, 2000, 3000, 4000]);
    for (let i = 1; i < 5; i++) {
      const gap = (a.falso.enviados[i] as Enviado).at - (a.falso.enviados[i - 1] as Enviado).at;
      expect(gap).toBeGreaterThanOrEqual(MIN_GAP_MS);
    }
    // Y salieron en ORDEN: la cola es FIFO, no un puñado de promesas sueltas.
    expect(a.falso.enviados.map((e) => e.texto)).toEqual([
      "mensaje 1",
      "mensaje 2",
      "mensaje 3",
      "mensaje 4",
      "mensaje 5",
    ]);
    expect(a.repo.lastMessages(ANTO).every((m) => m.status === "sent")).toBe(true);
  });

  test(`el ${MAX_PER_WINDOW + 1}.º del minuto espera a que se libere la ventana`, async () => {
    const a = armar();
    const total = MAX_PER_WINDOW + 1;
    for (let i = 1; i <= total; i++) a.cola.enqueue(ANTO, `m${i}`);
    await drenar(a, 2_000);

    expect(a.falso.enviados.length).toBe(total);
    const t = offsets(a);
    // Los primeros 20 salen a 1 por segundo…
    expect(t.slice(0, MAX_PER_WINDOW)).toEqual(
      Array.from({ length: MAX_PER_WINDOW }, (_, i) => i * MIN_GAP_MS),
    );
    // …y el 21.º NO sale a los 20 s: espera a que el primero cumpla el minuto.
    expect(t[MAX_PER_WINDOW]).toBe(60_000);
  });
});

// ── el aviso de que se están espaciando los envíos (D8, CA-19.5) ────────────
//
// Sin esto una ráfaga son cinco segundos de `⏳` sin ninguna explicación: el
// usuario no tiene forma de saber que el silencio es el rate limit de RNF-8 y no
// un cuelgue. Ojo con el detalle que lo hacía inútil: el limitador da 1 s casi
// siempre, porque el worker es serial y pide turno recién cuando toma el job.

describe("aviso de cola", () => {
  test("una ráfaga avisa que se están espaciando los envíos", async () => {
    const a = armar();
    for (let i = 1; i <= 6; i++) expect(a.cola.enqueue(ANTO, `m${i}`).ok).toBe(true);

    // El aviso sale al ENCOLAR, no cuando el mensaje llega a su turno: para
    // entonces ya pasaron los cinco segundos que había que explicar.
    expect(a.toasts).toContain(AVISO_EN_COLA);
    // Y sale en el pie, que es donde el usuario lo lee (CA-19.5).
    expect(a.store.getSnapshot("ui").toast?.text).toBe(AVISO_EN_COLA);

    await drenar(a);
    expect(a.falso.enviados.length).toBe(6);
  });

  test("un mensaje solo, con la cola vacía, no avisa nada", async () => {
    const a = armar();
    expect(a.cola.enqueue(ANTO, "único").ok).toBe(true);
    await drenar(a);
    // Sale en el acto: avisar acá sería ruido.
    expect(a.toasts).toEqual([]);
    expect(a.falso.enviados.length).toBe(1);
  });

  test(`el ${MAX_PER_WINDOW + 1}.º del minuto avisa aunque la cola esté vacía`, async () => {
    const a = armar();
    // De a uno y esperando cada envío: la cola nunca tiene a nadie adelante, así
    // que el único que puede avisar es el limitador cuando se cierra la ventana.
    for (let i = 1; i <= MAX_PER_WINDOW; i++) {
      a.cola.enqueue(ANTO, `m${i}`);
      await drenar(a);
    }
    expect(a.toasts).toEqual([]);

    a.cola.enqueue(ANTO, "el que espera el minuto");
    await drenar(a, 2_000);
    expect(a.toasts).toEqual([AVISO_EN_COLA]);
    expect(a.falso.enviados.length).toBe(MAX_PER_WINDOW + 1);
  });
});

// ── reintentos (RNF-9, CA-9.3) ──────────────────────────────────────────────

describe("reintentos", () => {
  test("un envío que falla se reintenta 3 veces con 1/3/9 s y termina en failed", async () => {
    const a = armar();
    a.falso.fallarSiempre("la red dijo que no");
    const r = a.cola.enqueue(ANTO, "esto no va a salir");
    expect(r.ok).toBe(true);

    await drenar(a);

    // 1 intento + 3 reintentos = 4 llamadas a `sendMessage`, ni una más.
    expect(a.falso.enviados.length).toBe(SEND_MAX_ATTEMPTS + 1);
    // Las esperas ENTRE intentos son exactamente 1 s, 3 s y 9 s (RNF-9). El
    // limitador no agrega nada: su gap de 1 s ya se cumplió esperando.
    const t = offsets(a);
    expect([t[1], t[2], t[3]]).toEqual([1_000, 4_000, 13_000]);
    // Y siempre el MISMO id: un reintento no es un mensaje nuevo (D7).
    expect(new Set(a.falso.enviados.map((e) => e.waId)).size).toBe(1);

    const fila = a.repo.lastMessages(ANTO)[0];
    expect(fila?.status).toBe("failed");
    expect(fila?.error).toBe("la red dijo que no"); // CA-9.3: el motivo, a la vista
  });

  test("Ctrl-Y reencola el fallado y, si esta vez sale, queda en sent", async () => {
    const a = armar();
    a.falso.fallarSiempre();
    const r = a.cola.enqueue(ANTO, "reintentame");
    await drenar(a);
    expect(a.repo.lastMessages(ANTO)[0]?.status).toBe("failed");

    // Ahora la red anda y se reintenta a mano (CA-9.3).
    a.falso.curar();
    const reintento = a.cola.retry(ANTO, r.waId as string);
    expect(reintento.ok).toBe(true);
    // Vuelve a `⏳ enviando` en el acto y sin el motivo viejo colgado.
    const enVuelo = a.repo.lastMessages(ANTO)[0];
    expect(enVuelo?.status).toBe("pending");
    expect(enVuelo?.error).toBe(null);

    await drenar(a);
    expect(a.repo.lastMessages(ANTO)[0]?.status).toBe("sent");
    // Sigue habiendo UNA sola fila: reintentar no duplica el mensaje.
    expect(a.repo.lastMessages(ANTO).length).toBe(1);
  });

  test("no se reintenta lo que no está fallado", async () => {
    const a = armar();
    const r = a.cola.enqueue(ANTO, "esta salió bien");
    await drenar(a);
    const fallo = a.cola.retry(ANTO, r.waId as string);
    expect(fallo).toEqual({ ok: false, reason: MOTIVO_NO_FALLADO });
    expect(a.falso.enviados.length).toBe(1);
  });
});

// ── el mensaje YA SALIÓ: nada de lo de después vuelve a la red ──────────────

describe("un error después del envío no lo reenvía", () => {
  test("si `repo.tx` lanza DESPUÉS de que el mensaje salió, sale UNA sola vez", async () => {
    const a = armar();
    const r = a.cola.enqueue(ANTO, "hola de verdad");
    expect(r.ok).toBe(true);

    // La base se rompe justo cuando el worker va a persistir el `sent`:
    // SQLITE_BUSY, disco lleno, o la base cerrada por el apagado (tarea 17). El
    // `enqueue` de arriba ya guardó su fila, así que esto sólo pega en el `tx`
    // del worker — el que corre con el mensaje YA entregado a WhatsApp.
    a.repo.tx = ((): never => {
      throw new Error("database is locked");
    }) as Repo["tx"];

    await drenar(a);

    // Lo único que importa: la persona del otro lado recibió UN mensaje, no
    // cuatro. Un error de la BASE no puede reintentar la RED.
    expect(a.falso.enviados.length).toBe(1);
    expect(a.falso.enviados.map((e) => e.texto)).toEqual(["hola de verdad"]);
    // La fila queda `pending` (⏳): no se pudo escribir el `sent`, y eso lo
    // corrige el eco/ack de WhatsApp. Lo que NO puede quedar es `failed`, que
    // le ofrecería al usuario un `Ctrl-Y` que duplicaría el mensaje.
    expect(a.repo.lastMessages(ANTO).map((m) => m.status)).toEqual(["pending"]);
  });
});

// ── sin conexión (CA-8.7) ───────────────────────────────────────────────────

describe("sin conexión", () => {
  test("enqueue devuelve {ok:false} y NO inserta nada", async () => {
    const a = armar();
    a.abierta.valor = false;

    const r = a.cola.enqueue(ANTO, "esto se tiene que quedar en el campo");
    expect(r).toEqual({ ok: false, reason: MOTIVO_SIN_CONEXION });
    // Ni fila, ni preview en la bandeja, ni trabajo encolado.
    expect(a.repo.lastMessages(ANTO)).toEqual([]);
    expect(a.repo.getChat(ANTO)?.lastPreview).toBe("");
    expect(a.cola.size()).toBe(0);

    await drenar(a);
    expect(a.falso.enviados.length).toBe(0);

    // Control positivo: con la conexión abierta, lo mismo SÍ entra.
    a.abierta.valor = true;
    expect(a.cola.enqueue(ANTO, "ahora sí").ok).toBe(true);
    expect(a.repo.lastMessages(ANTO).length).toBe(1);
  });

  test("la conexión se cae DESPUÉS de encolar: reintenta y termina en failed", async () => {
    const a = armar();
    a.cola.enqueue(ANTO, "en el aire");
    a.abierta.valor = false;
    await drenar(a);

    // Nunca llegó a la red y quedó fallado con motivo (no en `pending` para
    // siempre, que sería el peor final posible).
    expect(a.falso.enviados.length).toBe(0);
    const fila = a.repo.lastMessages(ANTO)[0];
    expect(fila?.status).toBe("failed");
    expect(fila?.error).toBe(MOTIVO_SIN_CONEXION);
  });

  test("un texto vacío o de puros espacios no manda nada (CA-8.3)", () => {
    const a = armar();
    expect(a.cola.enqueue(ANTO, "   \n  ")).toEqual({ ok: false, reason: MOTIVO_VACIO });
    expect(a.repo.lastMessages(ANTO)).toEqual([]);
  });
});

// ── lo que se persiste (D7, CA-8.4, CA-8.8) ─────────────────────────────────

describe("la fila optimista", () => {
  test("se guarda con NUESTRO id, propia y con el salto de línea intacto", async () => {
    const a = armar();
    const r = a.cola.enqueue(ANTO, "  hola\nsegunda línea  ");
    expect(r.ok).toBe(true);

    const fila = a.repo.lastMessages(ANTO)[0];
    expect(fila?.waId).toBe(r.waId as string);
    expect(fila?.fromMe).toBe(true);
    expect(fila?.senderJid).toBe(SELF_NORM);
    expect(fila?.kind).toBe("text");
    // Se recorta en las PUNTAS y el salto del medio viaja tal cual (CA-8.4).
    expect(fila?.body).toBe("hola\nsegunda línea");
    // El chat sube a lo más nuevo con el preview de una línea (CA-4.5).
    expect(a.repo.getChat(ANTO)?.lastPreview).toBe("hola segunda línea");
    expect(a.repo.getChat(ANTO)?.lastFromMe).toBe(true);

    await drenar(a);
    // A WhatsApp le va el MISMO texto y el MISMO id (D7).
    expect(a.falso.enviados[0]?.texto).toBe("hola\nsegunda línea");
    expect(a.falso.enviados[0]?.waId).toBe(r.waId as string);
  });

  test("también en un grupo (CA-8.8)", async () => {
    const a = armar();
    expect(a.cola.enqueue(GRUPO, "voy con la camioneta").ok).toBe(true);
    await drenar(a);
    expect(a.falso.enviados[0]?.jid).toBe(GRUPO);
    expect(a.repo.lastMessages(GRUPO)[0]?.status).toBe("sent");
  });

  test("el eco de WhatsApp NO duplica la fila (CA-9.4)", async () => {
    const a = armar();
    const r = a.cola.enqueue(ANTO, "una sola vez");
    await drenar(a);

    // Así entra el eco por `messages.upsert`: el mismo `wa_id`, ya como `sent`.
    const eco = a.repo.insertMessage({
      chatJid: ANTO,
      waId: r.waId as string,
      fromMe: true,
      senderJid: SELF_NORM,
      senderName: "",
      ts: Math.floor(a.reloj.now() / 1000),
      kind: "text",
      body: "una sola vez",
      attachment: null,
      status: "sent",
    });
    expect(eco.inserted).toBe(false); // el índice único lo descartó solo
    expect(a.repo.lastMessages(ANTO).length).toBe(1);
  });

  test("getMessage devuelve el proto del último envío (§8.6)", async () => {
    const a = armar();
    const r = a.cola.enqueue(ANTO, "reenviame esto");
    await drenar(a);
    const msg = await a.cola.getMessage({ id: r.waId as string, remoteJid: ANTO, fromMe: true });
    expect(msg?.conversation).toBe("reenviame esto");
    // Un id que nunca mandamos no inventa nada.
    expect(await a.cola.getMessage({ id: "NOEXISTE", remoteJid: ANTO, fromMe: true })).toBe(
      undefined,
    );
  });
});

// ── imágenes del portapapeles (`^V`) ────────────────────────────────────────
//
// Lo que se prueba acá NO es "que la imagen salga": es que **use la misma cola
// que el texto**. El riesgo real de esta feature era abrirle un camino paralelo
// —mandar la imagen derecho al socket— y saltearse el ritmo de RNF-8, que es lo
// único que separa a wacosas de parecer un bot y comerse un ban (R8).

/** Un PNG mínimo pero con la firma REAL: el mime sale de los bytes. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const imagen = (bytes: Uint8Array = PNG, mime = "image/png") => ({ bytes, mime });

describe("enviar una imagen", () => {
  test("va por la MISMA cola que el texto y respeta el ritmo de 1/s", async () => {
    const a = armar();
    // Mezcladas a propósito: si las imágenes tuvieran su propio camino, se
    // adelantarían a los textos o saldrían todas juntas.
    expect(a.cola.enqueue(ANTO, "mirá esto").ok).toBe(true);
    expect(a.cola.enqueueImage(ANTO, imagen(), "la captura").ok).toBe(true);
    expect(a.cola.enqueueImage(ANTO, imagen()).ok).toBe(true);
    expect(a.cola.enqueue(ANTO, "listo").ok).toBe(true);

    // Las cuatro filas ya están en `⏳` antes de que salga la primera (CA-9.1).
    expect(a.repo.lastMessages(ANTO).map((m) => m.status)).toEqual([
      "pending",
      "pending",
      "pending",
      "pending",
    ]);

    await drenar(a);

    expect(a.falso.enviados.length).toBe(4);
    // RNF-8, exactamente igual que con cuatro textos: uno por segundo y en orden.
    expect(offsets(a)).toEqual([0, 1000, 2000, 3000]);
    expect(a.falso.enviados.map((e) => !!e.contenido.image)).toEqual([false, true, true, false]);
    expect(a.repo.lastMessages(ANTO).every((m) => m.status === "sent")).toBe(true);
  });

  test(`el ${MAX_PER_WINDOW + 1}.º del minuto también espera si es una imagen`, async () => {
    const a = armar();
    for (let i = 1; i <= MAX_PER_WINDOW; i++) a.cola.enqueue(ANTO, `m${i}`);
    a.cola.enqueueImage(ANTO, imagen(), "la que se pasa del tope");
    await drenar(a, 2_000);

    expect(a.falso.enviados.length).toBe(MAX_PER_WINDOW + 1);
    // El tope de 20 por minuto no distingue imágenes de textos.
    expect(offsets(a)[MAX_PER_WINDOW]).toBe(60_000);
    expect(a.toasts).toContain(AVISO_EN_COLA);
  });

  test("una imagen que falla se reintenta 3 veces con 1/3/9 s y termina en failed", async () => {
    const a = armar();
    a.falso.fallarSiempre("la subida se cortó");
    expect(a.cola.enqueueImage(ANTO, imagen(), "esta no va a salir").ok).toBe(true);

    await drenar(a);

    // Mismos reintentos que un texto (RNF-9): 1 intento + 3.
    expect(a.falso.enviados.length).toBe(SEND_MAX_ATTEMPTS + 1);
    const t = offsets(a);
    expect([t[1], t[2], t[3]]).toEqual([1_000, 4_000, 13_000]);
    // Y siempre el MISMO id: un reintento no es un mensaje nuevo (D7).
    expect(new Set(a.falso.enviados.map((e) => e.waId)).size).toBe(1);
    // Los bytes viajaron en los cuatro intentos: el job los lleva en memoria.
    expect(a.falso.enviados.every((e) => (e.contenido.image as Buffer)?.length === PNG.length)).toBe(true);

    const fila = a.repo.lastMessages(ANTO)[0];
    expect(fila?.status).toBe("failed");
    expect(fila?.error).toBe("la subida se cortó");
  });

  test("la fila optimista se ve como imagen, con el caption debajo", async () => {
    const a = armar();
    const r = a.cola.enqueueImage(ANTO, imagen(), "  mirá la terminal  ");
    expect(r.ok).toBe(true);

    const fila = a.repo.lastMessages(ANTO)[0];
    expect(fila?.kind).toBe("image");
    expect(fila?.fromMe).toBe(true);
    // El placeholder es el MISMO que el de una imagen recibida (CA-7.1): la
    // conversación pinta `📷 imagen` y el caption abajo (CA-7.2).
    expect(fila?.attachment?.label).toBe("📷 imagen");
    expect(fila?.attachment?.mimetype).toBe("image/png");
    // El caption se recorta en las puntas, igual que un mensaje de texto.
    expect(fila?.body).toBe("mirá la terminal");
    // ⚠️ CA-7.4 en el otro sentido: en la base NO queda ni un byte de la imagen.
    expect(JSON.stringify(fila?.attachment)).not.toContain("bytes");
    // Y el preview de la bandeja lleva las dos cosas.
    expect(a.repo.getChat(ANTO)?.lastPreview).toBe("📷 imagen · mirá la terminal");

    await drenar(a);
    // A WhatsApp le fue la imagen con su mime, el caption y NUESTRO id (D7).
    const enviado = a.falso.enviados[0];
    expect(Array.from(enviado?.contenido.image as Buffer)).toEqual(Array.from(PNG));
    expect(enviado?.contenido.mimetype).toBe("image/png");
    expect(enviado?.contenido.caption).toBe("mirá la terminal");
    expect(enviado?.waId).toBe(r.waId as string);
  });

  test("sin caption no se manda un caption vacío (y el mensaje es válido igual)", async () => {
    const a = armar();
    // CA-8.3 (vacío no manda nada) NO aplica: una foto sola es un mensaje.
    expect(a.cola.enqueueImage(ANTO, imagen()).ok).toBe(true);
    await drenar(a);
    expect("caption" in (a.falso.enviados[0]?.contenido ?? {})).toBe(false);
    expect(a.repo.lastMessages(ANTO)[0]?.body).toBe("");
    expect(a.repo.getChat(ANTO)?.lastPreview).toBe("📷 imagen");
  });

  test("también en un grupo", async () => {
    const a = armar();
    expect(a.cola.enqueueImage(GRUPO, imagen(), "acá está").ok).toBe(true);
    await drenar(a);
    expect(a.falso.enviados[0]?.jid).toBe(GRUPO);
    expect(a.repo.lastMessages(GRUPO)[0]?.status).toBe("sent");
  });

  test("el eco de WhatsApp tampoco duplica la imagen (CA-9.4)", async () => {
    const a = armar();
    const r = a.cola.enqueueImage(ANTO, imagen(), "una sola vez");
    await drenar(a);
    const eco = a.repo.insertMessage({
      chatJid: ANTO,
      waId: r.waId as string,
      fromMe: true,
      senderJid: SELF_NORM,
      senderName: "",
      ts: Math.floor(a.reloj.now() / 1000),
      kind: "image",
      body: "una sola vez",
      attachment: { label: "📷 imagen" },
      status: "sent",
    });
    expect(eco.inserted).toBe(false);
    expect(a.repo.lastMessages(ANTO).length).toBe(1);
  });

  test("getMessage NO devuelve la imagen como si fuera un texto", async () => {
    const a = armar();
    const r = a.cola.enqueueImage(ANTO, imagen(), "el caption");
    await drenar(a);
    const msg = await a.cola.getMessage({ id: r.waId as string, remoteJid: ANTO, fromMe: true });
    // Lo que se cachea es el proto que devolvió baileys. El bug que esto evita
    // sería guardar `{conversation: caption}` de fallback: al re-cifrar por un
    // retry receipt, la foto le llegaría al otro como un mensaje de texto suelto.
    expect(msg?.imageMessage).toBeDefined();
    expect(msg?.conversation).toBeUndefined();
  });
});

// ── el tope de tamaño: rechazar ANTES de subir ──────────────────────────────

describe("el tope de tamaño de una imagen", () => {
  test("una imagen que se pasa se rechaza ANTES de tocar la red", async () => {
    const a = armar();
    // Un byte más que el tope. Lo importante no es el número: es que el rechazo
    // ocurra sin haber subido nada.
    const gorda = new Uint8Array(LIMITE_IMAGEN_BYTES + 1);
    gorda.set(PNG, 0);

    const r = a.cola.enqueueImage(ANTO, imagen(gorda), "esta no entra");
    expect(r).toEqual({ ok: false, reason: motivoImagenGrande(gorda.length) });
    // El mensaje tiene que ser entendible: qué pesa y cuál es el tope.
    expect(r.reason).toContain("16 MB");

    // Ni fila, ni preview, ni trabajo encolado…
    expect(a.repo.lastMessages(ANTO)).toEqual([]);
    expect(a.repo.getChat(ANTO)?.lastPreview).toBe("");
    expect(a.cola.size()).toBe(0);
    // …y sobre todo: NINGUNA llamada a la red. Ese es el punto del tope.
    await drenar(a);
    expect(a.falso.enviados.length).toBe(0);

    // Control positivo: justo en el tope SÍ entra (el rechazo es `>`, no `>=`).
    const justa = new Uint8Array(LIMITE_IMAGEN_BYTES);
    justa.set(PNG, 0);
    expect(a.cola.enqueueImage(ANTO, imagen(justa), "esta sí").ok).toBe(true);
    await drenar(a);
    expect(a.falso.enviados.length).toBe(1);
  });

  test("una imagen sin bytes no manda nada", async () => {
    const a = armar();
    expect(a.cola.enqueueImage(ANTO, imagen(new Uint8Array()))).toEqual({
      ok: false,
      reason: MOTIVO_IMAGEN_VACIA,
    });
    expect(a.repo.lastMessages(ANTO)).toEqual([]);
  });

  test("sin conexión tampoco se encola ni se inserta (CA-8.7)", async () => {
    const a = armar();
    a.abierta.valor = false;
    expect(a.cola.enqueueImage(ANTO, imagen(), "quedate")).toEqual({
      ok: false,
      reason: MOTIVO_SIN_CONEXION,
    });
    expect(a.repo.lastMessages(ANTO)).toEqual([]);
  });
});

// ── `Ctrl-Y` sobre una imagen ───────────────────────────────────────────────

test("Ctrl-Y sobre una imagen fallada explica que ya no está en memoria", async () => {
  // Consecuencia directa de no guardar bytes en la base (CA-7.4): los reintentos
  // AUTOMÁTICOS funcionan (el job vive en memoria), pero un `^Y` de más tarde ya
  // no tiene qué mandar. Lo que no puede pasar es que la tecla falle en silencio
  // o, peor, que mande una imagen vacía.
  const a = armar();
  a.falso.fallarSiempre();
  const r = a.cola.enqueueImage(ANTO, imagen(), "se cayó");
  await drenar(a);
  expect(a.repo.lastMessages(ANTO)[0]?.status).toBe("failed");

  a.falso.curar();
  expect(a.cola.retry(ANTO, r.waId as string)).toEqual({
    ok: false,
    reason: MOTIVO_IMAGEN_NO_REINTENTABLE,
  });
  await drenar(a);
  // No salió NADA de más: ni una imagen vacía ni el caption como texto suelto.
  expect(a.falso.enviados.length).toBe(SEND_MAX_ATTEMPTS + 1);
  expect(a.falso.enviados.every((e) => !!e.contenido.image)).toBe(true);
});

// ── escalera del estado de entrega (⚠️ del plan) ────────────────────────────

describe("el estado de entrega no retrocede", () => {
  let repo: Repo;
  const WA = "ABC123";

  beforeEach(() => {
    repo = createRepo(openDb(":memory:"));
    repo.upsertChat({ jid: ANTO, name: "anto 🌻" });
    repo.insertMessage({
      chatJid: ANTO,
      waId: WA,
      fromMe: true,
      senderJid: SELF_NORM,
      senderName: "",
      ts: 1_700_000_000,
      kind: "text",
      body: "hola",
      attachment: null,
      status: "pending",
    });
  });

  const estado = (): string => repo.getMessageByWaId(ANTO, WA)?.status as string;

  test("la escalera sube pero no baja", () => {
    expect(puedeAvanzar("pending", "sent")).toBe(true);
    expect(puedeAvanzar("sent", "delivered")).toBe(true);
    expect(puedeAvanzar("delivered", "read")).toBe(true);
    expect(puedeAvanzar("read", "delivered")).toBe(false);
    expect(puedeAvanzar("read", "sent")).toBe(false);
    expect(puedeAvanzar("delivered", "sent")).toBe(false);
    expect(puedeAvanzar("sent", "pending")).toBe(false);
    // `failed` y `pending` comparten escalón: el reintento manual vuelve.
    expect(puedeAvanzar("pending", "failed")).toBe(true);
    expect(puedeAvanzar("failed", "pending")).toBe(true);
    expect(ORDEN_ESTADO.read).toBeGreaterThan(ORDEN_ESTADO.delivered as number);

    // `failed` es la EXCEPCIÓN de la escalera: se puede caer ahí DESDE `sent`,
    // porque el ERROR ack de WhatsApp (403, 479 `smax-invalid`, "temporarily
    // restricted") llega siempre después de que escribimos `sent` —
    // `sock.sendMessage` no espera el ack—. Bloquearlo era perder la única
    // señal de que nos están limitando.
    expect(puedeAvanzar("sent", "failed")).toBe(true);
    // Pero `delivered` y `read` son prueba de que el mensaje LLEGÓ: de ahí no baja.
    expect(puedeAvanzar("delivered", "failed")).toBe(false);
    expect(puedeAvanzar("read", "failed")).toBe(false);
  });

  test("un SERVER_ACK atrasado no degrada un mensaje ya leído", () => {
    repo.setMessageStatus(ANTO, WA, "sent");
    repo.setMessageStatus(ANTO, WA, "delivered");
    repo.setMessageStatus(ANTO, WA, "read");
    expect(estado()).toBe("read");

    // El ack fuera de orden: doble tilde azul → un tilde. NO.
    repo.setMessageStatus(ANTO, WA, "sent");
    expect(estado()).toBe("read");
    repo.setMessageStatus(ANTO, WA, "delivered");
    expect(estado()).toBe("read");
  });

  test("por el camino REAL del ingest tampoco retrocede (sin tocar ingest.ts)", () => {
    const reloj = relojVirtual();
    const store = createStore({ now: reloj.now, schedule: reloj.schedule });
    const ingest = createIngest({
      repo,
      store,
      log: LOG,
      selfJid: () => SELF,
      openChatJid: () => ANTO,
      now: reloj.now,
      schedule: reloj.schedule,
    });

    const ack = (status: number): WAMessageUpdate => ({
      key: { remoteJid: ANTO, id: WA, fromMe: true },
      update: { status },
    });

    ingest.push({ kind: "msg-updates", updates: [ack(proto.WebMessageInfo.Status.READ)] });
    ingest.drainNow();
    expect(estado()).toBe("read");

    // El caso reproducido en la tarea 7: llega tarde el `SERVER_ACK` del mismo
    // mensaje. Antes bajaba a `sent`; ahora la escalera lo frena en el repo.
    ingest.push({ kind: "msg-updates", updates: [ack(proto.WebMessageInfo.Status.SERVER_ACK)] });
    ingest.drainNow();
    expect(estado()).toBe("read");

    // Control positivo: el ingest SÍ sigue aplicando lo que es un avance.
    repo.setMessageWaId(ANTO, WA, "OTRO");
    repo.insertMessage({
      chatJid: ANTO,
      waId: WA,
      fromMe: true,
      senderJid: SELF_NORM,
      senderName: "",
      ts: 1_700_000_100,
      kind: "text",
      body: "otro",
      attachment: null,
      status: "pending",
    });
    ingest.push({ kind: "msg-updates", updates: [ack(proto.WebMessageInfo.Status.DELIVERY_ACK)] });
    ingest.drainNow();
    expect(estado()).toBe("delivered");
  });

  // ── el ERROR ack: la única señal de que WhatsApp rechazó el mensaje ────────
  //
  // `sock.sendMessage` NO espera el ack (`relayMessage` vuelve apenas manda la
  // stanza), así que nuestro `sent` se escribe SIEMPRE antes de que llegue el
  // `messages.update` con `status: ERROR` —el ack con `attrs.error`: 403, 479
  // `smax-invalid`, "user is temporarily restricted"—. Con la escalera a secas
  // esa señal se perdía siempre y el mensaje rechazado quedaba en `✓ enviado`.

  /** Un ingest de verdad sobre el mismo repo: los acks entran por donde entran en vivo. */
  function ingestReal() {
    const reloj = relojVirtual();
    const store = createStore({ now: reloj.now, schedule: reloj.schedule });
    return createIngest({
      repo,
      store,
      log: LOG,
      selfJid: () => SELF,
      openChatJid: () => ANTO,
      now: reloj.now,
      schedule: reloj.schedule,
    });
  }

  const ackDe = (status: number, stub?: string[]): WAMessageUpdate => ({
    key: { remoteJid: ANTO, id: WA, fromMe: true },
    update: { status, ...(stub ? { messageStubParameters: stub } : {}) },
  });

  test("el ERROR ack baja un `sent` a `failed` y lo deja al alcance de Ctrl-Y", () => {
    const ingest = ingestReal();
    // Así queda SIEMPRE la fila cuando el ERROR llega: el worker ya escribió `sent`.
    repo.setMessageStatus(ANTO, WA, "sent", null);
    expect(estado()).toBe("sent");

    ingest.push({ kind: "msg-updates", updates: [ackDe(proto.WebMessageInfo.Status.ERROR, ["403"])] });
    ingest.drainNow();

    expect(estado()).toBe("failed");
    // Y aparece en `openSends`, que es de donde `Ctrl-Y` saca el último fallado
    // del chat (`commands.retrySend`). Antes devolvía "no hay ningún envío
    // fallado en este chat" sobre un mensaje que WhatsApp había rechazado.
    expect(repo.openSends().map((m) => m.waId)).toEqual([WA]);
    // Y con el MOTIVO adelante (tarea 15): el código viene en
    // `messageStubParameters` (`[attrs.error]`) y `ui/MessageRow.tsx` lo pinta
    // al lado del `✗`. Sin esto el usuario veía la cruz sin ninguna explicación.
    expect(repo.getMessageByWaId(ANTO, WA)?.error).toBe(`${MOTIVO_ACK_RECHAZO} (403)`);
  });

  test("un rechazo por cuenta restringida se explica distinto", () => {
    const ingest = ingestReal();
    repo.setMessageStatus(ANTO, WA, "sent", null);
    // El otro formato que emite baileys (`Socket/messages-recv.js:1563`): el
    // código + el texto de la restricción. Cambia qué hacer —reintentar con
    // `Ctrl-Y` no destraba una cuenta limitada—, así que se dice distinto.
    ingest.push({
      kind: "msg-updates",
      updates: [ackDe(proto.WebMessageInfo.Status.ERROR, ["479", ACCOUNT_RESTRICTED_TEXT])],
    });
    ingest.drainNow();

    expect(repo.getMessageByWaId(ANTO, WA)?.error).toBe(`${MOTIVO_ACK_RESTRINGIDA} (479)`);
  });

  test("un ack que AVANZA limpia el motivo del intento anterior", () => {
    const ingest = ingestReal();
    repo.setMessageStatus(ANTO, WA, "failed", "algo viejo");
    // `Ctrl-Y` lo vuelve a mandar y esta vez sale: la fila no puede quedarse con
    // el texto del fallo anterior colgando.
    repo.setMessageStatus(ANTO, WA, "pending", null);
    ingest.push({ kind: "msg-updates", updates: [ackDe(proto.WebMessageInfo.Status.DELIVERY_ACK)] });
    ingest.drainNow();

    expect(estado()).toBe("delivered");
    expect(repo.getMessageByWaId(ANTO, WA)?.error).toBe(null);
  });

  test("el ERROR ack NO baja un mensaje que ya llegó (delivered / read)", () => {
    const ingest = ingestReal();
    repo.setMessageStatus(ANTO, WA, "delivered", null);
    ingest.push({ kind: "msg-updates", updates: [ackDe(proto.WebMessageInfo.Status.ERROR)] });
    ingest.drainNow();
    // El doble tilde es prueba de que el mensaje llegó: no hay `✗` que valga.
    expect(estado()).toBe("delivered");

    repo.setMessageStatus(ANTO, WA, "read", null);
    ingest.push({ kind: "msg-updates", updates: [ackDe(proto.WebMessageInfo.Status.ERROR)] });
    ingest.drainNow();
    expect(estado()).toBe("read");
    // Ninguno de los dos queda ofreciendo un reintento que duplicaría el mensaje.
    expect(repo.openSends()).toEqual([]);
  });

  test("un envío que YA salió no se baja a `failed` aunque su promesa lance", async () => {
    // El otro lado del escalón `sent → failed`: ahora que el repo lo permite, el
    // que tiene que frenarse es `wa/send.ts`. `sendMessage` lanza (timeout del
    // socket) DESPUÉS de que la stanza salió y el server la acusó: el mensaje SÍ
    // se mandó, y ponerle `✗` sería invitar al usuario a duplicarlo con Ctrl-Y.
    const a = armar();
    a.falso.fallarSiempre("socket timeout");
    const r = a.cola.enqueue(ANTO, "salió igual");
    // El ack entra por el ingest mientras la promesa está lanzando.
    a.repo.setMessageStatus(ANTO, r.waId as string, "sent", null);

    await drenar(a);

    expect(a.repo.lastMessages(ANTO)[0]?.status).toBe("sent");
    expect(a.repo.lastMessages(ANTO)[0]?.error).toBe(null);
    // Nada que reintentar: `Ctrl-Y` no lo encuentra.
    expect(a.repo.openSends()).toEqual([]);
  });

  test("un DELIVERY_ACK que se adelanta al `sent` del propio envío gana", async () => {
    // Carrera real: el ack llega antes de que `sendMessage` resuelva. El worker
    // escribe `sent` DESPUÉS, y no puede bajarle el estado al mensaje.
    const a = armar();
    const r = a.cola.enqueue(ANTO, "carrera");
    a.repo.setMessageStatus(ANTO, r.waId as string, "delivered");
    await drenar(a);
    expect(a.repo.lastMessages(ANTO)[0]?.status).toBe("delivered");
  });
});
