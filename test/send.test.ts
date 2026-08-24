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
import { proto } from "baileys";
import type { WAMessageUpdate } from "baileys";

import type { Logger } from "../src/boot/log";
import { openDb } from "../src/db/open";
import { createRepo, ORDEN_ESTADO, puedeAvanzar, type Repo } from "../src/db/repo";
import { SEND_MAX_ATTEMPTS } from "../src/lib/backoff";
import { MAX_PER_WINDOW, MIN_GAP_MS } from "../src/lib/ratelimit";
import { createStore, type Store } from "../src/state/store";
import { createIngest } from "../src/wa/ingest";
import {
  createSendQueue,
  MOTIVO_NO_FALLADO,
  MOTIVO_SIN_CONEXION,
  MOTIVO_VACIO,
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

type Enviado = { jid: string; texto: string; waId: string; at: number };

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
      async sendMessage(jid: string, contenido: { text: string }, opts: { messageId: string }) {
        enviados.push({ jid, texto: contenido.text, waId: opts.messageId, at: reloj.now() });
        if (falla) throw new Error(falla);
        return {
          key: { id: opts.messageId, remoteJid: jid, fromMe: true },
          message: { conversation: contenido.text },
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

  return { repo, store, cola, reloj, falso, abierta };
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
    expect(puedeAvanzar("read", "failed")).toBe(false);
    // `failed` y `pending` comparten escalón: el reintento manual vuelve.
    expect(puedeAvanzar("pending", "failed")).toBe(true);
    expect(puedeAvanzar("failed", "pending")).toBe(true);
    expect(ORDEN_ESTADO.read).toBeGreaterThan(ORDEN_ESTADO.delivered as number);
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
