// El campo de redacción (CA-8.*): escribir, enviar con `⏎`, salto de línea con
// `Alt-⏎` y borradores que sobreviven al cambio de chat.
//
// Cuatro cosas que gobiernan este archivo:
//
//  1. **Los bindings del `<textarea>` vienen INVERTIDOS de fábrica** (V6,
//     verificado en OpenTUI 0.4.2): por default `return` es `newline` y
//     `meta+return` es `submit`, o sea exactamente al revés de lo que piden
//     CA-8.2 y CA-8.4. Se dan vuelta con `keyBindings` (ver `TECLAS`).
//  2. **El borrador se restaura REMONTANDO** (§7.4.6): el `<textarea>` toma
//     `initialValue` UNA sola vez, así que la única forma de que al volver a un
//     chat aparezca lo que se había dejado escrito es `key={jid}` — un
//     renderable nuevo, con el texto de ESE chat (CA-8.6).
//  3. **El campo es NO controlado.** El texto vive en el renderable; el store
//     guarda una copia en cada cambio, sólo para poder restaurarla. Forzarle el
//     valor en cada render le movería el cursor al final en la mitad de una
//     palabra (misma decisión que el buscador de la bandeja).
//  4. **Sin conexión el envío se RECHAZA y el texto se queda** (CA-8.7, CA-13.3):
//     no hay outbox diferido. El motivo lo avisa `commands.send` por el pie.
import type { KeyBinding, TextareaRenderable } from "@opentui/core";
import { useRef } from "react";

import { commands } from "../state/commands";
import { useSlice } from "../state/hooks";
import { store } from "../state/store";
import { ACCENT, ACCENT2, ELEVATED, INPUT_FG, MUT, WARN } from "./theme";

/** Filas que puede llegar a ocupar el campo antes de scrollear por dentro. */
export const ALTO_MAX_COMPOSER = 5;
/** Columnas del prefijo `✎ `, que vive en su propia columna. */
const ANCHO_PROMPT = 2;

/**
 * Los bindings dados vuelta (V6). Lo que NO se toca:
 *  · `linefeed` (`Ctrl-J` en una terminal sin protocolo kitty) sigue siendo
 *    salto de línea: es el camino portable del `Alt-⏎` de CA-8.4;
 *  · `Ctrl-E` sigue moviendo el cursor al fin de línea. Es la tecla que ENFOCA el
 *    campo (CA-8.1) y estando ya adentro no tiene nada que enfocar, así que su
 *    uso de edición es inofensivo.
 */
export const TECLAS: KeyBinding[] = [
  { name: "return", action: "submit" }, // CA-8.2
  { name: "kpenter", action: "submit" },
  { name: "return", meta: true, action: "newline" }, // CA-8.4
  { name: "kpenter", meta: true, action: "newline" },
];

/**
 * Filas que necesita el borrador, contando el envolvimiento por palabra: una
 * línea larga ocupa varias. Acotado a `ALTO_MAX_COMPOSER` — de ahí en adelante
 * scrollea el propio campo y la conversación no pierde más lugar.
 */
export function altoCampo(texto: string, ancho: number): number {
  const cols = Math.max(1, ancho);
  let filas = 0;
  for (const linea of String(texto ?? "").split("\n")) {
    filas += Math.max(1, Math.ceil(linea.length / cols));
    if (filas >= ALTO_MAX_COMPOSER) return ALTO_MAX_COMPOSER;
  }
  return Math.max(1, filas);
}

export type PropsComposer = {
  /** Chat abierto. El componente no se pinta sin uno (lo decide `App`). */
  jid: string;
  /** Ancho INTERIOR del panel de conversación (sin los bordes). */
  ancho: number;
  /** El foco lo maneja `App` con su `modo`: acá sólo se refleja. */
  enfocado: boolean;
  /** Click sobre el campo: `App` pasa a modo compose (CA-19.7). */
  onEnfocar: () => void;
};

export function Composer({ jid, ancho, enfocado, onEnfocar }: PropsComposer) {
  const ui = useSlice("ui");
  const conn = useSlice("conn");
  const campo = useRef<TextareaRenderable | null>(null);

  const abierta = conn.state === "open";
  const borrador = ui.drafts[jid] ?? "";
  const anchoTexto = Math.max(1, ancho - 2 - ANCHO_PROMPT); // −2 por el padding
  const alto = altoCampo(borrador, anchoTexto);

  /**
   * El texto con el que nace el `<textarea>` de ESTE chat. Se resuelve contra el
   * store EN VIVO y no contra el snapshot: al cambiar de chat el snapshot está
   * cacheado hasta el próximo flush (D3) y traería el borrador del anterior.
   */
  const inicial = useRef<{ jid: string; texto: string }>({ jid, texto: store.draft(jid) });
  if (inicial.current.jid !== jid) inicial.current = { jid, texto: store.draft(jid) };

  const enviar = (): void => {
    const c = campo.current;
    if (!c) return;
    const texto = c.plainText ?? "";
    // CA-8.3: vacío o sólo espacios no manda nada. Ni siquiera avisa: no hay
    // nada que explicar, el usuario apretó `⏎` sobre un campo vacío.
    if (texto.trim() === "") return;
    // CA-8.2: el campo se limpia SÓLO si el mensaje entró en la cola. Si el
    // envío se rechaza —sin conexión (CA-8.7)—, el texto se queda donde estaba.
    if (commands.send(jid, texto).ok) c.setText("");
  };

  const placeholder = !abierta
    ? "sin conexión: no se puede enviar"
    : enfocado
      ? "escribí · ⏎ envía · Alt-⏎ salto de línea"
      : "^E para escribir";

  return (
    <box
      height={alto}
      flexShrink={0}
      flexDirection="row"
      backgroundColor={ELEVATED}
      paddingLeft={1}
      paddingRight={1}
      onMouseDown={onEnfocar}
    >
      <text fg={!abierta ? WARN : enfocado ? ACCENT : MUT} wrapMode="none">
        {"✎ "}
      </text>
      <box flexGrow={1} flexShrink={1}>
        <textarea
          // §7.4.6: el borrador se restaura remontando, no reescribiendo.
          key={jid}
          ref={campo}
          focused={enfocado}
          initialValue={inicial.current.texto}
          keyBindings={TECLAS}
          wrapMode="word"
          placeholder={placeholder}
          placeholderColor={MUT}
          backgroundColor={ELEVATED}
          focusedBackgroundColor={ELEVATED}
          textColor={INPUT_FG}
          focusedTextColor={INPUT_FG}
          cursorColor={ACCENT2}
          onSubmit={enviar}
          // CA-8.6: cada cambio deja el borrador guardado, así cambiar de chat
          // (o apretar `Esc`) nunca pierde lo escrito. El evento no trae el
          // texto: se lee del renderable.
          onContentChange={() => store.setDraft(jid, campo.current?.plainText ?? "")}
        />
      </box>
    </box>
  );
}

/** Teclas del composer para el pie (`App` las muestra en modo compose). */
export const HINTS_COMPOSER = "⏎ enviar · Alt-⏎ salto · Esc volver";
