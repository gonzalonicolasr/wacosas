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
import { type RefObject, useImperativeHandle, useRef } from "react";

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

/**
 * Lo que `App` le puede pedir al campo. Mismo patrón que `ApiBusqueda`
 * (`ui/SearchOverlay.tsx`) y por el mismo motivo: el `useKeyboard` es **UNO
 * solo** y vive en `App` (§7.4), así que las teclas no llegan acá — llegan allá
 * y bajan por esta ref.
 */
export type ApiComposer = { pegar(): void };

export type PropsComposer = {
  /** Chat abierto. El componente no se pinta sin uno (lo decide `App`). */
  jid: string;
  /** Ancho INTERIOR del panel de conversación (sin los bordes). */
  ancho: number;
  /** El foco lo maneja `App` con su `modo`: acá sólo se refleja. */
  enfocado: boolean;
  /** Click sobre el campo: `App` pasa a modo compose (CA-19.7). */
  onEnfocar: () => void;
  /** Por acá le baja `App` el `^V` (ver `ApiComposer`). */
  apiRef?: RefObject<ApiComposer | null>;
};

export function Composer({ jid, ancho, enfocado, onEnfocar, apiRef }: PropsComposer) {
  const ui = useSlice("ui");
  const conn = useSlice("conn");
  const campo = useRef<TextareaRenderable | null>(null);
  /** ¿Hay un `^V` leyendo el portapapeles ahora mismo? (ver `pegar`). */
  const pegando = useRef(false);

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

  /**
   * `^V` (CA nueva): pegar del portapapeles del SISTEMA.
   *
   * ⚠️ **Lo que hay que entender antes de tocar esto**: la terminal no le puede
   * pasar una imagen a una TUI —el bracketed paste entrega texto y nada más—,
   * así que `^V` no *recibe* nada: es la tecla con la que el usuario nos autoriza
   * a salir a leer el portapapeles nosotros (`boot/clipboard.ts` spawnea
   * `wl-paste`). Por eso es asincrónico y por eso hay tantas guardas.
   *
   * Las tres decisiones:
   *
   *  1. **Con una IMAGEN se manda** por la misma cola que el texto, y lo que haya
   *     escrito en el campo viaja como **caption** (es lo que hace WhatsApp).
   *  2. **Con TEXTO se pega en el campo y NO se manda.** Es lo que espera
   *     cualquiera que apriete "pegar", y sobre todo: la única acción
   *     irreversible —mandarle algo a otra persona— queda detrás del `⏎` de
   *     siempre. Un `^V` nunca puede, por sí solo, mandar un texto.
   *  3. **Una lectura por vez** (`pegando`) y **sólo si el campo sigue siendo el
   *     mismo** al volver. `wl-paste` puede tardar hasta 3 s; en ese rato el
   *     usuario pudo cambiar de chat, y como el `<textarea>` se remonta con
   *     `key={jid}`, comparar la instancia (`campo.current === c`) es comparar el
   *     chat. Sin esto, un `^V` en un chat podía terminar mandando la imagen en
   *     otro.
   */
  const pegar = (): void => {
    const c = campo.current;
    if (!c || pegando.current) return;
    pegando.current = true;
    // El caption se lee AHORA, no cuando vuelve la lectura: es lo que el usuario
    // tenía escrito cuando apretó la tecla.
    const caption = c.plainText ?? "";
    commands
      .paste()
      .then((r) => {
        pegando.current = false;
        // ¿Sigue siendo el mismo campo del mismo chat? (ver punto 3).
        if (campo.current !== c) return;
        if (r.kind === "image") {
          if (commands.sendImage(jid, { bytes: r.bytes, mime: r.mime }, caption).ok) c.setText("");
          return;
        }
        if (r.kind === "text") {
          c.insertText(r.text);
          // El borrador se guarda a mano y no se confía en `onContentChange`: es
          // el mismo camino que ya usa `enviar`, y una tecla que no dispara el
          // evento dejaría el borrador viejo guardado.
          store.setDraft(jid, c.plainText ?? "");
        }
        // `empty` y `error` ya los avisó `commands.paste` por el pie.
      })
      .catch(() => {
        // `commands.paste` no rechaza; el catch es para que nada quede trabado en
        // `pegando: true` si algún día lo hiciera.
        pegando.current = false;
      });
  };

  // `useImperativeHandle` y no una asignación en el render: es el mismo camino
  // que `ApiBusqueda` en `ui/SearchOverlay.tsx`. Depende de `jid` porque `pegar`
  // lo captura: sin eso, al cambiar de chat `App` seguiría llamando al `pegar`
  // del chat anterior.
  useImperativeHandle(apiRef, () => ({ pegar }), [jid]);

  const placeholder = !abierta
    ? "sin conexión: no se puede enviar"
    : enfocado
      ? "escribí · ⏎ envía · ^V pega"
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

/**
 * Teclas del composer para el pie (`App` las muestra en modo compose). Con
 * `· ^C salir` que le agrega `App` mide 58 columnas: entra holgado en las 78 de
 * RNF-1 (el pie apretado es el de la bandeja, no éste).
 */
export const HINTS_COMPOSER = "⏎ enviar · Alt-⏎ salto · ^V pegar imagen · Esc volver";
