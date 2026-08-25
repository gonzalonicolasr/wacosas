// Tests de `src/boot/chafa.ts`: la imagen convertida en celdas de texto (`^O`) y
// el color con el que se tiñe cada chat de la bandeja.
//
// Dos mitades bien distintas:
//
//   · el **parser** es PURO y se prueba con salidas de `chafa` escritas a mano.
//     Lo que hay que clavar es que los colores son de ESTADO —`chafa` sólo emite
//     la secuencia cuando algo cambia, así que una fila puede heredar el color de
//     la de arriba— y que del ANSI **no se ejecuta nada**: un `\e[2J` adentro de
//     una imagen no puede borrarle la pantalla a nadie;
//   · el **spawn** se prueba con `correr` inyectado: acá no se ejecuta `chafa`.
import { describe, expect, test } from "bun:test";

import type { Correr } from "../src/boot/clipboard";
import {
  argsChafa,
  argsColorDominante,
  colorDominante,
  masSaturado,
  MOTIVO_SIN_CHAFA,
  MOTIVO_VACIO,
  parsearChafa,
  renderizarImagen,
} from "../src/boot/chafa";

const ESC = "\u001b";
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Un `correr` de juguete que devuelve siempre lo mismo y anota qué le pidieron. */
function correrCon(salida: string, ok = true): { correr: Correr; visto: string[][] } {
  const visto: string[][] = [];
  const correr: Correr = async (cmd) => {
    visto.push(cmd);
    return ok ? { ok: true, bytes: bytes(salida) } : { ok: false, reason: "" };
  };
  return { correr, visto };
}

describe("parsearChafa", () => {
  test("una fila con dos colores sale como dos tramos", () => {
    const s = `${ESC}[38;2;1;2;3;48;2;4;5;6m▄▄${ESC}[38;2;7;8;9m▄${ESC}[0m\n`;
    expect(parsearChafa(s)).toEqual([
      [
        { texto: "▄▄", fg: "#010203", bg: "#040506" },
        // ⚠️ El fondo NO se repite en la secuencia y NO se pierde: es estado.
        { texto: "▄", fg: "#070809", bg: "#040506" },
      ],
    ]);
  });

  test("el color se hereda entre filas (chafa no lo repite)", () => {
    const s = `${ESC}[38;2;10;20;30m▄\n▄▄\n`;
    expect(parsearChafa(s)).toEqual([
      [{ texto: "▄", fg: "#0a141e", bg: "" }],
      [{ texto: "▄▄", fg: "#0a141e", bg: "" }],
    ]);
  });

  test("las secuencias que no son color se DESCARTAN (no se ejecutan ni se pintan)", () => {
    // `?25l`/`?25h` los manda chafa alrededor de la imagen; `[2J` borraría la
    // pantalla y `]0;…` cambiaría el título de la terminal.
    const s = `${ESC}[?25l${ESC}[2J${ESC}]0;titulo${ESC}[38;2;1;1;1m▄${ESC}[0m\n${ESC}[?25h`;
    const filas = parsearChafa(s);
    expect(filas).toEqual([[{ texto: "▄", fg: "#010101", bg: "" }]]);
    // Ni un byte de escape sobrevivió al parser.
    expect(JSON.stringify(filas)).not.toContain("\\u001b");
  });

  test("`0` y `39`/`49` vuelven a los colores del panel", () => {
    const s = `${ESC}[38;2;9;9;9;48;2;8;8;8mA${ESC}[39mB${ESC}[49mC${ESC}[0mD\n`;
    expect(parsearChafa(s)).toEqual([
      [
        { texto: "A", fg: "#090909", bg: "#080808" },
        { texto: "B", fg: "", bg: "#080808" },
        // `C` y `D` quedan en UN tramo: ya tienen el mismo color, y abrir uno
        // nuevo por cada secuencia sería un `<span>` de más por celda.
        { texto: "CD", fg: "", bg: "" },
      ],
    ]);
  });

  test("las filas vacías del final no cuentan; las del medio sí", () => {
    expect(parsearChafa("A\n\nB\n\n\n")).toEqual([
      [{ texto: "A", fg: "", bg: "" }],
      [],
      [{ texto: "B", fg: "", bg: "" }],
    ]);
    expect(parsearChafa("")).toEqual([]);
  });
});

describe("argsChafa", () => {
  test("pide símbolos de ancho 1 y el tamaño en celdas", () => {
    const a = argsChafa("/tmp/foto.png", 40, 12);
    // ⚠️ Estos tres son la diferencia entre una imagen alineada y un dibujito
    // corrido: con el set completo de símbolos entran glifos de ancho ambiguo.
    expect(a).toContain("--symbols=space+vhalf+solid");
    expect(a).toContain("--colors=full");
    expect(a).toContain("--size=40x12");
    // El `--` es lo que impide que un nombre de archivo que empieza con `-` se
    // lea como una opción.
    expect(a[a.length - 2]).toBe("--");
    expect(a[a.length - 1]).toBe("/tmp/foto.png");
  });

  test("un tamaño absurdo se acota en vez de pedírselo a chafa", () => {
    expect(argsChafa("/x", 1e6, 1e6)).toContain("--size=400x200");
    expect(argsChafa("/x", 0, -5)).toContain("--size=1x1");
  });
});

describe("renderizarImagen", () => {
  test("sin el binario avisa cómo arreglarlo y no lanza", async () => {
    const r = await renderizarImagen("/tmp/x.png", 10, 5, { which: () => null });
    expect(r).toEqual({ ok: false, reason: MOTIVO_SIN_CHAFA });
  });

  test("un `which` que LANZA es un `which` que no encontró nada", async () => {
    const r = await renderizarImagen("/tmp/x.png", 10, 5, {
      which: () => {
        throw new Error("PATH roto");
      },
    });
    expect(r).toEqual({ ok: false, reason: MOTIVO_SIN_CHAFA });
  });

  test("chafa que no pudo con el archivo: motivo entendible, sin excepción", async () => {
    const { correr } = correrCon("", false);
    const r = await renderizarImagen("/tmp/x.png", 10, 5, { bin: "/usr/bin/chafa", correr });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("chafa no pudo");
  });

  test("una salida vacía no se toma por una imagen", async () => {
    const { correr } = correrCon("");
    const r = await renderizarImagen("/tmp/x.png", 10, 5, { bin: "/usr/bin/chafa", correr });
    expect(r).toEqual({ ok: false, reason: MOTIVO_VACIO });
  });
});

describe("masSaturado", () => {
  test("gana el de más croma, no el más claro", () => {
    expect(masSaturado(["#808080", "#c02020", "#f0f0f0"])).toBe("#c02020");
  });

  test("un casi negro no aporta color aunque tenga croma", () => {
    expect(masSaturado(["#200400", "#8a8f95"])).toBe("#8a8f95");
  });

  test("a igual croma gana el más claro; sin nada usable devuelve null", () => {
    expect(masSaturado(["#404040", "#c0c0c0"])).toBe("#c0c0c0");
    expect(masSaturado([])).toBeNull();
    expect(masSaturado(["", "no-es-un-color", "#000000"])).toBeNull();
  });
});

describe("colorDominante", () => {
  test("muestrea una GRILLA y se queda con la celda más viva", async () => {
    // ⚠️ Es el caso que justifica la grilla: el promedio de un retrato es barro
    // (beige grisáceo), y lo que distingue un chat de otro es el color fuerte que
    // hay en alguna parte de la foto.
    const s =
      `${ESC}[38;2;155;142;128m█${ESC}[38;2;160;145;130m█${ESC}[38;2;161;48;86m█${ESC}[0m\n`;
    const { correr, visto } = correrCon(s);
    expect(await colorDominante("/tmp/perfil.jpg", { bin: "/usr/bin/chafa", correr })).toBe("#a13056");
    expect(visto[0]).toContain("--size=5x5");
    expect(visto[0]).toContain("--stretch"); // sin esto una foto vertical da menos filas
  });

  test("sin chafa devuelve null en vez de romper la bandeja", async () => {
    expect(await colorDominante("/tmp/perfil.jpg", { which: () => null })).toBeNull();
  });

  test("argsColorDominante fuerza el bloque lleno (un color por celda)", () => {
    expect(argsColorDominante("/x.jpg")).toContain("--symbols=solid");
  });
});
