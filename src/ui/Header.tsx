// Encabezado: marca + estado de la conexión (CA-15.1, CA-13.3, CA-15.3).
//
// Lee el slice `conn` por su cuenta en vez de recibirlo por props: así un cambio
// de estado de conexión re-renderiza el encabezado y NO la bandeja.
//
// Los tabs con contadores (Todos / No leídos / Grupos) y el buscador los agrega
// la tarea 12; a 80 columnas se mudan al `title` del panel de la bandeja (§7.2).
import { useEffect, useState } from "react";

import { useSlice } from "../state/hooks";
import type { ConnSnapshot } from "../state/store";
import { Brand } from "./Brand";
import { ACCENT, BORDER_ACCENT, DANGER, MUT, SURFACE, WARN } from "./theme";

export const ALTO_HEADER = 3;

type Pinta = { texto: string; color: string };

/** Segundos que faltan para el próximo intento, redondeados para arriba. */
function faltan(nextAttemptAt: number | null, ahora: number): number {
  if (nextAttemptAt === null) return 0;
  return Math.max(0, Math.ceil((nextAttemptAt - ahora) / 1000));
}

function pintar(conn: ConnSnapshot, ahora: number): Pinta {
  switch (conn.state) {
    case "open":
      return { texto: "● conectado", color: ACCENT };
    case "connecting":
      return { texto: "◌ conectando…", color: WARN };
    case "reconnecting": {
      // CA-15.3: cuántos intentos lleva y cuánto falta para el próximo. Los dos
      // datos son OPCIONALES: al emitirse un QR el socket resetea `attempt` a 0
      // sin salir de `reconnecting` (D6), y ahí "intento 0" no significa nada.
      const s = faltan(conn.nextAttemptAt, ahora);
      const partes: string[] = [];
      if (conn.attempt > 0) partes.push(`intento ${conn.attempt}`);
      if (s > 0) partes.push(`${s} s`);
      return {
        texto: partes.length ? `⟳ reconectando · ${partes.join(" · ")}` : "⟳ reconectando…",
        color: WARN,
      };
    }
    case "unlinked":
      return { texto: "⊘ desvinculado", color: DANGER };
    default:
      return { texto: "○ sin conexión", color: DANGER };
  }
}

/**
 * Badge de conexión. Es su propio componente por el gotcha §7.4.4: la cuenta
 * regresiva late una vez por segundo y no puede arrastrar al resto del árbol.
 * El timer sólo existe mientras hay algo que contar.
 */
function ConnBadge({ conn }: { conn: ConnSnapshot }) {
  const [ahora, setAhora] = useState(() => Date.now());
  const contando = conn.state === "reconnecting" && conn.nextAttemptAt !== null;
  useEffect(() => {
    if (!contando) return;
    const id = setInterval(() => setAhora(Date.now()), 1000);
    return () => clearInterval(id);
  }, [contando, conn.nextAttemptAt]);

  const { texto, color } = pintar(conn, contando ? ahora : Date.now());
  return <text fg={color}>{texto}</text>;
}

export function Header() {
  const conn = useSlice("conn");
  return (
    <box
      flexDirection="row"
      height={ALTO_HEADER}
      border
      borderColor={BORDER_ACCENT}
      backgroundColor={SURFACE}
      paddingLeft={1}
      paddingRight={1}
    >
      <Brand />
      <box flexGrow={1}>
        <text fg={MUT}> </text>
      </box>
      <ConnBadge conn={conn} />
    </box>
  );
}
