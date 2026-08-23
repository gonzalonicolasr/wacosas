// Tests del store externo: coalescing (RNF-5, CA-4.3), identidad estable de los
// snapshots (requisito de `useSyncExternalStore`), bootstrap sincrónico
// (CA-13.1) y toast efímero (CA-19.5).
//
// El reloj y el agendado se inyectan (`relojFalso`), igual que el `now` de
// `lib/ratelimit.ts`: los diez segundos de tráfico continuo del test de la tasa
// de notify se simulan en microsegundos en vez de esperarlos de verdad.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../src/db/open";
import { createRepo, VENTANA_DEFAULT, type Repo } from "../src/db/repo";
import type { MappedMessage } from "../src/db/types";
import {
  createStore,
  FRAME_MS,
  getSnapshot,
  markDirty,
  subscribe,
  TOAST_MS,
  type Store,
} from "../src/state/store";
import { seedDb } from "./fixtures/seed";

const tmp = mkdtempSync(join(tmpdir(), "wacosas-store-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const CHAT = "5491150000001@s.whatsapp.net";

// ── reloj virtual ───────────────────────────────────────────────────────────

type Timer = { id: number; at: number; fn: () => void };

/**
 * Reloj + agendador falsos. `avanzar(ms)` mueve el tiempo disparando en orden
 * todo lo que venza en el camino, incluidos los timers que agenden los propios
 * callbacks (el toast agenda su limpieza desde adentro de un flush).
 */
function relojFalso() {
  let t = 0;
  let siguienteId = 1;
  const timers: Timer[] = [];

  return {
    now: () => t,
    schedule(fn: () => void, ms: number) {
      const id = siguienteId++;
      timers.push({ id, at: t + Math.max(0, ms), fn });
      return () => {
        const i = timers.findIndex((x) => x.id === id);
        if (i >= 0) timers.splice(i, 1);
      };
    },
    avanzar(ms: number) {
      const destino = t + ms;
      for (;;) {
        let i = -1;
        for (let k = 0; k < timers.length; k++) {
          if (timers[k]!.at <= destino && (i < 0 || timers[k]!.at < timers[i]!.at)) i = k;
        }
        if (i < 0) break;
        const timer = timers.splice(i, 1)[0]!;
        t = Math.max(t, timer.at);
        timer.fn();
      }
      t = destino;
    },
    pendientes: () => timers.length,
  };
}

/** Un store con reloj virtual y su mando a distancia. */
function conRelojFalso(): { store: Store; reloj: ReturnType<typeof relojFalso> } {
  const reloj = relojFalso();
  return { store: createStore({ now: reloj.now, schedule: reloj.schedule }), reloj };
}

// ── base de juguete ─────────────────────────────────────────────────────────

function base(opts: { chats?: number; messages?: number } = {}) {
  const db = openDb(":memory:");
  const sembrado = seedDb(db, { chats: opts.chats ?? 3, messages: opts.messages ?? 30 });
  return { db, repo: createRepo(db), ...sembrado };
}

/** Envuelve el repo contando cuántas veces se re-consultó la bandeja. */
function espiar(repo: Repo): { repo: Repo; consultas: () => number } {
  let n = 0;
  return {
    repo: {
      ...repo,
      listChats(limit?: number) {
        n++;
        return repo.listChats(limit);
      },
    },
    consultas: () => n,
  };
}

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

// ── coalescing (RNF-5, CA-4.3, D3) ──────────────────────────────────────────

test("500 markDirty('inbox') en el mismo tick ⇒ UN solo notify (RNF-5, CA-4.3)", () => {
  const { store, reloj } = conRelojFalso();
  let notifies = 0;
  store.subscribe("inbox", () => notifies++);

  for (let i = 0; i < 500; i++) store.markDirty("inbox");

  // Nada sale en el mismo tick: el flush siempre está agendado, nunca es
  // sincrónico. Si no, el sync inicial haría 500 renders.
  expect(notifies).toBe(0);
  expect(reloj.pendientes()).toBe(1);

  reloj.avanzar(FRAME_MS + 1);
  expect(notifies).toBe(1);
  expect(reloj.pendientes()).toBe(0);
});

test("500 markDirty con timers de verdad: 1 notify y UNA sola re-consulta (D2/D3)", async () => {
  const { db, repo: crudo } = base();
  const { repo, consultas } = espiar(crudo);
  const store = createStore(); // reloj y setTimeout REALES: el camino de producción
  store.bootstrap(repo);

  const consultasDelBootstrap = consultas();
  let notifies = 0;
  store.subscribe("inbox", () => notifies++);

  for (let i = 0; i < 500; i++) store.markDirty("inbox");
  await Bun.sleep(FRAME_MS * 3);

  expect(notifies).toBe(1);
  expect(consultas() - consultasDelBootstrap).toBe(1);
  store.stop();
  db.close();
});

test("los listeners de un slice limpio no se llaman", () => {
  const { store, reloj } = conRelojFalso();
  const llamadas = { inbox: 0, convo: 0, conn: 0 };
  store.subscribe("inbox", () => llamadas.inbox++);
  store.subscribe("convo", () => llamadas.convo++);
  store.subscribe("conn", () => llamadas.conn++);

  const convoAntes = store.getSnapshot("convo");

  store.markDirty("inbox");
  reloj.avanzar(FRAME_MS + 1);

  expect(llamadas).toEqual({ inbox: 1, convo: 0, conn: 0 });
  // Y el slice limpio ni siquiera se reconstruyó: misma identidad que antes.
  expect(store.getSnapshot("convo")).toBe(convoAntes);
});

test("markDirty acepta null: el flujo §6.2 lo pasa cuando el chat no está abierto", () => {
  const { store, reloj } = conRelojFalso();
  let convo = 0;
  store.subscribe("convo", () => convo++);

  store.markDirty("inbox", null);
  reloj.avanzar(FRAME_MS + 1);
  expect(convo).toBe(0);

  // Sólo nulls: no agenda nada.
  store.markDirty(null, undefined);
  expect(reloj.pendientes()).toBe(0);
});

test("con marcado continuo la tasa de notify queda ≤ 31/s (D3)", () => {
  const { store, reloj } = conRelojFalso();
  let notifies = 0;
  store.subscribe("inbox", () => notifies++);

  // Un mensaje por milisegundo durante 10 s de reloj virtual: el peor caso del
  // sync inicial, sostenido.
  const SEGUNDOS = 10;
  for (let ms = 0; ms < SEGUNDOS * 1000; ms++) {
    store.markDirty("inbox");
    reloj.avanzar(1);
  }

  const tasa = notifies / SEGUNDOS;
  expect(tasa).toBeLessThanOrEqual(31);
  // Y no se murió: sigue publicando cerca del techo de los 30 fps.
  expect(tasa).toBeGreaterThanOrEqual(29);
});

// ── identidad de los snapshots (useSyncExternalStore) ───────────────────────

test("dos getSnapshot sin flush en el medio devuelven la MISMA referencia", () => {
  const { store, reloj } = conRelojFalso();

  const a = store.getSnapshot("inbox");
  expect(store.getSnapshot("inbox")).toBe(a);

  // Marcar sucio tampoco la cambia: hasta el flush lo publicado es lo de antes.
  store.markDirty("inbox");
  expect(store.getSnapshot("inbox")).toBe(a);

  reloj.avanzar(FRAME_MS + 1);
  const b = store.getSnapshot("inbox");
  expect(b).not.toBe(a);
  expect(store.getSnapshot("inbox")).toBe(b);
});

test("un setter no publica hasta el flush, y ahí sí cambia la referencia", () => {
  const { store, reloj } = conRelojFalso();

  const antes = store.getSnapshot("conn");
  expect(antes.state).toBe("offline");

  store.setConn({ state: "reconnecting", attempt: 3 });
  expect(store.getSnapshot("conn")).toBe(antes);
  expect(store.getSnapshot("conn").state).toBe("offline");

  reloj.avanzar(FRAME_MS + 1);
  const despues = store.getSnapshot("conn");
  expect(despues).not.toBe(antes);
  expect(despues).toEqual({
    state: "reconnecting",
    attempt: 3,
    nextAttemptAt: null,
    lastCode: null,
    selfPhone: null,
  });
});

test("darse de baja corta las notificaciones", () => {
  const { store, reloj } = conRelojFalso();
  let n = 0;
  const baja = store.subscribe("inbox", () => n++);

  store.markDirty("inbox");
  reloj.avanzar(FRAME_MS + 1);
  expect(n).toBe(1);

  baja();
  store.markDirty("inbox");
  reloj.avanzar(FRAME_MS + 1);
  expect(n).toBe(1);
});

// ── bootstrap (CA-13.1) ─────────────────────────────────────────────────────

test("bootstrap(repo) llena inbox y conn de forma SINCRÓNICA (CA-13.1)", () => {
  const { db, repo, chatJids } = base({ chats: 5, messages: 60 });
  const { store, reloj } = conRelojFalso();
  let notifies = 0;
  store.subscribe("inbox", () => notifies++);

  store.bootstrap(repo);

  const inbox = store.getSnapshot("inbox");
  expect(inbox.chats.length).toBe(5);
  expect(inbox.counts.all).toBe(5);
  expect(inbox.counts.groups).toBe(1); // uno de cada cinco chats es grupo
  expect(new Set(inbox.chats.map((c) => c.jid))).toEqual(new Set(chatJids));
  // Ordenados por actividad, del más reciente al más viejo (CA-4.2).
  for (let i = 1; i < inbox.chats.length; i++) {
    expect(inbox.chats[i - 1]!.lastMessageAt).toBeGreaterThanOrEqual(inbox.chats[i]!.lastMessageAt);
  }

  expect(store.getSnapshot("conn").state).toBe("offline");
  expect(store.getSnapshot("link").phase).toBe("checking");

  // Corre antes del primer frame: no notifica a nadie ni deja timers colgados.
  expect(notifies).toBe(0);
  expect(reloj.pendientes()).toBe(0);
  db.close();
});

test("bootstrap con una base poblada entra holgado en el presupuesto de CA-13.1", () => {
  const CHATS = 200;
  const MENSAJES = 50_000;
  const path = join(tmp, "poblada.sqlite");

  const semilla = openDb(path);
  seedDb(semilla, { chats: CHATS, messages: MENSAJES });
  semilla.close();

  // Arranque en frío de verdad: abrir (incluye el `quick_check` de §4.2) y
  // después el bootstrap. Se miden por separado porque el quick_check ya se
  // sabe que es el caro y no es responsabilidad del store.
  const t0 = performance.now();
  const db = openDb(path);
  const repo = createRepo(db);
  const msAbrir = performance.now() - t0;

  const store = createStore();
  const t1 = performance.now();
  store.bootstrap(repo);
  const msBootstrap = performance.now() - t1;

  console.log(
    `bootstrap con ${CHATS} chats / ${MENSAJES} mensajes: ` +
      `openDb(+quick_check) ${msAbrir.toFixed(1)} ms · bootstrap ${msBootstrap.toFixed(1)} ms`,
  );

  expect(store.getSnapshot("inbox").chats.length).toBe(CHATS);
  expect(msBootstrap).toBeLessThan(100);
  expect(msAbrir + msBootstrap).toBeLessThan(1_000); // CA-13.1
  db.close();
}, 60_000);

// ── proyecciones: la base es la fuente de verdad (D2) ───────────────────────

test("el slice convo se re-consulta desde la base en cada flush (D2)", () => {
  const { db, repo } = base({ chats: 1, messages: 0 });
  const { store, reloj } = conRelojFalso();
  store.bootstrap(repo);

  repo.upsertChat({ jid: CHAT, name: "Ana" });
  repo.insertMessage(mensaje({ waId: "A1", body: "hola" }));

  expect(store.getSnapshot("convo").jid).toBeNull();
  expect(store.openChatJid()).toBeNull();

  store.setOpenChat(CHAT);
  reloj.avanzar(FRAME_MS + 1);

  const abierto = store.getSnapshot("convo");
  expect(abierto.jid).toBe(CHAT);
  expect(store.openChatJid()).toBe(CHAT);
  expect(abierto.messages.map((m) => m.body)).toEqual(["hola"]);
  expect(abierto.hasMoreAbove).toBe(false); // 1 mensaje, ventana de 500 (R2)
  expect(VENTANA_DEFAULT).toBe(500);

  // Escritura fuera del store (así trabaja el ingest) + markDirty: en el flush
  // el mensaje nuevo aparece solo, sin que nadie mantenga una segunda copia.
  repo.insertMessage(mensaje({ waId: "A2", body: "chau", ts: 1700000001 }));
  store.markDirty("convo");
  reloj.avanzar(FRAME_MS + 1);

  expect(store.getSnapshot("convo").messages.map((m) => m.body)).toEqual(["hola", "chau"]);
  db.close();
});

test("el slice search resuelve la consulta contra la base y sanea la sintaxis", () => {
  const { db, repo } = base({ chats: 1, messages: 0 });
  const { store, reloj } = conRelojFalso();
  store.bootstrap(repo);

  repo.upsertChat({ jid: CHAT, name: "Ana" });
  repo.insertMessage(mensaje({ waId: "B1", body: "nos vemos mañana temprano" }));

  expect(store.getSnapshot("search")).toEqual({ query: "", hits: [], chats: [] });

  // Sin acentos y con sintaxis FTS cruda: no tiene que lanzar (CA-12.5/12.6).
  store.setSearchQuery('manana "(-*:');
  reloj.avanzar(FRAME_MS + 1);

  const hits = store.getSnapshot("search").hits;
  expect(hits.length).toBe(1);
  expect(hits[0]!.chatName).toBe("Ana");
  db.close();
});

// ── toast (CA-19.5) ─────────────────────────────────────────────────────────

test("toast(): se ve y se limpia solo en ≤ 3 s (CA-19.5)", () => {
  const { store, reloj } = conRelojFalso();
  let n = 0;
  store.subscribe("ui", () => n++);

  store.toast("marcado como leído");
  reloj.avanzar(FRAME_MS + 1);
  expect(store.getSnapshot("ui").toast?.text).toBe("marcado como leído");
  expect(n).toBe(1);

  expect(TOAST_MS).toBeLessThanOrEqual(3_000);
  reloj.avanzar(TOAST_MS + FRAME_MS + 1);
  expect(store.getSnapshot("ui").toast).toBeNull();
  expect(n).toBe(2);
  expect(reloj.pendientes()).toBe(0);
});

test("un toast nuevo pisa al anterior y reinicia el reloj de limpieza", () => {
  const { store, reloj } = conRelojFalso();

  store.toast("primero");
  reloj.avanzar(TOAST_MS - 100);
  store.toast("segundo");
  reloj.avanzar(FRAME_MS + 1);
  expect(store.getSnapshot("ui").toast?.text).toBe("segundo");

  // Justo cuando le tocaba morir al primero, el segundo sigue en pantalla.
  reloj.avanzar(200);
  expect(store.getSnapshot("ui").toast?.text).toBe("segundo");

  reloj.avanzar(TOAST_MS + FRAME_MS);
  expect(store.getSnapshot("ui").toast).toBeNull();
});

// ── ciclo de vida ───────────────────────────────────────────────────────────

test("stop() cancela lo pendiente: el cierre no queda esperando timers", () => {
  const { store, reloj } = conRelojFalso();
  let n = 0;
  store.subscribe("ui", () => n++);

  store.toast("chau");
  store.markDirty("inbox");
  expect(reloj.pendientes()).toBeGreaterThan(0);

  store.stop();
  expect(reloj.pendientes()).toBe(0);

  reloj.avanzar(TOAST_MS * 2);
  expect(n).toBe(0);
});

test("flushNow() publica ya, sin esperar el frame", () => {
  const { store, reloj } = conRelojFalso();
  let n = 0;
  store.subscribe("conn", () => n++);

  store.setConn({ state: "open" });
  store.flushNow();

  expect(n).toBe(1);
  expect(store.getSnapshot("conn").state).toBe("open");
  expect(reloj.pendientes()).toBe(0);
});

test("las funciones sueltas del módulo operan sobre el store del proceso", async () => {
  let n = 0;
  const baja = subscribe("inbox", () => n++);
  const antes = getSnapshot("inbox");

  markDirty("inbox");
  await Bun.sleep(FRAME_MS * 3);

  expect(n).toBe(1);
  expect(getSnapshot("inbox")).not.toBe(antes);
  baja();
});
