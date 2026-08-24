// El QR de vinculación, PURO: payload → matriz de medias-cuadras lista para
// pintar, y la decisión de si entra en la terminal (design D10, §8.2).
//
// Por qué se dibuja nativo y no se pega la salida de `qrcode`:
//
//   · `QRCode.toString({ type:"terminal" })` devuelve un string lleno de escapes
//     ANSI, y OpenTUI **no interpreta ANSI adentro de un `<text>`** (V5 del
//     diseño): se verían los bytes crudos. Acá se devuelven filas de caracteres
//     y el color lo pone el componente.
//   · Conocer el tamaño EXACTO antes de pintar es lo que permite decidir entre
//     QR y código de emparejamiento (CA-2.1) en vez de recortar el QR y dejarlo
//     ilegible.
//
// Codificación: cada carácter son DOS módulos verticales (`█` los dos oscuros,
// `▀` el de arriba, `▄` el de abajo, ` ` ninguno). Con `fg` negro sobre `bg`
// blanco eso pinta el QR con la mitad de filas que módulos. Es exactamente lo
// que hace el renderer `terminal-small` de la librería —el que ya se sabe
// escaneable—, y `test/qr.test.ts` compara fila por fila contra él.
//
// ⚠️ `BitMatrix.get(fila, columna)`, en ese orden (`lib/core/bit-matrix.js:37`).
// El diseño lo escribió como `modules.get(x, y)`: invertirlo TRANSPONE el QR y
// lo deja espejado. Acá se indexa `data[fila * size + columna]`, igual que el
// renderer de la librería.
import QRCode from "qrcode";

/** Módulos de silencio alrededor del símbolo (D10). Es el del `terminal-small`. */
export const QUIET = 1;

/**
 * Umbral fijo de CA-1.5/CA-2.1. Es el tamaño del payload de HOY (277 chars ⇒
 * 67×34): si WhatsApp alarga el payload queda corto (300 chars ⇒ 71 columnas,
 * medido), y por eso `fitsQr` mira ADEMÁS la matriz real (§8.2).
 */
export const QR_MIN_COLS = 69;
export const QR_MIN_ROWS = 36;

export type Qr = {
  /** Módulos por lado, sin la zona de silencio (el `modules.size` de la librería). */
  size: number;
  /** Una fila de terminal por cada DOS filas de módulos, ya en medias-cuadras. */
  rows: string[];
  /** Ancho en columnas de terminal = `size + 2 * QUIET`. */
  cols: number;
  /** Alto en filas de terminal = `ceil(cols / 2)`. Espeja `rows.length`. */
  height: number;
};

const LLENO = "█";
const ARRIBA = "▀";
const ABAJO = "▄";
const VACIO = " ";

/**
 * Arma la matriz del payload. Devuelve `null` si `qrcode` no lo puede codificar
 * (payload vacío o demasiado largo): **nunca lanza**, porque esto se llama desde
 * el render y una excepción ahí se lleva puesta la pantalla entera.
 */
export function buildQr(payload: string | null | undefined): Qr | null {
  if (typeof payload !== "string" || payload === "") return null;

  let size: number;
  let data: Uint8Array;
  try {
    const qr = QRCode.create(payload, {});
    size = qr.modules.size;
    data = qr.modules.data;
  } catch {
    return null;
  }
  if (!Number.isFinite(size) || size < 1) return null;

  const cols = size + QUIET * 2;
  const height = Math.ceil(cols / 2);

  /** ¿Es oscuro el módulo de la fila/columna `py`/`px` YA con zona de silencio? */
  const oscuro = (px: number, py: number): boolean => {
    const x = px - QUIET;
    const y = py - QUIET;
    if (x < 0 || y < 0 || x >= size || y >= size) return false; // zona de silencio
    return data[y * size + x] === 1;
  };

  const rows: string[] = [];
  for (let f = 0; f < height; f++) {
    let fila = "";
    for (let px = 0; px < cols; px++) {
      const arriba = oscuro(px, f * 2);
      // La última fila puede quedar impar: la mitad de abajo es zona de silencio.
      const abajo = f * 2 + 1 < cols && oscuro(px, f * 2 + 1);
      fila += arriba ? (abajo ? LLENO : ARRIBA) : abajo ? ABAJO : VACIO;
    }
    rows.push(fila);
  }

  return { size, rows, cols, height };
}

/**
 * ¿Entra el QR en una terminal de `w × h`? (CA-1.5, CA-2.1, RNF-3)
 *
 * Son DOS condiciones, y las dos hacen falta:
 *
 *   1. el umbral fijo del requirements (36 filas × 69 columnas), que es la
 *      política declarada y contempla el renglón de estado y el pie;
 *   2. la matriz REAL, cuando ya la tenemos: el tamaño depende del largo del
 *      payload, así que un umbral fijo miente en cuanto WhatsApp lo cambie
 *      (§8.2). El `+ 1` es el renglón que necesita el estado.
 *
 * Sin matriz todavía (todavía no llegó ningún `qr`) decide sólo el umbral: es la
 * mejor estimación posible y evita que la pantalla parpadee entre los dos
 * métodos cuando llega el primer payload.
 */
export function fitsQr(w: number, h: number, qr?: Qr | null): boolean {
  if (!(h >= QR_MIN_ROWS && w >= QR_MIN_COLS)) return false;
  if (!qr) return true;
  return w >= qr.cols && h >= qr.height + 1;
}
