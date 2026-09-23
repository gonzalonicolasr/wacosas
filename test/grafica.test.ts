// Tests de la vista a CALIDAD REAL (`⏎` sobre una imagen, `src/boot/grafica.ts`).
//
// Acá no se suspende ninguna terminal ni se spawnea `chafa`: la terminal entera
// está inyectada (`Terminal`) y `correr` es un doble. Lo que se mira es la
// SECUENCIA de cosas que se le escriben a la terminal y el estado en el que
// queda el renderer, porque ahí viven los bugs de esta pantalla: una TUI que no
// se reanuda es una terminal muerta que sólo se arregla con `reset`.
import { beforeEach, expect, test } from "bun:test";

import type { FilaImagen } from "../src/boot/chafa";
import { MOTIVO_SIN_CHAFA } from "../src/boot/chafa";
import {
  argsChafaGrafico,
  borradoGrafico,
  consultaGrafica,
  CONSULTA_KITTY,
  envolverTmux,
  leerProtocolo,
  MOTIVO_OCUPADO,
  MOTIVO_SIN_TERMINAL,
  olvidarProtocolo,
  PIE_IMAGEN,
  PIE_SIMBOLOS,
  pieEnElBorde,
  pintarFilas,
  respuestaCompleta,
  type Terminal,
  verEnGrande,
} from "../src/boot/grafica";

/** La respuesta de una terminal que SÍ tiene el protocolo de kitty (Ghostty). */
const RESPUESTA_KITTY = "\x1b_Gi=31;OK\x1b\\\x1b[?62;22;52c";
/** La de una que no: contesta el DA1 y nada más (y tmux contesta esto mismo). */
const RESPUESTA_PELADA = "\x1b[?1;2;4c";

beforeEach(() => {
  // El protocolo se cachea por proceso: sin esto, el primer test le fijaría la
  // respuesta a todos los demás.
  olvidarProtocolo();
});

// ── las partes puras ─────────────────────────────────────────────────────────

test("envolverTmux duplica los escapes y cierra la envoltura", () => {
  expect(envolverTmux("\x1b_Ga=d\x1b\\")).toBe("\x1bPtmux;\x1b\x1b_Ga=d\x1b\x1b\\\x1b\\");
  // Sin escapes adentro no hay nada que duplicar, pero la envoltura va igual.
  expect(envolverTmux("hola")).toBe("\x1bPtmux;hola\x1b\\");
});

test("la consulta va pelada fuera de tmux y envuelta adentro, y siempre con el DA1", () => {
  const suelta = consultaGrafica(false);
  expect(suelta).toBe(`${CONSULTA_KITTY}\x1b[c`);
  const enTmux = consultaGrafica(true);
  expect(enTmux.startsWith("\x1bPtmux;")).toBe(true);
  // El DA1 queda AFUERA de la envoltura: lo tiene que contestar tmux si estamos
  // adentro (es el que marca "no llega nada más"), no la terminal de afuera.
  expect(enTmux.endsWith("\x1b[c")).toBe(true);
  expect(borradoGrafico(true).startsWith("\x1bPtmux;")).toBe(true);
  expect(borradoGrafico(false)).toBe("\x1b_Ga=d\x1b\\");
});

test("leerProtocolo sólo dice kitty con un OK de NUESTRO id", () => {
  expect(leerProtocolo(RESPUESTA_KITTY)).toBe("kitty");
  expect(leerProtocolo(RESPUESTA_PELADA)).toBeNull();
  expect(leerProtocolo("")).toBeNull();
  // Un OK de otro id es de otro programa (o de otra pane de tmux).
  expect(leerProtocolo("\x1b_Gi=99;OK\x1b\\\x1b[?62c")).toBeNull();
  // "Entiendo el protocolo pero eso no lo puedo hacer" no es una garantía.
  expect(leerProtocolo("\x1b_Gi=31;ENOENT:no such file\x1b\\")).toBeNull();
});

test("respuestaCompleta reconoce el DA1 y no se conforma con un pedazo", () => {
  expect(respuestaCompleta("\x1b[?62;22;52c")).toBe(true);
  expect(respuestaCompleta(RESPUESTA_KITTY)).toBe(true);
  expect(respuestaCompleta("\x1b_Gi=31;OK\x1b\\")).toBe(false);
  expect(respuestaCompleta("\x1b[?62;22")).toBe(false);
});

test("argsChafaGrafico pide kitty, dice el passthrough y acota las celdas", () => {
  const args = argsChafaGrafico("/tmp/foto.jpg", 90, 25, false);
  expect(args).toContain("--format=kitty");
  expect(args).toContain("--passthrough=none");
  expect(args).toContain("--animate=off");
  expect(args).toContain("--size=90x25");
  // La ruta va SIEMPRE después de `--`: un archivo que empiece con `-` no puede
  // convertirse en una opción.
  expect(args.slice(-2)).toEqual(["--", "/tmp/foto.jpg"]);

  expect(argsChafaGrafico("/tmp/f.jpg", 90, 25, true)).toContain("--passthrough=tmux");
  // Una terminal enorme no puede pedir un payload de 100 MB (tope de celdas).
  expect(argsChafaGrafico("/tmp/f.jpg", 900, 900, false)).toContain("--size=240x70");
  // Ni una de cero columnas puede pedir un `--size=0x0`, que chafa rechaza.
  expect(argsChafaGrafico("/tmp/f.jpg", 0, -3, false)).toContain("--size=1x1");
});

test("pintarFilas arma el color desde los `#rrggbb` ya parseados, con CR+LF", () => {
  const filas: FilaImagen[] = [
    [{ texto: "▄", fg: "#ff0000", bg: "#000080" }],
    [{ texto: "█", fg: "", bg: "" }],
  ];
  const pintado = pintarFilas(filas);
  expect(pintado).toContain("\x1b[38;2;255;0;0m");
  expect(pintado).toContain("\x1b[48;2;0;0;128m");
  // Sin color ⇒ los de la terminal, no un color inventado.
  expect(pintado).toContain("\x1b[39m\x1b[49m█");
  // `\r\n` y no `\n`: en modo crudo el `\n` solo no vuelve al margen izquierdo.
  expect(pintado.endsWith("\x1b[0m\r\n")).toBe(true);
  expect(pintado.split("\r\n")).toHaveLength(3);
  expect(pintarFilas([])).toBe("");
});

test("el pie va clavado en la última fila, recortado y SIN salto de línea", () => {
  const pie = pieEnElBorde("cualquier tecla vuelve", 40, 26);
  // Posición absoluta: el cursor quedó donde lo dejó la imagen, no acá.
  expect(pie.startsWith("\x1b[26;1H")).toBe(true);
  expect(pie).toContain("\x1b[2K");
  // Un `\n` en la última fila hace scroll, y un scroll con una imagen puesta se
  // la lleva media fila para arriba.
  expect(pie.endsWith("\n")).toBe(false);
  expect(pie).toContain("cualquier tecla vuelve");
  // En una terminal angosta se recorta: sin esto, el auto-wrap también scrollea.
  const angosto = pieEnElBorde("cualquier tecla vuelve a wacosas · ^C sale", 12, 5);
  expect(angosto.startsWith("\x1b[5;1H")).toBe(true);
  expect(angosto.endsWith("…")).toBe(true);
});

// ── la vista entera ──────────────────────────────────────────────────────────

type Guion = {
  /**
   * Lo que contesta la terminal a la consulta del protocolo. Con una lista, cada
   * lectura devuelve el siguiente tramo: es como se prueba la espera extra de
   * tmux (el DA1 primero, la respuesta gráfica después).
   */
  respuesta?: string | string[];
  /** La tecla que "aprieta" el usuario para volver. */
  tecla?: string;
  esTerminal?: boolean;
};

function armar(guion: Guion = {}) {
  const escrito: string[] = [];
  const pasos: string[] = [];
  const respuestas = Array.isArray(guion.respuesta) ? [...guion.respuesta] : [guion.respuesta ?? ""];
  const term: Terminal = {
    esTerminal: () => guion.esTerminal ?? true,
    columnas: () => 90,
    filas: () => 26,
    escribir(datos) {
      escrito.push(typeof datos === "string" ? datos : `<${datos.length} bytes>`);
    },
    vaciar: async () => {},
    crudo(activo) {
      pasos.push(activo ? "crudo:on" : "crudo:off");
    },
    async leer(_ms, hasta) {
      // Con `hasta` es la CONSULTA del protocolo; sin él, la espera de tecla.
      if (hasta) {
        pasos.push("consulta");
        return respuestas.shift() ?? "";
      }
      pasos.push("tecla");
      return guion.tecla ?? " ";
    },
  };
  const renderer = {
    suspend: () => pasos.push("suspend"),
    resume: () => pasos.push("resume"),
  };
  return { term, renderer, escrito, pasos, todo: () => escrito.join("") };
}

/** Un `chafa` de juguete: devuelve cuatro bytes y anota con qué lo llamaron. */
function chafaFalso(cmd: { visto: string[][] }) {
  return async (c: string[]) => {
    cmd.visto.push(c);
    return { ok: true as const, bytes: new Uint8Array([1, 2, 3, 4]) };
  };
}

test("con protocolo gráfico: suspende, dibuja los bytes de chafa y reanuda", async () => {
  const { term, renderer, escrito, pasos, todo } = armar({ respuesta: RESPUESTA_KITTY });
  const cmd = { visto: [] as string[][] };

  const r = await verEnGrande({
    ruta: "/tmp/foto.jpg",
    renderer,
    term,
    which: () => "/usr/bin/chafa",
    correr: chafaFalso(cmd),
    enTmux: false,
  });

  expect(r).toEqual({ ok: true, calidad: "kitty" });
  // El orden es el contrato: suspender ANTES de escribir nada, reanudar DESPUÉS
  // de haber soltado el modo crudo.
  expect(pasos).toEqual(["suspend", "crudo:on", "consulta", "tecla", "crudo:off", "resume"]);
  // Entró a la pantalla alternativa y salió: el prompt de atrás queda intacto.
  expect(escrito[0]).toContain("\x1b[?1049h");
  expect(todo()).toContain("\x1b[?1049l");
  // Los bytes de chafa se escriben CRUDOS (son píxeles, no se pueden parsear).
  expect(escrito).toContain("<4 bytes>");
  expect(todo()).toContain(PIE_IMAGEN);
  // Y antes de volver, las imágenes se despegan de la pantalla.
  expect(todo()).toContain("\x1b_Ga=d\x1b\\");
  // `chafa` se llamó UNA vez, con el tamaño de la terminal menos el renglón de
  // teclas de abajo.
  expect(cmd.visto).toHaveLength(1);
  expect(cmd.visto[0]).toContain("--size=90x25");
});

test("sin protocolo gráfico cae a símbolos, a pantalla completa y avisando", async () => {
  const { term, renderer, pasos, todo } = armar({ respuesta: RESPUESTA_PELADA });
  const pedido: Array<[number, number]> = [];

  const r = await verEnGrande({
    ruta: "/tmp/foto.jpg",
    renderer,
    term,
    enTmux: false,
    // El `chafa` gráfico ni se busca: se va por el camino de símbolos.
    which: () => {
      throw new Error("no se tiene que buscar el binario gráfico");
    },
    simbolos: async (_ruta, cols, filas) => {
      pedido.push([cols, filas]);
      return { ok: true as const, filas: [[{ texto: "▄", fg: "#ff0000", bg: "#000000" }]] };
    },
  });

  expect(r).toEqual({ ok: true, calidad: "simbolos" });
  expect(pedido).toEqual([[90, 25]]);
  // Lo que se pinta salió del PARSER (no es la salida cruda de chafa).
  expect(todo()).toContain("\x1b[38;2;255;0;0m\x1b[48;2;0;0;0m▄");
  // Y se dice por qué se ve así: sin esto parece que la imagen es la mala.
  expect(todo()).toContain(PIE_SIMBOLOS);
  expect(pasos).toEqual(["suspend", "crudo:on", "consulta", "tecla", "crudo:off", "resume"]);
});

test("en tmux la respuesta gráfica llega DESPUÉS del DA1 y se espera un toque más", async () => {
  // Exactamente lo que se midió en tmux 3.6b + Ghostty: tmux contesta el DA1 al
  // instante (`\e[?1;2;4c`, con su `4` de sixel que acá no se usa) y el `OK` de
  // la terminal de afuera llega 5 ms más tarde, en otra lectura.
  const { term, renderer, pasos } = armar({
    respuesta: [RESPUESTA_PELADA, "\x1b_Gi=31;OK\x1b\\"],
  });
  const cmd = { visto: [] as string[][] };

  const r = await verEnGrande({
    ruta: "/tmp/foto.jpg",
    renderer,
    term,
    which: () => "/usr/bin/chafa",
    correr: chafaFalso(cmd),
    enTmux: true,
  });

  expect(r).toEqual({ ok: true, calidad: "kitty" });
  // Dos lecturas de consulta: la que corta en el DA1 y la de gracia.
  expect(pasos.filter((p) => p === "consulta")).toHaveLength(2);
  // Y el dibujo va envuelto: sin `--passthrough=tmux` no se ve nada.
  expect(cmd.visto[0]).toContain("--passthrough=tmux");
});

test("fuera de tmux el DA1 pelado es un `no` y no cuesta ni una espera de más", async () => {
  const { term, renderer, pasos } = armar({ respuesta: [RESPUESTA_PELADA, "\x1b_Gi=31;OK\x1b\\"] });

  const r = await verEnGrande({
    ruta: "/tmp/foto.jpg",
    renderer,
    term,
    enTmux: false,
    simbolos: async () => ({ ok: true as const, filas: [[{ texto: "▄", fg: "#fff", bg: "#000" }]] }),
  });

  expect(r.calidad).toBe("simbolos");
  expect(pasos.filter((p) => p === "consulta")).toHaveLength(1);
});

test("^C sobre la imagen cierra la aplicación y NO reanuda la TUI", async () => {
  const { term, renderer, pasos, todo } = armar({ respuesta: RESPUESTA_KITTY, tecla: "\x03" });
  let cerrado = 0;

  await verEnGrande({
    ruta: "/tmp/foto.jpg",
    renderer,
    term,
    which: () => "/usr/bin/chafa",
    correr: chafaFalso({ visto: [] }),
    enTmux: false,
    alSalir: () => cerrado++,
  });

  expect(cerrado).toBe(1);
  // Reanudar para cerrar medio segundo después es un parpadeo de gusto.
  expect(pasos).not.toContain("resume");
  // Pero la terminal queda ENTREGADA igual: fuera del modo crudo, fuera de la
  // pantalla alternativa y con el cursor a la vista (CA-17.2, sin `reset`).
  expect(pasos).toContain("crudo:off");
  expect(todo()).toContain("\x1b[?1049l");
  expect(todo()).toContain("\x1b[?25h");
});

test("sin `chafa` lo dice en pantalla, y la TUI vuelve igual", async () => {
  const { term, renderer, pasos, todo } = armar({ respuesta: RESPUESTA_KITTY });

  const r = await verEnGrande({
    ruta: "/tmp/foto.jpg",
    renderer,
    term,
    which: () => null,
    enTmux: false,
  });

  expect(r.ok).toBe(false);
  expect(r.reason).toBe(MOTIVO_SIN_CHAFA);
  expect(todo()).toContain(MOTIVO_SIN_CHAFA);
  // Lo que no se negocia: la pantalla se cierra y el renderer se reanuda.
  expect(pasos).toEqual(["suspend", "crudo:on", "consulta", "tecla", "crudo:off", "resume"]);
});

test("una terminal que explota al escribir igual devuelve la TUI", async () => {
  const { term, renderer, pasos } = armar({ respuesta: RESPUESTA_KITTY });
  let primera = true;
  const roto: Terminal = {
    ...term,
    escribir() {
      if (primera) {
        primera = false;
        throw new Error("la terminal se cayó");
      }
    },
  };

  const r = await verEnGrande({
    ruta: "/tmp/foto.jpg",
    renderer,
    term: roto,
    which: () => "/usr/bin/chafa",
    correr: chafaFalso({ visto: [] }),
    enTmux: false,
  });

  expect(r.ok).toBe(false);
  expect(r.reason).toBe("la terminal se cayó");
  expect(pasos).toContain("resume");
});

test("fuera de una terminal de verdad no se suspende nada", async () => {
  const { term, renderer, pasos } = armar({ esTerminal: false });

  const r = await verEnGrande({ ruta: "/tmp/foto.jpg", renderer, term, enTmux: false });

  expect(r).toEqual({ ok: false, reason: MOTIVO_SIN_TERMINAL });
  // Ni `suspend`: una TUI suspendida sin nadie que la reanude es una terminal
  // muerta, y esto pasa justo donde no hay quién la rescate (un pipe, un test).
  expect(pasos).toEqual([]);
});

test("dos `⏎` en el mismo tick no suspenden dos veces", async () => {
  const { term, renderer, pasos } = armar({ respuesta: RESPUESTA_KITTY });
  const opciones = {
    ruta: "/tmp/foto.jpg",
    renderer,
    term,
    which: () => "/usr/bin/chafa",
    correr: chafaFalso({ visto: [] }),
    enTmux: false,
  };

  const [a, b] = await Promise.all([verEnGrande(opciones), verEnGrande(opciones)]);
  const ocupado = [a, b].find((r) => !r.ok);
  expect(ocupado?.reason).toBe(MOTIVO_OCUPADO);
  expect(pasos.filter((p) => p === "suspend")).toHaveLength(1);
  expect(pasos.filter((p) => p === "resume")).toHaveLength(1);
});

test("el protocolo se pregunta UNA vez por proceso", async () => {
  const { term, renderer } = armar({ respuesta: RESPUESTA_KITTY });
  const cmd = { visto: [] as string[][] };
  const opciones = {
    ruta: "/tmp/foto.jpg",
    renderer,
    term,
    which: () => "/usr/bin/chafa",
    correr: chafaFalso(cmd),
    enTmux: false,
  };

  await verEnGrande(opciones);
  // La segunda vez la terminal ya no contesta nada: si volviera a preguntar,
  // caería a símbolos y `chafa` no recibiría `--format=kitty`.
  const { term: mudo } = armar({ respuesta: "" });
  await verEnGrande({ ...opciones, term: mudo });

  expect(cmd.visto).toHaveLength(2);
  expect(cmd.visto[1]).toContain("--format=kitty");
});
