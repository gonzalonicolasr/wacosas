// Formateo puro para la interfaz (design §3 → `lib/fmt.ts`): plegado sin acentos
// ni mayúsculas (CA-5.2), recorte a una sola línea (CA-4.6), hora de un mensaje
// (CA-6.2), fecha relativa de la bandeja (CA-4.1) y partido en tramos resaltados
// (CA-12.2).
//
// Tres reglas que valen para todo el archivo:
//   · los timestamps entran en EPOCH SEGUNDOS —la unidad de `messages.ts` y de
//     `chats.last_message_at` (design §4.1)—, nunca en milisegundos;
//   · el "ahora" se inyecta siempre, así los tests no dependen del reloj;
//   · nada de I/O, nada de estado, cero deps (D12). Lo único que se usa del
//     runtime es `Bun.stringWidth` —una función pura— para medir columnas de
//     terminal; ver la sección "ancho en COLUMNAS" para por qué no alcanza con
//     contar caracteres.

/** Un tramo de texto y si cae dentro de una coincidencia (CA-12.2). */
export type Part = { text: string; hit: boolean };

/** Espacios y controles C0/C1. No incluye `\p{Cf}` a propósito: ahí vive el ZWJ
 *  que pega las secuencias de emoji, y sacarlo partiría 👨‍👩‍👧 en tres. */
const ESPACIOS_Y_CONTROLES = /[\s\p{Cc}]+/gu;

/** Todo lo que no sea letra ni número: separa términos en `highlightParts`. */
const SEPARADORES = /[^\p{L}\p{N}]+/u;

const DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"] as const;

const MS_POR_DIA = 86_400_000;

/**
 * Pliega para comparar: sin acentos y sin mayúsculas (CA-5.2, CA-12.6).
 * `fold("Mañana") === "manana"`. Es el mismo criterio que el tokenizer FTS5 con
 * `remove_diacritics 2`, pero del lado de JS, para el filtro de la bandeja.
 */
export function fold(s: string): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

/** Aplasta saltos, tabs y controles a un espacio simple. Base de `clip`. */
export function oneLine(s: string): string {
  return String(s ?? "").replace(ESPACIOS_Y_CONTROLES, " ").trim();
}

// ── ancho en COLUMNAS de terminal ───────────────────────────────────────────
//
// ⚠️ Esta sección corrige el que era el bug de emojis de wacosas, y conviene
// leer qué se midió antes de tocarla (OpenTUI 0.4.2 + Bun 1.3.14, con
// `testRender` y contando los espacios de relleno de una caja de ancho fijo,
// que es el único método que no depende de saber los anchos de antemano):
//
//  · **OpenTUI mide bien.** Agrupa por GRAFEMA y le da dos columnas a lo que el
//    terminal dibuja en dos: `👨‍👩‍👧` (ZWJ) → 2, `🇦🇷` (bandera) → 2, `1️⃣`
//    (keycap) → 2, `👍🏽` (tono de piel) → 2, `日` → 2, `⏳`/`❔` → 2. Y les da
//    **cero** a las marcas combinantes, incluidas las que `Bun.stringWidth`
//    cuenta como 1 (hebreo `U+0591`, árabe `U+064B`). O sea que el §7.4.11 del
//    diseño se lee al revés de como está escrito: la que miente es
//    `Bun.stringWidth`, y **por punto de código**; el renderer está bien.
//  · **Quien contaba mal era `clip()`**, que contaba PUNTOS DE CÓDIGO. Medido:
//    `clip("🎉🎉🎉🎉🎉 fiesta", 6)` devolvía 11 columnas para un presupuesto de
//    6 —casi el doble—, y `clip("🇦🇷 argentina", 2)` partía la bandera al medio
//    dejando un indicador regional suelto (que se dibuja como una "A" en un
//    cuadrito). Cada `📷 imagen` de un preview se pasaba por una columna, así
//    que OpenTUI se comía el último carácter de la fila.
//
// De ahí las dos reglas de abajo: cortar por GRAFEMA (nunca adentro de un
// cluster) y contar COLUMNAS (nunca puntos de código).

/**
 * Marcas que NO ocupan columna y que `Bun.stringWidth` cuenta igual como 1.
 *
 * `U+FE0F` (selector de variación 16) y `U+20E3` (keycap) quedan AFUERA a
 * propósito aunque también sean `Mn`/`Me`: esos dos no se suman al ancho, lo
 * CAMBIAN —`✉` mide 1 y `✉️` mide 2—, y `Bun.stringWidth` ya los resuelve bien.
 */
const MARCAS_SIN_ANCHO = /(?![\uFE0F\u20E3])[\p{Mn}\p{Me}]/gu;

/** Segmentador de grafemas. Uno solo: construirlo cuesta y no tiene estado. */
const GRAFEMAS = new Intl.Segmenter("es", { granularity: "grapheme" });

/** Los grafemas de un texto: `👨‍👩‍👧` es UNO, no cinco puntos de código. */
export function grafemas(s: string): string[] {
  const out: string[] = [];
  for (const g of GRAFEMAS.segment(String(s ?? ""))) out.push(g.segment);
  return out;
}

/**
 * Columnas que ocupa UN grafema (0, 1 o 2).
 *
 * `Bun.stringWidth` sobre el cluster entero acierta en todo lo que se midió
 * —emoji, ZWJ, banderas, keycaps, tonos de piel, CJK— menos en las marcas
 * combinantes, que suma de a 1: por eso se las saca antes de medir. El único
 * desacuerdo que quedó contra OpenTUI es el keycap SIN selector (`1⃣`), donde
 * esto devuelve 2 y el renderer 1: sobra una columna, o sea que se recorta un
 * poco antes. Pasarse nunca; quedarse corto, sí.
 */
export function anchoGrafema(g: string): number {
  const limpio = String(g ?? "").replace(MARCAS_SIN_ANCHO, "");
  if (limpio === "") return 0;
  return Math.max(0, Bun.stringWidth(limpio));
}

/** Columnas de terminal que ocupa un texto (CA-4.6). No cuenta caracteres. */
export function anchoTexto(s: string): number {
  let total = 0;
  for (const g of grafemas(s)) total += anchoGrafema(g);
  return total;
}

/**
 * Deja el texto en una sola línea de a lo sumo `width` COLUMNAS de terminal, con
 * `…` si sobra (CA-4.6).
 *
 * Dos garantías, las dos medidas contra el frame de OpenTUI:
 *
 *  1. **nunca se pasa del ancho pedido** —un `📷` cuenta 2, no 1—, así que la
 *     caja que lo contiene no tiene que recortar nada y el `…` no desaparece;
 *  2. **nunca corta adentro de un grafema**: ni un par suplente por la mitad
 *     (`` ), ni una bandera partida en un indicador regional suelto, ni una
 *     secuencia ZWJ dejando un `‍` colgado del `…`.
 *
 * La columna del `…` se reserva ANTES de repartir, así que el resultado entra
 * siempre. Si el último grafema que entraría es ancho y sobra una sola columna,
 * se lo deja afuera: queda un hueco de una columna, que es infinitamente mejor
 * que pasarse.
 */
export function clip(s: string, width: number): string {
  const linea = oneLine(s);
  if (!Number.isFinite(width) || width <= 0) return "";
  const tope = Math.floor(width);
  if (anchoTexto(linea) <= tope) return linea;

  // Se recorta: hay que reservar la columna del `…`.
  const presupuesto = tope - 1;
  let usado = 0;
  let corte = "";
  for (const g of grafemas(linea)) {
    const w = anchoGrafema(g);
    if (usado + w > presupuesto) break;
    corte += g;
    usado += w;
  }
  return `${corte}…`;
}

/** El último instante que `Date` sabe representar: ±8,64e15 ms desde epoch, o
 *  sea 8,64e12 segundos. Un segundo más y `new Date(ts * 1000)` es `Invalid
 *  Date` y todo lo que se le pregunte devuelve `NaN`. */
const TS_MAX_SEG = 8.64e12;

/** Un timestamp que se pueda mostrar: `0`, `NaN` o negativo = dato faltante, y
 *  arriba de `TS_MAX_SEG` también. El tope no es paranoia: `messageTimestamp`
 *  es un uint64 del proto que manda el otro lado (entrada remota, no confiable)
 *  y un valor basura pintaría `NaN/NaN/aN` en la fila. */
function tsValido(tsSec: number): boolean {
  return typeof tsSec === "number" && Number.isFinite(tsSec) && tsSec > 0 && tsSec <= TS_MAX_SEG;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Hora local de un mensaje, ancho fijo `HH:MM` (CA-6.2). Sin dato ⇒ `""`. */
export function fmtTime(tsSec: number): string {
  if (!tsValido(tsSec)) return "";
  const d = new Date(tsSec * 1000);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Medianoche local, para contar días de calendario y no bloques de 24 h. */
function inicioDelDia(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Fecha relativa para la fila de la bandeja (CA-4.1): hoy ⇒ hora, ayer ⇒
 * `ayer`, esta semana ⇒ día abreviado, más viejo ⇒ `dd/mm` (o `dd/mm/aa` si
 * cambió el año). Sin dato ⇒ `""`, nunca `Invalid Date`.
 *
 * La diferencia se calcula entre medianoches y se redondea: así los días de
 * cambio de horario (23 o 25 h) no corren la cuenta.
 */
export function fmtRelDate(tsSec: number, nowSec: number = Date.now() / 1000): string {
  if (!tsValido(tsSec)) return "";
  const d = new Date(tsSec * 1000);
  const ahora = new Date((Number.isFinite(nowSec) ? nowSec : Date.now() / 1000) * 1000);
  const dias = Math.round((inicioDelDia(ahora) - inicioDelDia(d)) / MS_POR_DIA);

  if (dias === 0) return fmtTime(tsSec);
  if (dias === 1) return "ayer";
  if (dias > 1 && dias < 7) return DIAS[d.getDay()];

  // Lo de más de una semana y lo que quedó en el futuro (teléfono con el reloj
  // adelantado) caen acá: fecha corta, con año sólo si no es el corriente.
  const corta = `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;
  return d.getFullYear() === ahora.getFullYear()
    ? corta
    : `${corta}/${String(d.getFullYear()).slice(-2)}`;
}

/**
 * Pliega guardando las posiciones: `idx[i]` es dónde arranca, en el string
 * original, la unidad plegada `i`. Hace falta porque plegar puede cambiar el
 * largo (`İ` baja a dos caracteres) y sin el mapa los tramos salen corridos.
 */
function foldConIndices(s: string): { folded: string; idx: number[] } {
  let folded = "";
  const idx: number[] = [];
  for (let i = 0; i < s.length; ) {
    const cp = String.fromCodePoint(s.codePointAt(i) as number);
    const f = fold(cp);
    for (let k = 0; k < f.length; k++) idx.push(i);
    folded += f;
    i += cp.length;
  }
  return { folded, idx };
}

/**
 * Parte `text` en tramos marcando los que coinciden con algún término de
 * `query`, sin distinguir acentos ni mayúsculas (CA-12.2 sobre nombres de chat,
 * donde no hay `snippet()` de FTS5 que resalte por nosotros).
 *
 * Siempre devuelve el texto ORIGINAL: se busca sobre la copia plegada y las
 * posiciones se traducen de vuelta.
 */
export function highlightParts(text: string, query: string): Part[] {
  const original = String(text ?? "");
  const terminos = fold(query)
    .split(SEPARADORES)
    .filter((t) => t.length > 0);
  if (original === "" || terminos.length === 0) {
    return original === "" ? [] : [{ text: original, hit: false }];
  }

  const { folded, idx } = foldConIndices(original);

  // Rangos en coordenadas del string plegado, después ordenados y fusionados
  // (dos términos pueden pisarse: "man" y "mana" sobre "mañana").
  const rangos: Array<[number, number]> = [];
  for (const t of terminos) {
    for (let i = folded.indexOf(t); i !== -1; i = folded.indexOf(t, i + 1)) {
      rangos.push([i, i + t.length]);
    }
  }
  if (rangos.length === 0) return [{ text: original, hit: false }];
  rangos.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const alOriginal = (i: number) => (i < idx.length ? idx[i] : original.length);
  const parts: Part[] = [];
  let cursor = 0; // en coordenadas del original
  for (const [desde, hasta] of rangos) {
    const ini = alOriginal(desde);
    const fin = alOriginal(hasta);
    if (fin <= cursor) continue; // ya cubierto por un rango anterior
    if (ini > cursor) parts.push({ text: original.slice(cursor, ini), hit: false });
    const arranque = Math.max(ini, cursor);
    const previo = parts[parts.length - 1];
    if (previo?.hit) previo.text += original.slice(arranque, fin);
    else parts.push({ text: original.slice(arranque, fin), hit: true });
    cursor = fin;
  }
  if (cursor < original.length) parts.push({ text: original.slice(cursor), hit: false });
  return parts;
}
