// Tests del QR puro (design D10, §8.2, CA-1.5, CA-2.1, RNF-3).
//
// El test que de verdad importa es el ÚLTIMO: compara fila por fila lo que
// dibujamos contra el renderer `terminal-small` de `qrcode` —el que el spike ya
// probó escaneable— porque hay dos formas silenciosas de arruinar un QR y
// ninguna se ve en un `expect` de tamaños:
//
//   · **transponerlo**: `BitMatrix.get` es `(fila, columna)` y el diseño lo
//     escribió al revés (`modules.get(x, y)`). Un QR espejado tiene el tamaño
//     correcto y no lo lee ningún teléfono;
//   · **invertir las medias-cuadras**: `▀` por `▄` da un QR en negativo, del
//     tamaño exacto y también ilegible.
//
// Los números no son inventados: son los del payload real de WhatsApp (277
// chars ⇒ versión 12 ⇒ 65 módulos ⇒ 67×34) medidos contra la librería.
import { expect, test } from "bun:test";
import QRCode from "qrcode";

import { buildQr, fitsQr, QR_MIN_COLS, QR_MIN_ROWS, type Qr } from "../src/wa/qr";

/** Un payload con la pinta de los de WhatsApp (`ref,clave,identidad,tipo`). */
function payloadDe(largo: number): string {
  const relleno = "AbC9/+xyzWQ".repeat(Math.ceil(largo / 11)).slice(0, Math.max(0, largo - 4));
  return `2@${relleno}==`.slice(0, largo - 2) + ",1";
}

const P277 = payloadDe(277);

// ── medidas (CA-1.5) ────────────────────────────────────────────────────────

test("el payload de 277 chars de WhatsApp mide 67 columnas × 34 filas", () => {
  expect(P277.length).toBe(277);
  const qr = buildQr(P277) as Qr;
  expect(qr).not.toBeNull();
  // 65 módulos (versión 12) + 1 de zona de silencio a cada lado.
  expect({ size: qr.size, cols: qr.cols, rows: qr.rows.length, height: qr.height }).toEqual({
    size: 65,
    cols: 67,
    rows: 34,
    height: 34,
  });
});

test("el tamaño depende del largo del payload: 250 ⇒ 63, 277 ⇒ 67, 300 ⇒ 71", () => {
  // El motivo por el que `fitsQr` mira la matriz real y no sólo el umbral fijo
  // (§8.2): con 300 chars el QR ya no entra en las 69 columnas del requirements.
  const medidas = [250, 277, 300].map((n) => (buildQr(payloadDe(n)) as Qr).cols);
  expect(medidas).toEqual([63, 67, 71]);
});

test("toda fila mide `cols` y usa sólo las cuatro medias-cuadras", () => {
  const qr = buildQr(P277) as Qr;
  const permitidos = new Set(["█", "▀", "▄", " "]);
  for (const [i, fila] of qr.rows.entries()) {
    const chars = Array.from(fila);
    expect({ fila: i, ancho: chars.length }).toEqual({ fila: i, ancho: qr.cols });
    expect(chars.every((c) => permitidos.has(c))).toBe(true);
  }
});

test("la zona de silencio deja libre la primera y la última columna", () => {
  const qr = buildQr(P277) as Qr;
  for (const [i, fila] of qr.rows.entries()) {
    const chars = Array.from(fila);
    expect({ fila: i, izq: chars[0], der: chars[chars.length - 1] }).toEqual({
      fila: i,
      izq: " ",
      der: " ",
    });
  }
});

// ── entradas que no se pueden dibujar (nunca lanza) ─────────────────────────

test("un payload vacío o imposible devuelve null en vez de lanzar", () => {
  // Se llama desde el render: una excepción acá se lleva puesta la pantalla.
  expect(buildQr("")).toBeNull();
  expect(buildQr(null)).toBeNull();
  expect(buildQr(undefined)).toBeNull();
  // Arriba de la capacidad máxima de un QR (versión 40) `qrcode` tira.
  expect(buildQr("x".repeat(10_000))).toBeNull();
});

// ── ¿entra? (CA-1.5, CA-2.1, RNF-3) ─────────────────────────────────────────

test("fitsQr rechaza la pane de 24×80 de RNF-3 y acepta 40×80", () => {
  const qr = buildQr(P277) as Qr;
  // La terminal típica de Gon: el QR mide 34 filas y sobran 24. Por eso el
  // código de emparejamiento es el camino principal, no el de respaldo.
  expect(fitsQr(80, 24, qr)).toBe(false);
  expect(fitsQr(80, 40, qr)).toBe(true);
});

test("fitsQr exige el umbral fijo del requirements: 36 filas × 69 columnas", () => {
  const qr = buildQr(P277) as Qr;
  expect(fitsQr(QR_MIN_COLS, QR_MIN_ROWS, qr)).toBe(true);
  expect(fitsQr(QR_MIN_COLS - 1, QR_MIN_ROWS, qr)).toBe(false);
  expect(fitsQr(QR_MIN_COLS, QR_MIN_ROWS - 1, qr)).toBe(false);
});

test("fitsQr además mide contra la matriz real, no sólo contra el umbral", () => {
  // Un payload más largo que el de hoy pasa el umbral fijo y NO entra: sin esta
  // segunda condición se dibujaría un QR recortado, o sea ilegible (§8.2).
  const grande = buildQr(payloadDe(300)) as Qr;
  expect(grande.cols).toBe(71);
  expect(fitsQr(QR_MIN_COLS, QR_MIN_ROWS, grande)).toBe(false);
  expect(fitsQr(71, 37, grande)).toBe(true);
  // Y el `+1` del renglón de estado: con 36 filas justas, un QR de 36 no entra.
  expect(fitsQr(71, 36, grande)).toBe(false);
});

test("sin matriz todavía decide el umbral fijo solo", () => {
  expect(fitsQr(80, 40, null)).toBe(true);
  expect(fitsQr(80, 24, null)).toBe(false);
  expect(fitsQr(80, 40)).toBe(true);
});

// ── el dibujo es el mismo que el de la librería ─────────────────────────────

test("cada fila coincide con el renderer terminal-small de qrcode", async () => {
  const qr = buildQr(P277) as Qr;
  // `type:"terminal", small:true` es la salida que el spike verificó escaneable.
  // Viene con escapes ANSI (que OpenTUI NO interpreta, V5): se stripean para
  // comparar los caracteres, que es lo que nosotros pintamos con color propio.
  const crudo = (await QRCode.toString(P277, { type: "terminal", small: true })) as string;
  const esperadas = crudo.replace(/\x1b\[[0-9;]*m/g, "").split("\n");

  for (let i = 0; i < qr.height - 1; i++) {
    expect({ fila: i, dibujo: qr.rows[i] }).toEqual({ fila: i, dibujo: esperadas[i] as string });
  }

  // La ÚLTIMA fila es la única que difiere, y a propósito: el símbolo tiene un
  // número impar de filas de módulos, así que a la de abajo le sobra media
  // fila. La librería la deja transparente (pinta `▀` blanco sobre el fondo de
  // la terminal); nosotros pintamos la fila entera de blanco, que es zona de
  // silencio de verdad y no el verde noche del tema.
  const ultima = qr.rows[qr.height - 1] as string;
  expect(Array.from(ultima).every((c) => c === " ")).toBe(true);
  expect(Array.from(esperadas[qr.height - 1] as string).every((c) => c === "▀")).toBe(true);
});
