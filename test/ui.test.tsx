// Tests de la interfaz que abrió la revisión de la tarea 9. Todos renderizan de
// verdad con el `testRender` de OpenTUI y miran el frame de caracteres: el bug
// que se arregla acá —el cuerpo de la ayuda desbordando el alto y quedando
// ENCIMADO— no se ve en ningún estado de React, sólo en lo que se pinta.
//
// Los tamaños no son caprichosos: 60×15 es el mínimo declarado de RNF-2, 80×19 y
// 80×20 son el rango donde la ayuda no entraba, y 80×24 es RNF-1.
import { expect, test } from "bun:test";
import type { ScrollBoxRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act, createRef } from "react";

import { configureCommands, type CommandDeps } from "../src/state/commands";
import { store } from "../src/state/store";
import { App } from "../src/ui/App";
import { ayudaScrollea, Help, lineasAyuda, lineasQueEntran } from "../src/ui/Help";

const LOG = "/tmp/wacosas-test.log";

const ATAJOS_GLOBALES = [
  "?               abrir / cerrar esta ayuda",
  "Esc             cerrar la ayuda",
  "Ctrl-R          reconectar ahora, sin esperar el backoff",
  "Ctrl-C · Ctrl-Q salir",
];
const ATAJOS_MINI = [
  "⏎               entrar a la conversación",
  "Esc             volver a la bandeja",
];
const NOTAS = [`log: ${LOG}`, "la base local NO se cifra: queda 0600, sólo para tu usuario"];
const TITULOS = ["teclas", "en terminales angostas (un panel por vez)"];

/** Las filas de adentro del panel de la ayuda, sin borde ni padding. */
function filasAyuda(frame: string): string[] {
  const filas = frame.split("\n");
  const arriba = filas.findIndex((f) => f.includes("─ ayuda "));
  expect(arriba).toBeGreaterThanOrEqual(0);
  const abajo = filas.findIndex((f, i) => i > arriba && f.startsWith("└"));
  return filas
    .slice(arriba + 1, abajo)
    .map((f) => Array.from(f).slice(2, -2).join("").trimEnd());
}

/** `clip` corta con `…`, así que una fila entera es un prefijo de la esperada. */
function coincideCon(fila: string, esperadas: string[]): boolean {
  const limpia = fila.endsWith("…") ? fila.slice(0, -1) : fila;
  return esperadas.some((e) => e.startsWith(limpia));
}

/** `renderOnce` dispara efectos (medidas, suscripciones): va adentro de `act`. */
async function pintar(t: { renderOnce: () => Promise<void> }, veces = 1) {
  for (let i = 0; i < veces; i++) {
    await act(async () => {
      await t.renderOnce();
    });
  }
}

async function montar(width: number, height: number, noSplash = true) {
  const t = await testRender(<App noSplash={noSplash} logPath={LOG} />, { width, height });
  await pintar(t);
  return t;
}

async function abrirAyuda(t: Awaited<ReturnType<typeof montar>>) {
  act(() => {
    t.mockInput.pressKey("?");
  });
  // Dos pasadas: la primera monta el `<scrollbox>`, la segunda ya lo mide.
  await pintar(t, 2);
}

/** Comandos con dobles: sin esto `quit()` llamaría a `process.exit` de verdad. */
function cablearComandos() {
  const visto = { reconexiones: 0, salidas: [] as number[] };
  configureCommands({
    repo: {} as CommandDeps["repo"],
    wa: {
      reconnectNow() {
        visto.reconexiones++;
      },
    } as CommandDeps["wa"],
    store,
    log: { info() {}, warn() {}, error() {}, path: LOG },
    shutdown(code = 0) {
      visto.salidas.push(code);
    },
  });
  return visto;
}

// ── el cuerpo de la ayuda entra siempre (CA-19.3, RNF-2) ────────────────────

for (const [width, height, mini] of [
  [60, 15, true],
  [80, 19, false],
  [80, 20, false],
  [80, 24, false],
] as Array<[number, number, boolean]>) {
  test(`la ayuda a ${width}×${height} se lee entera y sin filas encimadas`, async () => {
    const t = await montar(width, height);
    await abrirAyuda(t);
    const filas = filasAyuda(t.captureCharFrame());

    const conocidas = [...ATAJOS_GLOBALES, ...NOTAS, ...TITULOS, ...(mini ? ATAJOS_MINI : [])];
    // 1) Nada de lo pintado es basura: si dos `<text>` se encimaran, la fila
    //    saldría mezclada ("?eclas", "⏎n terminales anentrar…") y no matchearía.
    for (const fila of filas.filter((f) => f !== "")) {
      expect({ fila, conocida: coincideCon(fila, conocidas) }).toEqual({ fila, conocida: true });
    }
    // 2) Todos los atajos VIGENTES están, más la ruta del log (CA-16.3).
    const obligatorias = [...ATAJOS_GLOBALES, ...NOTAS, ...(mini ? ATAJOS_MINI : [])];
    for (const esperada of obligatorias) {
      const hay = filas.some((f) => coincideCon(f, [esperada]) && f !== "");
      expect({ esperada, hay }).toEqual({ esperada, hay: true });
    }
    // 3) En `compact`/`wide` no se prometen los atajos de `mini`: ahí no hacen nada.
    if (!mini) {
      for (const ajena of ATAJOS_MINI) {
        expect(filas.some((f) => f !== "" && coincideCon(f, [ajena]))).toBe(false);
      }
    }
    // 4) Y como entra entera, el pie NO anuncia el `↑↓` de scroll.
    const pie = t.captureCharFrame().split("\n")[height - 1] as string;
    expect(pie).toContain("Esc / ? cerrar la ayuda");
    expect(pie).not.toContain("↑↓");
    t.renderer.destroy();
  });
}

test("cuando el alto no alcanza se cae el adorno antes que un atajo", () => {
  const todas = lineasAyuda({ logPath: LOG, mini: true });
  expect(todas.length).toBe(12);
  // Entra todo: se pinta todo, adorno incluido.
  expect(lineasQueEntran(todas, 12)).toEqual(todas);
  // No entra: se van títulos y renglones en blanco, quedan los 6 atajos + 2 notas.
  const apretadas = lineasQueEntran(todas, 9);
  expect(apretadas.length).toBe(8);
  expect(apretadas.every((l) => l.tipo === "atajo" || l.tipo === "nota")).toBe(true);
  // Nunca se recorta a mano por debajo de lo esencial: eso lo cubre el scroll.
  expect(lineasQueEntran(todas, 3)).toEqual(apretadas);

  // A 60×15 (el mínimo, RNF-2) el cuerpo son 9 filas y entra todo lo esencial:
  // ahí NO hay nada que scrollear. Con menos, sí.
  expect(ayudaScrollea({ logPath: LOG, mini: true, filas: 9 })).toBe(false);
  expect(ayudaScrollea({ logPath: LOG, mini: true, filas: 7 })).toBe(true);
});

test("lo que no entra ni sin adorno queda dentro del scrollbox y se alcanza con scroll", async () => {
  const caja = createRef<ScrollBoxRenderable>();
  const t = await testRender(
    <box width={60} height={7}>
      <Help logPath={LOG} width={60} filas={5} mini cajaRef={caja} />
    </box>,
    { width: 60, height: 8 },
  );
  await pintar(t);
  await pintar(t);

  // Recortado, NO encimado: se ven las primeras filas y la última no aparece.
  const antes = filasAyuda(t.captureCharFrame());
  expect(antes.length).toBe(5);
  expect(coincideCon(antes[0] as string, [ATAJOS_GLOBALES[0] as string])).toBe(true);
  expect(antes.some((f) => f.startsWith("log:"))).toBe(false);

  act(() => {
    caja.current?.scrollBy(3);
  });
  await pintar(t);
  await pintar(t);
  const despues = filasAyuda(t.captureCharFrame());
  expect(despues.some((f) => f.startsWith("log:"))).toBe(true);
  t.renderer.destroy();
});

// ── teclado (CA-17.1, CA-15.5) ──────────────────────────────────────────────

test("Ctrl-C durante el splash SALE, no lo saltea", async () => {
  const visto = cablearComandos();
  const t = await montar(80, 24, false);
  act(() => {
    t.mockInput.pressCtrlC();
  });
  await pintar(t);
  expect(visto.salidas).toEqual([0]);
  // Y no entró a la bandeja: el `^C` no se gastó en saltear la animación.
  expect(t.captureCharFrame()).not.toContain("chats 0");
  t.renderer.destroy();
});

test("Ctrl-R funciona con la ayuda abierta y la ayuda queda abierta", async () => {
  const visto = cablearComandos();
  const t = await montar(80, 24);
  await abrirAyuda(t);
  act(() => {
    t.mockInput.pressKey("r", { ctrl: true });
  });
  act(() => {
    store.flushNow(); // el toast viaja en el flush coalescido (D3)
  });
  await pintar(t);
  expect(visto.reconexiones).toBe(1);
  const frame = t.captureCharFrame();
  expect(frame).toContain("reconectando…"); // CA-19.5, el aviso del pie
  expect(frame).toContain("─ ayuda ");
  t.renderer.destroy();
});

test("no reescribe el banner cuando no cambió (un flush menos por montaje)", async () => {
  const original = store.setBanner.bind(store);
  let escrituras = 0;
  store.setBanner = (text) => {
    escrituras++;
    original(text);
  };
  try {
    const t = await montar(80, 24);
    await pintar(t);
    expect(escrituras).toBe(0); // ya estaba en `null`
    t.renderer.destroy();
  } finally {
    store.setBanner = original;
  }
});
