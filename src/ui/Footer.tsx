// Pie de una sola línea: el aviso efímero si lo hay (CA-19.5), si no las teclas
// del modo actual.
//
// Lee el slice `ui` por su cuenta (el toast no tiene por qué re-renderizar la
// bandeja) y recorta el texto a mano: `height={1}` + `wrapMode="none"` evitan que
// una línea larga se envuelva y le robe una fila al cuerpo.
import { clip } from "../lib/fmt";
import { useSlice } from "../state/hooks";
import { ACCENT, MUT } from "./theme";

export const ALTO_FOOTER = 1;

export function Footer({ hints, width }: { hints: string; width: number }) {
  const ui = useSlice("ui");
  const texto = ui.toast ? `▸ ${ui.toast.text}` : hints;
  return (
    <box height={ALTO_FOOTER} paddingLeft={1} paddingRight={1}>
      <text fg={ui.toast ? ACCENT : MUT} wrapMode="none">
        {clip(texto, Math.max(0, width - 2))}
      </text>
    </box>
  );
}
