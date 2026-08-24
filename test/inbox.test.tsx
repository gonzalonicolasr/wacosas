// Tests de la bandeja (tarea 12): las funciones puras del reparto de columnas y
// del filtro, los comandos de selección, y el render de verdad con `testRender`.
//
// Lo que se mira en el frame de caracteres y no en el estado de React son
// justamente los bugs que sólo existen ahí: una fila que crece al pasarle el
// mouse (CA-19.7), un nombre vacío que deja la fila en blanco, y la fecha o el
// badge corridos por un emoji del preview (que ocupa dos columnas y cuenta como
// un carácter).
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";

import { openDb } from "../src/db/open";
import { createRepo, type Repo } from "../src/db/repo";
import type { ChatRow } from "../src/db/types";
import {
  commands,
  configureCommands,
  etiquetaChat,
  filtrarChats,
  FILTROS,
  SALTO_EXTREMO,
  seleccionVigente,
  type CommandDeps,
} from "../src/state/commands";
import { createStore, store, type Store } from "../src/state/store";
import { anchoTabs, Header, nivelTabs, textoTab } from "../src/ui/Header";
import { Inbox, repartirColumnas, ventana } from "../src/ui/Inbox";
import { seedDb } from "./fixtures/seed";

const LOG = { info() {}, warn() {}, error() {}, path: "/tmp/wacosas-test.log" };

/** Una base en memoria, ya migrada, con los chats que pida el test. */
function baseCon(filas: Array<Partial<ChatRow> & { jid: string }>, contactos: Array<[string, string]> = []) {
  const db = openDb(":memory:");
  for (const [jid, nombre] of contactos) {
    db.run("INSERT INTO contacts (jid, name, phone) VALUES (?, ?, '')", [jid, nombre]);
  }
  const repo = createRepo(db);
  for (const f of filas) repo.upsertChat(f);
  return { db, repo };
}

/** Cablea `commands` contra un store propio (o el global, para los renders). */
function cablear(repo: Repo, s: Store): void {
  configureCommands({
    repo,
    // La bandeja no toca el socket: alcanza con un doble vacío.
    wa: {} as CommandDeps["wa"],
    store: s,
    log: LOG as CommandDeps["log"],
    shutdown() {},
  });
}

const chat = (jid: string, name: string, extra: Partial<ChatRow> = {}): ChatRow => ({
  jid,
  name,
  contactName: "",
  isGroup: jid.endsWith("@g.us"),
  lastMessageAt: 1_700_000_000,
  lastPreview: "hola",
  lastFromMe: false,
  unreadCount: 0,
  lastReadId: 0,
  ...extra,
});

// ── funciones puras ─────────────────────────────────────────────────────────

describe("reparto de columnas", () => {
  test("con espacio de sobra parte la fila en nombre y preview", () => {
    expect(repartirColumnas(40)).toEqual({ nombre: 19, preview: 18 });
    // Justo en el mínimo: 8 de nombre + 3 del separador + 6 de preview.
    expect(repartirColumnas(17)).toEqual({ nombre: 8, preview: 6 });
  });

  test("cuando no alcanza para los dos, lo que se cae es el preview", () => {
    // Es el caso de `compact`: la bandeja mide 34 columnas fijas (§7.2).
    expect(repartirColumnas(16)).toEqual({ nombre: 16, preview: 0 });
    expect(repartirColumnas(4)).toEqual({ nombre: 4, preview: 0 });
    expect(repartirColumnas(0)).toEqual({ nombre: 0, preview: 0 });
    expect(repartirColumnas(-5)).toEqual({ nombre: 0, preview: 0 });
  });
});

describe("ventana visible", () => {
  test("no se mueve mientras la selección esté adentro", () => {
    expect(ventana(100, 3, 10, 0)).toBe(0);
    expect(ventana(100, 9, 10, 0)).toBe(0);
    expect(ventana(100, 25, 10, 20)).toBe(20);
  });

  test("se corre lo MÍNIMO cuando la selección se sale", () => {
    expect(ventana(100, 10, 10, 0)).toBe(1); // un renglón, no media pantalla
    expect(ventana(100, 19, 10, 20)).toBe(19);
  });

  test("nunca deja filas en blanco al final ni índices negativos", () => {
    expect(ventana(100, 99, 10, 0)).toBe(90);
    expect(ventana(5, 0, 10, 3)).toBe(0); // entra todo ⇒ arranca en 0
    expect(ventana(100, 0, 0, 5)).toBe(0); // sin alto no hay ventana
  });
});

describe("etiqueta de la fila", () => {
  test("un chat sin nombre cae al número, no queda en blanco", () => {
    // Es el chat creado por un mensaje SALIENTE: el ingest no le pone nombre a
    // propósito (el `pushName` de un eco propio es uno mismo).
    expect(etiquetaChat(chat("5491133445566@s.whatsapp.net", ""))).toBe("+5491133445566");
  });

  test("un `@lid` NO se muestra como teléfono", () => {
    // El lid es un identificador opaco: pintarlo con `+` sería inventar un
    // número que nadie puede marcar.
    expect(etiquetaChat(chat("182736455647382@lid", ""))).toBe("~182736455647382");
  });

  test("un grupo sin subject se identifica igual, y nunca con el nombre de quien habló", () => {
    expect(etiquetaChat(chat("120-1@g.us", ""))).toBe("grupo sin nombre");
    expect(etiquetaChat(chat("120-1@g.us", "Logística"))).toBe("Logística");
    // Aunque hubiera un contacto homónimo, en un grupo la agenda no manda.
    expect(etiquetaChat({ ...chat("120-1@g.us", "Logística"), contactName: "Ana" })).toBe("Logística");
  });

  test("el nombre de la agenda le gana al pushName (precedencia de §5.4)", () => {
    const c = { ...chat("549115000001@s.whatsapp.net", "anto 🌻"), contactName: "Antonella" };
    expect(etiquetaChat(c)).toBe("Antonella");
  });
});

describe("filtro de la bandeja", () => {
  const lista: ChatRow[] = [
    chat("1@s.whatsapp.net", "Mañana Temprano", { unreadCount: 2 }),
    chat("2@s.whatsapp.net", "Manana Sin Tilde"),
    chat("120-9@g.us", "Grupo mañana", { unreadCount: 1 }),
    chat("5491199887766@s.whatsapp.net", ""),
  ];

  test("`mañana` y `manana` dan exactamente lo mismo (CA-5.2)", () => {
    const con = filtrarChats(lista, "all", "mañana").map((c) => c.jid);
    const sin = filtrarChats(lista, "all", "manana").map((c) => c.jid);
    expect(con).toEqual(["1@s.whatsapp.net", "2@s.whatsapp.net", "120-9@g.us"]);
    expect(sin).toEqual(con);
    // Y tampoco distingue mayúsculas.
    expect(filtrarChats(lista, "all", "MAÑANA").map((c) => c.jid)).toEqual(con);
  });

  test("busca por número aunque el chat no tenga nombre", () => {
    expect(filtrarChats(lista, "all", "998877").map((c) => c.jid)).toEqual([
      "5491199887766@s.whatsapp.net",
    ]);
  });

  test("`No leídos` lista sólo los que tienen contador > 0 (CA-10.4)", () => {
    expect(filtrarChats(lista, "unread", "").map((c) => c.jid)).toEqual([
      "1@s.whatsapp.net",
      "120-9@g.us",
    ]);
  });

  test("`Grupos` lista sólo grupos, y el texto se sigue aplicando encima", () => {
    expect(filtrarChats(lista, "groups", "").map((c) => c.jid)).toEqual(["120-9@g.us"]);
    expect(filtrarChats(lista, "groups", "temprano")).toEqual([]);
  });
});

describe("selección vigente", () => {
  const lista = [chat("a@x", "A"), chat("b@x", "B")] as ChatRow[];

  test("respeta el jid guardado mientras siga a la vista", () => {
    expect(seleccionVigente(lista, "b@x")).toBe("b@x");
  });

  test("cae al primero cuando el guardado ya no está, y a null con la lista vacía", () => {
    expect(seleccionVigente(lista, "z@x")).toBe("a@x");
    expect(seleccionVigente(lista, null)).toBe("a@x");
    expect(seleccionVigente([], "a@x")).toBeNull();
  });
});

// ── comandos ────────────────────────────────────────────────────────────────

describe("comandos de la bandeja", () => {
  let repo: Repo;
  let s: Store;

  beforeEach(() => {
    const b = baseCon([
      chat("uno@s.whatsapp.net", "Uno", { lastMessageAt: 500 }),
      chat("dos@s.whatsapp.net", "Dos", { lastMessageAt: 400, unreadCount: 3 }),
      chat("120-1@g.us", "Grupo", { lastMessageAt: 300 }),
      chat("cuatro@s.whatsapp.net", "Cuatro", { lastMessageAt: 200 }),
    ]);
    repo = b.repo;
    s = createStore();
    s.bootstrap(repo);
    cablear(repo, s);
  });

  const sel = (): string | null => s.inboxUi().selectedJid;

  test("moverse por la lista no da la vuelta: se clava en las puntas", () => {
    commands.moveSelection(1);
    expect(sel()).toBe("dos@s.whatsapp.net");
    commands.moveSelection(-5);
    expect(sel()).toBe("uno@s.whatsapp.net");
    commands.moveSelection(SALTO_EXTREMO);
    expect(sel()).toBe("cuatro@s.whatsapp.net");
    commands.moveSelection(3);
    expect(sel()).toBe("cuatro@s.whatsapp.net");
  });

  test("la selección se guarda por JID: un chat nuevo arriba no le mueve el cursor (CA-4.4)", () => {
    commands.moveSelection(2); // tercero de la lista: el grupo
    expect(sel()).toBe("120-1@g.us");
    const indiceAntes = s.getSnapshot("inbox").chats.findIndex((c) => c.jid === "120-1@g.us");
    expect(indiceAntes).toBe(2);

    // Entra un mensaje de un chat nuevo, más reciente que todos: se cuela ARRIBA.
    repo.upsertChat(chat("nuevo@s.whatsapp.net", "Recién llegado", { lastMessageAt: 900 }));
    s.markDirty("inbox");
    s.flushNow();

    // El chat seleccionado cambió de índice…
    expect(s.getSnapshot("inbox").chats.findIndex((c) => c.jid === "120-1@g.us")).toBe(3);
    // …y el cursor sigue sobre el MISMO chat, no sobre el que ocupa su lugar.
    expect(sel()).toBe("120-1@g.us");
    // Un índice guardado habría terminado acá:
    expect(s.getSnapshot("inbox").chats[2]?.jid).toBe("dos@s.whatsapp.net");
  });

  test("`Tab` cicla los tres filtros y vuelve al principio (CA-5.5)", () => {
    const vistos = [s.inboxUi().inboxFilter];
    for (let i = 0; i < 3; i++) {
      commands.cycleInboxFilter();
      vistos.push(s.inboxUi().inboxFilter);
    }
    expect(vistos).toEqual([...FILTROS, "all"]);
  });

  test("cambiar de filtro reancla el cursor si el chat seleccionado ya no entra", () => {
    commands.selectChat("cuatro@s.whatsapp.net"); // leído, no es grupo
    commands.setInboxFilter("unread");
    expect(sel()).toBe("dos@s.whatsapp.net"); // el único con no leídos
    // Y al volver a `Todos` se queda donde está: el chat sigue a la vista.
    commands.setInboxFilter("all");
    expect(sel()).toBe("dos@s.whatsapp.net");
  });

  test("tipear en el buscador reancla igual, y limpiarlo no salta al principio", () => {
    commands.selectChat("cuatro@s.whatsapp.net");
    commands.setInboxQuery("grupo");
    expect(sel()).toBe("120-1@g.us");
    commands.setInboxQuery("");
    expect(sel()).toBe("120-1@g.us");
  });

  test("`⏎` abre el chat seleccionado y lo marca leído (CA-6.1, CA-11.1)", () => {
    commands.selectChat("dos@s.whatsapp.net");
    expect(repo.getChat("dos@s.whatsapp.net")?.unreadCount).toBe(3);
    commands.openSelectedChat();
    expect(s.openChatJid()).toBe("dos@s.whatsapp.net");
    expect(repo.getChat("dos@s.whatsapp.net")?.unreadCount).toBe(0);
  });

  test("con la lista filtrada a cero, nada explota y el cursor se suelta", () => {
    commands.setInboxQuery("no-existe-nada");
    expect(sel()).toBeNull();
    commands.moveSelection(1);
    commands.openSelectedChat();
    expect(s.openChatJid()).toBeNull();
  });
});

// ── tabs del encabezado ─────────────────────────────────────────────────────

describe("tabs del encabezado", () => {
  const counts = { all: 22, unread: 4, groups: 4 };

  test("a 80 columnas con la conexión abierta entran los tres con su palabra", () => {
    // 76 útiles − 11 de la marca − 11 de `● conectado` − 1 de slack = 53.
    expect(nivelTabs(counts, 53)).toBe(0);
    expect(textoTab("unread", 4, 0)).toBe("No leídos 4");
    expect(anchoTabs(counts, 0)).toBeLessThanOrEqual(53);
  });

  test("cuando el badge de reconexión se come el renglón, los tabs se achican pero el NÚMERO queda", () => {
    // `⟳ reconectando · intento 12 · 60 s` mide 34: quedan 30 columnas.
    expect(nivelTabs(counts, 30)).toBe(2);
    expect(textoTab("all", 22, 2)).toBe("≡22");
    expect(anchoTabs(counts, 2)).toBeLessThanOrEqual(30);
    // El nivel del medio es el escalón intermedio, no un adorno.
    expect(textoTab("unread", 4, 1)).toBe("Sin leer 4");
    expect(anchoTabs(counts, 1)).toBeLessThan(anchoTabs(counts, 0));
  });
});

// ── render ──────────────────────────────────────────────────────────────────

/** `renderOnce` dispara efectos (medidas, suscripciones): va adentro de `act`. */
async function pintar(t: { renderOnce: () => Promise<void> }, veces = 2) {
  for (let i = 0; i < veces; i++) {
    await act(async () => {
      await t.renderOnce();
    });
  }
}

/** Las filas de chat del frame (la 0 es el buscador), sin espacios de relleno. */
const filasChat = (frame: string): string[] =>
  frame
    .split("\n")
    .slice(1)
    .map((f) => f.trimEnd())
    .filter((f) => f !== "");

describe("render de la bandeja", () => {
  const AHORA = Math.floor(Date.now() / 1000);
  const FILAS = [
    chat("549115000001@s.whatsapp.net", "anto 🌻", {
      lastMessageAt: AHORA - 600,
      lastPreview: "📷 imagen · mirá esto que encontré",
      unreadCount: 12,
    }),
    chat("5491133445566@s.whatsapp.net", "", {
      lastMessageAt: AHORA - 86_400,
      lastPreview: "dale, mañana lo vemos",
    }),
    chat("120000999-1600000000@g.us", "Grupo mañana", {
      lastMessageAt: AHORA - 86_400 * 9,
      lastPreview: "quedamos 8am en la esquina",
      unreadCount: 3,
    }),
  ];

  /** Monta `<Inbox/>` sobre el store GLOBAL (que es el que lee `useSlice`). */
  async function montar(ancho: number, alto: number) {
    const { repo } = baseCon(FILAS, [["549115000001@s.whatsapp.net", "Antonella"]]);
    store.bootstrap(repo);
    store.setInboxUi({ inboxFilter: "all", inboxQuery: "", selectedJid: null });
    store.flushNow();
    cablear(repo, store);
    const t = await testRender(<Inbox ancho={ancho} alto={alto} />, { width: ancho, height: alto });
    await pintar(t);
    return { t, repo };
  }

  afterAll(() => {
    // El store es un singleton compartido con el resto de los archivos de test:
    // se lo deja como estaba para no contaminar a los que corran después.
    store.bootstrap(createRepo(openDb(":memory:")));
    store.setInboxUi({ inboxFilter: "all", inboxQuery: "", selectedJid: null });
    store.flushNow();
  });

  test("la fila trae nombre, preview, fecha relativa y badge (CA-4.1, CA-10.2)", async () => {
    const { t } = await montar(46, 6);
    const filas = filasChat(t.captureCharFrame());
    expect(filas.length).toBe(3);
    // Nombre de la AGENDA (no el pushName), preview del adjunto (CA-4.5), hora
    // de hoy (CA-4.1) y contador (CA-10.2).
    expect(filas[0]).toContain("Antonella");
    expect(filas[0]).toContain("📷 imagen");
    expect(filas[0]).toMatch(/\d\d:\d\d +12$/);
    // Ayer se dice "ayer"; hace nueve días, la fecha corta.
    expect(filas[1]).toContain("ayer");
    expect(filas[2]).toMatch(/\d\d\/\d\d +3$/);
    t.renderer.destroy();
  });

  test("un chat sin nombre muestra el número: la fila NUNCA queda en blanco", async () => {
    const { t } = await montar(46, 6);
    const filas = filasChat(t.captureCharFrame());
    expect(filas[1]).toContain("+5491133445566");
    t.renderer.destroy();
  });

  test("el grupo se distingue del 1:1 con su propio glifo (CA-4.8)", async () => {
    const { t } = await montar(46, 6);
    const filas = filasChat(t.captureCharFrame());
    expect(filas[2]).toContain("▣");
    expect(filas[0]).toContain("▪");
    expect(filas[0]).not.toContain("▣");
    t.renderer.destroy();
  });

  test("ninguna fila crece a dos líneas al pasarle el mouse por encima (CA-19.7)", async () => {
    // El bug que cubre esto: un evento de mouse vuelve a MEDIR el `<text>`, y
    // sin `wrapMode="none"` la fila se envuelve, empuja a las de abajo y la
    // lista queda corrida. Se pasa por las tres filas, incluida la del preview
    // con emoji, que es la más larga.
    const { t } = await montar(46, 6);
    const antes = t.captureCharFrame();
    for (let y = 1; y <= 3; y++) {
      await act(async () => {
        await t.mockMouse.moveTo(6, y);
      });
      await pintar(t);
    }
    const despues = t.captureCharFrame();
    expect(filasChat(despues).length).toBe(3);
    // Y no sólo la cantidad: el contenido es idéntico, sin corrimientos.
    expect(despues).toBe(antes);
    t.renderer.destroy();
  });

  test("la fecha y el badge quedan en la MISMA columna aunque el preview traiga emoji", async () => {
    // Un emoji ocupa dos columnas y cuenta como un carácter: si las columnas se
    // alinearan con `padEnd` adentro del texto, esta fila saldría corrida.
    const { t } = await montar(46, 6);
    // Se mide el BORDE DERECHO de la fecha: la columna está alineada a la
    // derecha, así que `ayer` (4) empieza una columna más tarde que `13:08` (5)
    // y termina en el mismo lugar.
    const columnas = filasChat(t.captureCharFrame()).map((f) => {
      const m = f.match(/(\d\d:\d\d|ayer|\d\d\/\d\d)/);
      expect(m).not.toBeNull();
      return Bun.stringWidth(f.slice(0, (m?.index ?? 0) + (m?.[0].length ?? 0)));
    });
    expect(columnas[1]).toBe(columnas[0]);
    expect(columnas[2]).toBe(columnas[0]);
    t.renderer.destroy();
  });

  test("doble click abre el chat y un solo click sólo lo selecciona (CA-5.6)", async () => {
    const { t, repo } = await montar(46, 6);
    // Un solo click sobre el grupo: selecciona y NO lo marca leído.
    await act(async () => {
      await t.mockMouse.click(6, 3);
    });
    await pintar(t);
    expect(store.inboxUi().selectedJid).toBe("120000999-1600000000@g.us");
    expect(store.openChatJid()).toBeNull();
    expect(repo.getChat("120000999-1600000000@g.us")?.unreadCount).toBe(3);

    // Doble click: abre (y por CA-11.1 queda leído).
    await act(async () => {
      await t.mockMouse.doubleClick(6, 3);
    });
    await pintar(t);
    expect(store.openChatJid()).toBe("120000999-1600000000@g.us");
    expect(repo.getChat("120000999-1600000000@g.us")?.unreadCount).toBe(0);
    t.renderer.destroy();
  });

  test("la rueda mueve la selección (CA-5.7)", async () => {
    const { t } = await montar(46, 6);
    expect(store.inboxUi().selectedJid).toBeNull(); // = la primera
    await act(async () => {
      await t.mockMouse.scroll(6, 2, "down");
    });
    await pintar(t);
    expect(store.inboxUi().selectedJid).toBe("5491133445566@s.whatsapp.net");
    await act(async () => {
      await t.mockMouse.scroll(6, 2, "up");
    });
    await pintar(t);
    expect(store.inboxUi().selectedJid).toBe("549115000001@s.whatsapp.net");
    t.renderer.destroy();
  });

  test("con la base vacía explica que está esperando la sincronización (CA-4.7)", async () => {
    const { repo } = baseCon([]);
    store.bootstrap(repo);
    store.flushNow();
    cablear(repo, store);
    const t = await testRender(<Inbox ancho={40} alto={5} />, { width: 40, height: 5 });
    await pintar(t);
    expect(t.captureCharFrame()).toContain("esperando la sincronización");
    t.renderer.destroy();
  });

  test("el encabezado muestra los tres contadores tal como quedaron persistidos (CA-10.5, CA-19.1)", async () => {
    const { repo } = baseCon(FILAS);
    store.bootstrap(repo); // sincrónico, ANTES del primer frame
    store.setConn({ state: "open" });
    store.flushNow();
    cablear(repo, store);
    const t = await testRender(<Header conTabs />, { width: 80, height: 3 });
    await pintar(t);
    const frame = t.captureCharFrame();
    expect(frame).toContain("Todos 3");
    expect(frame).toContain("No leídos 2");
    expect(frame).toContain("Grupos 1");
    t.renderer.destroy();
  });
});

// ── RNF-6 ───────────────────────────────────────────────────────────────────

test(
  "RNF-6: con 50.000 mensajes persistidos, mover la selección responde en ≤ 50 ms",
  () => {
    // Timeout propio: sembrar 50.000 mensajes tarda ~3,4 s (los triggers del
    // FTS), y el default de `bun test` son 5 s.
    const db = openDb(":memory:");
    seedDb(db, { chats: 200, messages: 50_000 });
    const repo = createRepo(db);
    const s = createStore();
    s.bootstrap(repo);
    cablear(repo, s);
    expect(repo.listChats().length).toBe(200);

    let peor = 0;
    for (let i = 0; i < 200; i++) {
      const t0 = performance.now();
      // El camino COMPLETO de una tecla: mover, publicar el snapshot y rearmar
      // la lista visible, que es lo que hace el render.
      commands.moveSelection(i % 40 === 39 ? -39 : 1);
      s.flushNow();
      const ui = s.inboxUi();
      filtrarChats(s.getSnapshot("inbox").chats, ui.inboxFilter, ui.inboxQuery);
      peor = Math.max(peor, performance.now() - t0);
    }
    console.log(`RNF-6 · peor movimiento de selección: ${peor.toFixed(3)} ms (200 movimientos)`);
    expect(peor).toBeLessThanOrEqual(50);
    repo.close();
  },
  { timeout: 30_000 },
);
