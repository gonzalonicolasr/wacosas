// Tests de la búsqueda global (tarea 16): el presupuesto de RNF-7 sobre 50.000
// mensajes, la sintaxis rota que NO puede romper el MATCH (CA-12.5), y el modelo
// puro de la lista de resultados.
//
// Dos cosas sobre el volumen, para no re-descubrirlas:
//   · sembrar 50.000 mensajes tarda ~3,5 s (casi todo son los triggers del FTS),
//     y el default de `bun test` son 5 s por test ⇒ estos tests llevan su PROPIO
//     `timeout`.
//   · la base va a un ARCHIVO temporal y no a `:memory:`: el índice FTS en disco
//     es el que tiene la aplicación de verdad, y medir contra otro sería medir
//     otra cosa.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../src/db/open";
import { createRepo, type Repo } from "../src/db/repo";
import type { ChatRow, SearchHit } from "../src/db/types";
import { buildFtsQuery } from "../src/lib/fts";
import { coincideChat, filtrarChats } from "../src/state/commands";
import { createStore, LIMITE_HITS, type SearchSnapshot } from "../src/state/store";
import {
  columnasBusqueda,
  filasBusqueda,
  indiceVigente,
  moverSeleccion,
  primerSeleccionable,
  recortarPartes,
  type FilaBusqueda,
} from "../src/ui/SearchOverlay";
import { seedDb } from "./fixtures/seed";

const tmp = mkdtempSync(join(tmpdir(), "wacosas-search-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** RNF-7: lo que puede tardar la búsqueda con 50.000 mensajes persistidos. */
const TOPE_MS = 200;
const MENSAJES = 50_000;
const CHATS = 20;

/**
 * El store con un agendador MANUAL: uno que ejecute en el acto rompe el store
 * (el `flush` limpia `cancelarFlush` y el `markDirty` que lo llamó se lo vuelve a
 * escribir, dejándolo colgado y matando todos los flush siguientes). Acá los
 * timers se juntan y no se disparan nunca: el test publica con `flushNow()`.
 */
function storeManual(repo: Repo) {
  const s = createStore({ schedule: () => () => {} });
  s.bootstrap(repo);
  return s;
}

/** El camino REAL del usuario: texto ⇒ proyección publicada (§6.4). */
function buscar(s: ReturnType<typeof storeManual>, texto: string): SearchSnapshot {
  s.setSearchQuery(texto);
  s.flushNow();
  return s.getSnapshot("search");
}

let poblada: { repo: Repo; cerrar: () => void } | null = null;

/** La base de 50.000 mensajes: se siembra UNA vez y la comparten los tests. */
function baseGrande(): Repo {
  if (poblada) return poblada.repo;
  const ruta = join(tmp, "volumen.sqlite");
  const semilla = openDb(ruta);
  const t0 = performance.now();
  seedDb(semilla, { chats: CHATS, messages: MENSAJES });
  const msSiembra = performance.now() - t0;
  semilla.close();

  const db = openDb(ruta);
  const repo = createRepo(db);
  console.log(`[search] sembrar ${MENSAJES} mensajes en ${CHATS} chats: ${msSiembra.toFixed(0)} ms`);
  poblada = { repo, cerrar: () => db.close() };
  return repo;
}

afterAll(() => poblada?.cerrar());

// ── RNF-7: ≤ 200 ms sobre 50.000 mensajes ───────────────────────────────────

test(
  "la búsqueda sobre 50.000 mensajes responde dentro del presupuesto (RNF-7)",
  () => {
    const repo = baseGrande();
    const s = storeManual(repo);

    // Cuatro formas distintas de query, porque no cuestan lo mismo: una palabra
    // rara filtra casi todo, `la` matchea casi todos los mensajes (el peor caso
    // del `ORDER BY bm25`, que tiene que ordenar decenas de miles de filas), dos
    // términos obligan a intersecar y `manana` ejercita el `remove_diacritics`.
    const queries = ["camión", "la", "reunión café", "manana"];
    const medido: Array<{ q: string; ms: number; hits: number }> = [];

    for (const q of queries) {
      // Una vuelta de calentamiento y después la medición: la primera consulta
      // paga el caché de páginas del índice, y el usuario que tipea ya lo pagó.
      buscar(s, q);
      const t0 = performance.now();
      const snap = buscar(s, q);
      medido.push({ q, ms: performance.now() - t0, hits: snap.hits.length });
    }

    for (const m of medido) {
      console.log(`[search] "${m.q}" · ${m.ms.toFixed(1)} ms · ${m.hits} resultados`);
    }
    const peor = Math.max(...medido.map((m) => m.ms));
    console.log(`[search] peor caso ${peor.toFixed(1)} ms (tope ${TOPE_MS} ms)`);

    expect(peor).toBeLessThanOrEqual(TOPE_MS);
    // Y busca de verdad: el tope de §6.4 se respeta y los resultados vienen con
    // su fragmento partido (CA-12.2).
    const conResultados = medido.filter((m) => m.hits > 0);
    expect(conResultados.length).toBe(queries.length);
    expect(Math.max(...medido.map((m) => m.hits))).toBeLessThanOrEqual(LIMITE_HITS);
  },
  60_000,
);

test(
  "la sintaxis rota se busca como texto literal y NUNCA lanza (CA-12.5)",
  () => {
    const repo = baseGrande();
    const s = storeManual(repo);

    // Todo lo que un usuario puede tener a medio escribir mientras tipea. Ojo:
    // no alcanza con que no lance — un error de sintaxis de FTS5 se lleva puesta
    // la consulta entera y la pantalla se queda sin resultados para siempre.
    const hostiles = [
      '"comillas',
      'comillas"',
      '"',
      "*",
      "**",
      "café*",
      "NEAR/2",
      "NEAR(a b, 2)",
      "(paren",
      "paren)",
      "((()))",
      "-guion",
      "- ",
      ":dosp",
      "col:umna",
      "a AND b",
      "OR",
      "NOT",
      "^ancla",
      "{llave}",
      "café AND (mañana OR *",
      "!@#$%^&*()_+",
      "🌻",
      "👨‍👩‍👧 familia",
      "  ",
      "x".repeat(500),
      "mañana ".repeat(60),
    ];

    for (const q of hostiles) {
      const snap = buscar(s, q);
      expect(Array.isArray(snap.hits)).toBe(true);
      expect(Array.isArray(snap.chats)).toBe(true);
      expect(snap.query).toBe(q);
    }

    // Y los términos de adentro se buscan igual: `"café*"` encuentra `café`.
    expect(buscar(s, "café*").hits.length).toBeGreaterThan(0);
    expect(buscar(s, '"reunión"').hits.length).toBeGreaterThan(0);
    expect(buscar(s, "(camión)").hits.length).toBeGreaterThan(0);
    // Los operadores pelados no son términos: no hay nada que buscar.
    expect(buildFtsQuery("AND OR NOT NEAR")).toBe("");
    expect(buscar(s, "AND OR NOT NEAR").hits).toEqual([]);
  },
  60_000,
);

test(
  "sin acentos encuentra lo acentuado, y un mensaje nuevo aparece sin reiniciar (CA-12.6, CA-12.7)",
  () => {
    const repo = baseGrande();
    const s = storeManual(repo);

    const con = buscar(s, "mañana").hits.length;
    const sin = buscar(s, "manana").hits.length;
    expect(sin).toBe(con);
    expect(sin).toBeGreaterThan(0);
    // Y tampoco distingue mayúsculas.
    expect(buscar(s, "MAÑANA").hits.length).toBe(con);

    // CA-12.7: llega un mensaje y la búsqueda SIGUIENTE lo tiene que ver, sin
    // tocar el proceso. El texto es inventado a propósito: no está en el
    // vocabulario del seed, así que antes daba cero.
    const jid = repo.listChats(1)[0]!.jid;
    expect(buscar(s, "berenjena").hits).toEqual([]);
    repo.tx(() =>
      repo.insertMessage({
        chatJid: jid,
        waId: "NUEVO-BERENJENA",
        fromMe: false,
        senderJid: jid,
        senderName: "Ana",
        ts: 1_800_000_000,
        kind: "text",
        body: "te dejé una berenjena en la heladera",
        attachment: null,
        status: "received",
      }),
    );
    const despues = buscar(s, "berenjena");
    expect(despues.hits.length).toBe(1);
    expect(despues.hits[0]!.chatJid).toBe(jid);
    // El fragmento viene partido con el término marcado (CA-12.2).
    const marcado = despues.hits[0]!.parts.filter((p) => p.hit).map((p) => p.text.toLowerCase());
    expect(marcado.join(" ")).toContain("berenjena");
  },
  60_000,
);

// ── los dos buscadores dicen lo mismo (⚠️ de la tarea 16) ────────────────────

test("el mismo texto da lo mismo en la bandeja y en la búsqueda global", () => {
  const db = openDb(":memory:");
  const repo = createRepo(db);
  repo.tx(() => {
    // El caso del ⚠️: el `pushName` quedó TAPADO por el nombre de la agenda. La
    // bandeja muestra "Antonella" y no "anto 🌻".
    repo.upsertChat({ jid: "549115000001@s.whatsapp.net", name: "anto 🌻", lastMessageAt: 900 });
    repo.upsertContact("549115000001@s.whatsapp.net", "Antonella", "549115000001");
    repo.upsertChat({ jid: "120000999-1600000000@g.us", name: "Grupo mañana", isGroup: true, lastMessageAt: 800 });
    repo.upsertChat({ jid: "5491199887766@s.whatsapp.net", name: "", lastMessageAt: 700 });
  });
  const s = storeManual(repo);
  const chats = () => repo.listChats();

  /** Los jid que da cada buscador con el MISMO texto. */
  const enBandeja = (q: string): string[] => filtrarChats(chats(), "all", q).map((c) => c.jid);
  const enGlobal = (q: string): string[] => buscar(s, q).chats.map((c) => c.jid);

  for (const q of [
    "anto", // el pushName tapado por la agenda: era 0 en la bandeja y 1 en la global
    "🌻", // sin letras ni números: era 1 en la bandeja y 0 en la global
    "antonella", // la agenda
    "mañana", // un grupo, por su subject
    "manana", // …sin acento
    "998877", // por número, sin nombre
    "nadaqueverconesto",
  ]) {
    expect({ q, bandeja: enBandeja(q), global: enGlobal(q) }).toEqual({
      q,
      bandeja: enBandeja(q),
      global: enBandeja(q),
    });
  }

  // El predicado compartido, explícito: se busca por CUALQUIER nombre que
  // WhatsApp conozca del chat, no sólo por el que se ve.
  const anto = chats().find((c) => c.jid === "549115000001@s.whatsapp.net")!;
  expect(anto.contactName).toBe("Antonella");
  expect(coincideChat(anto, "anto")).toBe(true);
  expect(coincideChat(anto, "antonella")).toBe(true);
  expect(coincideChat(anto, "pepe")).toBe(false);
  db.close();
});

// ── el modelo puro de la lista ──────────────────────────────────────────────

const chatFalso = (jid: string, name: string): ChatRow => ({
  jid,
  name,
  contactName: "",
  isGroup: jid.endsWith("@g.us"),
  lastMessageAt: 1_700_000_000,
  lastPreview: "lo último",
  lastFromMe: false,
  unreadCount: 0,
  lastReadId: 0,
});

const hitFalso = (messageId: number): SearchHit => ({
  messageId,
  chatJid: "a@s.whatsapp.net",
  chatName: "A",
  isGroup: false,
  ts: 1_700_000_000,
  fromMe: false,
  parts: [{ text: "hola ", hit: false }, { text: "mundo", hit: true }],
});

const snapshot = (chats: ChatRow[], hits: SearchHit[]): SearchSnapshot => ({ query: "x", chats, hits });

test("la lista arma las dos secciones y los títulos NO son seleccionables", () => {
  const filas = filasBusqueda(snapshot([chatFalso("a@s.whatsapp.net", "A")], [hitFalso(1), hitFalso(2)]));
  expect(filas.map((f) => f.tipo)).toEqual(["titulo", "chat", "titulo", "hit", "hit"]);
  expect(primerSeleccionable(filas)).toBe(1);

  // Sin chats no hay sección de chats (§6.4: "el grupo Chats, si hay").
  expect(filasBusqueda(snapshot([], [hitFalso(1)])).map((f) => f.tipo)).toEqual(["titulo", "hit"]);
  expect(filasBusqueda(snapshot([], []))).toEqual([]);
  expect(primerSeleccionable([])).toBe(-1);

  // Con la lista llena el título no promete un total que no es.
  const llena = filasBusqueda(
    snapshot([], Array.from({ length: LIMITE_HITS }, (_, i) => hitFalso(i))),
  );
  expect((llena[0] as { texto: string }).texto).toContain(String(LIMITE_HITS));
});

test("moverse saltea los títulos, no da la vuelta y `Inicio`/`Fin` van a las puntas", () => {
  const filas = filasBusqueda(
    snapshot([chatFalso("a@s.whatsapp.net", "A")], [hitFalso(1), hitFalso(2), hitFalso(3)]),
  );
  // [0]=título, [1]=chat, [2]=título, [3..5]=hits
  expect(moverSeleccion(filas, 1, 1)).toBe(3); // se saltea el título del medio
  expect(moverSeleccion(filas, 3, -1)).toBe(1);
  expect(moverSeleccion(filas, 1, -1)).toBe(1); // arriba de todo: se clava
  expect(moverSeleccion(filas, 5, 1)).toBe(5); // abajo de todo: se clava
  expect(moverSeleccion(filas, 1, 2)).toBe(4);
  // Un `delta` de `Inicio`/`Fin` (SALTO_EXTREMO) no cuelga: el recorrido está
  // acotado por el largo de la lista.
  expect(moverSeleccion(filas, 1, Number.MAX_SAFE_INTEGER)).toBe(5);
  expect(moverSeleccion(filas, 5, -Number.MAX_SAFE_INTEGER)).toBe(1);

  // Un índice que ya no apunta a nada seleccionable cae en el primero.
  expect(indiceVigente(filas, 2)).toBe(1);
  expect(indiceVigente(filas, 99)).toBe(1);
  expect(indiceVigente(filas, 4)).toBe(4);
  expect(indiceVigente([], 0)).toBe(-1);
});

test("el fragmento se recorta a lo ancho de la fila conservando los resaltados", () => {
  const partes: Array<{ text: string; hit: boolean }> = [
    { text: "quedamos ", hit: false },
    { text: "mañana", hit: true },
    { text: " a las ocho en la esquina", hit: false },
  ];
  const entero = recortarPartes(partes, 100);
  expect(entero.map((p) => p.text).join("")).toBe("quedamos mañana a las ocho en la esquina");
  expect(entero.filter((p) => p.hit).map((p) => p.text)).toEqual(["mañana"]);

  // Recortado: nunca más ancho que la fila, y termina en `…`.
  for (const ancho of [1, 2, 5, 12, 20, 39]) {
    const corto = recortarPartes(partes, ancho);
    const texto = corto.map((p) => p.text).join("");
    expect({ ancho, largo: Array.from(texto).length <= ancho }).toEqual({ ancho, largo: true });
    expect(texto.endsWith("…")).toBe(true);
  }
  // El resaltado sobrevive al corte por el medio de una coincidencia.
  expect(recortarPartes(partes, 12).some((p) => p.hit)).toBe(true);
  expect(recortarPartes(partes, 0)).toEqual([]);

  // Un cuerpo con saltos de línea NO puede crecer a dos filas: se aplasta, y el
  // espacio entre dos tramos se conserva (si se trimeara, se pegarían).
  const conSaltos = recortarPartes([{ text: "hola\nque\ttal ", hit: false }, { text: "vos", hit: true }], 40);
  expect(conSaltos.map((p) => p.text).join("")).toBe("hola que tal vos");
});

test("las columnas de la fila reparten el ancho y el fragmento se queda con el resto", () => {
  // 80 columnas: panel 78, fila 76 útiles, fecha de 5 (`13:45`).
  const a80 = columnasBusqueda(76, 5);
  expect(a80.nombre + a80.frag + 2 + 6 + 2).toBe(76);
  expect(a80.frag).toBeGreaterThan(a80.nombre);

  // 60 columnas (RNF-2): sigue habiendo nombre Y fragmento.
  const a60 = columnasBusqueda(56, 5);
  expect(a60.nombre).toBeGreaterThanOrEqual(6);
  expect(a60.frag).toBeGreaterThanOrEqual(10);

  // Ridículamente angosto: se cae el fragmento antes que el nombre (sin nombre
  // la fila no se puede identificar).
  expect(columnasBusqueda(14, 5).frag).toBe(0);
  expect(columnasBusqueda(0, 0)).toEqual({ nombre: 0, frag: 0 });
});
