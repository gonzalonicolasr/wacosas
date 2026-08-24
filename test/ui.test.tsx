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
import { store, TOAST_MS, type LinkSnapshot } from "../src/state/store";
import { App } from "../src/ui/App";
import { ayudaScrollea, Help, lineasAyuda, lineasQueEntran } from "../src/ui/Help";
import { VIDA_CODIGO_MS } from "../src/ui/PairingView";
import { buildQr } from "../src/wa/qr";

const LOG = "/tmp/wacosas-test.log";

const ATAJOS_GLOBALES = [
  "?               abrir / cerrar esta ayuda",
  "Esc             cerrar la ayuda",
  "Ctrl-R          reconectar ahora, sin esperar el backoff",
  "Ctrl-C · Ctrl-Q salir",
];
const ATAJOS_BANDEJA = [
  "escribir        filtrar por nombre o número, sin acentos",
  "↑ ↓ · ^K ^J     mover la selección (la rueda también)",
  "PgUp PgDn       saltar de a una pantalla (Inicio / Fin, a las puntas)",
  "⏎ · doble click abrir el chat seleccionado",
  "Tab             filtrar: todos / no leídos / grupos",
  "Esc             limpiar el buscador",
];
const ATAJOS_CONVO = ["⇧↑↓ ⇧PgUp/PgDn  scrollear el chat · ⇧Inicio ⇧Fin a las puntas"];
const ATAJOS_MINI = [
  "⏎               entrar a la conversación",
  "Esc             volver a la bandeja",
  "↑ ↓ PgUp PgDn   con el chat a la vista, scrollean sin ⇧",
];
const NOTAS = [`log: ${LOG}`, "la base local NO se cifra: queda 0600, sólo para tu usuario"];
const TITULOS = [
  "teclas",
  "en la bandeja",
  "en la conversación",
  "en terminales angostas (un panel por vez)",
];

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
  // Con la sesión sin vincular la pantalla es `<Login/>` (CA-1.1, tarea 10) y no
  // habría bandeja ni ayuda que mirar: estos tests son de la vista principal, así
  // que declaran la sesión ya vinculada. El `flushNow` es porque el snapshot está
  // cacheado hasta el próximo flush (D3) y el render leería el estado anterior.
  store.setLink({ phase: "linked", qr: null, pairingCode: null, reason: null });
  store.flushNow();
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
  const visto = {
    reconexiones: 0,
    salidas: [] as number[],
    telefonos: [] as string[],
    /** Eventos del log, para poder afirmar que algo NO pasó (ver `Ctrl-R`). */
    eventos: [] as string[],
  };
  configureCommands({
    repo: {} as CommandDeps["repo"],
    wa: {
      reconnectNow() {
        visto.reconexiones++;
        // El controlador real lo loguea así (`wa/socket.ts`); el doble lo imita
        // para que el test mire el mismo rastro que se lee en vivo.
        visto.eventos.push("wa.reconnect_now");
      },
      async requestPairingCode(digits: string) {
        visto.telefonos.push(digits);
      },
    } as CommandDeps["wa"],
    store,
    log: {
      info: (ev: string) => visto.eventos.push(ev),
      warn: (ev: string) => visto.eventos.push(ev),
      error: (ev: string) => visto.eventos.push(ev),
      path: LOG,
    },
    shutdown(code = 0) {
      visto.salidas.push(code);
    },
  });
  return visto;
}

// ── el cuerpo de la ayuda entra siempre (CA-19.3, RNF-2) ────────────────────

// `entera: false` = a esa altura el cuerpo YA no entra ni sacándole el adorno, y
// lo que sobra vive en el `<scrollbox>`. Pasó al sumar los seis atajos de la
// bandeja (tarea 12): a 60×15, el mínimo de RNF-2, el cuerpo son 9 filas y los
// atajos vigentes ya son 14. Lo que NO puede pasar nunca es que se encimen.
for (const [width, height, mini, entera] of [
  [60, 15, true, false],
  [80, 19, false, true],
  [80, 20, false, true],
  [80, 24, false, true],
] as Array<[number, number, boolean, boolean]>) {
  test(`la ayuda a ${width}×${height} se lee sin filas encimadas`, async () => {
    const t = await montar(width, height);
    await abrirAyuda(t);
    const filas = filasAyuda(t.captureCharFrame());

    const conocidas = [
      ...ATAJOS_GLOBALES,
      ...ATAJOS_BANDEJA,
      ...ATAJOS_CONVO,
      ...NOTAS,
      ...TITULOS,
      ...(mini ? ATAJOS_MINI : []),
    ];
    // 1) Nada de lo pintado es basura: si dos `<text>` se encimaran, la fila
    //    saldría mezclada ("?eclas", "⏎n terminales anentrar…") y no matchearía.
    for (const fila of filas.filter((f) => f !== "")) {
      expect({ fila, conocida: coincideCon(fila, conocidas) }).toEqual({ fila, conocida: true });
    }
    // 2) Todos los atajos VIGENTES están, más la ruta del log (CA-16.3).
    const obligatorias = [
      ...ATAJOS_GLOBALES,
      ...ATAJOS_BANDEJA,
      ...ATAJOS_CONVO,
      ...NOTAS,
      ...(mini ? ATAJOS_MINI : []),
    ];
    if (entera) {
      for (const esperada of obligatorias) {
        const hay = filas.some((f) => coincideCon(f, [esperada]) && f !== "");
        expect({ esperada, hay }).toEqual({ esperada, hay: true });
      }
    } else {
      // No entra todo: lo que se ve son las PRIMERAS de la lista, en orden, y el
      // resto se alcanza con `↑↓` (que el pie sí anuncia, abajo).
      expect(filas.filter((f) => f !== "").length).toBeGreaterThan(0);
      expect(coincideCon(filas[0] as string, [ATAJOS_GLOBALES[0] as string])).toBe(true);
    }
    // 3) En `compact`/`wide` no se prometen los atajos de `mini`: ahí no hacen nada.
    if (!mini) {
      for (const ajena of ATAJOS_MINI) {
        expect(filas.some((f) => f !== "" && coincideCon(f, [ajena]))).toBe(false);
      }
    }
    // 4) El pie anuncia el `↑↓` de scroll SÓLO cuando de verdad hay algo abajo.
    const pie = t.captureCharFrame().split("\n")[height - 1] as string;
    expect(pie).toContain("Esc / ? cerrar la ayuda");
    expect(pie.includes("↑↓")).toBe(!entera);
    t.renderer.destroy();
  });
}

test("cuando el alto no alcanza se cae el adorno antes que un atajo", () => {
  const todas = lineasAyuda({ logPath: LOG, mini: true });
  // 4 títulos + 4 huecos + 14 atajos (4 globales, 6 de bandeja, 1 de conversación,
  // 3 de mini) + 2 notas.
  expect(todas.length).toBe(24);
  // Entra todo: se pinta todo, adorno incluido.
  expect(lineasQueEntran(todas, 24)).toEqual(todas);
  // No entra: primero se van SÓLO los renglones en blanco. Los títulos son lo
  // que hace encontrar el atajo de un vistazo y aguantan un escalón más (a 80×24
  // la ayuda son 19 líneas contra 18 de alto: gastar seis renglones de adorno
  // para ahorrar uno la dejaba sin un solo título y con cinco filas en blanco).
  const sinHuecos = lineasQueEntran(todas, 20);
  expect(sinHuecos.length).toBe(20);
  expect(sinHuecos.some((l) => l.tipo === "titulo")).toBe(true);
  expect(sinHuecos.every((l) => l.tipo !== "hueco")).toBe(true);
  // Recién si tampoco así entra se van los títulos: quedan los 14 atajos + 2 notas.
  const apretadas = lineasQueEntran(todas, 16);
  expect(apretadas.length).toBe(16);
  expect(apretadas.every((l) => l.tipo === "atajo" || l.tipo === "nota")).toBe(true);
  // Nunca se recorta a mano por debajo de lo esencial: eso lo cubre el scroll.
  expect(lineasQueEntran(todas, 3)).toEqual(apretadas);

  // Con lo esencial entrando justo NO hay nada que scrollear; con menos, sí — y
  // ése es el caso de 60×15 (el mínimo de RNF-2), donde el cuerpo son 9 filas.
  expect(ayudaScrollea({ logPath: LOG, mini: true, filas: 16 })).toBe(false);
  expect(ayudaScrollea({ logPath: LOG, mini: true, filas: 9 })).toBe(true);
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
    // Bien de más: el `<scrollbox>` se clava en el fondo, que es donde viven las
    // notas (el cuerpo apretado son 14 filas y se ven 5).
    caja.current?.scrollBy(20);
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

// ── vinculación (tarea 10) ──────────────────────────────────────────────────
//
// Todo se mira en el frame de caracteres, que es donde viven los bugs de esta
// pantalla: un QR recortado, un QR encimado con el pie, o un código de
// emparejamiento que desaparece porque baileys rotó el QR. Ninguno se ve en el
// estado de React.

/** Un payload con el largo real del de WhatsApp (277 chars ⇒ 67×34). */
const PAYLOAD = `2@${"AbC9/+xyzWQ".repeat(26).slice(0, 271)}==,1`;

const LINK_LIMPIO: LinkSnapshot = {
  phase: "qr-waiting",
  method: "qr",
  methodForced: false,
  qr: null,
  pairingCode: null,
  pairingRequestedAt: null,
  reason: null,
};

async function montarLogin(
  width: number,
  height: number,
  link: Partial<LinkSnapshot> = {},
  /** `--qr-png`: la ruta que el entry le pasa a `<App/>` (null = sin el flag). */
  qrPngPath: string | null = null,
) {
  store.setLink({ ...LINK_LIMPIO, ...link });
  store.flushNow();
  const t = await testRender(<App noSplash logPath={LOG} qrPngPath={qrPngPath} />, {
    width,
    height,
  });
  await pintar(t);
  return t;
}

/** Las filas del frame, sin el relleno de la derecha. */
function filasDe(frame: string): string[] {
  return frame.split("\n");
}

test("el payload de prueba mide lo mismo que el de WhatsApp", () => {
  expect(PAYLOAD.length).toBe(277);
  expect(buildQr(PAYLOAD)?.cols).toBe(67);
});

for (const ancho of [69, 79, 80, 100]) {
  test(`a ${ancho}×40 el QR se dibuja ENTERO: las 34 filas, en orden y sin recortes`, async () => {
    // Varios anchos a propósito: centrar un bloque de 67 columnas en uno de
    // ancho par deja una coordenada fraccionaria, y el redondeo de la grilla de
    // celdas puede comerse una columna. Una sola columna de menos deja un QR
    // del tamaño correcto que NINGÚN teléfono lee.
    const t = await montarLogin(ancho, 40, { phase: "qr-shown", qr: PAYLOAD });
    const filas = filasDe(t.captureCharFrame());
    const qr = buildQr(PAYLOAD)!;

    // La primera fila con módulos oscuros ancla el bloque; de ahí en adelante
    // TIENEN que estar las 34, cada una completa (67 caracteres seguidos).
    const arriba = filas.findIndex((f) => f.includes(qr.rows[1] as string));
    expect(arriba).toBeGreaterThan(0);
    for (const [i, fila] of qr.rows.entries()) {
      const enPantalla = filas[arriba - 1 + i] ?? "";
      expect({ fila: i, entera: enPantalla.includes(fila) }).toEqual({ fila: i, entera: true });
    }
    // Y abajo del QR no hay nada del QR: el pie no quedó encimado (OpenTUI no
    // recorta a los hijos que no entran, los superpone).
    const abajo = filas[arriba - 1 + qr.rows.length] ?? "";
    expect(abajo).not.toContain("▀");
    expect(abajo).not.toContain("█");
    t.renderer.destroy();
  });
}

test("a 80×24 el QR NO se dibuja: panel de 'no entra' con actual vs requerido y el código", async () => {
  const t = await montarLogin(80, 24, { phase: "qr-shown", qr: PAYLOAD });
  const frame = t.captureCharFrame();

  // CA-2.1: por qué no se ve el QR, cuánto mide la terminal y cuánto haría falta.
  expect(frame).toContain("el QR no entra");
  expect(frame).toContain("ahora 80 × 24");
  expect(frame).toContain("hace falta 69 × 36");
  // …y el camino que SÍ sirve acá, ofrecido en el acto (no escondido tras Tab).
  expect(frame).toContain("escribí tu número");
  // Ni un pedazo de QR dibujado a medias.
  expect(frame).not.toContain("█");
  t.renderer.destroy();
});

test("mientras WhatsApp no manda el payload dice que lo está esperando, no que 'no entra'", async () => {
  // El segundo que pasa entre `wa.connect` y el primer `wa.qr`: la terminal es
  // grande, el QR entra, lo que falta es el payload (CA-1.9).
  const t = await montarLogin(80, 40, { phase: "qr-waiting", qr: null });
  const frame = t.captureCharFrame();
  expect(frame).toContain("esperando el QR");
  expect(frame).not.toContain("no entra");
  t.renderer.destroy();
});

test("Tab alterna QR ↔ código sin tocar el socket (CA-2.6)", async () => {
  cablearComandos();
  const t = await montarLogin(80, 40, { phase: "qr-shown", qr: PAYLOAD });
  const qr = buildQr(PAYLOAD)!;
  expect(t.captureCharFrame()).toContain(qr.rows[1] as string);

  act(() => {
    t.mockInput.pressTab();
  });
  act(() => {
    store.flushNow(); // `chooseLinkMethod` viaja por el flush coalescido (D3)
  });
  await pintar(t);
  const conCodigo = t.captureCharFrame();
  expect(conCodigo).toContain("escribí tu número");
  expect(conCodigo).not.toContain(qr.rows[1] as string);

  act(() => {
    t.mockInput.pressTab();
  });
  act(() => {
    store.flushNow();
  });
  await pintar(t);
  const deVuelta = t.captureCharFrame();
  expect(deVuelta).toContain(qr.rows[1] as string);
  expect(deVuelta).not.toContain("escribí tu número");
  t.renderer.destroy();
});

// ── `--qr-png` ──────────────────────────────────────────────────────────────
//
// El flag existe para el caso de arriba: el QR mide 34 × 67 y en una pane de
// 24 × 80 no entra. Con el PNG el usuario lo abre en un visor y escanea sin
// salir de la app —que es lo que importa, porque el 515 posterior al escaneo lo
// maneja el controlador (CA-1.8)—. Pero el archivo no sirve de nada si la
// pantalla no dice CUÁL es, así que eso es lo que se mide acá.

const RUTA_PNG = "/tmp/wacosas-test/qr.png";

test("con --qr-png y el QR que no entra, la pantalla dice la ruta del PNG", async () => {
  const t = await montarLogin(80, 24, { phase: "qr-shown", qr: PAYLOAD }, RUTA_PNG);
  const frame = t.captureCharFrame();

  expect(frame).toContain(RUTA_PNG);
  // El aviso se lleva el renglón del panel de "no entra": ahí las medidas ya no
  // obligan a nada (no hace falta agrandar la terminal) y la ruta sí.
  expect(frame).toContain("el QR no entra acá");
  expect(frame).not.toContain("hace falta 69 × 36");
  // Y el código de emparejamiento sigue ofrecido: el PNG es otro camino, no un
  // reemplazo (CA-2.1).
  expect(frame).toContain("escribí tu número");
  t.renderer.destroy();
});

test("sin el flag, la misma pantalla no nombra ningún PNG", async () => {
  // Control negativo del anterior: si la ruta apareciera igual, el test de
  // arriba no probaría nada.
  const t = await montarLogin(80, 24, { phase: "qr-shown", qr: PAYLOAD });
  const frame = t.captureCharFrame();
  expect(frame).not.toContain(".png");
  expect(frame).toContain("hace falta 69 × 36");
  t.renderer.destroy();
});

test("con --qr-png y el QR dibujado, se ven las dos cosas: el QR entero y la ruta", async () => {
  const t = await montarLogin(80, 40, { phase: "qr-shown", qr: PAYLOAD }, RUTA_PNG);
  const filas = filasDe(t.captureCharFrame());
  const qr = buildQr(PAYLOAD)!;

  // El aviso NO le puede comer filas al QR: las 34 tienen que seguir enteras
  // (OpenTUI no recorta a los hijos que no entran, los encima).
  const arriba = filas.findIndex((f) => f.includes(qr.rows[1] as string));
  expect(arriba).toBeGreaterThan(0);
  for (const [i, fila] of qr.rows.entries()) {
    const enPantalla = filas[arriba - 1 + i] ?? "";
    expect({ fila: i, entera: enPantalla.includes(fila) }).toEqual({ fila: i, entera: true });
  }
  expect(filas.some((f) => f.includes(RUTA_PNG))).toBe(true);
  t.renderer.destroy();
});

test("con --qr-png y el QR forzado con Tab en una terminal chica, el panel lleva la ruta", async () => {
  // CA-2.6: el usuario puede forzar el QR aunque no entre. El panel que le
  // explica que no entra es, con el flag, el lugar donde tiene que ver la ruta.
  const t = await montarLogin(
    80,
    24,
    { phase: "qr-shown", qr: PAYLOAD, method: "qr", methodForced: true },
    RUTA_PNG,
  );
  const frame = t.captureCharFrame();
  expect(frame).toContain("el QR no entra en esta terminal");
  expect(frame).toContain(RUTA_PNG);
  expect(frame).toContain("ahora 80 × 24"); // acá las medidas SÍ siguen (hay lugar)
  t.renderer.destroy();
});

test("la rotación del QR NO le borra al usuario el código de emparejamiento", async () => {
  // El bug que arregló la tarea 8b, del lado de la pantalla: baileys sigue
  // rotando el QR cada 20-60 s aunque ya se haya pedido un código, y en una pane
  // de 80×24 ese código es el ÚNICO camino de vinculación. Del lado del store lo
  // cubre `socket.test.ts`; acá se prueba que la vista tampoco lo pierde.
  const t = await montarLogin(80, 24, {
    phase: "pairing-shown",
    method: "code",
    methodForced: true,
    pairingCode: "ABCD1234",
    pairingRequestedAt: Date.now(),
  });
  expect(t.captureCharFrame()).toContain("ABCD-1234"); // CA-2.3

  act(() => {
    store.setLink({ qr: PAYLOAD }); // llega la rotación
    store.flushNow();
  });
  await pintar(t);

  const despues = t.captureCharFrame();
  expect(despues).toContain("ABCD-1234");
  expect(despues).toContain("ingresá este código en el teléfono");
  t.renderer.destroy();
});

test("un teléfono de 5 dígitos se rechaza explicando el formato (CA-2.2)", async () => {
  const visto = cablearComandos();
  const t = await montarLogin(80, 24);
  expect(t.captureCharFrame()).toContain("escribí tu número");

  await act(async () => {
    await t.mockInput.typeText("12345");
  });
  act(() => {
    t.mockInput.pressEnter();
  });
  await pintar(t);

  const frame = t.captureCharFrame();
  expect(frame).toContain("el número tiene 5 dígitos");
  expect(frame).toContain("van entre 8 y 15");
  // Y NO se le pidió nada a WhatsApp: un número mal escrito no gasta una llamada.
  expect(visto.telefonos).toEqual([]);
  t.renderer.destroy();
});

test("el input se come lo que no sea un dígito y con 13 sí pide el código", async () => {
  const visto = cablearComandos();
  const t = await montarLogin(80, 24);

  await act(async () => {
    await t.mockInput.typeText("+54 9 11-2233-4455");
  });
  act(() => {
    t.mockInput.pressEnter();
  });
  act(() => {
    store.flushNow();
  });
  await pintar(t);

  expect(visto.telefonos).toEqual(["5491122334455"]);
  t.renderer.destroy();
});

// ── `Ctrl-R` y `Esc` en la vinculación (CA-2.5, CA-2.4) ─────────────────────
//
// `Ctrl-R` hace dos cosas distintas según lo que se esté MIRANDO, y el pie lo
// anuncia: con el código a la vista pide otro código, en cualquier otro caso
// reconecta. Lo que decide es el método visible, no que exista un `pairingCode`
// guardado: mirando sólo eso, pedir un código una vez dejaba a `Ctrl-R` sin
// poder reconectar nunca más durante esa vinculación, y encima el pedido
// arrastraba al usuario fuera del QR (`requestPairing` fuerza `method:"code"`),
// justo el tirón que arregló la tarea 8b.

/** Pide un código desde el input, como en vivo (⏎ ⇒ `requestPairing`). */
async function pedirCodigo(t: Awaited<ReturnType<typeof montarLogin>>, numero: string) {
  await act(async () => {
    await t.mockInput.typeText(numero);
  });
  act(() => {
    t.mockInput.pressEnter();
  });
  act(() => {
    store.flushNow();
  });
  await pintar(t);
}

/** Lo que contesta WhatsApp: el código y el momento en que se pidió. */
async function llegaCodigo(
  t: Awaited<ReturnType<typeof montarLogin>>,
  codigo = "ABCD1234",
  desde = Date.now(),
) {
  act(() => {
    store.setLink({ phase: "pairing-shown", pairingCode: codigo, pairingRequestedAt: desde });
    store.flushNow();
  });
  await pintar(t);
}

/**
 * `Esc` PELADO no llega en el acto: el parser de stdin lo retiene 20 ms por si
 * es el prefijo de una secuencia (`\x1b[…`) y recién ahí lo suelta como tecla
 * —en un terminal de verdad pasa lo mismo—. Sin la espera, el frame se captura
 * antes de que el handler haya visto nada.
 */
async function apretarEsc(t: Awaited<ReturnType<typeof montarLogin>>) {
  act(() => {
    t.mockInput.pressEscape();
  });
  await act(async () => {
    await Bun.sleep(40);
  });
  act(() => {
    store.flushNow();
  });
  await pintar(t);
}

/**
 * El aviso efímero TAPA los hints (`Footer` muestra uno u otro) y vive
 * `TOAST_MS` reales; el store no tiene con qué apagarlo antes de tiempo. Los
 * tests que miran el pie esperan lo que le quede de vida — nada, si no hay
 * ninguno, que es el caso salvo justo después de un `Ctrl-R` que reconectó.
 */
async function sinToast(t: Awaited<ReturnType<typeof montarLogin>>) {
  act(() => {
    store.flushNow();
  });
  const toast = store.getSnapshot("ui").toast;
  if (!toast) return;
  await act(async () => {
    await Bun.sleep(Math.max(0, TOAST_MS - (Date.now() - toast.at)) + 20);
  });
  act(() => {
    store.flushNow();
  });
  await pintar(t);
}

test("en la vista del código, Ctrl-R pide uno NUEVO para el mismo número (CA-2.5)", async () => {
  const visto = cablearComandos();
  const t = await montarLogin(80, 24, {
    phase: "pairing-phone",
    method: "code",
    methodForced: true,
  });
  await pedirCodigo(t, "5491122334455");
  // Vencido: es el caso que CA-2.5 pide resolver con una sola tecla.
  await llegaCodigo(t, "ABCD1234", Date.now() - VIDA_CODIGO_MS);
  await sinToast(t);
  const vencido = t.captureCharFrame();
  expect(vencido).toContain("el código venció");
  expect(vencido).toContain("^R código nuevo");

  act(() => {
    t.mockInput.pressKey("r", { ctrl: true });
  });
  act(() => {
    store.flushNow();
  });
  await pintar(t);

  // Mismo número, segunda solicitud (`requestPairing` sin argumento lo reusa).
  expect(visto.telefonos).toEqual(["5491122334455", "5491122334455"]);
  expect(visto.eventos).toContain("link.pairing_pedido");
  expect(visto.reconexiones).toBe(0);
  t.renderer.destroy();
});

test("con el código en pantalla, Esc vuelve al input y deja pedir para otro número", async () => {
  // El tropiezo real: WhatsApp NO valida que el número sea tuyo, así que un
  // teléfono mal tipeado pero con formato válido devuelve un código igual. Sin
  // esta salida, corregirlo sería `Ctrl-C` y arrancar el proceso de nuevo.
  const visto = cablearComandos();
  const t = await montarLogin(80, 24, {
    phase: "pairing-phone",
    method: "code",
    methodForced: true,
  });
  // Un número distinto del `placeholder` del campo, para que verlo en pantalla
  // signifique algo: el placeholder ES el ejemplo `5491122334455`.
  await pedirCodigo(t, "5491133445566"); // el número EQUIVOCADO
  await llegaCodigo(t);
  await sinToast(t);
  const conCodigo = t.captureCharFrame();
  expect(conCodigo).toContain("ABCD-1234");
  expect(conCodigo).toContain("Esc otro número"); // el pie lo ofrece

  await apretarEsc(t);
  const enInput = t.captureCharFrame();
  expect(enInput).toContain("escribí tu número");
  expect(enInput).not.toContain("ABCD-1234");

  // Y el input quedó usable: se puede pedir para el número correcto (CA-2.4).
  await pedirCodigo(t, "5491199887766");
  expect(visto.telefonos).toEqual(["5491133445566", "5491199887766"]);
  expect(t.captureCharFrame()).toContain("pidiéndole el código");
  t.renderer.destroy();
});

test("en la vista del QR, Ctrl-R RECONECTA aunque ya se haya pedido un código", async () => {
  const visto = cablearComandos();
  // 80×40: el QR entra, así que volver a él con `Tab` es un camino real (CA-2.6).
  const t = await montarLogin(80, 40, {
    phase: "pairing-phone",
    method: "code",
    methodForced: true,
    qr: PAYLOAD,
  });
  await pedirCodigo(t, "5491122334455");
  await llegaCodigo(t);
  expect(t.captureCharFrame()).toContain("ABCD-1234");

  act(() => {
    t.mockInput.pressTab(); // vuelta al QR
  });
  act(() => {
    store.flushNow();
  });
  await pintar(t);
  await sinToast(t);
  const qr = buildQr(PAYLOAD)!;
  const enQr = t.captureCharFrame();
  expect(enQr).toContain(qr.rows[1] as string);
  expect(enQr).toContain("^R reconectar"); // lo que promete el pie

  visto.eventos.length = 0;
  act(() => {
    t.mockInput.pressKey("r", { ctrl: true });
  });
  act(() => {
    store.flushNow();
  });
  await pintar(t);

  // …y lo que hace la tecla. Reconecta:
  expect(visto.eventos).toContain("wa.reconnect_now");
  // sin pedir otro código —ni la llamada a WhatsApp ni el rastro en el log—:
  expect(visto.eventos).not.toContain("link.pairing_pedido");
  expect(visto.telefonos).toEqual(["5491122334455"]);
  // y sin sacar al usuario de la pantalla que estaba usando.
  expect(t.captureCharFrame()).toContain(qr.rows[1] as string);
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
