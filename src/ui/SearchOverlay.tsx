// La búsqueda global full-text (CA-12.*, RNF-7): el overlay que reemplaza el
// cuerpo mientras el modo es `search` (§7.1) y el flujo de §6.4.
//
// Seis cosas que gobiernan este archivo:
//
//  1. **Acá NO se consulta la base.** El slice `search` es una PROYECCIÓN (D2):
//     `commands.search(texto)` deja el texto en el store y el flush resuelve
//     `buildFtsQuery` + `searchMessages` + `searchChats`. La vista sólo lee el
//     snapshot. Una consulta por tecla desde el componente sería la misma
//     consulta hecha dos veces y sin el techo de 33 ms (D3).
//  2. **El debounce vive acá** (RNF-7: ~120 ms). Es lo único que separa una
//     tecla de una consulta FTS sobre 50.000 mensajes.
//  3. **Las filas se PRESUPUESTAN, no se recortan** (§7.4.1, igual que la
//     bandeja): OpenTUI no esconde a los hijos que no entran en el alto de una
//     caja, los dibuja ENCIMADOS. Se pinta exactamente lo que entra —de ahí
//     `ventana()`, que se comparte con `ui/Inbox.tsx`— y cada fila mide
//     `height={1}` con `wrapMode="none"` y todos sus textos recortados.
//  4. **El teclado NO está acá.** El `useKeyboard` es UNO solo y vive en `App`
//     (§7.4.2); este componente expone `mover`/`abrir` por una ref imperativa,
//     igual que la conversación expone su `<scrollbox>`. Lo que `App` no maneja
//     cae en el `<input>`, que es quien escribe la query.
//  5. **`Ctrl-K` se neutraliza en el campo** (mismo gotcha que la bandeja): en
//     un `<input>` de OpenTUI está mapeado a "borrar hasta el fin de línea", y
//     acá es "subir un resultado" — sin esto cada movimiento del cursor se comía
//     media búsqueda.
//  6. **Los dos buscadores dicen lo mismo.** El de la bandeja filtra por
//     `coincideChat` y éste muestra lo que devolvió `repo.searchChats`, que
//     mira las mismas tres fuentes (nombre del chat, agenda, jid); y la etiqueta
//     de cada fila sale de `etiquetaChat`, la misma que pinta la bandeja, así el
//     mismo chat se lee igual en los dos lados.
import type { KeyBinding, MouseEvent } from "@opentui/core";
import type { RefObject } from "react";
import { useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";

import type { ChatRow, SearchHit } from "../db/types";
import { clip, fmtRelDate, highlightParts, type Part } from "../lib/fmt";
import { commands, etiquetaChat } from "../state/commands";
import { useSlice } from "../state/hooks";
import { LIMITE_HITS, type SearchSnapshot } from "../state/store";
import { DOBLE_CLICK_MS, ventana } from "./Inbox";
import { ACCENT, ACCENT2, ELEVATED, FAINT, GOLD, INPUT_FG, MUT, SELBG, TEXT, TEXT_DIM } from "./theme";

/** RNF-7: lo que se espera después de la última tecla antes de tocar el FTS. */
export const DEBOUNCE_MS = 120;

/** Teclas de la búsqueda para el pie (`App` les agrega las globales). */
export const HINTS_BUSQUEDA = "↑↓ mover · ⏎ abrir en el mensaje · Esc volver";

/** El campo se lleva una fila del panel; el resto es lista. */
export const ALTO_CAMPO = 1;

/** Columnas del glifo de cada fila, con su espacio. */
const ANCHO_GLIFO = 2;
/** Separador entre el nombre del chat y el fragmento. */
const SEP = "  ";
const MIN_NOMBRE = 6;
const MIN_FRAG = 10;
/** Arriba de esto el nombre no crece más: el fragmento es lo que se vino a leer. */
const MAX_NOMBRE = 20;

/** Igual que en la bandeja: `Ctrl-K` mueve la selección, no borra la línea. */
const SIN_CTRL_K: KeyBinding[] = [{ name: "k", ctrl: true, action: "newline" }];

// ── el modelo de la lista (puro) ────────────────────────────────────────────

/**
 * Una fila de la lista de resultados. Los títulos son filas de verdad —ocupan
 * su renglón y hay que presupuestarlas— pero no son seleccionables: `mover` los
 * saltea.
 */
export type FilaBusqueda =
  | { tipo: "titulo"; texto: string }
  | { tipo: "chat"; chat: ChatRow }
  | { tipo: "hit"; hit: SearchHit };

/**
 * Arma la lista de §6.4: primero el grupo "chats" (si hay) y después los
 * mensajes. Las dos secciones salen del mismo snapshot, así que la lista entera
 * cambia de una sola vez y nunca se ve media búsqueda vieja.
 */
export function filasBusqueda(search: SearchSnapshot): FilaBusqueda[] {
  const filas: FilaBusqueda[] = [];
  const chats = search?.chats ?? [];
  const hits = search?.hits ?? [];
  if (chats.length > 0) {
    filas.push({ tipo: "titulo", texto: chats.length === 1 ? "1 chat" : `${chats.length} chats` });
    for (const chat of chats) filas.push({ tipo: "chat", chat });
  }
  if (hits.length > 0) {
    // Con la lista llena el número miente por definición (el tope es del
    // `LIMIT`, no del historial): se dice que son los primeros.
    filas.push({
      tipo: "titulo",
      texto:
        hits.length >= LIMITE_HITS
          ? `mensajes · los ${LIMITE_HITS} más relevantes`
          : hits.length === 1
            ? "1 mensaje"
            : `${hits.length} mensajes`,
    });
    for (const hit of hits) filas.push({ tipo: "hit", hit });
  }
  return filas;
}

const seleccionable = (f: FilaBusqueda | undefined): boolean => !!f && f.tipo !== "titulo";

/** Índice de la primera fila que se puede seleccionar, o `-1` si no hay ninguna. */
export function primerSeleccionable(filas: FilaBusqueda[]): number {
  for (let i = 0; i < filas.length; i++) if (seleccionable(filas[i])) return i;
  return -1;
}

/** El índice guardado si todavía apunta a una fila seleccionable; si no, la primera. */
export function indiceVigente(filas: FilaBusqueda[], i: number): number {
  return seleccionable(filas[i]) ? i : primerSeleccionable(filas);
}

/**
 * Mueve la selección `delta` filas SELECCIONABLES, salteando los títulos y sin
 * dar la vuelta (se clava en las puntas, igual que la bandeja).
 *
 * El recorrido está acotado por el largo de la lista, así que un `delta` enorme
 * —el `Inicio`/`Fin` de `SALTO_EXTREMO`— es simplemente "hasta la punta" y no
 * un loop de nueve mil billones de vueltas.
 */
export function moverSeleccion(filas: FilaBusqueda[], actual: number, delta: number): number {
  if (!Number.isFinite(delta) || delta === 0) return actual;
  const paso = delta > 0 ? 1 : -1;
  let quedan = Math.abs(delta);
  let i = actual;
  for (let k = actual + paso; k >= 0 && k < filas.length && quedan > 0; k += paso) {
    if (!seleccionable(filas[k])) continue;
    i = k;
    quedan--;
  }
  return i;
}

/**
 * Reparte el ancho de una fila entre el nombre del chat y el fragmento. El
 * fragmento se queda con lo que sobra: es el texto que se vino a leer.
 */
export function columnasBusqueda(usable: number, anchoFecha: number): { nombre: number; frag: number } {
  const reserva = ANCHO_GLIFO + (anchoFecha > 0 ? anchoFecha + 1 : 0) + SEP.length;
  const libre = Math.max(0, Math.floor(usable) - reserva);
  if (libre < MIN_NOMBRE + MIN_FRAG) return { nombre: libre, frag: 0 };
  const nombre = Math.max(MIN_NOMBRE, Math.min(MAX_NOMBRE, Math.round(libre * 0.3)));
  return { nombre, frag: libre - nombre };
}

/** Aplasta saltos y controles SIN trimear: el espacio entre dos tramos es texto. */
const aplanar = (s: string): string => String(s ?? "").replace(/[\s\p{Cc}]+/gu, " ");

/**
 * Recorta un fragmento ya partido en tramos a `ancho` caracteres, conservando
 * cuáles son coincidencia (CA-12.2).
 *
 * Hace falta una versión propia de `clip`: el fragmento son VARIOS `<span>` y
 * recortar cada uno por su cuenta daría una fila mucho más larga que el ancho
 * disponible — que en una fila de `height={1}` es texto que se pierde detrás de
 * la fecha del vecino o, peor, una fila que se envuelve y empuja a la de abajo.
 */
export function recortarPartes(parts: Part[], ancho: number): Part[] {
  if (!Number.isFinite(ancho) || ancho <= 0) return [];
  const limpias = (parts ?? [])
    .map((p) => ({ text: aplanar(p?.text ?? ""), hit: !!p?.hit }))
    .filter((p) => p.text !== "");
  const total = limpias.reduce((n, p) => n + Array.from(p.text).length, 0);
  if (total <= ancho) return limpias;

  const tope = Math.floor(ancho) - 1; // la columna que se lleva el `…`
  const salida: Part[] = [];
  let usados = 0;
  for (const p of limpias) {
    const chars = Array.from(p.text);
    if (usados + chars.length <= tope) {
      salida.push(p);
      usados += chars.length;
      continue;
    }
    const corte = tope - usados;
    if (corte > 0) salida.push({ text: chars.slice(0, corte).join(""), hit: p.hit });
    break;
  }
  salida.push({ text: "…", hit: false });
  return salida;
}

// ── la vista ────────────────────────────────────────────────────────────────

/** Lo que `App` puede pedirle al overlay desde su `useKeyboard` (§7.4.2). */
export type ApiBusqueda = {
  /** Mueve la selección `delta` resultados. */
  mover(delta: number): void;
  /**
   * Abre lo seleccionado (CA-12.3) y sale de la búsqueda por `onAbrir`.
   * `false` = no había nada que abrir (y entonces no se sale de nada).
   */
  abrir(): boolean;
};

/** Los tramos de un texto, con las coincidencias resaltadas (CA-12.2). */
function Tramos({ parts, color }: { parts: Part[]; color: string }) {
  return (
    <>
      {parts.map((p, i) => (
        // La lista se rehace entera con cada búsqueda y no se reordena: el
        // índice alcanza como `key`.
        <span key={i} fg={p.hit ? GOLD : color}>
          {p.text}
        </span>
      ))}
    </>
  );
}

type Cols = { nombre: number; frag: number; fecha: number };

/**
 * Una fila de resultado. Chats y mensajes comparten componente a propósito: son
 * el mismo tipo de elemento en la misma posición de la lista y ⚠️ el
 * reconciliador de OpenTUI **no resetea las props que desaparecen** entre dos
 * ramas, así que dos componentes distintos con juegos de props distintos se
 * contaminarían al cambiar la query. Con una sola forma —las mismas cajas, las
 * mismas props, siempre— no hay nada que contaminar.
 */
function Fila({
  glifo,
  colorGlifo,
  nombre,
  fecha,
  frag,
  colorFrag,
  seleccionada,
  cols,
  onClick,
}: {
  glifo: string;
  colorGlifo: string;
  nombre: Part[];
  fecha: string;
  frag: Part[];
  colorFrag: string;
  seleccionada: boolean;
  cols: Cols;
  onClick: () => void;
}) {
  return (
    <box
      flexDirection="row"
      height={1}
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={seleccionada ? SELBG : undefined}
      onMouseDown={onClick}
    >
      <box width={ANCHO_GLIFO + cols.nombre} flexShrink={0}>
        <text wrapMode="none">
          <span fg={colorGlifo}>{glifo}</span>
          <Tramos parts={nombre} color={seleccionada ? TEXT : TEXT_DIM} />
        </text>
      </box>

      <box width={1 + cols.fecha} flexShrink={0}>
        <text wrapMode="none">
          <span fg={FAINT}>{fecha.padStart(1 + cols.fecha)}</span>
        </text>
      </box>

      <box flexGrow={1} flexShrink={1}>
        {cols.frag > 0 ? (
          <text wrapMode="none">
            <span fg={FAINT}>{SEP}</span>
            <Tramos parts={frag} color={colorFrag} />
          </text>
        ) : null}
      </box>
    </box>
  );
}

/** Título de sección: no es seleccionable, pero ocupa su renglón. */
function Titulo({ texto, ancho }: { texto: string; ancho: number }) {
  return (
    <box height={1} flexShrink={0} paddingLeft={1} paddingRight={1}>
      <text fg={ACCENT} wrapMode="none">
        {clip(texto, Math.max(1, ancho - 2))}
      </text>
    </box>
  );
}

/** El renglón que explica por qué no hay resultados (CA-12.4). */
function Vacio({ texto, ancho }: { texto: string; ancho: number }) {
  return (
    <box height={1} flexShrink={0} paddingLeft={1} paddingRight={1}>
      <text fg={MUT} wrapMode="none">
        {clip(texto, Math.max(1, ancho - 2))}
      </text>
    </box>
  );
}

export function SearchOverlay({
  ancho,
  alto,
  apiRef,
  onAbrir,
}: {
  /** Ancho INTERIOR del panel (sin los bordes). */
  ancho: number;
  /** Filas de alto que le quedan al overlay (sin los bordes). */
  alto: number;
  apiRef: RefObject<ApiBusqueda | null>;
  /**
   * Se abrió un resultado: hay que salir de la búsqueda. El modo vive en `App`
   * (es quien rutea el teclado), así que la salida es UNA sola y pasa por acá
   * —la mano y el mouse terminan en el mismo lugar—.
   */
  onAbrir: () => void;
}) {
  const search = useSlice("search");
  const inbox = useSlice("inbox");
  const desdeRef = useRef(0);

  /** El texto tal cual se tipea. La query que se CONSULTA va 120 ms atrás. */
  const [texto, setTexto] = useState("");
  const [sel, setSel] = useState(0);

  // RNF-7: una consulta recién cuando la mano frena. Sin esto, escribir
  // "mañana" son seis búsquedas FTS sobre todo el historial.
  useEffect(() => {
    const t = setTimeout(() => commands.search(texto), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [texto]);

  const filas = useMemo(() => filasBusqueda(search), [search]);

  // Resultados nuevos ⇒ el cursor vuelve arriba. La identidad del snapshot sólo
  // cambia en el flush que trae otra búsqueda (D3), así que esto no se dispara
  // mientras el usuario navega.
  //
  // Se ajusta durante el RENDER y no en un efecto (patrón "adjust state while
  // rendering" de React): en un efecto el cursor viejo alcanza a pintarse un
  // frame, y con la lista scrolleada ese frame es la ventana de scroll vieja —
  // se ve el salto.
  const [previo, setPrevio] = useState(search);
  const resultadosNuevos = previo !== search;
  if (resultadosNuevos) {
    setPrevio(search);
    setSel(primerSeleccionable(filas));
    // La ventana de scroll también vuelve arriba: sin esto, `ventana()` respeta
    // la posición anterior y la lista nueva arranca por el medio.
    desdeRef.current = 0;
  }

  // La pasada en la que se ajusta el estado se DESCARTA, pero `desdeRef` es una
  // ref y se escribe igual más abajo: si acá se usara el `sel` viejo, la ventana
  // de scroll quedaría movida antes de la pasada buena.
  const idx = indiceVigente(filas, resultadosNuevos ? primerSeleccionable(filas) : sel);

  // Las etiquetas de los mensajes salen del MISMO lugar que las de la bandeja:
  // `SearchHit.chatName` es `chats.name` a secas —sin la agenda—, así que un 1:1
  // agendado se leería distinto acá que en la fila de la izquierda.
  const porJid = useMemo(() => {
    const m = new Map<string, ChatRow>();
    for (const c of inbox.chats) m.set(c.jid, c);
    return m;
  }, [inbox.chats]);

  const etiquetaHit = (hit: SearchHit): string => {
    const chat = porJid.get(hit.chatJid);
    return chat
      ? etiquetaChat(chat)
      : etiquetaChat({ jid: hit.chatJid, name: hit.chatName, contactName: "", isGroup: hit.isGroup });
  };

  const abrirFila = (i: number): boolean => {
    const fila = filas[i];
    if (!fila || fila.tipo === "titulo") return false;
    if (fila.tipo === "chat") commands.openChat(fila.chat.jid);
    // CA-12.3: el chat se abre POSICIONADO en el mensaje encontrado; la ventana
    // la resuelve `messagesAround` y la marca visual la pone la conversación.
    else commands.openChat(fila.hit.chatJid, { anchorId: fila.hit.messageId });
    onAbrir();
    return true;
  };

  /** Último click, para el doble click que abre (mismo trato que la bandeja, CA-5.6). */
  const ultimoClick = useRef<{ i: number; at: number }>({ i: -1, at: 0 });
  const clickEnFila = (i: number): void => {
    const at = Date.now();
    const previo = ultimoClick.current;
    if (previo.i === i && at - previo.at < DOBLE_CLICK_MS) {
      ultimoClick.current = { i, at: 0 }; // corta la cadena: un tercer click no reabre
      abrirFila(i);
      return;
    }
    ultimoClick.current = { i, at };
    setSel(i);
  };

  // CA-5.7: la rueda mueve la SELECCIÓN, igual que sobre la bandeja.
  const rueda = (e: MouseEvent): void => {
    const dir = e.scroll?.direction === "up" ? -1 : 1;
    const pasos = Math.max(1, Math.min(5, Math.round(e.scroll?.delta ?? 1)));
    setSel((s) => moverSeleccion(filas, indiceVigente(filas, s), dir * pasos));
  };

  useImperativeHandle(
    apiRef,
    () => ({
      mover(delta: number) {
        setSel((s) => moverSeleccion(filas, indiceVigente(filas, s), delta));
      },
      abrir() {
        return abrirFila(idx);
      },
    }),
    [filas, idx],
  );

  const filasLista = Math.max(0, alto - ALTO_CAMPO);
  let desde = ventana(filas.length, Math.max(0, idx), filasLista, desdeRef.current);
  // El título de sección que está JUSTO arriba de la selección no puede quedar
  // cortado: es lo que dice si la fila es un chat o un mensaje. Subir el borde
  // una fila no puede empujar la selección fuera de la ventana (la corre para el
  // mismo lado).
  if (desde > 0 && desde === idx && filas[idx - 1]?.tipo === "titulo") desde -= 1;
  desdeRef.current = desde;
  const enPantalla = filas.slice(desde, desde + filasLista);

  const ahoraSeg = Date.now() / 1000;
  const fechaDe = (ts: number): string => fmtRelDate(ts, ahoraSeg);
  const anchoFecha = enPantalla.reduce((m, f) => {
    if (f.tipo === "titulo") return m;
    const ts = f.tipo === "chat" ? f.chat.lastMessageAt : f.hit.ts;
    return Math.max(m, fechaDe(ts).length);
  }, 0);
  const usable = Math.max(0, ancho - 2); // paddingLeft + paddingRight de la fila
  const cols: Cols = { ...columnasBusqueda(usable, anchoFecha), fecha: anchoFecha };

  // CA-12.4: sin resultados se dice EXPLÍCITAMENTE que no hubo coincidencias, y
  // no se deja la lista anterior (el snapshot ya vino vacío). Mientras el
  // debounce no venció, lo que se ve sigue siendo la búsqueda anterior: por eso
  // el aviso mira `search.query` —la que de verdad se consultó— y no el texto
  // que se está tipeando.
  const vacio =
    search.query !== ""
      ? "sin coincidencias"
      : texto !== ""
        ? "buscando…"
        : "escribí para buscar en todos los mensajes guardados";

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      border
      borderColor={ACCENT2}
      backgroundColor={ELEVATED}
      title=" buscar en todo el historial "
    >
      <box
        height={ALTO_CAMPO}
        flexShrink={0}
        flexDirection="row"
        backgroundColor={ELEVATED}
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={texto ? ACCENT : MUT} wrapMode="none">
          {"⌕ "}
        </text>
        <box flexGrow={1} flexShrink={1}>
          {/* Recién montado: el `<input>` toma el foco al crearse, y al cerrarse
              el overlay se desmonta entero y el buscador de la bandeja —que
              también se remonta— lo recupera. */}
          <input
            focused
            placeholder="mensajes y chats…"
            keyBindings={SIN_CTRL_K}
            backgroundColor={ELEVATED}
            focusedBackgroundColor={ELEVATED}
            textColor={INPUT_FG}
            focusedTextColor={INPUT_FG}
            placeholderColor={MUT}
            onInput={(valor: string) => setTexto(valor)}
          />
        </box>
      </box>

      <box flexDirection="column" flexGrow={1} onMouseScroll={rueda}>
        {enPantalla.length === 0 ? (
          <Vacio texto={vacio} ancho={ancho} />
        ) : (
          enPantalla.map((f, i) => {
            const posicion = desde + i;
            if (f.tipo === "titulo") {
              return <Titulo key={`t${posicion}:${f.texto}`} texto={f.texto} ancho={ancho} />;
            }
            if (f.tipo === "chat") {
              const nombre = etiquetaChat(f.chat);
              return (
                <Fila
                  key={`c:${f.chat.jid}`}
                  glifo={f.chat.isGroup ? "▣ " : "▪ "}
                  colorGlifo={f.chat.isGroup ? ACCENT2 : FAINT}
                  // El chat matcheó POR EL NOMBRE: el resaltado va ahí (acá no
                  // hay `snippet()` de FTS5 que lo haga por nosotros).
                  nombre={recortarPartes(highlightParts(nombre, search.query), cols.nombre)}
                  fecha={fechaDe(f.chat.lastMessageAt)}
                  frag={recortarPartes([{ text: f.chat.lastPreview, hit: false }], cols.frag)}
                  colorFrag={MUT}
                  seleccionada={posicion === idx}
                  cols={cols}
                  onClick={() => clickEnFila(posicion)}
                />
              );
            }
            return (
              <Fila
                key={`m:${f.hit.messageId}`}
                glifo={f.hit.fromMe ? "› " : "‹ "}
                colorGlifo={f.hit.fromMe ? ACCENT : ACCENT2}
                nombre={[{ text: clip(etiquetaHit(f.hit), cols.nombre), hit: false }]}
                fecha={fechaDe(f.hit.ts)}
                // El fragmento ya viene partido por `snippet()` (CA-12.2).
                frag={recortarPartes(f.hit.parts, cols.frag)}
                colorFrag={TEXT_DIM}
                seleccionada={posicion === idx}
                cols={cols}
                onClick={() => clickEnFila(posicion)}
              />
            );
          })
        )}
      </box>
    </box>
  );
}
