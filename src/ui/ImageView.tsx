// Ver una imagen recibida (`^O`). Reemplaza el cuerpo, igual que la ayuda, la
// búsqueda global y la pantalla del candado (§7.1).
//
// **Por qué una pantalla entera y no una vista adentro de la conversación.** Una
// imagen necesita filas, y las filas de la conversación son de los mensajes: una
// foto metida entre dos globos deja al chat sin contexto y encima se ve del
// tamaño de una estampilla. Como pantalla, a 80×24 la imagen se lleva 16 filas
// (32 píxeles de alto con medios bloques) en vez de 4, y de paso todas las teclas
// quedan libres: `Esc` cierra, `←`/`→` caminan las fotos del chat y `o` la abre
// en el visor del sistema. Es el mismo patrón que ya usan `Help` y `LockCode`.
//
// Tres decisiones que no son de estilo:
//
//  1. **La descarga es a demanda y una por vez.** Se baja la imagen que se está
//     MIRANDO, nunca las de al lado (nada de precargar la siguiente: sería
//     tráfico que el usuario no pidió). Al moverse, la anterior queda en el caché
//     de disco, así que volver es instantáneo y no cuesta un byte.
//  2. **La respuesta que llega tarde se descarta.** Bajar una foto puede tardar
//     segundos y en ese rato el usuario ya se movió tres imágenes: cada pedido
//     lleva un turno y sólo se pinta el que sigue siendo el vigente. Sin esto, la
//     imagen de hace tres pasos aparecería encima de la actual.
//  3. **El tamaño se recalcula con la terminal.** `chafa` recibe las celdas que
//     de verdad hay (CA-19.4): al redimensionar se vuelve a convertir, que es
//     barato porque el archivo ya está en disco.
//  4. **La calidad real es OTRA pantalla, bajo demanda (`⏎`).** Lo que se pinta
//     acá son medios bloques —dos píxeles por celda—: alcanza para reconocer una
//     foto y para caminar las imágenes del chat, pero una captura de pantalla
//     con texto es ilegible. Para eso está `⏎`, que suspende la TUI entera y
//     dibuja con el protocolo gráfico de la terminal (`boot/grafica.ts`). No se
//     hace siempre porque una imagen dibujada por fuera del renderer la pisa el
//     frame siguiente: mientras se ve a calidad real, la TUI **no existe**.
import { useEffect, useMemo, useRef, useState } from "react";

import type { FilaImagen } from "../boot/chafa";
import type { MessageRow } from "../db/types";
import { clip, fmtTime } from "../lib/fmt";
import { commands, etiquetaChat } from "../state/commands";
import { useSlice } from "../state/hooks";
import { autorDe } from "./MessageRow";
import { BORDER, DANGER, FAINT, MUT, SURFACE, TEXT_DIM } from "./theme";

/** Teclas de esta pantalla para el pie (`App` les agrega las globales). */
export const HINTS_IMAGEN = "← → cambiar · ⏎ calidad real · o visor · Esc cerrar";

/** Filas que se reserva el renglón de datos (hora, autor, epígrafe). */
const ALTO_INFO = 1;

/**
 * Lo que `App` le puede pedir a esta pantalla. Mismo patrón que `ApiBusqueda` y
 * `ApiComposer`, y por el mismo motivo: el `useKeyboard` es **UNO solo** y vive
 * en `App` (§7.4), así que las teclas llegan allá y bajan por esta ref.
 */
export type ApiImagen = { mover(delta: number): void; abrirEnVisor(): void; verEnGrande(): void };

export type PropsImagen = {
  /** Ancho de la terminal. El panel se queda con todo. */
  ancho: number;
  /** Filas que le quedan al cuerpo (sin encabezado ni pie). */
  alto: number;
  apiRef?: React.RefObject<ApiImagen | null>;
};

/** El estado de la imagen que se está mirando. */
type Vista =
  | { fase: "bajando" }
  | { fase: "listo"; filas: FilaImagen[] }
  | { fase: "error"; motivo: string };

/** Una fila de la imagen: un `<text>` con un `<span>` por tramo de color. */
function Fila({ tramos }: { tramos: FilaImagen }) {
  return (
    <box height={1} flexShrink={0}>
      <text wrapMode="none">
        {tramos.map((t, i) => (
          // La lista es estática por render (sale del parser, no se reordena):
          // el índice alcanza como `key`.
          <span key={i} fg={t.fg || undefined} bg={t.bg || undefined}>
            {t.texto}
          </span>
        ))}
      </text>
    </box>
  );
}

export function ImageView({ ancho, alto, apiRef }: PropsImagen) {
  const convo = useSlice("convo");
  const inbox = useSlice("inbox");
  const jid = convo.jid;

  // Las imágenes salen de la BASE y no de la ventana de 500 del slice `convo`:
  // una foto de hace tres meses tiene que estar en la lista aunque su mensaje
  // haya quedado fuera de la ventana que se está leyendo.
  const imagenes = useMemo(() => commands.chatImages(jid), [jid]);

  const [idx, pintarIdx] = useState(0);
  // ⚠️ El índice va DUPLICADO en una ref, que es la que lee el teclado (§7.4.15):
  // varias teclas pueden caer dentro del mismo render y todas verían el mismo
  // `idx` de la closure — dos `←` seguidos moverían una sola imagen. La ref es el
  // valor de ahora; el `useState` es sólo para repintar.
  const idxRef = useRef(0);
  const [vista, setVista] = useState<Vista>({ fase: "bajando" });
  /** Turno del pedido vigente: lo que llegue con otro turno se descarta. */
  const turnoRef = useRef(0);

  const total = imagenes.length;
  const msg = imagenes[Math.min(idx, Math.max(0, total - 1))] ?? null;

  const chat = jid === null ? null : (inbox.chats.find((c) => c.jid === jid) ?? null);
  const grupo = chat ? chat.isGroup : String(jid ?? "").endsWith("@g.us");
  const nombreChat = chat ? etiquetaChat(chat) : "";

  // −2 del borde del panel, −2 del padding del contenido.
  const cols = Math.max(4, ancho - 4);
  const filasImagen = Math.max(2, alto - 2 - ALTO_INFO);

  const mover = (delta: number): void => {
    if (total === 0) return;
    const j = Math.max(0, Math.min(total - 1, idxRef.current + delta));
    if (j === idxRef.current) return;
    idxRef.current = j;
    pintarIdx(j);
  };

  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      mover,
      abrirEnVisor() {
        if (msg) commands.openImageExternally(msg);
      },
      // `⏎`: la misma imagen a calidad real, con la TUI suspendida (decisión 4).
      // No se espera el resultado —mientras dura, esta pantalla no existe: la
      // dueña de la terminal es `boot/grafica.ts`— y el `catch` es para que un
      // rechazo inesperado no termine en un `unhandledRejection`, que en esta
      // aplicación cierra el proceso.
      verEnGrande() {
        if (msg) void commands.showImageFullQuality(msg).catch(() => {});
      },
    };
    return () => {
      apiRef.current = null;
    };
  });

  // ── bajar + convertir ─────────────────────────────────────────────────────
  // Depende del mensaje y del TAMAÑO: al redimensionar se vuelve a convertir con
  // las celdas nuevas (CA-19.4). El archivo ya está en disco, así que eso es un
  // `chafa` y nada de red.
  useEffect(() => {
    if (!msg) return;
    const turno = ++turnoRef.current;
    setVista({ fase: "bajando" });
    commands
      .showImage(msg, cols, filasImagen)
      .then((r) => {
        // Llegó tarde: el usuario ya está mirando otra (decisión 2).
        if (turno !== turnoRef.current) return;
        setVista(r.ok ? { fase: "listo", filas: r.filas } : { fase: "error", motivo: r.reason });
      })
      .catch((e: unknown) => {
        if (turno !== turnoRef.current) return;
        // `showImage` no rechaza; el catch es para que un rechazo inesperado no
        // termine en un unhandled rejection (que en esta app cierra el proceso).
        setVista({ fase: "error", motivo: e instanceof Error ? e.message : String(e) });
      });
  }, [msg?.id, cols, filasImagen]);

  const titulo =
    total === 0 ? " imágenes " : ` imagen ${Math.min(idx, total - 1) + 1} de ${total} `;

  // El renglón de datos: de quién es, de cuándo y qué decía. Es lo que hace que
  // una foto suelta se entienda sin volver a la conversación.
  const info = msg
    ? [fmtTime(msg.ts), autorDe(msg, grupo, nombreChat), String(msg.body ?? "").trim()]
        .filter((p) => p !== "")
        .join(" · ")
    : "este chat no tiene ninguna imagen";

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      border
      borderColor={BORDER}
      backgroundColor={SURFACE}
      paddingLeft={1}
      paddingRight={1}
      title={titulo}
    >
      <box flexDirection="column" flexGrow={1} alignItems="center" justifyContent="center">
        {vista.fase === "listo" ? (
          vista.filas.map((tramos, i) => <Fila key={i} tramos={tramos} />)
        ) : (
          <text fg={vista.fase === "error" ? DANGER : MUT} wrapMode="none">
            {clip(
              vista.fase === "error" ? `⚠ ${vista.motivo}` : "⋯ bajando la imagen…",
              Math.max(0, cols),
            )}
          </text>
        )}
      </box>

      <box height={ALTO_INFO} flexShrink={0}>
        <text fg={msg ? TEXT_DIM : FAINT} wrapMode="none">
          {clip(info, Math.max(0, cols))}
        </text>
      </box>
    </box>
  );
}
