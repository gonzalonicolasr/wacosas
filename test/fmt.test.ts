// Tests de lib/fmt.ts: plegado (CA-5.2), recorte a una línea (CA-4.6), hora
// (CA-6.2), fecha relativa (CA-4.1) y tramos resaltados (CA-12.2).
//
// Dos precauciones para que el test no mienta:
//   · las fechas se arman con `new Date(año, mes, día, …)`, o sea en hora LOCAL,
//     así el resultado no depende de la zona horaria de quien lo corre;
//   · las palabras con acento nunca se comparan contra un literal escrito acá
//     (podría estar precompuesto o descompuesto y serían strings distintos): se
//     comparan contra `fold()` o contra pedazos del mismo texto de entrada.
import { expect, test } from "bun:test";

import { clip, fmtRelDate, fmtTime, fold, highlightParts, oneLine } from "../src/lib/fmt";

/** Epoch en SEGUNDOS (la unidad de `messages.ts`, design §4.1) en hora local. */
const seg = (y: number, mes: number, d: number, h = 0, min = 0) =>
  Math.floor(new Date(y, mes, d, h, min).getTime() / 1000);

// ── fold (CA-5.2, CA-12.6) ───────────────────────────────────────────────────

test("fold saca acentos y mayúsculas: 'Mañana' y 'manana' pliegan igual (CA-5.2)", () => {
  expect(fold("Mañana")).toBe("manana");
  expect(fold("manana")).toBe("manana");
  expect(fold("MAÑANA")).toBe(fold("mañana"));
  expect(fold("Sofía Gómez")).toBe("sofia gomez");
  expect(fold("ÁÉÍÓÚÜ")).toBe("aeiouu");
});

test("fold no rompe lo que no tiene acentos ni deja marcas sueltas", () => {
  expect(fold("+54 9 11 5555-5555")).toBe("+54 9 11 5555-5555");
  expect(fold("")).toBe("");
  expect(fold(null as unknown as string)).toBe("");
  // Descompuesto (n + tilde suelta) y precompuesto (ñ) caen en lo mismo.
  expect(fold("mañana".normalize("NFD"))).toBe("manana");
  expect(fold("mañana".normalize("NFC"))).toBe("manana");
});

// ── clip (CA-4.6) ────────────────────────────────────────────────────────────

test("clip deja una sola línea aunque el texto traiga saltos (CA-4.6)", () => {
  expect(oneLine("hola\nque\ttal\r\n che")).toBe("hola que tal che");
  expect(clip("hola\nque tal", 40)).toBe("hola que tal");
  expect(clip("hola\nque tal", 40)).not.toContain("\n");
});

test("clip recorta con … y respeta el ancho exacto (CA-4.6)", () => {
  expect(clip("holaaa", 10)).toBe("holaaa");
  expect(clip("holaaa", 6)).toBe("holaaa"); // justo, sin puntos suspensivos
  expect(clip("holaaa", 5)).toBe("hola…");
  expect(Array.from(clip("holaaa", 5))).toHaveLength(5);
  expect(clip("holaaa", 1)).toBe("…");
  expect(clip("holaaa", 0)).toBe("");
  expect(clip("", 10)).toBe("");
});

test("clip no parte un emoji al medio", () => {
  // Cortando por unidades UTF-16 saldría media pareja suplente en la bandeja.
  expect(clip("😀😀😀", 2)).toBe("😀…");
  expect(clip("📷 imagen", 4)).toBe("📷 i…");
  expect(clip("😀😀😀", 2)).not.toContain("�");
});

// ── fmtTime / fmtRelDate (CA-6.2, CA-4.1) ────────────────────────────────────

test("fmtTime da HH:MM en 24 h y ancho fijo (CA-6.2)", () => {
  expect(fmtTime(seg(2026, 7, 23, 14, 32))).toBe("14:32");
  expect(fmtTime(seg(2026, 7, 23, 9, 5))).toBe("09:05");
  expect(fmtTime(seg(2026, 7, 23, 0, 0))).toBe("00:00");
});

test("fmtRelDate: hoy ⇒ hora, ayer ⇒ 'ayer', esta semana ⇒ día (CA-4.1)", () => {
  const ahora = seg(2026, 7, 23, 18, 0); // domingo 23/08/2026
  expect(fmtRelDate(seg(2026, 7, 23, 14, 32), ahora)).toBe("14:32");
  expect(fmtRelDate(seg(2026, 7, 23, 0, 1), ahora)).toBe("00:01"); // hoy temprano, no "ayer"
  expect(fmtRelDate(seg(2026, 7, 22, 23, 59), ahora)).toBe("ayer");
  expect(fmtRelDate(seg(2026, 7, 20, 10, 0), ahora)).toBe("jue");
  expect(fmtRelDate(seg(2026, 7, 17, 10, 0), ahora)).toBe("lun"); // 6 días: todavía entra
});

test("fmtRelDate: más de una semana ⇒ dd/mm, y con el año si cambió (CA-4.1)", () => {
  const ahora = seg(2026, 7, 23, 18, 0);
  expect(fmtRelDate(seg(2026, 7, 16, 10, 0), ahora)).toBe("16/08"); // 7 días justos
  expect(fmtRelDate(seg(2026, 0, 3, 10, 0), ahora)).toBe("03/01");
  expect(fmtRelDate(seg(2025, 11, 31, 10, 0), ahora)).toBe("31/12/25");
});

test("fmtRelDate y fmtTime nunca escupen NaN ni 'Invalid Date'", () => {
  const ahora = seg(2026, 7, 23, 18, 0);

  // Lo obvio: falta el dato.
  const sinDato = [
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    undefined,
    null,
  ];

  // Lo que se escapaba: FINITOS pero enormes. `messageTimestamp` es un uint64
  // del proto que manda el otro lado —entrada remota, no confiable— y pasados
  // los 8,64e12 segundos `new Date(ts * 1000)` se desborda: `fmtTime` daba
  // "NaN:NaN" y `fmtRelDate` "NaN/NaN/aN". Y un mensaje así no sólo se ve mal:
  // queda clavado arriba de todo en la bandeja, que ordena por timestamp.
  const enormes = [8.64e12 + 1, 1e18, Number.MAX_SAFE_INTEGER, Number.MAX_VALUE];

  for (const malo of [...sinDato, ...enormes]) {
    expect(fmtRelDate(malo as number, ahora)).toBe("");
    expect(fmtTime(malo as number)).toBe("");
  }

  // El borde de arriba (el último instante que `Date` sabe representar) sí es
  // válido: el tope acota, no recorta de más.
  expect(fmtTime(8.64e12)).not.toBe("");
  expect(fmtRelDate(8.64e12, ahora)).not.toBe("");

  // Y la propiedad del título afirmada sobre TODO el corpus, buenos incluidos:
  // un corpus incompleto hace que un test así mienta.
  const buenos = [1, 8.64e12, seg(2026, 7, 23, 14, 32), seg(1999, 0, 1), seg(2030, 5, 9)];
  for (const ts of [...sinDato, ...enormes, ...buenos]) {
    for (const salida of [fmtTime(ts as number), fmtRelDate(ts as number, ahora)]) {
      expect(salida).not.toContain("NaN");
      expect(salida).not.toContain("aN"); // lo que queda de un año NaN cortado a dos dígitos
      expect(salida).not.toContain("Invalid");
    }
  }
});

test("fmtRelDate con el reloj del teléfono adelantado cae en la fecha corta", () => {
  const ahora = seg(2026, 7, 23, 18, 0);
  expect(fmtRelDate(seg(2026, 8, 1, 10, 0), ahora)).toBe("01/09");
});

// ── highlightParts (CA-12.2 sobre nombres) ───────────────────────────────────

test("highlightParts marca la coincidencia sin acentos y devuelve el texto original", () => {
  const frase = "Mañana nos vemos";
  const partes = highlightParts(frase, "manana");

  expect(partes.map((p) => p.text).join("")).toBe(frase); // no pierde ni agrega nada
  expect(partes.map((p) => p.hit)).toEqual([true, false]);
  expect(fold(partes[0].text)).toBe("manana");
  expect(partes[1].text).toBe(" nos vemos");
});

test("highlightParts encuentra el término en el medio del nombre", () => {
  const nombre = "Sofía Gómez";
  const partes = highlightParts(nombre, "gomez");

  expect(partes.map((p) => p.text).join("")).toBe(nombre);
  expect(partes.map((p) => p.hit)).toEqual([false, true]);
  expect(fold(partes[1].text)).toBe("gomez");
});

test("highlightParts sin query, sin coincidencia o con texto vacío no inventa tramos", () => {
  expect(highlightParts("Sofia", "")).toEqual([{ text: "Sofia", hit: false }]);
  expect(highlightParts("Sofia", "   -  ")).toEqual([{ text: "Sofia", hit: false }]);
  expect(highlightParts("Sofia", "juan")).toEqual([{ text: "Sofia", hit: false }]);
  expect(highlightParts("", "juan")).toEqual([]);
});

test("highlightParts junta términos que se pisan y no duplica texto", () => {
  const palabra = "mañanita";
  const partes = highlightParts(palabra, "man mana");

  expect(partes.map((p) => p.text).join("")).toBe(palabra);
  expect(partes.map((p) => p.hit)).toEqual([true, false]);
  expect(fold(partes[0].text)).toBe("mana");
  expect(partes[1].text).toBe("nita");
});
