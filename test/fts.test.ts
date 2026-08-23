// Tests de lib/fts.ts: sanitización de la query (CA-12.5) y lectura del
// fragmento de `snippet()` (CA-12.2).
import { expect, test } from "bun:test";

import { SNIPPET_CLOSE, SNIPPET_OPEN, buildFtsQuery, parseSnippet } from "../src/lib/fts";

test('buildFtsQuery(\'hola "mundo" -x*: (a)\') ⇒ "hola"* "mundo"* "x"* "a"* (CA-12.5)', () => {
  expect(buildFtsQuery('hola "mundo" -x*: (a)')).toBe('"hola"* "mundo"* "x"* "a"*');
});

test("una query vacía (o de puro símbolo) devuelve '' (CA-12.5)", () => {
  expect(buildFtsQuery("")).toBe("");
  expect(buildFtsQuery("   ")).toBe("");
  expect(buildFtsQuery('"')).toBe("");
  expect(buildFtsQuery("-*:()")).toBe("");
  expect(buildFtsQuery(undefined as unknown as string)).toBe("");
  expect(buildFtsQuery(null as unknown as string)).toBe("");
});

test("ningún carácter de sintaxis de FTS5 sobrevive fuera de las comillas (CA-12.5)", () => {
  // La query rota del done-when de la tarea 16, tal cual la tipearía el usuario.
  for (const raw of ['"comillas" -guion (paren) *ast :dosp', 'foo"', "a (b", "NEAR(x y)", "^ini", "a OR"]) {
    const q = buildFtsQuery(raw);
    // Sólo términos entrecomillados con `*` pegado, separados por un espacio.
    expect(q).toMatch(/^(?:"[\p{L}\p{N}]+"\*)(?: "[\p{L}\p{N}]+"\*)*$/u);
  }
});

test("los operadores de FTS5 se descartan como palabra pelada", () => {
  expect(buildFtsQuery("hola AND chau")).toBe('"hola"* "chau"*');
  expect(buildFtsQuery("AND OR NOT NEAR")).toBe("");
  // En minúscula no son operadores: son texto que el usuario quiso buscar.
  expect(buildFtsQuery("and or")).toBe('"and"* "or"*');
});

test("los acentos y las mayúsculas se dejan pasar: los resuelve el tokenizer", () => {
  // `remove_diacritics 2` en el DDL (§4.1) hace que "manana" encuentre "Mañana";
  // acá no hay que plegar nada, sólo no romper el término.
  expect(buildFtsQuery("Mañana")).toBe('"Mañana"*');
});

test("una query gigante no se lleva la consulta puesta", () => {
  const q = buildFtsQuery(`${"palabra ".repeat(500)}`);
  // Tope de 8 términos, y ninguno truncado a la mitad de una comilla.
  expect(q.split(" ")).toHaveLength(8);
  expect(q).toBe('"palabra"* '.repeat(8).trim());
});

test("parseSnippet parte el fragmento y marca los resaltados (CA-12.2)", () => {
  const frag = `nos vemos ${SNIPPET_OPEN}mañana${SNIPPET_CLOSE} temprano`;
  expect(parseSnippet(frag)).toEqual([
    { text: "nos vemos ", hit: false },
    { text: "mañana", hit: true },
    { text: " temprano", hit: false },
  ]);
});

test("parseSnippet aguanta varias marcas, el fragmento vacío y el texto sin marcas", () => {
  expect(parseSnippet(`${SNIPPET_OPEN}a${SNIPPET_CLOSE} y ${SNIPPET_OPEN}b${SNIPPET_CLOSE}`)).toEqual([
    { text: "a", hit: true },
    { text: " y ", hit: false },
    { text: "b", hit: true },
  ]);
  expect(parseSnippet("")).toEqual([]);
  expect(parseSnippet("sin marcas")).toEqual([{ text: "sin marcas", hit: false }]);
  // El texto reconstruido es siempre el original menos las marcas.
  const frag = `…${SNIPPET_OPEN}hola${SNIPPET_CLOSE} che`;
  expect(
    parseSnippet(frag)
      .map((p) => p.text)
      .join(""),
  ).toBe("…hola che");
});
