// Una fila de la conversación (design §7.1 → `MessageRow.tsx`): hora, autor,
// cuerpo o placeholder de adjunto con su caption debajo, y el estado de entrega
// cuando el mensaje es propio (CA-6.2, CA-6.3, CA-7.1, CA-7.2, CA-7.3, CA-7.5).
//
// Cuatro reglas que gobiernan este archivo:
//
//  1. **Acá SÍ se envuelve por palabra** (`wrapMode="word"`). El gotcha de
//     `height={1}` + `wrapMode="none"` es de las filas de LISTA (§7.4.1): un
//     mensaje largo tiene que seguir en la línea de abajo, no recortarse. Lo que
//     recorta en vertical es el `<scrollbox>` de `Conversation.tsx`, que es el
//     único contenedor de OpenTUI que de verdad esconde lo que no entra.
//  2. **De un adjunto no se toca ni un byte** (CA-7.4). Lo único que se pinta es
//     el `label` que armó `lib/placeholder.ts` cuando el mensaje se persistió: en
//     todo el camino de un mensaje no hay —ni puede haber— descarga de medios ni
//     escritura de archivos, y el criterio se verifica con un grep sobre `src/`.
//  3. **El autor se muestra SIEMPRE**, no sólo en los grupos. CA-6.2 lo pide en
//     todos los mensajes y CA-6.3 agrega que en un grupo tiene que ser QUIEN
//     ESCRIBIÓ, no el nombre del chat. Es el estilo de cualquier cliente de chat
//     de terminal (el nick en cada línea): con el scroll a mitad de camino, una
//     línea suelta se sigue entendiendo sin buscar el encabezado del bloque.
//  4. **El propio y el ajeno se distinguen por FORMA y por COLOR** (CA-6.2): el
//     glifo `›`/`‹` primero, el color después. Con el color apagado —una terminal
//     monocroma, un `capture-pane` sin `-e`— el mensaje se sigue pudiendo
//     atribuir.
import { memo } from "react";

import type { MessageRow as Mensaje } from "../db/types";
import { clip, fmtTime } from "../lib/fmt";
import { placeholderFor } from "../lib/placeholder";
import { ACCENT, ACCENT2, DANGER, FAINT, GOLD, MUT, SELBG, TEXT, TEXT_DIM, WARN } from "./theme";

/** `id` del renderable de la fila: lo usa `scrollChildIntoView` (CA-12.3). */
export const idFila = (id: number): string => `msg-${id}`;

/** `HH:MM ` — ancho fijo y ASCII puro, así que contar caracteres es contar columnas. */
export const ANCHO_HORA = 6;
/** Columnas del glifo `›`/`‹` con su espacio. */
export const ANCHO_MARCA = 2;
/** Dónde arranca el cuerpo: es también la sangría del caption (CA-7.2). */
export const SANGRIA = ANCHO_HORA + ANCHO_MARCA;

/** Tope del nombre del autor: un `pushName` puede ser una frase entera. */
const MAX_AUTOR = 14;

/** Piso del ancho de la fila: abajo de esto ya estamos en `<TooSmall/>` (RNF-2). */
const ANCHO_MINIMO = SANGRIA + 4;

/**
 * Glifo de entrega de un mensaje PROPIO (design §7.1: "hora, autor,
 * cuerpo/placeholder, estado"). Los recibos que mueven este estado son de las
 * tareas 14 y 15; acá sólo se pinta lo que ya está en la fila.
 *
 * `received` no lleva nada: el estado de entrega de un mensaje ajeno no es
 * asunto nuestro.
 */
export function estadoDe(status: Mensaje["status"]): { glifo: string; color: string } | null {
  switch (status) {
    case "pending":
      return { glifo: "⏳", color: MUT };
    case "sent":
      return { glifo: "✓", color: FAINT };
    case "delivered":
      return { glifo: "✓✓", color: FAINT };
    case "read":
      return { glifo: "✓✓", color: ACCENT2 };
    case "failed":
      return { glifo: "✗", color: DANGER };
    default:
      return null;
  }
}

/** La parte útil de un jid cuando no hay ningún nombre: `+549…` o `~lid`. */
function usuarioDe(jid: string): string {
  const corte = String(jid ?? "").indexOf("@");
  const user = corte < 0 ? String(jid ?? "") : jid.slice(0, corte);
  if (!user) return "";
  if (jid.endsWith("@lid")) return `~${user}`;
  return /^\d+$/.test(user) ? `+${user}` : user;
}

/**
 * Quién escribió el mensaje (CA-6.2, CA-6.3).
 *
 * `senderName` es el `pushName` CONGELADO al momento del mensaje (§4.3): si la
 * persona se cambió el nombre después, la charla vieja sigue diciendo cómo se
 * llamaba entonces, que es lo que hace legible un historial.
 *
 * El fallback se parte en dos porque en un grupo el nombre del CHAT no
 * identifica a nadie: sin `pushName` hay que caer al jid de quien escribió, no
 * a "Logística".
 */
export function autorDe(msg: Mensaje, grupo: boolean, nombreChat: string): string {
  if (msg.fromMe) return "vos";
  const congelado = String(msg.senderName ?? "").trim();
  if (congelado) return congelado;
  return (grupo ? usuarioDe(msg.senderJid) : String(nombreChat ?? "").trim()) || usuarioDe(msg.senderJid) || "…";
}

export type PropsMensaje = {
  msg: Mensaje;
  /**
   * Ancho EXPLÍCITO de la fila, en columnas. No es un detalle de estilo:
   * ⚠️ adentro de un `<scrollbox>` con barra de scroll, una fila de ancho
   * automático se MIDE con una columna menos de la que se DIBUJA (la barra se
   * descuenta del layout pero no del dibujo). El resultado es una fila en blanco
   * fantasma debajo de cada mensaje que se pasa por un pelo, y el último
   * carácter metido en la columna de la barra. Con el ancho fijado a mano, medida
   * y dibujo coinciden (verificado en OpenTUI 0.4.2 con y sin barra).
   */
  ancho: number;
  /** El chat es un grupo: cambia a quién se cae el autor cuando falta el `pushName`. */
  grupo: boolean;
  /** Etiqueta visible del chat: el autor de un 1:1 recibido sin `pushName`. */
  nombreChat: string;
  /** Señalado por el salto desde la búsqueda global (CA-12.3). */
  marcado?: boolean;
};

function Fila({ msg, ancho, grupo, nombreChat, marcado }: PropsMensaje) {
  const propio = msg.fromMe;
  const hora = fmtTime(msg.ts);
  // Precedencia idéntica a la del preview de la bandeja (`previewFor`), pero sin
  // pasar por `wa/map.ts`: ese módulo arrastra baileys entero y la interfaz no
  // puede importarlo. El `label` ya viene resuelto de cuando se persistió el
  // mensaje; el `placeholderFor` de atrás cubre las filas sin adjunto —`revoked`
  // (CA-6.9) y `unsupported` (CA-7.5)— y los adjuntos viejos sin label.
  const etiqueta = String(msg.attachment?.label ?? "").trim() || placeholderFor(msg.kind);
  const cuerpo = String(msg.body ?? "");
  const estado = propio ? estadoDe(msg.status) : null;

  // Un adjunto con caption son DOS líneas: el placeholder arriba y el texto
  // abajo (CA-7.2). Sin caption, o sin adjunto, es una sola.
  const conCaption = etiqueta !== "" && cuerpo !== "";
  const colorCuerpo = propio ? TEXT_DIM : TEXT;
  const colorEtiqueta = msg.kind === "revoked" || msg.kind === "unsupported" ? MUT : ACCENT2;

  // La fila son DOS columnas y no un `<text>` corrido: la hora y el glifo viven
  // en una caja de ancho fijo y todo lo demás en la de al lado. Así el salto de
  // línea de un mensaje largo cae SANGRADO —el wrap ocurre dentro de la columna
  // derecha— en vez de volver al margen izquierdo y confundirse con la fila
  // siguiente. Es también lo que alinea el caption con el cuerpo (CA-7.2).
  return (
    <box
      id={idFila(msg.id)}
      width={Math.max(ANCHO_MINIMO, ancho)}
      flexDirection="row"
      flexShrink={0}
      backgroundColor={marcado ? SELBG : undefined}
    >
      <box width={SANGRIA} flexShrink={0}>
        <text wrapMode="none">
          {/* `fmtTime` devuelve "" ante un timestamp inservible: se rellena para
              que el cuerpo de todas las filas arranque en la misma columna. */}
          <span fg={FAINT}>{hora.padEnd(ANCHO_HORA)}</span>
          <span fg={propio ? ACCENT : ACCENT2}>{propio ? "› " : "‹ "}</span>
        </text>
      </box>

      <box flexDirection="column" flexGrow={1} flexShrink={1}>
        <text wrapMode="word">
          <span fg={propio ? ACCENT : GOLD}>{clip(autorDe(msg, grupo, nombreChat), MAX_AUTOR)}</span>
          <span fg={FAINT}>{": "}</span>
          {etiqueta ? (
            <span fg={colorEtiqueta}>{etiqueta}</span>
          ) : (
            <span fg={colorCuerpo}>{cuerpo}</span>
          )}
          {estado ? <span fg={estado.color}>{` ${estado.glifo}`}</span> : null}
          {/* CA-9.3: el motivo del fallo va en la misma línea, no en un modal. */}
          {msg.error && msg.status === "failed" ? (
            <span fg={WARN}>{` (${clip(msg.error, 40)})`}</span>
          ) : null}
        </text>

        {/* CA-7.2: el caption va DEBAJO del placeholder, alineado con él. */}
        {conCaption ? (
          <text wrapMode="word" fg={colorCuerpo}>
            {cuerpo}
          </text>
        ) : null}
      </box>
    </box>
  );
}

/**
 * Memoizada con comparación por CAMPOS y no por identidad: el slice `convo` es
 * una PROYECCIÓN (D2), o sea que cada flush vuelve a consultar la base y devuelve
 * 500 objetos nuevos. Con el `Object.is` de fábrica, `memo` no ahorraría un solo
 * render: sin esto, un mensaje entrante repinta las 500 filas enteras.
 *
 * ⚠️ **`ancho` va PRIMERO en la guarda** (CA-19.4). Es la única prop de la que
 * depende el maquetado de la fila, y saltearla al redimensionar dejaba las 500
 * filas con el ancho VIEJO: el panel se re-maquetaba, pero cada mensaje seguía
 * dibujándose a las columnas de antes, la cola caía fuera del panel y el
 * `<scrollbox>` la clipeaba —el texto desaparecía y no volvía hasta cambiar de
 * chat—. Acá no hay medida cacheada que valga (§8.1): si cambia el ancho, se
 * vuelve a envolver.
 */
export const MessageRow = memo(Fila, (a, b) => {
  if (a.ancho !== b.ancho) return false;
  if (a.grupo !== b.grupo || a.nombreChat !== b.nombreChat || a.marcado !== b.marcado) return false;
  const x = a.msg;
  const y = b.msg;
  return (
    x.id === y.id &&
    x.ts === y.ts &&
    x.kind === y.kind &&
    x.body === y.body &&
    x.status === y.status &&
    x.error === y.error &&
    x.fromMe === y.fromMe &&
    x.senderName === y.senderName &&
    x.senderJid === y.senderJid &&
    (x.attachment?.label ?? "") === (y.attachment?.label ?? "")
  );
});
