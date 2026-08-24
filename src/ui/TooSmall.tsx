// Pantalla de "agrandá la terminal" (RNF-2). Es un render CONDICIONAL, no un
// estado: en cuanto la terminal vuelve a medir lo mínimo, `App` deja de montarla
// y la interfaz aparece sola, sin tener que reiniciar nada (CA-19.4).
//
// Las líneas son cortas a propósito: esta pantalla se ve justamente cuando no hay
// ancho, así que nada de textos que se envuelvan en cuatro renglones.
import { BG, DANGER, MUT, TEXT, WARN } from "./theme";

/** Mínimo usable (RNF-2). Abajo de esto no se dibuja el layout: se pide agrandar. */
export const MIN_COLS = 60;
export const MIN_ROWS = 15;

export function TooSmall({ width, height }: { width: number; height: number }) {
  const faltaAncho = width < MIN_COLS;
  const faltaAlto = height < MIN_ROWS;
  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      justifyContent="center"
      alignItems="center"
      backgroundColor={BG}
    >
      <text fg={DANGER}>{"⚠ la terminal es muy chica"}</text>
      <text> </text>
      <text fg={TEXT}>
        {"ahora: "}
        <span fg={faltaAncho ? WARN : TEXT}>{String(width)}</span>
        {" × "}
        <span fg={faltaAlto ? WARN : TEXT}>{String(height)}</span>
      </text>
      <text fg={MUT}>{`mínimo: ${MIN_COLS} × ${MIN_ROWS}`}</text>
      <text> </text>
      <text fg={MUT}>{"agrandala y wacosas vuelve solo"}</text>
    </box>
  );
}
