// Encabezado: marca + tabs de filtro con contadores + estado de la conexión
// (CA-5.5, CA-10.3, CA-10.5, CA-15.1, CA-13.3, CA-15.3, CA-19.1).
//
// Lee `conn` por su cuenta en vez de recibirlo por props: así un cambio de estado
// de conexión re-renderiza el encabezado y NO la bandeja.
//
// **Los tabs se achican antes que romper el header.** A 80 columnas (RNF-1) el
// renglón útil son 76 y ahí adentro tienen que entrar la marca, los tres
// contadores y el badge de conexión, que mide 11 caracteres conectado y **34**
// reconectando con cuenta regresiva. En vez de reservar el peor caso —lo que
// dejaría los tabs en jeroglíficos todo el tiempo— se mide el badge que se va a
// pintar AHORA y se elige el nivel de detalle más largo que entre. El diseño
// (§7.2) proponía mudarlos al `title` del panel en `compact`; se resolvió así
// porque CA-5.5 y CA-10.3 piden los contadores en el ENCABEZADO, y a 80 columnas
// con la conexión abierta entran de sobra.
import { useTerminalDimensions } from "@opentui/react";
import { useEffect, useState } from "react";

import type { Counts } from "../db/repo";
import { commands, FILTROS } from "../state/commands";
import { useSlice } from "../state/hooks";
import type { ConnSnapshot, InboxFilter } from "../state/store";
import { Brand } from "./Brand";
import { ACCENT, BORDER_ACCENT, DANGER, MUT, SEL_FG, SURFACE, TEXT_DIM, WARN } from "./theme";

export const ALTO_HEADER = 3;

/** `"✦ wacosas"` + los dos espacios que deja `Brand`. */
const ANCHO_MARCA = 11;
/** Cada tab lleva un espacio de aire a cada lado (y ahí vive el fondo del activo). */
const AIRE_TAB = 2;
/** Slack por si el badge crece un carácter entre renders (9 s → 10 s). */
const SLACK_BADGE = 1;

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
 * Los tres niveles de detalle de los tabs, del más explícito al más apretado.
 * El último es de glifos y sirve para que los NÚMEROS nunca desaparezcan: un
 * contador escondido es peor que uno con un ícono en vez de una palabra.
 */
const ETIQUETAS: Array<Record<InboxFilter, string>> = [
  { all: "Todos", unread: "No leídos", groups: "Grupos" },
  { all: "Todos", unread: "Sin leer", groups: "Grupos" },
  { all: "≡", unread: "✉", groups: "▣" },
];

/** Texto de un tab: en los niveles con palabra va separado del número. */
export function textoTab(filtro: InboxFilter, n: number, nivel: number): string {
  const i = Math.max(0, Math.min(ETIQUETAS.length - 1, nivel));
  const etiqueta = (ETIQUETAS[i] as Record<InboxFilter, string>)[filtro];
  return i === ETIQUETAS.length - 1 ? `${etiqueta}${n}` : `${etiqueta} ${n}`;
}

const numeroDe = (counts: Counts, f: InboxFilter): number =>
  f === "unread" ? counts.unread : f === "groups" ? counts.groups : counts.all;

/** Columnas que ocupan los tres tabs juntos, aire incluido. */
export function anchoTabs(counts: Counts, nivel: number): number {
  return FILTROS.reduce((t, f) => t + AIRE_TAB + textoTab(f, numeroDe(counts, f), nivel).length, 0);
}

/** El nivel más explícito que entra en `disponible` columnas. */
export function nivelTabs(counts: Counts, disponible: number): number {
  for (let n = 0; n < ETIQUETAS.length - 1; n++) {
    if (anchoTabs(counts, n) <= disponible) return n;
  }
  return ETIQUETAS.length - 1;
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

/** Los tres filtros con su contador. Clickeables (CA-5.8). */
function Tabs({ disponible }: { disponible: number }) {
  const { counts } = useSlice("inbox");
  const { inboxFilter } = useSlice("ui");
  const nivel = nivelTabs(counts, disponible);

  return (
    <box flexDirection="row" flexShrink={0}>
      {FILTROS.map((f) => {
        const n = numeroDe(counts, f);
        const activo = f === inboxFilter;
        return (
          <box
            key={f}
            height={1}
            flexShrink={0}
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={activo ? ACCENT : undefined}
            onMouseDown={() => commands.setInboxFilter(f)}
          >
            <text
              wrapMode="none"
              // CA-10.3: el total de no leídos se destaca aunque el tab no esté
              // activo — es el número por el que uno mira el encabezado.
              fg={activo ? SEL_FG : f === "unread" && n > 0 ? ACCENT : TEXT_DIM}
            >
              {textoTab(f, n, nivel)}
            </text>
          </box>
        );
      })}
    </box>
  );
}

export function Header({ conTabs = false }: { conTabs?: boolean } = {}) {
  const conn = useSlice("conn");
  const { width } = useTerminalDimensions();
  // −2 del borde, −2 del padding del propio encabezado.
  const disponible =
    width - 4 - ANCHO_MARCA - pintar(conn, Date.now()).texto.length - SLACK_BADGE;

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
      {/* La pantalla de vinculación también monta el encabezado, y ahí los tabs
          no tienen sobre qué filtrar: todavía no hay bandeja. */}
      {conTabs ? <Tabs disponible={Math.max(0, disponible)} /> : null}
      <box flexGrow={1} flexShrink={1}>
        <text fg={MUT}> </text>
      </box>
      <ConnBadge conn={conn} />
    </box>
  );
}
