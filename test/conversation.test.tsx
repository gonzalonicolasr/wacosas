// Tests del panel de conversación (tarea 13). Tres capas, de la más barata a la
// más cara:
//
//  1. funciones puras (`hayMasArriba`, `autorDe`, `estadoDe`);
//  2. el store visto desde los comandos: la ventana fija de 500 y —lo más
//     importante— que **el ancla se suelte** (el ⚠️ del plan);
//  3. el render de verdad con `testRender`, que es la única forma de ver el
//     scroll: que abra al final, que cambiar de chat lo resetee, y que un mensaje
//     entrante no le robe la posición al que está leyendo más arriba.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { act, createRef, type RefObject } from "react";

import { openDb } from "../src/db/open";
import { createRepo, VENTANA_DEFAULT, type Repo } from "../src/db/repo";
import type { MessageRow } from "../src/db/types";
import { commands, configureCommands, type CommandDeps } from "../src/state/commands";
import { store } from "../src/state/store";
import { Conversation, hayMasArriba, lejosDelFinal } from "../src/ui/Conversation";
import { autorDe, estadoDe } from "../src/ui/MessageRow";

const LOG = { info() {}, warn() {}, error() {}, path: "/tmp/wacosas-test.log" };

const ANTO = "549115000001@s.whatsapp.net";
const OTRO = "549115000002@s.whatsapp.net";
const GRUPO = "120000999-1600000000@g.us";

/** Base en memoria con dos 1:1 y un grupo, ya migrada. */
function baseNueva(): Repo {
  const db = openDb(":memory:");
  const repo = createRepo(db);
  repo.upsertChat({ jid: ANTO, name: "anto 🌻" });
  repo.upsertChat({ jid: OTRO, name: "Jorge" });
  repo.upsertChat({ jid: GRUPO, name: "Grupo mañana", isGroup: true });
  return repo;
}

/** Inserta `n` mensajes en el chat, alternando propios y ajenos, y toca la actividad. */
function sembrar(repo: Repo, jid: string, n: number, desde = 1_700_000_000, etiqueta = "m"): void {
  repo.tx(() => {
    for (let i = 0; i < n; i++) {
      const propio = i % 3 === 0;
      repo.insertMessage({
        chatJid: jid,
        waId: `${etiqueta}${i}`,
        fromMe: propio,
        senderJid: propio ? "self@s.whatsapp.net" : jid,
        senderName: propio ? "yo" : "anto 🌻",
        ts: desde + i * 60,
        kind: "text",
        body: `${etiqueta} número ${i}`,
        attachment: null,
        status: propio ? "delivered" : "received",
      });
    }
    repo.touchChatActivity(jid, desde + (n - 1) * 60, `${etiqueta} número ${n - 1}`, false);
  });
}

/** Un mensaje entrante, por el mismo camino que el ingest (§6.2). */
function entra(repo: Repo, jid: string, waId: string, body: string, ts: number): void {
  repo.tx(() => {
    repo.insertMessage({
      chatJid: jid,
      waId,
      fromMe: false,
      senderJid: jid,
      senderName: "anto 🌻",
      ts,
      kind: "text",
      body,
      attachment: null,
      status: "received",
    });
    repo.touchChatActivity(jid, ts, body, false);
  });
  store.markDirty("inbox", "convo");
  store.flushNow();
}

function cablear(repo: Repo): void {
  configureCommands({
    repo,
    wa: {} as CommandDeps["wa"],
    store,
    log: LOG as CommandDeps["log"],
    shutdown() {},
  });
}

const fila = (p: Partial<MessageRow> = {}): MessageRow => ({
  id: 1,
  chatJid: ANTO,
  waId: "a",
  fromMe: false,
  senderJid: ANTO,
  senderName: "",
  ts: 1_700_000_000,
  kind: "text",
  body: "hola",
  attachment: null,
  status: "received",
  error: null,
  ...p,
});

// ── funciones puras ─────────────────────────────────────────────────────────

describe("hay más arriba (aviso de la ventana fija, CA-6.8 recortado)", () => {
  const lista = (n: number, desdeId = 1): MessageRow[] =>
    Array.from({ length: n }, (_, i) => fila({ id: desdeId + i }));

  test("por el camino del final, la ventana llena es la señal", () => {
    expect(hayMasArriba(lista(VENTANA_DEFAULT), null)).toBe(true);
    expect(hayMasArriba(lista(VENTANA_DEFAULT - 1), null)).toBe(false);
    expect(hayMasArriba([], null)).toBe(false);
  });

  test("por el camino ANCLADO no alcanza con contar filas: `hasMoreAbove` miente ahí", () => {
    // El caso reproducido por la revisión de la tarea 6: `messagesAround`
    // devolvió 252 filas (2 arriba del ancla, 250 abajo) con ~650 mensajes más
    // arriba. `messages.length >= 500` habría dicho que no hay nada arriba.
    const anclada = lista(252, 1);
    expect(anclada.length).toBeLessThan(VENTANA_DEFAULT);
    // El ancla en la fila 250: la mitad de arriba llegó a su tope ⇒ hay más.
    expect(hayMasArriba(anclada, 250)).toBe(true);
    // El ancla cerca del principio: arriba está TODO lo que hay.
    expect(hayMasArriba(anclada, 3)).toBe(false);
  });

  test("con el ancla fuera de la ventana avisa igual: en la duda, se avisa", () => {
    expect(hayMasArriba(lista(10), 9_999)).toBe(true);
  });
});

describe("autor de la fila (CA-6.2, CA-6.3)", () => {
  test("lo propio se muestra como `vos`", () => {
    expect(autorDe(fila({ fromMe: true, senderName: "yo" }), false, "Antonella")).toBe("vos");
  });

  test("manda el pushName CONGELADO del mensaje, no el nombre de hoy del chat", () => {
    expect(autorDe(fila({ senderName: "anto 🌻" }), false, "Antonella")).toBe("anto 🌻");
  });

  test("en un 1:1 sin pushName cae al nombre del chat", () => {
    expect(autorDe(fila({ senderName: "" }), false, "Antonella")).toBe("Antonella");
  });

  test("en un GRUPO sin pushName cae a quien escribió, nunca al nombre del grupo", () => {
    const m = fila({ senderName: "", senderJid: "5491160000001@s.whatsapp.net" });
    expect(autorDe(m, true, "Grupo mañana")).toBe("+5491160000001");
    // Y un `@lid` no se disfraza de teléfono.
    expect(autorDe(fila({ senderName: "", senderJid: "182736455647382@lid" }), true, "G")).toBe(
      "~182736455647382",
    );
  });
});

describe("a qué distancia del final quiso quedar el usuario (13b)", () => {
  test("con el pin arriba del scroll manda lo que el usuario movió, no el hueco al final", () => {
    // El caso medido: el lote entró (el contenido pasó de 50 a 98 líneas) y la
    // tecla se aplicó sobre la posición VIEJA —33 → 30—. La cuenta ingenua
    // diría 81-30 = 51 líneas, o sea 48 mensajes de regalo; lo que el usuario
    // pidió fueron 3.
    expect(lejosDelFinal(33, 30, 81)).toBe(3);
  });

  test("si scrolleó DESPUÉS del layout, el pin viejo queda abajo y vale la distancia al final", () => {
    // Mismo lote, pero la tecla llegó con el layout ya hecho: el sticky lo había
    // dejado en 81 y de ahí se movió tres líneas.
    expect(lejosDelFinal(33, 78, 81)).toBe(3);
  });

  test("sin carrera las dos lecturas dan lo mismo, y nunca da negativo", () => {
    expect(lejosDelFinal(40, 35, 40)).toBe(5);
    // Scrolleó hacia ABAJO desde el pin (o el pin quedó viejo): nada que reponer.
    expect(lejosDelFinal(40, 40, 40)).toBe(0);
    expect(lejosDelFinal(0, 50, 40)).toBe(0);
  });
});

describe("glifo de entrega", () => {
  test("sólo el ciclo de vida de un envío propio tiene glifo", () => {
    expect(estadoDe("received")).toBeNull();
    expect(estadoDe("pending")?.glifo).toBe("⏳");
    expect(estadoDe("sent")?.glifo).toBe("✓");
    expect(estadoDe("delivered")?.glifo).toBe("✓✓");
    expect(estadoDe("failed")?.glifo).toBe("✗");
    // `read` se distingue de `delivered` por color, no por glifo.
    expect(estadoDe("read")?.glifo).toBe("✓✓");
    expect(estadoDe("read")?.color).not.toBe(estadoDe("delivered")?.color);
  });
});

// ── la ventana y el ancla, sin render ───────────────────────────────────────

describe("ventana de la conversación", () => {
  let repo: Repo;

  beforeEach(() => {
    repo = baseNueva();
    store.bootstrap(repo);
    store.setInboxUi({ inboxFilter: "all", inboxQuery: "", selectedJid: null });
    store.flushNow();
    cablear(repo);
  });

  test("un chat con más de 500 mensajes abre con los ÚLTIMOS 500 (CA-6.1, CA-6.8)", () => {
    sembrar(repo, ANTO, 620);
    store.markDirty("inbox");
    commands.openChat(ANTO);
    store.flushNow();
    const convo = store.getSnapshot("convo");
    expect(convo.messages.length).toBe(VENTANA_DEFAULT);
    // Cronológico ascendente y con el más reciente al final (CA-6.1).
    expect(convo.messages[0]?.body).toBe("m número 120");
    expect(convo.messages[VENTANA_DEFAULT - 1]?.body).toBe("m número 619");
    expect(hayMasArriba(convo.messages, convo.anchorId)).toBe(true);
  });

  test("`loadWindow` con ancla centra la ventana en ese mensaje (CA-12.3)", () => {
    sembrar(repo, ANTO, 900);
    const ancla = repo.lastMessages(ANTO, 900)[300] as MessageRow;
    commands.openChat(ANTO, { anchorId: ancla.id });
    store.flushNow();
    const convo = store.getSnapshot("convo");
    expect(convo.anchorId).toBe(ancla.id);
    expect(convo.messages.some((m) => m.id === ancla.id)).toBe(true);
    // La ventana anclada NO llega al final del chat: ése es todo el problema.
    expect(convo.messages[convo.messages.length - 1]?.body).not.toBe("m número 899");
  });

  test("`releaseAnchor` devuelve la ventana al final sin cambiar de chat", () => {
    sembrar(repo, ANTO, 900);
    const ancla = repo.lastMessages(ANTO, 900)[100] as MessageRow;
    commands.openChat(ANTO, { anchorId: ancla.id });
    store.flushNow();
    expect(store.getSnapshot("convo").anchorId).toBe(ancla.id);

    commands.releaseAnchor();
    store.flushNow();
    const convo = store.getSnapshot("convo");
    expect(convo.jid).toBe(ANTO);
    expect(convo.anchorId).toBeNull();
    expect(convo.messages[convo.messages.length - 1]?.body).toBe("m número 899");
  });

  afterAll(() => {
    store.bootstrap(createRepo(openDb(":memory:")));
    store.setOpenChat(null);
    store.flushNow();
  });
});

// ── render ──────────────────────────────────────────────────────────────────

/** `renderOnce` dispara efectos (medidas, suscripciones): va adentro de `act`. */
async function pintar(t: { renderOnce: () => Promise<void> }, veces = 3) {
  for (let i = 0; i < veces; i++) {
    await act(async () => {
      await t.renderOnce();
    });
  }
}

/** Espera de verdad: el salto y el muestreo de la posición usan timers. */
async function esperar(ms: number) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

/**
 * Espera a que la conversación termine de montarse por LOTES (tarea 13b).
 *
 * El panel monta primero la cola —lo único que se ve— y deja entrar el resto de
 * a `LOTE` filas con un `setTimeout(0)` en el medio, así que un `pintar()` solo
 * deja la lista a medio montar. Los tests que tocan el scroll tienen que
 * esperar a que esté entera: con el montaje en curso, la vuelta siguiente los ve
 * "scrolleados" y dispara el rescate, que mueve la posición A PROPÓSITO.
 *
 * Se espera hasta que dejen de aparecer filas en vez de un tiempo fijo: los
 * lotes son `setTimeout(0)` encadenados y cuánto tarda cada vuelta depende de la
 * máquina (~13 ms acá). El `pintar` del final es para que el layout mida lo que
 * entró.
 */
async function montarTodo(
  t: { renderOnce: () => Promise<void> },
  caja: RefObject<ScrollBoxRenderable | null>,
) {
  let previo = -1;
  for (let i = 0; i < 40; i++) {
    const n = caja.current?.getChildren().length ?? 0;
    if (n === previo) break;
    previo = n;
    await esperar(30);
  }
  await pintar(t, 2);
}

const ANCHO = 46;
const ALTO = 16;

/**
 * El panel colgado del ancho REAL de la terminal, como lo hace `App` (§7.2:
 * `anchoConvo = width - anchoBandeja - 2`). Es la única forma de ejercitar
 * CA-19.4 desde un test: `t.resize()` mueve el ancho y el panel lo propaga a las
 * filas, que es justo donde se quedaba pegado el ancho viejo.
 */
function PanelElastico({ cajaRef }: { cajaRef: RefObject<ScrollBoxRenderable | null> }) {
  const { width } = useTerminalDimensions();
  return <Conversation ancho={width - 2} cajaRef={cajaRef} />;
}

/** Las líneas del frame que son una fila de mensaje (`HH:MM ›/‹ autor: …`). */
const filasDeMensaje = (frame: string): string[] =>
  frame
    .split("\n")
    .map((f) => f.trimEnd())
    .filter((f) => /\d\d:\d\d [›‹]/.test(f));

describe("render de la conversación", () => {
  let repo: Repo;
  let caja: ReturnType<typeof createRef<ScrollBoxRenderable>>;

  beforeEach(() => {
    repo = baseNueva();
    store.bootstrap(repo);
    store.setOpenChat(null);
    store.setInboxUi({ inboxFilter: "all", inboxQuery: "", selectedJid: null });
    store.flushNow();
    cablear(repo);
    caja = createRef<ScrollBoxRenderable>();
  });

  afterAll(() => {
    store.bootstrap(createRepo(openDb(":memory:")));
    store.setOpenChat(null);
    store.flushNow();
  });

  const montar = async () => {
    const t = await testRender(<Conversation ancho={ANCHO} cajaRef={caja} />, {
      width: ANCHO,
      height: ALTO,
    });
    await pintar(t);
    return t;
  };

  const alFinal = (): boolean => {
    const c = caja.current as ScrollBoxRenderable;
    return c.scrollTop >= Math.max(0, c.scrollHeight - c.viewport.height) - 1;
  };

  test("abre al final y ahí se queda (CA-6.1)", async () => {
    sembrar(repo, ANTO, 620);
    store.markDirty("inbox");
    commands.openChat(ANTO);
    store.flushNow();
    const t = await montar();

    const frame = t.captureCharFrame();
    expect(frame).toContain("m número 619");
    // El primero de la ventana está cargado pero NO a la vista: el scroll arrancó abajo.
    expect(frame).not.toContain("m número 120");
    expect(alFinal()).toBe(true);
    t.renderer.destroy();
  });

  // ── montaje por lotes (tarea 13b) ─────────────────────────────────────────

  test("abre montando SÓLO la cola y el resto entra por lotes, sin mover la vista", async () => {
    // El costo de abrir un chat es el commit de React creando renderables: 500
    // filas de un saque son ~700 ms en la aplicación real, y el 97 % es eso. Se
    // monta la cola —lo único que se ve— y el resto entra después.
    sembrar(repo, ANTO, 620);
    store.markDirty("inbox");
    commands.openChat(ANTO);
    store.flushNow();
    const t = await montar();

    const montadas = () => (caja.current as ScrollBoxRenderable).getChildren().length;
    // Un puñado de filas, no las 500 de la ventana.
    expect(montadas()).toBeLessThan(VENTANA_DEFAULT / 2);
    const primerFrame = filasDeMensaje(t.captureCharFrame());
    expect(primerFrame[primerFrame.length - 1]).toContain("m número 619");
    expect(alFinal()).toBe(true);

    await montarTodo(t, caja);

    // Ya está todo: las 500 filas + el aviso de arriba de la ventana, que
    // aparece recién ahora —mientras entraban los lotes habría estado mintiendo
    // ("lo anterior no se carga" justo cuando lo anterior está entrando)—.
    expect(montadas()).toBe(VENTANA_DEFAULT + 1);
    // Y la vista no se movió ni una línea: mismas filas, y sigue al final.
    expect(filasDeMensaje(t.captureCharFrame())).toEqual(primerFrame);
    expect(alFinal()).toBe(true);
    t.renderer.destroy();
  });

  test("mientras se monta NO se prende el aviso de mensajes nuevos", async () => {
    // El montaje hace crecer `scrollHeight` hacia arriba sin que llegue nada:
    // sin la guarda, el muestreo lo lee como "el usuario se fue del final" y
    // prende el badge de la nada.
    sembrar(repo, ANTO, 620);
    store.markDirty("inbox");
    commands.openChat(ANTO);
    store.flushNow();
    const t = await montar();

    // Se pinta y se deja correr el muestreo (200 ms) con los lotes entrando.
    for (let i = 0; i < 4; i++) {
      await pintar(t, 1);
      await esperar(70);
      expect(t.captureCharFrame()).not.toContain("mensajes nuevos");
    }
    await montarTodo(t, caja);
    await esperar(260);
    await pintar(t);

    expect(t.captureCharFrame()).not.toContain("mensajes nuevos");
    expect(alFinal()).toBe(true);
    t.renderer.destroy();
  });

  test("si el usuario scrollea EN MEDIO del montaje, lo dejan donde pidió", async () => {
    // Sin rescate, cada lote que entra arriba le corre la lectura hacia atrás:
    // en la aplicación real, tres `⇧↑` a los 150 ms de abrir terminaban 400
    // mensajes más arriba. El panel tiene que montar el resto de un saque y
    // devolverlo a las tres líneas del final que pidió.
    sembrar(repo, ANTO, 620);
    store.markDirty("inbox");
    commands.openChat(ANTO);
    store.flushNow();
    const t = await montar();
    const c = caja.current as ScrollBoxRenderable;
    expect(c.getChildren().length).toBeLessThan(VENTANA_DEFAULT);

    // Tres `⇧↑`: es lo que hace `App` con la caja (§7.3), sin pasar por React.
    c.scrollBy(-3);
    // El rescate son tres pasos con un frame de espera entre medio, y el layout
    // sólo corre cuando se pinta.
    for (let i = 0; i < 12; i++) {
      await esperar(30);
      await pintar(t, 1);
    }

    expect(c.getChildren().length).toBe(VENTANA_DEFAULT + 1);
    // Tres líneas del final, ni una más: ni pegado abajo ni 48 filas más arriba.
    expect(Math.max(0, c.scrollHeight - c.viewport.height) - c.scrollTop).toBe(3);
    expect(alFinal()).toBe(false);
    // Y no llegó nada, así que tampoco hay aviso que mostrar.
    expect(t.captureCharFrame()).not.toContain("mensajes nuevos");
    t.renderer.destroy();
  });

  test("un mensaje que llega EN MEDIO del montaje entra igual y queda a la vista", async () => {
    // Las filas montadas se cuentan desde el PRINCIPIO de la lista justamente
    // por esto: lo que llega se appendea, y con un contador desde el final cada
    // entrante le comería una fila al borde de arriba de lo montado.
    sembrar(repo, ANTO, 620);
    store.markDirty("inbox");
    commands.openChat(ANTO);
    store.flushNow();
    const t = await montar();

    entra(repo, ANTO, "en-medio", "llegó mientras montaba", 1_700_000_000 + 620 * 60);
    await pintar(t);
    await montarTodo(t, caja);
    await esperar(260);
    await pintar(t);

    const frame = t.captureCharFrame();
    expect(frame).toContain("llegó mientras montaba");
    expect(frame).not.toContain("mensajes nuevos");
    expect(alFinal()).toBe(true);
    t.renderer.destroy();
  });

  test("con ancla NO se lotea: la ventana entra entera de una", async () => {
    // Con ancla el `stickyScroll` va apagado (si no, el primer layout se come el
    // salto), así que meter filas arriba SÍ correría la vista; y al soltarla hay
    // un `scrollChildIntoView` a una fila vieja que tiene que existir.
    sembrar(repo, ANTO, 900);
    const ancla = repo.lastMessages(ANTO, 900)[300] as MessageRow;
    store.markDirty("inbox");
    commands.openChat(ANTO, { anchorId: ancla.id });
    store.flushNow();
    const t = await montar();

    const ventana = store.getSnapshot("convo").messages.length;
    expect(ventana).toBeGreaterThan(200);
    expect((caja.current as ScrollBoxRenderable).getChildren().length).toBe(ventana + 1);
    await esperar(80);
    await pintar(t);
    // El salto quedó donde tenía que quedar y el ancla no se soltó sola.
    expect(t.captureCharFrame()).toContain(`m número ${300}`);
    expect(store.getSnapshot("convo").anchorId).toBe(ancla.id);
    t.renderer.destroy();
  });

  test("al angostar la terminal las filas RE-ENVUELVEN (CA-19.4)", async () => {
    // Regresión: `MessageRow` está memoizada por CAMPOS y el comparador no
    // miraba `ancho`, así que al redimensionar el panel se re-maquetaba pero las
    // 500 filas se salteaban y conservaban el ancho VIEJO: la cola de cada
    // mensaje se dibujaba fuera del panel y el `<scrollbox>` la clipeaba (§8.1:
    // no hay medidas cacheadas fuera de `listHeight`).
    const LARGO = "uno dos tres cuatro cinco seis siete";
    repo.tx(() => {
      repo.insertMessage({
        chatJid: ANTO,
        waId: "largo",
        fromMe: false,
        senderJid: ANTO,
        senderName: "anto 🌻",
        ts: 1_700_000_000,
        kind: "text",
        body: LARGO,
        attachment: null,
        status: "received",
      });
      repo.touchChatActivity(ANTO, 1_700_000_000, LARGO, false);
    });
    store.markDirty("inbox");
    commands.openChat(ANTO);
    store.flushNow();

    const t = await testRender(<PanelElastico cajaRef={caja} />, { width: 60, height: ALTO });
    await pintar(t);
    /** La fila donde arranca el mensaje: a 60 lleva la cola, a 40 no puede. */
    const arranque = (frame: string) => filasDeMensaje(frame).find((f) => f.includes("uno dos tres"));

    expect(arranque(t.captureCharFrame())).toContain("siete");

    act(() => {
      t.resize(40, ALTO);
    });
    await pintar(t);

    const frame = t.captureCharFrame();
    expect(arranque(frame)).not.toContain("siete");
    // Y la cola NO se perdió: bajó a la línea de abajo, sangrada.
    expect(frame).toContain("siete");
    t.renderer.destroy();
  });

  test("cambiar de chat resetea el scroll al final del nuevo (CA-6.7)", async () => {
    sembrar(repo, ANTO, 60, 1_700_000_000, "anto");
    sembrar(repo, OTRO, 60, 1_700_000_000, "jorge");
    store.markDirty("inbox");
    commands.openChat(ANTO);
    store.flushNow();
    const t = await montar();
    await montarTodo(t, caja); // 13b: el scroll de abajo tiene que ser del usuario, no del lote

    // Scroll bien arriba en el primer chat.
    caja.current?.scrollTo(0);
    await pintar(t);
    expect(alFinal()).toBe(false);

    commands.openChat(OTRO);
    store.flushNow();
    await pintar(t);
    const frame = t.captureCharFrame();
    expect(frame).toContain("jorge número 59");
    expect(alFinal()).toBe(true);
    t.renderer.destroy();
  });

  // ⚠️ 620 mensajes y no 120: **con la ventana LLENA** cada flush reconsulta
  // `lastMessages(jid, 500)` y el más viejo se cae, así que todo el contenido sube
  // una fila y el `scrollTop` absoluto deja de apuntar a lo mismo. Por debajo de
  // los 500 no se cae nadie y el bug no se ejercita: ése fue el agujero que dejó
  // pasar la deriva de lectura.
  test("un mensaje que entra con el panel scrolleado arriba NO roba la posición (CA-6.4)", async () => {
    sembrar(repo, ANTO, 620);
    store.markDirty("inbox");
    commands.openChat(ANTO);
    store.flushNow();
    const t = await montar();
    await montarTodo(t, caja); // 13b: con el montaje en curso, scrollear dispara el rescate

    caja.current?.scrollTo(20);
    await pintar(t);
    const posicion = caja.current?.scrollTop;
    const arriba = filasDeMensaje(t.captureCharFrame())[0];
    expect(alFinal()).toBe(false);

    entra(repo, ANTO, "nuevo-1", "recién llegado", 1_700_000_000 + 620 * 60);
    await pintar(t);
    await esperar(260); // el muestreo de la posición
    await pintar(t);

    expect(caja.current?.scrollTop).toBe(posicion as number);
    // La posición no es sólo el número: la fila de arriba tiene que ser LA MISMA.
    expect(filasDeMensaje(t.captureCharFrame())[0]).toBe(arriba as string);
    expect(t.captureCharFrame()).toContain("↓ 1 mensaje nuevo");
    t.renderer.destroy();
  });

  test("una RÁFAGA con la ventana llena no corre la lectura ni una fila (CA-6.4)", async () => {
    // El caso de un grupo activo: 15 entrantes seguidos mientras el usuario lee
    // más arriba. Con la ventana rodando, la deriva era 1:1 con los entrantes —el
    // texto se iba yendo para arriba mientras leías—; acá tiene que ser 0.
    sembrar(repo, ANTO, 620);
    store.markDirty("inbox");
    commands.openChat(ANTO);
    store.flushNow();
    const t = await montar();
    await montarTodo(t, caja); // 13b: con el montaje en curso, scrollear dispara el rescate

    caja.current?.scrollTo(30);
    await pintar(t);
    expect(alFinal()).toBe(false);

    // El primero deja el badge puesto: así el viewport ya mide lo mismo antes y
    // después y las filas se pueden comparar una a una.
    entra(repo, ANTO, "raf-0", "ráfaga 0", 1_700_000_000 + 620 * 60);
    await pintar(t);
    await esperar(260);
    await pintar(t);
    const antes = filasDeMensaje(t.captureCharFrame());
    const posicion = caja.current?.scrollTop;
    expect(antes.length).toBeGreaterThan(5);

    for (let i = 1; i <= 15; i++) {
      entra(repo, ANTO, `raf-${i}`, `ráfaga ${i}`, 1_700_000_000 + (620 + i) * 60);
      await pintar(t, 1);
    }
    await esperar(260);
    await pintar(t);

    const despues = filasDeMensaje(t.captureCharFrame());
    expect(caja.current?.scrollTop).toBe(posicion as number);
    // Deriva 0: arriba, abajo y todo lo del medio, idéntico.
    expect(despues).toEqual(antes);
    // Y lo que llegó se cuenta, que es lo único que se tiene que mover.
    expect(t.captureCharFrame()).toContain("↓ 16 mensajes nuevos");
    t.renderer.destroy();
  });

  test("al volver al final la lista se RESINCRONIZA con la ventana del store", async () => {
    // La contracara del congelado: mientras el usuario lee arriba la lista se
    // queda con filas que ya no están en la ventana; al volver abajo tiene que
    // soltarlas y mostrar lo último, sin badge.
    sembrar(repo, ANTO, 620);
    store.markDirty("inbox");
    commands.openChat(ANTO);
    store.flushNow();
    const t = await montar();
    await montarTodo(t, caja); // 13b: con el montaje en curso, scrollear dispara el rescate

    caja.current?.scrollTo(30);
    await pintar(t);
    for (let i = 0; i < 5; i++) {
      entra(repo, ANTO, `sync-${i}`, `sincro ${i}`, 1_700_000_000 + (620 + i) * 60);
      await pintar(t, 1);
    }
    await esperar(260);
    await pintar(t);
    expect(t.captureCharFrame()).toContain("↓ 5 mensajes nuevos");

    const c = caja.current as ScrollBoxRenderable;
    c.scrollTo(Math.max(0, c.scrollHeight - c.viewport.height));
    await esperar(260);
    await pintar(t);
    entra(repo, ANTO, "sync-5", "sincro 5", 1_700_000_000 + 626 * 60);
    await pintar(t);
    await esperar(260);
    await pintar(t);

    const frame = t.captureCharFrame();
    expect(frame).toContain("sincro 5");
    expect(frame).not.toContain("mensajes nuevos");
    // La ventana volvió a ser la del store: 500 filas, ni una de las caídas.
    expect(store.getSnapshot("convo").messages.length).toBe(VENTANA_DEFAULT);
    expect(alFinal()).toBe(true);
    t.renderer.destroy();
  });

  test("con el panel al final, el mensaje nuevo se ve y no hay aviso (CA-6.4)", async () => {
    sembrar(repo, ANTO, 40);
    store.markDirty("inbox");
    commands.openChat(ANTO);
    store.flushNow();
    const t = await montar();
    expect(alFinal()).toBe(true);

    entra(repo, ANTO, "nuevo-2", "recién llegado", 1_700_000_000 + 40 * 60);
    await pintar(t);
    await esperar(260);
    await pintar(t);

    const frame = t.captureCharFrame();
    expect(frame).toContain("recién llegado");
    expect(frame).not.toContain("mensaje nuevo");
    t.renderer.destroy();
  });

  test("⚠️ el ancla se SUELTA cuando entra un mensaje: si no, la conversación se congela", async () => {
    sembrar(repo, ANTO, 900);
    const ancla = repo.lastMessages(ANTO, 900)[100] as MessageRow;
    store.markDirty("inbox");
    commands.openChat(ANTO, { anchorId: ancla.id });
    store.flushNow();
    const t = await montar();
    expect(store.getSnapshot("convo").anchorId).toBe(ancla.id);

    entra(repo, ANTO, "nuevo-3", "recién llegado", 1_700_000_000 + 900 * 60);
    // ANTES de que la interfaz reaccione: la ventana anclada NO tiene el mensaje
    // nuevo. Éste es el bug que se está arreglando — con el ancla pegada, esta
    // ventana es la que se seguía publicando para siempre.
    expect(store.getSnapshot("convo").messages.some((m) => m.body === "recién llegado")).toBe(false);

    await pintar(t); // corre el efecto que suelta el ancla
    store.flushNow(); // y el flush que publica la ventana nueva
    await pintar(t);

    const convo = store.getSnapshot("convo");
    expect(convo.anchorId).toBeNull();
    expect(convo.messages.some((m) => m.body === "recién llegado")).toBe(true);
    t.renderer.destroy();
  });

  test("el ancla también se suelta al volver al final de la ventana", async () => {
    sembrar(repo, ANTO, 900);
    const ancla = repo.lastMessages(ANTO, 900)[100] as MessageRow;
    store.markDirty("inbox");
    commands.openChat(ANTO, { anchorId: ancla.id });
    store.flushNow();
    const t = await montar();
    await esperar(80); // el salto al mensaje anclado
    await pintar(t);
    expect(store.getSnapshot("convo").anchorId).toBe(ancla.id);

    const c = caja.current as ScrollBoxRenderable;
    c.scrollTo(Math.max(0, c.scrollHeight - c.viewport.height));
    await esperar(260); // el muestreo ve que volvió al final
    await pintar(t);
    store.flushNow();
    await pintar(t);

    expect(store.getSnapshot("convo").anchorId).toBeNull();
    t.renderer.destroy();
  });

  test("propios y ajenos se distinguen, y el grupo dice quién escribió (CA-6.2, CA-6.3)", async () => {
    repo.tx(() => {
      repo.insertMessage({
        chatJid: GRUPO,
        waId: "g1",
        fromMe: false,
        senderJid: "5491160000001@s.whatsapp.net",
        senderName: "Meli",
        ts: 1_700_000_000,
        kind: "text",
        body: "quedamos 8am",
        attachment: null,
        status: "received",
      });
      repo.insertMessage({
        chatJid: GRUPO,
        waId: "g2",
        fromMe: true,
        senderJid: "self@s.whatsapp.net",
        senderName: "yo",
        ts: 1_700_000_060,
        kind: "text",
        body: "listo",
        attachment: null,
        status: "read",
      });
      repo.touchChatActivity(GRUPO, 1_700_000_060, "listo", true);
    });
    store.markDirty("inbox");
    commands.openChat(GRUPO);
    store.flushNow();
    const t = await montar();

    const filas = t
      .captureCharFrame()
      .split("\n")
      .map((f) => f.trimEnd())
      .filter((f) => f !== "");
    const ajeno = filas.find((f) => f.includes("quedamos 8am")) as string;
    const propio = filas.find((f) => f.includes("listo")) as string;
    expect(ajeno).toContain("‹ Meli:");
    expect(propio).toContain("› vos:");
    t.renderer.destroy();
  });

  test("revoke, adjuntos con caption y tipo desconocido (CA-6.9, CA-7.1, CA-7.2, CA-7.5)", async () => {
    repo.tx(() => {
      repo.insertMessage({
        chatJid: ANTO,
        waId: "x1",
        fromMe: false,
        senderJid: ANTO,
        senderName: "anto",
        ts: 1_700_000_000,
        kind: "image",
        body: "mirá lo que encontré",
        attachment: { label: "📷 imagen" },
        status: "received",
      });
      repo.insertMessage({
        chatJid: ANTO,
        waId: "x2",
        fromMe: false,
        senderJid: ANTO,
        senderName: "anto",
        ts: 1_700_000_060,
        kind: "text",
        body: "esto lo borro",
        attachment: null,
        status: "received",
      });
      repo.insertMessage({
        chatJid: ANTO,
        waId: "x3",
        fromMe: false,
        senderJid: ANTO,
        senderName: "anto",
        ts: 1_700_000_120,
        kind: "unsupported",
        body: "",
        attachment: null,
        status: "received",
      });
      repo.revokeMessage(ANTO, "x2");
      repo.touchChatActivity(ANTO, 1_700_000_120, "❔ mensaje no soportado", false);
    });
    store.markDirty("inbox");
    commands.openChat(ANTO);
    store.flushNow();
    const t = await montar();

    const frame = t.captureCharFrame();
    // CA-6.9: el cuerpo original desaparece y queda el cartel.
    expect(frame).toContain("🚫 mensaje eliminado");
    expect(frame).not.toContain("esto lo borro");
    // CA-7.1 + CA-7.2: placeholder arriba, caption DEBAJO.
    const filas = frame.split("\n").map((f) => f.trimEnd());
    const iPlaceholder = filas.findIndex((f) => f.includes("📷 imagen"));
    const iCaption = filas.findIndex((f) => f.includes("mirá lo que encontré"));
    expect(iPlaceholder).toBeGreaterThanOrEqual(0);
    expect(iCaption).toBe(iPlaceholder + 1);
    // CA-7.5: el tipo desconocido se muestra igual.
    expect(frame).toContain("❔ mensaje no soportado");
    t.renderer.destroy();
  });

  test("abrir un chat DESPUÉS del montaje no corre el panel una columna", async () => {
    // Regresión de un gotcha de OpenTUI 0.4.2: su reconciliador no resetea las
    // props que desaparecen, así que el `paddingLeft/Right` de la rama "sin chat
    // abierto" se le pegaba al `<scrollbox>` de la otra rama. Se veía corrido a
    // la derecha, dos columnas más angosto y con el último glifo comido — y sólo
    // por el camino real del usuario (abrir el chat con `⏎`, no al arrancar).
    sembrar(repo, ANTO, 40);
    store.markDirty("inbox");
    store.flushNow();
    const t = await testRender(
      <box width={ANCHO + 2} height={ALTO} border>
        <Conversation ancho={ANCHO} cajaRef={caja} />
      </box>,
      { width: ANCHO + 2, height: ALTO },
    );
    await pintar(t);
    expect(t.captureCharFrame()).toContain("ningún chat abierto");

    commands.openChat(ANTO);
    store.flushNow();
    await pintar(t);

    const c = caja.current as ScrollBoxRenderable;
    // Pegado al borde izquierdo del panel y del ancho completo, sin herencias.
    expect(c.x).toBe(1);
    expect(c.width).toBe(ANCHO);
    // Y en el frame: la hora arranca justo después del borde + 1 de padding.
    const conMensajes = t
      .captureCharFrame()
      .split("\n")
      .filter((f) => /\d\d:\d\d ‹/.test(f));
    expect(conMensajes.length).toBeGreaterThan(0);
    for (const f of conMensajes) expect(f).toMatch(/^│ \d\d:\d\d ‹/);
    t.renderer.destroy();
  });

  test("la rueda del mouse scrollea el panel (§7.4.5: el `<scrollbox>` la maneja solo)", async () => {
    sembrar(repo, ANTO, 120);
    store.markDirty("inbox");
    commands.openChat(ANTO);
    store.flushNow();
    const t = await montar();
    await montarTodo(t, caja); // 13b: con el montaje en curso, scrollear dispara el rescate
    const abajo = caja.current?.scrollTop as number;

    await act(async () => {
      await t.mockMouse.scroll(10, 8, "up");
    });
    await pintar(t);
    expect(caja.current?.scrollTop as number).toBeLessThan(abajo);
    t.renderer.destroy();
  });

  test("sin chat abierto lo dice, y no se cuelga de un jid fantasma", async () => {
    const t = await montar();
    expect(t.captureCharFrame()).toContain("ningún chat abierto");
    t.renderer.destroy();
  });
});
