// Pie de una sola línea: el aviso efímero si lo hay (CA-19.5), si no las teclas
// del modo actual.
//
// Lee el slice `ui` por su cuenta (el toast no tiene por qué re-renderizar la
// bandeja) y recorta el texto a mano: `height={1}` + `wrapMode="none"` evitan que
// una línea larga se envuelva y le robe una fila al cuerpo.
//
// ⚠️ **Las TECLAS se pintan distinto que las palabras**, y no es decoración: el
// pie son ~78 columnas de texto corrido donde lo único que se busca es una tecla
// («¿con qué era que se marcaba leído?»). Todo del mismo color obliga a leerlo
// entero; con las teclas resaltadas se saltea de tecla en tecla. Es el mismo
// criterio que ya usaba la ayuda (`ui/Help.tsx`: teclas en `GOLD`, descripción en
// `TEXT_DIM`), traído al pie para que las dos pantallas se lean igual.
//
// El recorte se hace ANTES de partir, así el ancho no cambia ni una columna: lo
// que cambia es de qué color sale cada tramo.
import { clip } from "../lib/fmt";
import { useSlice } from "../state/hooks";
import { ACCENT, ACCENT2, MUT } from "./theme";

export const ALTO_FOOTER = 1;

/**
 * Teclas con nombre propio (las que no se reconocen por su forma). El `·` NO
 * está: es el separador entre hints, y pintarlo como tecla haría parpadear la
 * línea entera.
 */
const NOMBRADAS = new Set(["Esc", "Tab", "PgUp", "PgDn", "Inicio", "Fin", "⏎", "?", "/"]);

/**
 * ¿Este pedazo de texto es una tecla?
 *
 * Cubre las cuatro formas en las que se nombran en esta aplicación: las de
 * símbolo (`⏎`, `⇧↑↓`, `← →`), las de nombre (`Esc`, `Tab`, `PgUp`), las de
 * control (`^E`, `^C`) y las combinadas (`Alt-⏎`, `⇧PgUp/PgDn`). Se exporta para
 * poder testearla: si algún día un hint nuevo no se pinta, es acá.
 */
export function esTecla(palabra: string): boolean {
  const p = String(palabra ?? "");
  if (p === "") return false;
  if (NOMBRADAS.has(p)) return true;
  // `^` + una letra: todos los atajos de la aplicación.
  if (/^\^[A-Za-zÁÉÍÓÚÑ]$/u.test(p)) return true;
  // Sólo símbolos de tecla: flechas, ⏎, ⇧ y la barra que separa alternativas.
  if (/^[⏎⇧↑↓←→/]+$/u.test(p)) return true;
  // Combinadas: un prefijo conocido y algo pegado (`Alt-⏎`, `⇧PgUp/PgDn`).
  if (/^(Alt-|Ctrl-|⇧)/u.test(p)) return true;
  return false;
}

/** Un tramo del pie ya clasificado. */
export type TramoPie = { texto: string; tecla: boolean };

/**
 * Parte la línea de hints en tramos de tecla y de texto, conservando los
 * espacios (el pie tiene que salir con el MISMO ancho que entró).
 */
export function partirHints(linea: string): TramoPie[] {
  const out: TramoPie[] = [];
  for (const trozo of String(linea ?? "").split(/(\s+)/)) {
    if (trozo === "") continue;
    const ultimo = out[out.length - 1];
    // Un espacio no tiene color propio: se pega a lo que venga antes (o abre un
    // tramo de texto, si es lo primero de la línea).
    if (/^\s+$/.test(trozo)) {
      if (ultimo) ultimo.texto += trozo;
      else out.push({ texto: trozo, tecla: false });
      continue;
    }
    const tecla = esTecla(trozo);
    if (ultimo && ultimo.tecla === tecla) ultimo.texto += trozo;
    else out.push({ texto: trozo, tecla });
  }
  return out;
}

export function Footer({ hints, width }: { hints: string; width: number }) {
  const ui = useSlice("ui");
  const texto = clip(ui.toast ? `▸ ${ui.toast.text}` : hints, Math.max(0, width - 2));

  return (
    <box height={ALTO_FOOTER} flexShrink={0} paddingLeft={1} paddingRight={1}>
      {ui.toast ? (
        // Un aviso es una frase, no una lista de teclas: va entero y en acento.
        <text fg={ACCENT} wrapMode="none">
          {texto}
        </text>
      ) : (
        <text wrapMode="none">
          {partirHints(texto).map((t, i) => (
            // La lista es estática por render: el índice alcanza como `key`.
            <span key={i} fg={t.tecla ? ACCENT2 : MUT}>
              {t.texto}
            </span>
          ))}
        </text>
      )}
    </box>
  );
}
