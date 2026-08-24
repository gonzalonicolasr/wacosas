// La bandeja: buscador siempre activo, filas de una línea y mouse (CA-4.*,
// CA-5.*, CA-10.2/10.4, CA-19.7).
//
// Cinco cosas que gobiernan este archivo:
//
//  1. **Cada fila mide EXACTAMENTE una línea** (`height={1}` + `wrapMode="none"`
//     + `clip()` sobre cada string, §7.4.1). No es cosmético: un evento de mouse
//     vuelve a MEDIR el `<text>`, y si el wrap está habilitado la fila crece,
//     empuja a las de abajo y la lista queda corrida (CA-19.7).
//  2. **Las filas que se pintan se PRESUPUESTAN, no se recortan.** OpenTUI no
//     esconde a los hijos que no entran en el alto de una caja: los dibuja
//     ENCIMADOS. Por eso la ventana visible se calcula a mano (`ventana()`) y se
//     renderizan exactamente las filas que entran, ni una más.
//  3. **Las columnas son cajas, no padding adentro de un string.** `clip()`
//     aplasta los espacios repetidos (usa `oneLine`), así que alinear con
//     `padEnd` adentro de un texto recortado no funciona. Y una caja de ancho
//     fijo SÍ recorta a su hijo horizontalmente (verificado): con un emoji en el
//     preview —que ocupa dos columnas y cuenta como un carácter— la fila se
//     recorta un carácter antes, pero NUNCA se corre la fecha ni se pisa el
//     badge.
//  4. **La selección se guarda por jid** (CA-4.4). Acá sólo se BUSCA el índice de
//     ese jid en la lista visible; el estado vive en el slice `ui` y lo mueven
//     los comandos.
//  5. **El buscador es NO controlado**, con una sincronización de una sola vía.
//     El `<input>` de OpenTUI toma el valor por su cuenta; forzarle el texto en
//     cada render le movería el cursor. Sólo se le escribe cuando alguien lo
//     cambió desde afuera (el `Esc` que limpia la búsqueda, CA-5.4).
import type { InputRenderable, KeyBinding, MouseEvent } from "@opentui/core";
import { useEffect, useMemo, useRef } from "react";

import { commands, etiquetaChat, filtrarChats, seleccionVigente } from "../state/commands";
import { useSlice } from "../state/hooks";
import type { ChatRow } from "../db/types";
import { clip, fmtRelDate } from "../lib/fmt";
import { ACCENT, ACCENT2, ELEVATED, FAINT, GOLD, INPUT_FG, MUT, SELBG, TEXT, TEXT_DIM } from "./theme";

/** El buscador se lleva una fila del panel; el resto es lista. */
export const ALTO_BUSCADOR = 1;

/** CA-5.6: dos clicks sobre la MISMA fila dentro de esta ventana abren el chat. */
export const DOBLE_CLICK_MS = 350;

/** Columnas del glifo que distingue grupo de 1:1 (CA-4.8), con su espacio. */
const ANCHO_GLIFO = 2;

/** Mínimos para que valga la pena partir la fila en nombre + preview. */
const MIN_NOMBRE = 8;
const MIN_PREVIEW = 6;
/** Separador entre el nombre y el preview. Su ancho entra en el reparto. */
const SEP = " · ";

/** Arriba de esto el contador se abrevia: tres columnas y no crece nunca más. */
const TOPE_BADGE = 99;

/**
 * Reparte el ancho sobrante entre nombre y preview (CA-4.1).
 *
 * Cuando no alcanza para los dos, el preview es lo que se cae: sin nombre la
 * fila no se puede identificar, sin preview sí. Pasa en `compact`, donde la
 * bandeja mide 34 columnas fijas (§7.2).
 */
export function repartirColumnas(disponible: number): { nombre: number; preview: number } {
  if (disponible < MIN_NOMBRE + SEP.length + MIN_PREVIEW) {
    return { nombre: Math.max(0, disponible), preview: 0 };
  }
  const nombre = Math.max(MIN_NOMBRE, Math.round((disponible - SEP.length) / 2));
  return { nombre, preview: disponible - SEP.length - nombre };
}

/**
 * Primera fila visible de la lista, con el cursor SIEMPRE adentro (CA-5.3: "el
 * viewport debe seguir a la selección").
 *
 * Recibe la posición anterior y se mueve lo MÍNIMO necesario: centrar el cursor
 * en cada tecla haría que la lista entera se deslice todo el tiempo y perdería
 * el punto de referencia visual.
 */
export function ventana(total: number, sel: number, filas: number, previo: number): number {
  if (filas <= 0 || total <= filas) return 0;
  const tope = total - filas;
  let desde = Math.max(0, Math.min(previo, tope));
  if (sel < desde) desde = sel;
  else if (sel >= desde + filas) desde = sel - filas + 1;
  return Math.max(0, Math.min(desde, tope));
}

/** El contador de la fila (CA-10.2). Vacío cuando está todo leído. */
function badgeDe(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  return n > TOPE_BADGE ? `${TOPE_BADGE}+` : String(Math.floor(n));
}

/**
 * Neutraliza el `Ctrl-K` de edición del `<input>` (borrar hasta el fin de línea).
 * `Ctrl-K` es "subir un ítem" (CA-5.3) y el campo también recibe la tecla: con
 * el cursor en el medio del texto, cada movimiento del cursor le comía media
 * búsqueda. Se lo redirige a `newline`, que en un `<input>` de una sola línea es
 * un no-op de fábrica (`InputRenderable.newLine()` devuelve `false`) — no hay
 * acción "no hacer nada" en el tipo `TextareaAction`, así que ésta es la más
 * inofensiva de las que hay.
 */
const SIN_CTRL_K: KeyBinding[] = [{ name: "k", ctrl: true, action: "newline" }];

type PropsFila = {
  chat: ChatRow;
  seleccionada: boolean;
  ahoraSeg: number;
  /** Anchos ya repartidos: son iguales para todas las filas de la lista. */
  cols: { nombre: number; preview: number; fecha: number; badge: number };
  onClick: (jid: string) => void;
};

function Fila({ chat, seleccionada, ahoraSeg, cols, onClick }: PropsFila) {
  const sinLeer = chat.unreadCount > 0;
  const badge = badgeDe(chat.unreadCount);
  const fecha = fmtRelDate(chat.lastMessageAt, ahoraSeg);

  return (
    <box
      flexDirection="row"
      height={1}
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={seleccionada ? SELBG : undefined}
      onMouseDown={() => onClick(chat.jid)}
    >
      <box width={ANCHO_GLIFO + cols.nombre} flexShrink={0}>
        <text wrapMode="none">
          {/* CA-4.8: el grupo se distingue por glifo Y por color. */}
          <span fg={chat.isGroup ? ACCENT2 : FAINT}>{chat.isGroup ? "▣ " : "▪ "}</span>
          <span fg={sinLeer ? TEXT : TEXT_DIM}>{clip(etiquetaChat(chat), cols.nombre)}</span>
        </text>
      </box>

      {/* CA-4.5: el preview de un adjunto ya viene con su placeholder desde
          `previewFor()`, guardado en `chats.last_preview`. */}
      <box flexGrow={1} flexShrink={1}>
        {cols.preview > 0 ? (
          <text wrapMode="none">
            <span fg={FAINT}>{SEP}</span>
            <span fg={sinLeer ? TEXT_DIM : MUT}>{clip(chat.lastPreview, cols.preview)}</span>
          </text>
        ) : null}
      </box>

      {/* Fecha y badge en UNA caja de ancho fijo, con el relleno hecho a mano:
          son ASCII (dígitos, `/`, día abreviado), así que contar caracteres es
          contar columnas y el `padStart` alinea de verdad. */}
      <box width={1 + cols.fecha + cols.badge} flexShrink={0}>
        <text wrapMode="none">
          <span fg={FAINT}>{fecha.padStart(1 + cols.fecha)}</span>
          <span fg={sinLeer ? (seleccionada ? GOLD : ACCENT) : MUT}>
            {badge.padStart(cols.badge)}
          </span>
        </text>
      </box>
    </box>
  );
}

/** El renglón que explica por qué no hay filas (CA-4.7). */
function Vacio({ texto, ancho }: { texto: string; ancho: number }) {
  return (
    <box height={1} flexShrink={0} paddingLeft={1} paddingRight={1}>
      <text fg={MUT} wrapMode="none">
        {clip(texto, Math.max(1, ancho - 2))}
      </text>
    </box>
  );
}

export function Inbox({
  ancho,
  alto,
  // El buscador está enfocado SIEMPRE (CA-5.1) menos cuando el foco se lo lleva
  // el campo de redacción (tarea 14): OpenTUI tiene un solo renderable enfocado,
  // y como el reconciliador sólo aplica `focused` cuando la prop CAMBIA, tener
  // acá un `true` fijo dejaba a la bandeja sin foco al volver de redactar.
  enfocado = true,
}: {
  ancho: number;
  alto: number;
  enfocado?: boolean;
}) {
  const inbox = useSlice("inbox");
  const ui = useSlice("ui");
  const campo = useRef<InputRenderable | null>(null);
  /** Último click, para el doble click de CA-5.6. */
  const ultimoClick = useRef<{ jid: string; at: number }>({ jid: "", at: 0 });
  /** Primera fila visible: se conserva entre renders para no deslizar de más. */
  const desdeRef = useRef(0);

  const visibles = useMemo(
    () => filtrarChats(inbox.chats, ui.inboxFilter, ui.inboxQuery),
    [inbox.chats, ui.inboxFilter, ui.inboxQuery],
  );

  // Sincronización de una sola vía hacia el campo: sólo cuando el texto cambió
  // desde AFUERA (el `Esc` de CA-5.4). `commands.setInboxQuery` corta cuando el
  // valor no cambió, así que el `input` que emite el setter no hace ciclo.
  useEffect(() => {
    const c = campo.current;
    if (c && c.value !== ui.inboxQuery) c.value = ui.inboxQuery;
  }, [ui.inboxQuery]);

  const jidSel = seleccionVigente(visibles, ui.selectedJid);
  const idxSel = Math.max(
    0,
    visibles.findIndex((c) => c.jid === jidSel),
  );
  const filasLista = Math.max(0, alto - ALTO_BUSCADOR);
  const desde = (desdeRef.current = ventana(visibles.length, idxSel, filasLista, desdeRef.current));
  const enPantalla = visibles.slice(desde, desde + filasLista);

  // Las reservas se calculan sobre lo que se VE, no sobre toda la lista: si
  // ningún chat a la vista tiene no leídos, esas columnas se las queda el
  // preview. `fmtRelDate` devuelve entre 0 ("ayer" no, 4) y 8 caracteres.
  const ahoraSeg = Date.now() / 1000;
  const anchoFecha = enPantalla.reduce(
    (m, c) => Math.max(m, fmtRelDate(c.lastMessageAt, ahoraSeg).length),
    0,
  );
  const anchoBadge = enPantalla.reduce((m, c) => Math.max(m, badgeDe(c.unreadCount).length), 0);
  const usable = Math.max(0, ancho - 2); // paddingLeft + paddingRight de la fila
  const reservaDerecha = 1 + anchoFecha + (anchoBadge > 0 ? anchoBadge + 1 : 0);
  const cols = {
    ...repartirColumnas(Math.max(0, usable - ANCHO_GLIFO - reservaDerecha)),
    fecha: anchoFecha,
    badge: anchoBadge > 0 ? anchoBadge + 1 : 0,
  };

  const clickEnFila = (jid: string): void => {
    const at = Date.now();
    const previo = ultimoClick.current;
    if (previo.jid === jid && at - previo.at < DOBLE_CLICK_MS) {
      // El `at: 0` corta la cadena: un tercer click no vuelve a abrir el chat.
      ultimoClick.current = { jid, at: 0 };
      commands.openChat(jid);
      return;
    }
    ultimoClick.current = { jid, at };
    commands.selectChat(jid);
  };

  // CA-5.7: la rueda sobre la bandeja mueve la SELECCIÓN (el panel de
  // conversación es el que scrollea, tarea 13). El delta viene del terminal y
  // se acota: algunos mandan saltos enormes por muesca.
  const rueda = (e: MouseEvent): void => {
    const dir = e.scroll?.direction === "up" ? -1 : 1;
    const pasos = Math.max(1, Math.min(5, Math.round(e.scroll?.delta ?? 1)));
    commands.moveSelection(dir * pasos);
  };

  const vacio =
    inbox.chats.length === 0
      ? // CA-4.7: base vacía. No es "no tenés chats", es "todavía no llegaron".
        "esperando la sincronización inicial…"
      : ui.inboxQuery !== ""
        ? "sin coincidencias"
        : ui.inboxFilter === "unread"
          ? "no hay chats sin leer"
          : "no hay grupos";

  return (
    <box flexDirection="column" flexGrow={1}>
      {/* CA-5.1: el buscador arranca enfocado y escribir filtra al instante, sin
          apretar ninguna tecla previa. Es el único elemento con foco de la
          vista principal. */}
      <box
        height={ALTO_BUSCADOR}
        flexShrink={0}
        flexDirection="row"
        backgroundColor={ELEVATED}
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={ui.inboxQuery ? ACCENT : MUT} wrapMode="none">
          {"⌕ "}
        </text>
        <box flexGrow={1} flexShrink={1}>
          <input
            ref={campo}
            focused={enfocado}
            placeholder="filtrar…"
            keyBindings={SIN_CTRL_K}
            backgroundColor={ELEVATED}
            focusedBackgroundColor={ELEVATED}
            textColor={INPUT_FG}
            focusedTextColor={INPUT_FG}
            placeholderColor={MUT}
            onInput={(valor: string) => commands.setInboxQuery(valor)}
          />
        </box>
      </box>

      <box flexDirection="column" flexGrow={1} onMouseScroll={rueda}>
        {enPantalla.length === 0 ? (
          <Vacio texto={vacio} ancho={ancho} />
        ) : (
          enPantalla.map((c) => (
            <Fila
              key={c.jid}
              chat={c}
              seleccionada={c.jid === jidSel}
              ahoraSeg={ahoraSeg}
              cols={cols}
              onClick={clickEnFila}
            />
          ))
        )}
      </box>
    </box>
  );
}

/**
 * Teclas de la bandeja para el pie (`App` las concatena con las globales).
 *
 * ⚠️ Con un chat abierto el pie mide EXACTAMENTE 78 caracteres, que es lo que
 * entra a 80 columnas (RNF-1): cada hint nuevo tiene que sacar otro. `^L leído`
 * (tarea 15, CA-11.5) entró en el lugar de `↑↓ mover` —los dos miden lo mismo,
 * así que el pie sigue en 78— porque de los dos es el que NO se adivina: que las
 * flechas muevan el cursor de una lista lo sabe cualquiera, y siguen figurando
 * en la ayuda (`?`) junto con `^K`/`^J`.
 */
export const HINTS_BANDEJA = "⏎ abrir · ^L leído · Tab filtro";
