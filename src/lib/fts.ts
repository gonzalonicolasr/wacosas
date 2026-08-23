// Sanitización de la búsqueda full-text (design §5.3, CA-12.5) y lectura del
// fragmento que devuelve `snippet()` (CA-12.2). Puro: no toca la base.
//
// El buscador está SIEMPRE activo mientras el usuario tipea, así que la mitad de
// las queries que llegan acá son sintaxis rota a medio escribir (`"algo`, `foo (`,
// `-x`). Nada de eso puede llegar crudo a un `MATCH`: FTS5 tira un error de
// sintaxis y se lleva puesta la consulta. Por eso el texto se tokeniza y se
// vuelve a citar término por término —mismo patrón que `miscosas/src/repo.js`,
// ya probado en producción—: entrecomillado, las comillas, `*`, `-`, `:` y los
// paréntesis quedan como texto literal y no como sintaxis.
import type { Part } from "./fmt";

/** Tope de lo que se mira de la query: el resto es ruido de pegar un texto. */
const MAX_QUERY_LEN = 200;
/** Tope de términos: más que esto ya no filtra, sólo hace lenta la consulta. */
const MAX_TERMS = 8;
/** Operadores booleanos/de proximidad de FTS5: jamás como palabra pelada. */
const FTS_OPERADORES = new Set(["AND", "OR", "NOT", "NEAR"]);
/** Todo lo que no sea letra ni número separa términos. */
const SEPARADORES = /[^\p{L}\p{N}]+/u;

// Marcadores que envuelven cada coincidencia en `snippet(...)` (design §5.2).
// Se arman con `fromCharCode` en vez de escribirlos literales: son caracteres de
// control invisibles y en el fuente no se distinguirían de un typo.
/** `char(1)` de la consulta: abre un tramo resaltado. */
export const SNIPPET_OPEN = String.fromCharCode(1);
/** `char(2)` de la consulta: lo cierra. */
export const SNIPPET_CLOSE = String.fromCharCode(2);

/**
 * Convierte texto libre en una expresión `MATCH` segura (CA-12.5): parte por
 * cualquier cosa que no sea letra o número, descarta los operadores de FTS5,
 * entrecomilla cada término y le agrega `*` para que matchee por prefijo.
 *
 *   buildFtsQuery('hola "mundo" -x*: (a)')  →  '"hola"* "mundo"* "x"* "a"*'
 *
 * Devuelve `''` si no quedó ningún término utilizable: el caller decide qué
 * hacer con eso (listar todo o no buscar), pero NUNCA le pasa un `''` a `MATCH`.
 */
export function buildFtsQuery(raw: string): string {
  const texto = String(raw ?? "")
    .trim()
    .slice(0, MAX_QUERY_LEN);
  if (!texto) return "";

  return texto
    .split(SEPARADORES)
    .filter((tkn) => tkn.length > 0 && !FTS_OPERADORES.has(tkn))
    .slice(0, MAX_TERMS)
    .map((tkn) => `"${tkn}"*`)
    .join(" ");
}

/**
 * Parte el fragmento de `snippet()` en tramos, marcando los resaltados (CA-12.2).
 * Los delimitadores son `char(1)`/`char(2)`: caracteres de control que no pueden
 * aparecer en un mensaje real, así que no hay forma de que el texto del usuario
 * se disfrace de marca.
 */
export function parseSnippet(frag: string): Part[] {
  const parts: Part[] = [];
  let buf = "";
  let hit = false;
  for (const ch of String(frag ?? "")) {
    if (ch === SNIPPET_OPEN || ch === SNIPPET_CLOSE) {
      if (buf) parts.push({ text: buf, hit });
      buf = "";
      hit = ch === SNIPPET_OPEN;
      continue;
    }
    buf += ch;
  }
  if (buf) parts.push({ text: buf, hit });
  return parts;
}
