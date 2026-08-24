// Pantalla de error fatal (CA-13.6): la base local no se pudo abrir.
//
// Se monta SOLA (fuera de `<App/>`, que necesita una base viva), así que se
// maneja su propio teclado. Existe para que el usuario vea la ruta y el motivo en
// vez de un stack trace crudo — que además sería invisible, porque el fd 2 está
// redirigido al log desde el arranque (D9).
//
// La tarea 17 le agrega la variante "instancia ya tomada" (CA-18.2).
import { useKeyboard, useTerminalDimensions } from "@opentui/react";

import { clip } from "../lib/fmt";
import { BG, DANGER, FAINT, MUT, SURFACE, TEXT } from "./theme";

export function ErrorScreen({
  path,
  reason,
  onQuit,
}: {
  path: string;
  reason: string;
  onQuit: () => void;
}) {
  const { width } = useTerminalDimensions();
  // Cualquier tecla cierra: el usuario no tiene nada más que hacer acá y no hay
  // ningún atajo que adivinar.
  useKeyboard(() => onQuit());

  const ancho = Math.max(20, width - 8);
  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      justifyContent="center"
      alignItems="center"
      backgroundColor={BG}
    >
      <box flexDirection="column" border borderColor={DANGER} backgroundColor={SURFACE} padding={1}>
        <text fg={DANGER}>{"✖ no se pudo abrir la base de datos de wacosas"}</text>
        <text> </text>
        {/* La etiqueta va aparte del valor: `clip` aplasta los espacios repetidos
            (usa `oneLine`), así que no se pueden alinear columnas con padding
            adentro del texto recortado. */}
        <text wrapMode="none">
          <span fg={MUT}>{"archivo  "}</span>
          <span fg={TEXT}>{clip(path, ancho - 9)}</span>
        </text>
        <text wrapMode="none">
          <span fg={MUT}>{"motivo   "}</span>
          <span fg={TEXT}>{clip(reason, ancho - 9)}</span>
        </text>
        <text> </text>
        <text fg={MUT}>{"Mové ese archivo a un lado y wacosas la recrea vacía"}</text>
        <text fg={MUT}>{"(perdés el historial local, no la cuenta vinculada)."}</text>
        <text> </text>
        <text fg={FAINT}>{"cualquier tecla para salir"}</text>
      </box>
    </box>
  );
}
