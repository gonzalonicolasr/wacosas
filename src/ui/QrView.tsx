// El QR en pantalla: una fila de terminal por cada dos filas de módulos, con los
// colores CLAVADOS en negro sobre blanco (design D10, CA-1.5).
//
// Los dos únicos `#rrggbb` a mano de toda la interfaz, y no son un descuido:
//
//   · **no son tokens del tema.** El tema es una decisión estética; esto es un
//     requisito del lector del teléfono. Un QR pintado con el verde noche de
//     `theme.ts` tiene el contraste al revés y NO lo lee ningún teléfono, así
//     que si algún día cambia la paleta este color no se tiene que enterar;
//   · van juntos y sólo acá, así que sacarlos a `theme.ts` sería invitar a que
//     alguien los "unifique" con el resto de la paleta.
//
// El resto de la pantalla lo arma `Login.tsx`: este componente pinta la matriz y
// nada más. Ojo con dos cosas que lo rompen en silencio:
//
//   · **nunca pasar las filas por `clip()`**: aplasta los espacios repetidos
//     (`fmt.oneLine`), y la mitad del QR son espacios (los módulos claros);
//   · `wrapMode="none"` en cada fila: si una fila se envolviera, correría todo
//     el resto del símbolo una fila para abajo.
import { QR_MIN_COLS, QR_MIN_ROWS, type Qr } from "../wa/qr";
import { ACCENT, DANGER, MUT, TEXT, WARN } from "./theme";

/** Negro y blanco fijos: los pide el lector del teléfono, no el tema (D10). */
export const QR_FG = "#000000";
export const QR_BG = "#ffffff";

export function QrView({ qr }: { qr: Qr }) {
  return (
    <box flexDirection="column" flexShrink={0} width={qr.cols} height={qr.height}>
      {qr.rows.map((fila, i) => (
        // Las filas son estáticas dentro de un mismo payload y el QR entero se
        // reemplaza con `key={qr}` desde `Login`: el índice alcanza.
        <text key={i} fg={QR_FG} bg={QR_BG} wrapMode="none" height={1}>
          {fila}
        </text>
      ))}
    </box>
  );
}

/**
 * El QR no entra: tamaño actual contra el requerido (CA-2.1). Se usa en dos
 * lados —a pantalla completa cuando el usuario forzó el QR con `Tab`, y como un
 * renglón arriba del input cuando el método se eligió solo— así que la versión
 * corta y la larga viven juntas, para que los números no se separen nunca.
 *
 * Con `--qr-png` (`pngPath`) el mensaje cambia de tono: el QR igual se puede
 * escanear, sólo que desde el archivo. Ahí la ruta es lo ÚNICO accionable —"hace
 * falta 69 × 36" es un dato que ya no obliga a nada— así que en la versión corta
 * se lleva el renglón, y en la larga va arriba de las medidas.
 */
export function QrNoEntra({
  width,
  height,
  qr,
  compacto = false,
  pngPath = null,
}: {
  width: number;
  height: number;
  qr: Qr | null;
  compacto?: boolean;
  pngPath?: string | null;
}) {
  // Lo que hace falta de verdad: el umbral del requirements, o la matriz real si
  // resultó más grande que él (un payload más largo, §8.2).
  const cols = Math.max(QR_MIN_COLS, qr?.cols ?? 0);
  const filas = Math.max(QR_MIN_ROWS, qr ? qr.height + 1 : 0);
  const medidas = `ahora ${width} × ${height} · hace falta ${cols} × ${filas}`;

  if (compacto) {
    return (
      <text fg={pngPath ? ACCENT : MUT} wrapMode="none">
        {pngPath ? `📷 el QR no entra acá: escaneá ${pngPath}` : `⚠ el QR no entra acá: ${medidas}`}
      </text>
    );
  }

  return (
    <box flexDirection="column" alignItems="center">
      <text fg={DANGER} wrapMode="none">
        {"⚠ el QR no entra en esta terminal"}
      </text>
      {pngPath ? (
        <text fg={ACCENT} wrapMode="none">
          {`📷 escaneá el PNG: ${pngPath}`}
        </text>
      ) : null}
      <text fg={TEXT} wrapMode="none">
        {medidas}
      </text>
      <text fg={WARN} wrapMode="none">
        {"agrandala, o apretá Tab para vincular con un código"}
      </text>
    </box>
  );
}
