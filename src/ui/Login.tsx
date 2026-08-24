// Pantalla de vinculación (CA-1.*, CA-2.*, RNF-3). Es lo primero que ve alguien
// que instala wacosas y lo que vuelve a aparecer si WhatsApp desvincula la
// sesión (CA-3.1), así que tiene que explicarse sola.
//
// Las tres decisiones que la gobiernan:
//
//  1. **Se pinta por MÉTODO, no por fase.** Baileys sigue rotando el QR aunque
//     ya se haya pedido un código de emparejamiento (`Socket/socket.js:711`), y
//     esa rotación llegaba a borrarle al usuario el código de la pantalla a los
//     ~20 s (arreglado en la tarea 8b, guard en `socket.ts`). Mirando el método
//     —que sólo cambia si el usuario aprieta `Tab` o si cambia el tamaño de la
//     terminal— una rotación no puede sacarle de encima lo que está mirando.
//  2. **El método se DERIVA, no se guarda**, mientras el usuario no elija a mano
//     (`methodForced`): así se recalcula gratis en cada resize (§6.1.1) sin
//     escribir en el store desde un efecto, o sea sin un flush por cada
//     redimensionada. `Tab` sí escribe: es la elección explícita de CA-2.6.
//  3. **El QR manda en el presupuesto de filas.** OpenTUI no recorta a los hijos
//     que no entran: los dibuja ENCIMADOS. Un QR encimado con el pie es un QR
//     ilegible, así que el encabezado, el renglón de estado y el motivo se van
//     cayendo en ese orden cuando el alto no alcanza.
//
// Alternar QR ↔ código NO toca el socket (D11): es un cambio de pintura.
import { useMemo } from "react";

import { clip } from "../lib/fmt";
import { useSlice } from "../state/hooks";
import type { LinkSnapshot } from "../state/store";
import { buildQr, fitsQr, type Qr } from "../wa/qr";
import { ALTO_FOOTER, Footer } from "./Footer";
import { ALTO_HEADER, Header } from "./Header";
import { PairingView } from "./PairingView";
import { QrNoEntra, QrView } from "./QrView";
import { ACCENT, BG, DANGER, MUT, TEXT, WARN } from "./theme";

/** Filas que necesita el cuerpo del código para no quedar apretado. */
const ALTO_CUERPO_CODIGO = 8;
/** Y su peor caso, con todos los renglones opcionales puestos. Es el que manda
 *  para el centrado: sobreestimar sólo corre el bloque un renglón para arriba,
 *  subestimarlo lo empujaría contra el pie. */
const ALTO_CUERPO_CODIGO_MAX = 10;
/** Desde acá el cuerpo se puede dar el lujo de los renglones en blanco. */
const FILAS_ESPACIOSO = 14;

export type Metodo = "qr" | "code";

/**
 * Qué método de vinculación corresponde AHORA (CA-2.1, CA-2.6).
 *
 * Vive afuera del componente porque lo necesitan dos: esta pantalla para
 * pintarse y el `Tab` de `App` para saber hacia dónde alternar. Si `App` lo
 * dedujera por su cuenta, alcanzaría con que una de las dos cuentas cambiara
 * para que `Tab` empezara a llevar al método que ya se está mirando.
 *
 * La matriz se puede pasar hecha (el render la tiene memorizada); desde el
 * teclado se arma en el momento, que es una vez por tecla y no por frame.
 */
export function metodoDe(
  link: LinkSnapshot,
  width: number,
  height: number,
  qr: Qr | null = buildQr(link.qr),
): Metodo {
  if (link.methodForced) return link.method;
  return fitsQr(width, height, qr) ? "qr" : "code";
}

/** Estado del proceso de vinculación, en una línea (CA-1.9). */
export function estadoDe(
  link: LinkSnapshot,
  metodo: Metodo,
  /** ¿La terminal da para dibujar el QR? Si no, prometer "escaneá" es mentirle. */
  entra: boolean,
): { texto: string; color: string } {
  switch (link.phase) {
    case "checking":
      return { texto: "⟳ revisando la sesión guardada…", color: MUT };
    case "restarting":
      // El 515 de después del escaneo: la sesión ya es válida, sólo falta que el
      // socket vuelva a abrir (CA-1.8). Cerrar acá sería lo peor que puede hacer.
      return { texto: "⟳ vinculando… no cierres wacosas", color: WARN };
    case "linked":
      return { texto: "✓ vinculado", color: ACCENT };
    case "failed":
      return { texto: "✗ no se pudo vincular", color: DANGER };
  }
  if (metodo === "code") return { texto: "✦ vincular con un código", color: TEXT };
  if (!entra) return { texto: "✦ vincular escaneando el QR", color: TEXT };
  return link.qr
    ? { texto: "escaneá el QR: WhatsApp › Dispositivos vinculados", color: TEXT }
    : { texto: "⟳ esperando el QR de WhatsApp…", color: MUT };
}

export function Login({ width, height }: { width: number; height: number }) {
  const link = useSlice("link");
  // La matriz se arma UNA vez por payload: `QRCode.create` no es gratis y este
  // componente se re-renderiza con cada latido del badge de conexión.
  const qr = useMemo(() => buildQr(link.qr), [link.qr]);
  const entra = fitsQr(width, height, qr);
  // CA-2.1 + CA-2.6: el tamaño elige por default, el usuario tiene la última
  // palabra. Y como es derivado, achicar la terminal mientras se ve el QR
  // muestra el panel de "no entra" y agrandarla lo trae de vuelta, sin esperar
  // la próxima rotación ni reconectar (§6.1.2).
  const metodo = metodoDe(link, width, height, qr);
  /** La matriz SÓLO si se va a dibujar: si no, no ocupa presupuesto de filas. */
  const aPintar = metodo === "qr" && entra ? qr : null;

  // ── presupuesto de filas ──────────────────────────────────────────────────
  const altoQr = aPintar ? aPintar.height : 0;
  const necesario = aPintar ? altoQr + 1 : ALTO_CUERPO_CODIGO;
  const conHeader = height - ALTO_HEADER - ALTO_FOOTER >= necesario;
  const filasCuerpo = Math.max(1, height - (conHeader ? ALTO_HEADER : 0) - ALTO_FOOTER);
  const conEstado = filasCuerpo >= altoQr + 1;
  const conMotivo = !!link.reason && filasCuerpo >= altoQr + (conEstado ? 2 : 1);
  const espacioso = !aPintar && filasCuerpo >= FILAS_ESPACIOSO;

  // Centrado vertical con un padding entero calculado del MISMO presupuesto de
  // filas de arriba: el centrado y lo que se pinta salen de una sola cuenta.
  //
  // Lo que rompe esta pantalla NO es cómo se centra —`justifyContent:"center"`
  // da lo mismo: medido con 3, 5 y 7 hijos de alto automático, con `center` y
  // sin él, el frame sale idéntico—, es el DESBORDE: OpenTUI no recorta a los
  // hijos que no entran, los dibuja ENCIMADOS (7 hijos en un cuerpo de 5 filas
  // pierden los mismos dos con `center` y sin `center`). Un QR encimado con el
  // pie es un QR que ningún teléfono lee.
  //
  // Por eso la defensa es el presupuesto: `conEstado`/`conMotivo`/`espacioso`
  // van soltando renglones opcionales antes de quedarse sin lugar, y el
  // `Math.max(0, …)` de acá abajo hace que cuando no sobra nada el padding sea
  // 0 en vez de negativo. El alto estimado no necesita ser exacto: si sobra, el
  // bloque queda un renglón más arriba y lo que sobra queda ABAJO.
  const altoContenido = aPintar
    ? altoQr + (conEstado ? 1 : 0) + (conMotivo ? 1 : 0)
    : ALTO_CUERPO_CODIGO_MAX;
  const relleno = Math.max(0, Math.floor((filasCuerpo - altoContenido) / 2));

  const estado = estadoDe(link, metodo, entra);
  /** El código A LA VISTA: es lo que cambia qué hacen `Ctrl-R` y `Esc` (`App`). */
  const viendoCodigo = metodo === "code" && !!link.pairingCode;
  const hints = [
    metodo === "qr" ? "Tab código" : "Tab QR",
    // CA-2.5: con un código en pantalla, `Ctrl-R` pide otro en vez de reconectar.
    viendoCodigo ? "^R código nuevo" : "^R reconectar",
    // La salida del callejón: el código se pidió para un número que puede estar
    // mal tipeado y WhatsApp lo devuelve igual (no valida que sea tuyo).
    ...(viendoCodigo ? ["Esc otro número"] : []),
    "^C salir",
  ].join(" · ");

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={BG}>
      {conHeader ? <Header /> : null}

      <box
        flexDirection="column"
        flexGrow={1}
        alignItems="center"
        paddingTop={relleno}
        paddingLeft={1}
        paddingRight={1}
      >
        {conEstado ? (
          <text fg={estado.color} wrapMode="none">
            {clip(estado.texto, Math.max(20, width - 2))}
          </text>
        ) : null}

        {/* CA-2.1: aunque el camino ofrecido sea el código, el usuario tiene que
            enterarse de POR QUÉ no ve el QR y qué tamaño le haría falta. Va
            arriba del cuerpo, pegado al título: es la explicación de por qué
            está en esta pantalla y no en la del QR. */}
        {metodo === "code" && !entra ? (
          <QrNoEntra width={width} height={height} qr={qr} compacto />
        ) : null}

        {espacioso ? <text> </text> : null}

        {aPintar ? (
          // CA-1.6: la rotación REEMPLAZA el QR anterior. Con el payload de key,
          // React monta uno nuevo y desmonta el viejo — no hay apilado posible.
          <QrView key={link.qr as string} qr={aPintar} />
        ) : metodo === "qr" && !entra ? (
          <QrNoEntra width={width} height={height} qr={qr} />
        ) : metodo === "qr" ? (
          // Entra, pero WhatsApp todavía no mandó ningún payload (el segundo que
          // hay entre `wa.connect` y el primer `wa.qr`). Decir acá que "no entra"
          // sería mentir, y dejarlo en blanco, no explicar nada.
          <text fg={MUT} wrapMode="none">
            {"el QR aparece en unos segundos"}
          </text>
        ) : (
          <PairingView link={link} width={width} espacioso={espacioso} />
        )}

        {conMotivo ? (
          <text fg={link.phase === "failed" ? DANGER : WARN} wrapMode="none">
            {clip(link.reason as string, Math.max(20, width - 2))}
          </text>
        ) : null}
      </box>

      <Footer hints={hints} width={width} />
    </box>
  );
}
