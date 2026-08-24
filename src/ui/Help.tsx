// Ayuda (CA-19.3): los atajos VIGENTES —los que hoy hacen algo— y la ruta del
// archivo de log (CA-16.3). Se cierra con `Esc` (o con `?` de nuevo).
//
// Cada tarea que agrega teclas agrega su fila acá: una ayuda que promete atajos
// que todavía no existen es peor que no tenerla.
//
// **El cuerpo NO puede desbordar el alto disponible.** OpenTUI no recorta los
// hijos que no entran en un `<box>`: los dibuja ENCIMADOS, y abajo de 20 filas la
// ayuda quedaba ilegible (a 60×15, el mínimo de RNF-2, se pisaban tres renglones).
// Van dos mecanismos, en este orden:
//
//  1. `lineasQueEntran()` tira el ADORNO (títulos de sección y renglones en
//     blanco) cuando no entra todo. Es lo que hace que a 60×15 se vean los cuatro
//     atajos, la ruta del log y el aviso sin tener que scrollear nada.
//  2. Lo que aun así no entre queda dentro de un `<scrollbox>` (§7.4.5), que sí
//     recorta y se desplaza con `↑`/`↓` (y con la rueda) desde el `useKeyboard`
//     de `App`. Es la red para cuando las próximas tareas sumen más atajos: nunca
//     se pierde una fila, en el peor caso hay que bajar.
import type { ScrollBoxRenderable } from "@opentui/core";
import type { RefObject } from "react";

import { clip } from "../lib/fmt";
import { ACCENT, BORDER, FAINT, GOLD, MUT, SURFACE, TEXT_DIM } from "./theme";

/** Ancho fijo de la columna de teclas: alinea sin tener que medir nada. */
const COL = 16;

const ATAJOS: Array<[string, string]> = [
  ["?", "abrir / cerrar esta ayuda"],
  ["Esc", "cerrar la ayuda"],
  ["Ctrl-R", "reconectar ahora, sin esperar el backoff"],
  ["Ctrl-C · Ctrl-Q", "salir"],
];

const ATAJOS_BANDEJA: Array<[string, string]> = [
  ["escribir", "filtrar por nombre o número, sin acentos"],
  ["↑ ↓ · ^K ^J", "mover la selección (la rueda también)"],
  ["PgUp PgDn", "saltar de a una pantalla (Inicio / Fin, a las puntas)"],
  ["⏎ · doble click", "abrir el chat seleccionado"],
  ["Tab", "filtrar: todos / no leídos / grupos"],
  ["Esc", "limpiar el buscador"],
];

const ATAJOS_MINI: Array<[string, string]> = [
  ["⏎", "entrar a la conversación"],
  ["Esc", "volver a la bandeja"],
];

const AVISO = "la base local NO se cifra: queda 0600, sólo para tu usuario";

export type LineaAyuda =
  | { tipo: "atajo"; tecla: string; texto: string }
  | { tipo: "nota"; texto: string; tenue: boolean }
  | { tipo: "titulo"; texto: string }
  | { tipo: "hueco" };

/**
 * El contenido de la ayuda como datos, para poder contarlo y recortarlo antes de
 * pintarlo. Las filas de `mini` (un panel por vez, §7.2) sólo se listan cuando la
 * terminal está en ese modo: en `compact`/`wide` esas teclas no hacen nada y una
 * ayuda que promete atajos que no existen es peor que no tenerla.
 */
export function lineasAyuda({ logPath, mini }: { logPath: string; mini: boolean }): LineaAyuda[] {
  const lineas: LineaAyuda[] = [{ tipo: "titulo", texto: "teclas" }];
  for (const [tecla, texto] of ATAJOS) lineas.push({ tipo: "atajo", tecla, texto });
  lineas.push({ tipo: "hueco" });
  lineas.push({ tipo: "titulo", texto: "en la bandeja" });
  for (const [tecla, texto] of ATAJOS_BANDEJA) lineas.push({ tipo: "atajo", tecla, texto });
  if (mini) {
    lineas.push({ tipo: "hueco" });
    lineas.push({ tipo: "titulo", texto: "en terminales angostas (un panel por vez)" });
    for (const [tecla, texto] of ATAJOS_MINI) lineas.push({ tipo: "atajo", tecla, texto });
  }
  lineas.push({ tipo: "hueco" });
  lineas.push({ tipo: "nota", texto: `log: ${logPath}`, tenue: false });
  lineas.push({ tipo: "nota", texto: AVISO, tenue: true });
  return lineas;
}

/** Adorno = las filas que no informan ningún atajo ni ninguna ruta. */
function esAdorno(linea: LineaAyuda): boolean {
  return linea.tipo === "titulo" || linea.tipo === "hueco";
}

/**
 * Las líneas que se pintan en `filas` filas de alto. Si no entran todas, se cae
 * el adorno primero (lo que queda sigue siendo legible y ordenado). Si ni así
 * entran, devuelve igual la lista completa de lo esencial: recortarla a mano
 * escondería un atajo para siempre, y de eso se encarga el scroll.
 */
export function lineasQueEntran(todas: LineaAyuda[], filas: number): LineaAyuda[] {
  if (todas.length <= filas) return todas;
  return todas.filter((l) => !esAdorno(l));
}

/**
 * ¿Ni sacando el adorno entra? Entonces hay algo abajo del corte y las teclas de
 * scroll sirven. Lo usa el pie de `App` para no anunciar un `↑↓` que no hace nada
 * (la ayuda no promete atajos que no existen; el pie tampoco).
 */
export function ayudaScrollea(args: { logPath: string; mini: boolean; filas: number }): boolean {
  return lineasQueEntran(lineasAyuda(args), args.filas).length > args.filas;
}

function Fila({ tecla, texto, ancho }: { tecla: string; texto: string; ancho: number }) {
  return (
    <text wrapMode="none">
      <span fg={GOLD}>{tecla.padEnd(COL)}</span>
      <span fg={TEXT_DIM}>{clip(texto, Math.max(10, ancho - COL))}</span>
    </text>
  );
}

function Linea({ linea, ancho }: { linea: LineaAyuda; ancho: number }) {
  switch (linea.tipo) {
    case "atajo":
      return <Fila tecla={linea.tecla} texto={linea.texto} ancho={ancho} />;
    case "titulo":
      return (
        <text fg={ACCENT} wrapMode="none">
          {clip(linea.texto, ancho)}
        </text>
      );
    case "nota":
      // `wrapMode="none"` + `clip` en TODAS las líneas: una sola que se envuelva
      // le suma una fila al cuerpo y arranca el encimado.
      return (
        <text fg={linea.tenue ? FAINT : MUT} wrapMode="none">
          {clip(linea.texto, ancho)}
        </text>
      );
    default:
      return <text> </text>;
  }
}

export function Help({
  logPath,
  width,
  filas,
  mini,
  cajaRef,
}: {
  logPath: string;
  width: number;
  /** Filas de alto que le quedan al cuerpo de la ayuda (sin el borde). */
  filas: number;
  mini: boolean;
  cajaRef: RefObject<ScrollBoxRenderable | null>;
}) {
  const lineas = lineasQueEntran(lineasAyuda({ logPath, mini }), filas);
  // −2 borde, −2 padding, y −1 más por la barra de scroll, que el `<scrollbox>`
  // muestra sólo cuando el contenido no entra (y le come una columna al cuerpo).
  const ancho = Math.max(20, width - 4 - (lineas.length > filas ? 1 : 0));
  return (
    <box
      flexDirection="column"
      flexGrow={1}
      border
      borderColor={BORDER}
      backgroundColor={SURFACE}
      title=" ayuda "
    >
      <scrollbox
        ref={cajaRef}
        flexGrow={1}
        scrollX={false}
        backgroundColor={SURFACE}
        contentOptions={{ flexDirection: "column", paddingLeft: 1, paddingRight: 1 }}
      >
        {lineas.map((linea, i) => (
          // La lista es estática por render (no se reordena ni se filtra por
          // interacción): el índice alcanza como `key`.
          <Linea key={i} linea={linea} ancho={ancho} />
        ))}
      </scrollbox>
    </box>
  );
}
