// La raíz de la interfaz: modos, teclado global, layout y ruteo de pantallas
// (design §7.1). Todo lo que se ve cuelga de acá.
//
// Tres reglas que se heredan del prior art (`miscosas/tui`) y del §7.4:
//
//  1. **Un solo `useKeyboard`**, que rutea por `modo`. Varios handlers repartidos
//     por el árbol terminan peleándose la misma tecla.
//  2. **Las combinaciones con `Shift` se evalúan ANTES que las teclas peladas**
//     (§7.3) y **ningún `Ctrl-<letra>` scrollea**: el `<input>` del buscador
//     (tarea 12) también recibe la tecla — a `Ctrl-U` le borra la línea.
//  3. **El estado de la máquina se lee por `useSlice`**, nunca de la base: el
//     snapshot está cacheado y sólo cambia de identidad en el flush coalescido
//     (D3), que es lo que le pone techo a los renders (RNF-5).
//
import type { KeyEvent, ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useRef, useState } from "react";

import { clip } from "../lib/fmt";
import { commands, etiquetaChat, SALTO_EXTREMO } from "../state/commands";
import { useSlice } from "../state/hooks";
import { store } from "../state/store";
import { Composer, HINTS_COMPOSER } from "./Composer";
import { Conversation, HINTS_CONVO } from "./Conversation";
import { ALTO_FOOTER, Footer } from "./Footer";
import { ALTO_HEADER, Header } from "./Header";
import { ayudaScrollea, Help } from "./Help";
import { HINTS_BANDEJA, Inbox } from "./Inbox";
import { CANDADO_INICIAL, conDigito, type EstadoCandado, LockCode, siguientePaso, sinUltimo } from "./LockCode";
import { Login, metodoDe } from "./Login";
import { type ApiBusqueda, HINTS_BUSQUEDA, SearchOverlay } from "./SearchOverlay";
import { Splash } from "./Splash";
import { MIN_COLS, MIN_ROWS, TooSmall } from "./TooSmall";
import { BG, BORDER, ELEVATED, SURFACE, WARN } from "./theme";

/**
 * `compose` es "el foco lo tiene el campo de redacción" (CA-8.1). Es un modo y no
 * un `useState` adentro del composer porque el `useKeyboard` es UNO solo (§7.4):
 * con el campo enfocado, las teclas las reciben LOS DOS —el handler global y el
 * `<textarea>`—, así que el handler global tiene que saber que no le tocan a él.
 * Sin esto, cada flecha escrita en el campo movería también el cursor de la
 * bandeja.
 *
 * `search` es la búsqueda global (CA-12.1): tapa el cuerpo entero, se lleva el
 * foco del teclado y ni la bandeja ni la conversación se pintan mientras dura.
 *
 * `candado` es la pantalla de `Ctrl-P` (fijar el código de los chats con
 * candado). Tapa el cuerpo igual que la ayuda y **se come todas las teclas**: los
 * dígitos son el código y no pueden llegar a ningún otro lado.
 */
type Modo = "browse" | "help" | "compose" | "search" | "candado";
/** Un panel por vez cuando la terminal es angosta (§7.2). */
type PanelMini = "inbox" | "convo";
type Disposicion = "wide" | "compact" | "mini";

/** CA-19.2: la animación de arranque dura esto y se saltea con cualquier tecla. */
const DURACION_SPLASH_MS = 1_500;
/** Cuadro del splash: 25 fps alcanzan y sobran para una barra de carga. */
const PASO_SPLASH_MS = 40;
/** Ancho fijo de la bandeja en `compact` (§7.2): a 80 columnas deja 44 al chat. */
const ANCHO_BANDEJA_COMPACT = 34;
/** Proporción de la bandeja en `wide` (§7.2). */
const RATIO_BANDEJA_WIDE = 0.4;

/** Los tres modos de §7.2. Abajo de `MIN_COLS` no llega: eso es `<TooSmall/>`. */
function disposicionDe(ancho: number): Disposicion {
  if (ancho >= 100) return "wide";
  if (ancho >= 72) return "compact";
  return "mini";
}

/** Las teclas que scrollean la conversación (CA-6.5). Ninguna es `Ctrl-<letra>` (CA-6.6). */
const TECLAS_SCROLL = new Set(["up", "down", "pageup", "pagedown", "home", "end"]);

/**
 * Aplica al panel de conversación una de las teclas de arriba. Devuelve `false`
 * si no había caja (ningún chat abierto), para que el llamador decida.
 *
 * El scroll se le pide al `<scrollbox>`, que es el dueño de su posición (V7): no
 * hay ningún `scrollTop` calculado a mano en toda la aplicación.
 */
function scrollConvo(caja: ScrollBoxRenderable | null, tecla: string, media: number): boolean {
  if (!caja) return false;
  switch (tecla) {
    case "up":
      caja.scrollBy(-1);
      return true;
    case "down":
      caja.scrollBy(1);
      return true;
    case "pageup":
      caja.scrollBy(-media);
      return true;
    case "pagedown":
      caja.scrollBy(media);
      return true;
    case "home":
      caja.scrollTo(0);
      return true;
    case "end":
      caja.scrollTo(Math.max(0, caja.scrollHeight - caja.viewport.height));
      return true;
    default:
      return false;
  }
}

export function App({
  noSplash,
  logPath,
  // `--qr-png`: la ruta donde el entry va escribiendo cada QR como imagen, o
  // `null` sin el flag. Viaja como prop —igual que `logPath`— y no por el store
  // porque no es estado de la máquina: es una decisión de arranque que no
  // cambia en toda la corrida. La pantalla de vinculación la MUESTRA, para que
  // el usuario sepa qué archivo abrir.
  qrPngPath = null,
}: {
  noSplash: boolean;
  logPath: string;
  qrPngPath?: string | null;
}) {
  const { width, height } = useTerminalDimensions();
  const conn = useSlice("conn");
  const link = useSlice("link");
  const inbox = useSlice("inbox");
  const convo = useSlice("convo");
  const ui = useSlice("ui");

  const [modo, setModo] = useState<Modo>("browse");
  // El código a medio tipear de la pantalla del candado. Vive acá y no adentro
  // de `<LockCode/>` porque el `useKeyboard` es UNO solo (§7.4): las teclas las
  // recibe este handler y el panel es una vista. Es memoria y nada más: no se
  // guarda, no se loguea y se borra al salir de la pantalla (efecto de abajo).
  //
  // ⚠️ Va DUPLICADO en una ref, que es la que lee el teclado. Es el mismo motivo
  // por el que los comandos leen el store en vivo (D3): varias teclas dentro del
  // mismo render ven todas el MISMO `candado` de la closure y las últimas se
  // pierden — medido, tipear `8264` dejaba un solo dígito. La ref es el valor de
  // ahora; el `useState` es sólo para que se vuelva a pintar.
  const candadoRef = useRef<EstadoCandado>(CANDADO_INICIAL);
  const [candado, pintarCandado] = useState<EstadoCandado>(CANDADO_INICIAL);
  const setCandado = (e: EstadoCandado): void => {
    candadoRef.current = e;
    pintarCandado(e);
  };
  const [panelMini, setPanelMini] = useState<PanelMini>("inbox");
  const [splash, setSplash] = useState(!noSplash);
  const [avance, setAvance] = useState(0);
  // El cuerpo de la ayuda se scrollea desde acá: el `useKeyboard` es uno solo
  // (§7.4) y el `<scrollbox>` no tiene el foco, así que se lo mueve por la ref.
  const ayudaRef = useRef<ScrollBoxRenderable | null>(null);
  // Misma historia con la conversación: el `<scrollbox>` no tiene el foco (lo
  // tiene el buscador de la bandeja, CA-5.1), así que las teclas de scroll salen
  // de acá y llegan por la ref.
  const convoRef = useRef<ScrollBoxRenderable | null>(null);
  // Misma historia con la búsqueda global: el teclado es UNO solo y vive acá, así
  // que mover la selección y abrir un resultado se le piden al overlay por esta
  // ref (§7.4.2). Lo que no se maneja acá cae en su `<input>`.
  const busquedaRef = useRef<ApiBusqueda | null>(null);

  const disposicion = disposicionDe(width);

  // ── medidas del layout ────────────────────────────────────────────────────
  // Se calculan ACÁ ARRIBA, antes del `useKeyboard`, porque el teclado también
  // las necesita: `PgUp`/`PgDn` saltan una pantalla de la bandeja y las teclas
  // de la bandeja sólo tienen sentido si la bandeja está a la vista. Todo se
  // recalcula en cada render: no hay nada cacheado que se desincronice al
  // redimensionar (CA-19.4).
  const banner = ui.connBanner;
  const altoCuerpo = Math.max(1, height - ALTO_HEADER - ALTO_FOOTER - (banner ? 1 : 0));
  /** −2 por los bordes del panel. */
  const filasVisibles = Math.max(0, altoCuerpo - 2);
  const anchoBandeja =
    disposicion === "wide" ? Math.floor(width * RATIO_BANDEJA_WIDE) : ANCHO_BANDEJA_COMPACT;
  const verBandeja = disposicion !== "mini" || panelMini === "inbox";
  const verConvo = disposicion !== "mini" || panelMini === "convo";
  /** Ancho INTERIOR del panel de la bandeja (sin los bordes). */
  const anchoInterior = (disposicion === "mini" ? width : anchoBandeja) - 2;
  /** Ancho INTERIOR del panel de conversación: lo que sobra, sin los bordes. */
  const anchoConvo = (disposicion === "mini" ? width : width - anchoBandeja) - 2;

  /** El chat abierto, para el título del panel y para el pie. */
  const chatAbierto =
    convo.jid === null ? null : (inbox.chats.find((c) => c.jid === convo.jid) ?? null);

  /**
   * CA-1.1: sin sesión vinculada la pantalla es `<Login/>`, no la bandeja. Vale
   * también para `checking` —la fase de arranque, hasta que el socket dice si
   * las creds sirven—: mostrar la bandeja ahí sería prometerle chats a alguien
   * que todavía no vinculó nada.
   */
  const enLogin = link.phase !== "linked";

  // Línea de tiempo del splash (CA-19.2). Se apaga solo al llegar a 1.
  useEffect(() => {
    if (!splash) return;
    const t0 = Date.now();
    const id = setInterval(() => {
      const p = Math.min(1, (Date.now() - t0) / DURACION_SPLASH_MS);
      setAvance(p);
      if (p >= 1) {
        clearInterval(id);
        setSplash(false);
      }
    }, PASO_SPLASH_MS);
    return () => clearInterval(id);
  }, [splash]);

  // `ui.connBanner` — SEMÁNTICA (el diseño la dejaba sin definir): es la línea
  // persistente que explica POR QUÉ la conexión no está abierta. La escribe la
  // interfaz espejando `link.reason` y se limpia sola cuando la conexión abre.
  //
  // Sin esto, los cierres que frenan en seco quedan mudos: con un 440 (te
  // desalojó otra sesión de WhatsApp Web) o un 403, `link.phase` sigue en
  // `linked` y el único rastro del motivo es `link.reason` — el usuario vería
  // "sin conexión" para siempre sin enterarse de que la salida es `Ctrl-R`.
  //
  // No hay loop posible: el efecto depende de dos strings que este `setBanner`
  // no toca. Igual se compara antes de escribir — `setBanner` marca el slice `ui`
  // sucio aunque el texto sea el mismo, y eso es un flush (y un render de todo el
  // árbol) regalado en cada montaje y en cada cambio de conexión (RNF-5).
  // `ui.connBanner` se LEE acá pero NO va en las dependencias, a propósito: el
  // efecto tiene que correr cuando cambia la conexión, no cuando cambia el
  // banner que él mismo escribe.
  useEffect(() => {
    const nuevo = conn.state === "open" ? null : link.reason;
    if (nuevo !== ui.connBanner) store.setBanner(nuevo);
  }, [conn.state, link.reason]);

  // El campo de redacción sólo existe con un chat A LA VISTA: si el chat se
  // cierra —o si un `resize` deja la conversación fuera de pantalla en `mini`—,
  // el `<textarea>` se desmonta y el foco se va con él. Quedarse en `compose`
  // dejaría las teclas cayendo en un campo que ya no está.
  useEffect(() => {
    if (modo === "compose" && (convo.jid === null || !verConvo)) setModo("browse");
  }, [modo, convo.jid, verConvo]);

  // La vinculación se lleva la pantalla entera: si la ayuda quedó abierta cuando
  // WhatsApp desvinculó la sesión, dejarla "abierta abajo" haría que reaparezca
  // sola al volver a vincular, sin que nadie la haya pedido.
  useEffect(() => {
    if (enLogin) setModo("browse");
  }, [enLogin]);

  // El `?` que abre la ayuda NO es una búsqueda. La tecla la reciben LOS DOS —el
  // handler global y el `<input>` enfocado, que la inserta como cualquier
  // carácter— y no hay forma de que uno se la saque al otro. Como la ayuda sólo
  // se abre con el buscador VACÍO, al entrar el buscador tiene que quedar vacío:
  // no se pierde nada y el `?` fantasma no queda filtrando al volver.
  //
  // Va en un efecto y no en el handler porque el orden entre los dos receptores
  // de la tecla no está garantizado; el efecto corre después de los dos.
  useEffect(() => {
    if (modo === "help") commands.setInboxQuery("");
  }, [modo]);

  // Salir de la pantalla del candado borra lo tipeado (de la ref y del estado).
  // `CANDADO_INICIAL` es una constante del módulo, así que volver a setearla
  // cuando ya estaba no re-renderiza nada (React compara por identidad).
  useEffect(() => {
    if (modo !== "candado") setCandado(CANDADO_INICIAL);
  }, [modo]);

  /**
   * La ÚNICA salida de la búsqueda global. `restaurar` es el `Esc` de CA-12.8
   * —la bandeja vuelve como estaba—; sin él se abrió un resultado y la bandeja
   * se queda donde la dejó el salto (CA-12.3). En `mini` hay un panel por vez,
   * así que abrir un resultado también trae la conversación a la vista.
   */
  const salirDeBusqueda = (restaurar: boolean): void => {
    commands.closeSearch(restaurar);
    setModo("browse");
    if (!restaurar && disposicion === "mini") setPanelMini("convo");
  };

  useKeyboard((key: KeyEvent) => {
    const n = key?.name ?? "";
    const seq = key?.sequence ?? "";
    const es = (x: string) => n === x || seq === x;
    const enter = es("return") || es("enter");

    // Salida ordenada, en cualquier modo y antes que nada (CA-17.1), INCLUIDO el
    // splash: que salir dependa de que la animación haya terminado convierte al
    // primer `Ctrl-C` en un "saltear splash". El renderer va con
    // `exitOnCtrlC:false`, así que sin esta rama no habría cómo salir.
    if (key.ctrl && (es("c") || es("q"))) {
      commands.quit();
      return;
    }

    // Cualquier OTRA tecla saltea el splash y NO se propaga: la primera tecla es
    // para entrar, no para ejecutar un comando a ciegas (CA-19.2).
    if (splash) {
      setSplash(false);
      return;
    }

    // `Ctrl-R` funciona en todos los modos —la ayuda lo anuncia como global
    // (CA-15.5)—, así que va ANTES de la rama que se traga las teclas.
    if (key.ctrl && es("r")) {
      // CA-2.5: con el código de emparejamiento A LA VISTA, la misma tecla pide
      // OTRO código. Reconectar ahí sería tirar abajo el socket que está
      // esperando justamente ese código.
      //
      // Lo que decide es el método que se está VIENDO —lo mismo que anuncia el
      // pie (`Login.tsx`)—, no que exista un `pairingCode` guardado. Mirando
      // sólo eso, una vez pedido un código `Ctrl-R` no podía volver a
      // reconectar en toda la vinculación, ni siquiera con el QR en pantalla y
      // el motivo del 440 pidiéndolo; y el pedido arrastraba al usuario de
      // vuelta al código (`requestPairing` fuerza `method:"code"`), el mismo
      // tirón que arregló la tarea 8b, ahora disparado por una tecla.
      if (enLogin && link.pairingCode && metodoDe(link, width, height) === "code") {
        commands.requestPairing();
      } else commands.reconnectNow();
      return;
    }

    // Volver a pedirle a WhatsApp los nombres de la agenda (`wa/appstate.ts`): es
    // la salida manual de una colección de app-state estacionada, y sin ella la
    // bandeja se queda con números para siempre sin que el usuario pueda hacer
    // nada. Va acá arriba, con `Ctrl-R`, por dos motivos: la ayuda la anuncia en
    // la sección GLOBAL —al lado de `^R`, en el mismo renglón— y el lugar más
    // probable donde alguien la va a probar es justamente leyendo la ayuda, que
    // más abajo se traga todas las teclas.
    //
    // Que sea global no la vuelve peligrosa: manda stanzas, pero `resyncContacts`
    // corta sin conexión y `appstate.force` tiene su propio espaciado
    // (`ESPERA_MANUAL_MS`), así que un `^N` de más no le pregunta nada a WhatsApp.
    // Y no le come nada a ningún campo de texto: el `<input>` y el `<textarea>` de
    // OpenTUI no tienen bindings con `ctrl` (§7.3, el mismo chequeo de `^L`/`^G`).
    if (key.ctrl && es("n")) {
      commands.resyncContacts();
      return;
    }

    // ── login ───────────────────────────────────────────────────────────────
    // Va ANTES que el resto: mientras no haya sesión, la pantalla es la
    // vinculación y las teclas de la bandeja no tienen a qué aplicarse. El
    // `return` es importante: lo que no se maneja acá es para el input del
    // teléfono, que recibe las mismas teclas por su cuenta (§7.4.2).
    if (enLogin) {
      if (es("tab")) {
        // CA-2.6: alternar contra lo que se está VIENDO, que no siempre es
        // `link.method` (mientras nadie eligió a mano, el método lo decide el
        // tamaño de la terminal).
        commands.chooseLinkMethod(metodoDe(link, width, height) === "qr" ? "code" : "qr");
        return;
      }
      // `Esc` con el código a la vista ⇒ volver al input del teléfono. WhatsApp
      // devuelve un código para CUALQUIER número bien formado (no valida que sea
      // tuyo), así que un dígito de más deja al usuario esperando un código que
      // su teléfono nunca le va a pedir, y `Ctrl-R` sólo pide otro para el MISMO
      // número: sin esta salida, corregirlo era `Ctrl-C` y arrancar de nuevo.
      //
      // Va derecho al store y no por `commands` porque no hay nada de la máquina
      // que avisar: es la misma pantalla un paso atrás, el socket sigue como
      // estaba (D11). El método no se toca: se sigue viendo el código, ahora con
      // el input.
      if (es("escape") && link.pairingCode && metodoDe(link, width, height) === "code") {
        store.setLink({ phase: "pairing-phone", pairingCode: null, pairingRequestedAt: null });
      }
      return;
    }

    // ── compose ─────────────────────────────────────────────────────────────
    // Con el campo enfocado el handler global no maneja NADA salvo la salida:
    // todo lo demás es texto y lo resuelve el `<textarea>` (incluidas `⏎`,
    // `Alt-⏎` y las flechas, que ahí mueven el cursor). El `return` es la parte
    // importante: sin él, escribir en el campo también navegaría la bandeja.
    if (modo === "compose") {
      // CA-8.5: `Esc` devuelve el foco a la bandeja CONSERVANDO el borrador. No
      // hay que hacer nada para conservarlo: cada tecla ya lo dejó guardado en
      // el store (`onContentChange`), y el campo ni siquiera se desmonta.
      if (es("escape")) setModo("browse");
      return;
    }

    // ── candado: fijar el código (`Ctrl-P`) ─────────────────────────────────
    // Se traga TODAS las teclas: acá los dígitos son el código y no pueden caer
    // en el buscador de la bandeja (que además está desmontado, como con la
    // ayuda). No hay `<input>`: lo tipeado se acumula en `candado.digitos` y en
    // pantalla se ven `•`, así que el código no queda a la vista de nadie.
    if (modo === "candado") {
      if (es("escape")) {
        setModo("browse");
        return;
      }
      // La ref y no el `useState`: varias teclas pueden caer en el mismo render.
      const actual = candadoRef.current;
      if (enter) {
        if (actual.fase === "listo") {
          setModo("browse");
          return;
        }
        const paso = siguientePaso(actual);
        if (paso.guardar === undefined) {
          setCandado(paso.estado);
          return;
        }
        // El único punto donde el código sale de la memoria: `setLockCode` lo
        // deriva con scrypt y guarda sal + hash (nunca los dígitos).
        const r = commands.setLockCode(paso.guardar);
        setCandado(r.ok ? { ...CANDADO_INICIAL, fase: "listo" } : { ...CANDADO_INICIAL, motivo: r.reason });
        return;
      }
      if (es("backspace")) {
        setCandado(sinUltimo(actual));
        return;
      }
      // `sequence` y no `name`: es el carácter que se tipeó.
      if (/^[0-9]$/.test(seq)) setCandado(conDigito(actual, seq));
      return;
    }

    // ── búsqueda global (CA-12.*) ───────────────────────────────────────────
    // Sólo las teclas de NAVEGACIÓN: el texto lo escribe el `<input>` del
    // overlay, que recibe todo lo que no se maneje acá (incluido el `?`, que
    // adentro de una búsqueda es un carácter más y no la ayuda).
    if (modo === "search") {
      // CA-12.8: vuelve a la bandeja con el mismo chat seleccionado y el mismo
      // filtro que tenía antes de abrir la búsqueda.
      if (es("escape")) {
        salirDeBusqueda(true);
        return;
      }
      // CA-12.3: abre el chat posicionado en el mensaje encontrado. Si no había
      // nada que abrir (lista vacía), la tecla no hace nada y no se sale.
      if (enter) {
        busquedaRef.current?.abrir();
        return;
      }
      const paginaHits = Math.max(1, filasVisibles - 2);
      if (es("up") || (key.ctrl && es("k"))) busquedaRef.current?.mover(-1);
      else if (es("down") || (key.ctrl && es("j")) || es("linefeed")) busquedaRef.current?.mover(1);
      else if (es("pageup")) busquedaRef.current?.mover(-paginaHits);
      else if (es("pagedown")) busquedaRef.current?.mover(paginaHits);
      else if (es("home")) busquedaRef.current?.mover(-SALTO_EXTREMO);
      else if (es("end")) busquedaRef.current?.mover(SALTO_EXTREMO);
      return;
    }

    if (modo === "help") {
      // La ayuda se traga el resto de las teclas; `Esc` y `?` la cierran (CA-19.3).
      if (es("escape") || es("?")) {
        setModo("browse");
        return;
      }
      // Desplazar el cuerpo: sólo hace falta cuando la ayuda no entra entera
      // (terminal muy baja), pero las teclas están siempre.
      if (es("up")) ayudaRef.current?.scrollBy(-1);
      else if (es("down")) ayudaRef.current?.scrollBy(1);
      else if (es("pageup")) ayudaRef.current?.scrollBy(-1, "viewport");
      else if (es("pagedown")) ayudaRef.current?.scrollBy(1, "viewport");
      return;
    }

    // ── browse ──────────────────────────────────────────────────────────────
    // ACÁ ARRIBA van las combinaciones con `Shift` (§7.3): `Shift-↑/↓` línea a
    // línea, `Shift-PgUp/PgDn` media página y `Shift-Inicio/Fin` a las puntas
    // (CA-6.5). Tienen que quedar ANTES de las teclas peladas, o el `↑` pelado de
    // la bandeja se las come.
    //
    // La tecla se consume SIEMPRE que venga con `Shift`, haya o no chat abierto:
    // si se dejara pasar, un `Shift-↑` sin conversación movería la selección de
    // la bandeja, que es exactamente lo que el usuario NO pidió.
    const media = Math.max(1, Math.floor(filasVisibles / 2));
    if (key.shift && TECLAS_SCROLL.has(n)) {
      scrollConvo(convoRef.current, n, media);
      return;
    }

    // CA-8.1: la tecla que enfoca el campo de redacción, distinta de la del
    // buscador (que está siempre enfocado y no necesita ninguna). En `mini` no
    // hay campo hasta entrar al chat, así que la misma tecla hace las dos cosas.
    if (key.ctrl && es("e")) {
      if (!convo.jid) return;
      if (disposicion === "mini") setPanelMini("convo");
      setModo("compose");
      return;
    }

    // CA-9.3: reintentar el último envío fallado del chat abierto. El comando
    // resuelve CUÁL era: la vista no tiene por qué salir a buscarlo.
    if (key.ctrl && es("y")) {
      commands.retrySend();
      return;
    }

    // CA-11.5: marcar leído el chat seleccionado SIN abrirlo. Es un
    // `Ctrl-<letra>` y el buscador de la bandeja está enfocado, pero no hay
    // choque: `Ctrl-L` no está en las teclas del `<input>` de OpenTUI y su
    // `handleKeyPress` devuelve `false` para cualquier combinación con `ctrl`
    // que no tenga binding (verificado en el fuente, `index.js:5198`).
    if (key.ctrl && es("l")) {
      commands.markSelectedRead();
      return;
    }

    // CA-12.1: la búsqueda global. Es un `Ctrl-<letra>` con el buscador de la
    // bandeja enfocado, pero `Ctrl-G` no está entre las teclas de edición del
    // `<input>` de OpenTUI (§7.3), así que no le come nada al texto.
    if (key.ctrl && es("g")) {
      // El estado de la bandeja se guarda ACÁ, antes de cambiar de modo, para
      // poder devolverlo con `Esc` (CA-12.8).
      commands.openSearch();
      setModo("search");
      return;
    }

    // CA nueva (candado): fijar el código que revela los chats con candado. Es
    // un `Ctrl-<letra>` con el buscador de la bandeja enfocado y no le come nada
    // al texto: `Ctrl-P` no está entre las teclas de edición del `<input>` de
    // OpenTUI (verificado en el fuente: sus bindings con `ctrl` son
    // a/e/f/b/w/k/u/d y `-`/`.`).
    if (key.ctrl && es("p")) {
      setModo("candado");
      return;
    }

    // Esconder a mano el chat seleccionado (o devolverlo, con el candado
    // revelado). Va acá abajo, con las teclas de la bandeja y NO arriba con las
    // globales: opera sobre la selección, así que en la ayuda, en la búsqueda o
    // fijando el código no tiene a qué aplicarse.
    //
    // POR QUÉ `^X`: de las teclas que quedaban libres es la única que no choca
    // con nada. `^H`/`^I`/`^M` son los mismos bytes que Backspace/Tab/⏎ en una
    // terminal legacy, `^S`/`^Q` son el control de flujo XON/XOFF de la tty y
    // `^Z` suspende el proceso. `^X` no está entre las teclas de edición del
    // `<input>` de OpenTUI (sus bindings con `ctrl` son a/e/f/b/w/k/u/d, las
    // flechas, `-` y `.`; verificado en el fuente), así que el buscador de la
    // bandeja —que está enfocado— no pierde ni un carácter. Y no esconde nada
    // sola: la primera pulsación PREGUNTA (ver `toggleSelectedHidden`).
    if (key.ctrl && es("x")) {
      commands.toggleSelectedHidden();
      return;
    }

    // El buscador se lee EN VIVO y no del snapshot: éste está cacheado hasta el
    // próximo flush (D3), así que un `?` apretado dentro de los 33 ms de haber
    // tipeado vería el campo vacío y abriría la ayuda en vez de escribirse.
    const busqueda = store.inboxUi().inboxQuery;

    // `?` abre la ayuda SÓLO con el buscador vacío (§7.3): con texto tipeado es
    // un carácter más y lo tiene que recibir el campo, que también escucha esta
    // misma tecla por su cuenta.
    if (es("?") && (!verBandeja || busqueda === "")) {
      setModo("help");
      return;
    }

    // `Esc` tiene cuatro significados y el orden importa: primero volver de panel
    // en `mini` (§7.2), después esconder de nuevo los chats con candado, y por
    // último limpiar el buscador (CA-5.4). Sin nada de eso no hace nada — cerrar
    // la aplicación con `Esc` sería un accidente esperando.
    //
    // El candado va ANTES del buscador porque al revelar el campo quedó vacío (es
    // lo que esconde el código de la pantalla): mirando sólo el texto, `Esc` no
    // habría tenido forma de volver a esconderlos.
    if (es("escape")) {
      if (disposicion === "mini" && panelMini === "convo") {
        setPanelMini("inbox");
        return;
      }
      // EN VIVO y no del snapshot (D3): el revelado llega por un camino
      // asincrónico (la derivación scrypt) y el snapshot puede estar atrasado.
      if (store.lockedRevealed()) {
        commands.hideLocked();
        return;
      }
      if (busqueda !== "") commands.setInboxQuery("");
      return;
    }

    // De acá para abajo, las teclas de la bandeja. En `mini` con la conversación
    // a la vista no hay lista que navegar, así que ahí las flechas PELADAS
    // scrollean el chat: es el único panel en pantalla y pedirle `Shift` al
    // usuario cuando no hay ambigüedad sería gratuito.
    if (!verBandeja) {
      scrollConvo(convoRef.current, n, media);
      return;
    }

    if (enter) {
      commands.openSelectedChat();
      // `mini`: un panel por vez, `⏎` entra a la conversación (§7.2).
      if (disposicion === "mini") setPanelMini("convo");
      return;
    }

    // CA-5.5: `Tab` cicla Todos → No leídos → Grupos.
    if (es("tab")) {
      commands.cycleInboxFilter();
      return;
    }

    // CA-5.3. `Ctrl-K`/`Ctrl-J` necesitan el protocolo de teclado kitty para
    // llegar distinguibles; sin él, `Ctrl-J` es el mismo byte que un salto de
    // línea y aparece como `linefeed` (medido). Las flechas son el camino
    // portable y funcionan siempre.
    const pagina = Math.max(1, filasVisibles - 1);
    if (es("up") || (key.ctrl && es("k"))) commands.moveSelection(-1);
    else if (es("down") || (key.ctrl && es("j")) || es("linefeed")) commands.moveSelection(1);
    else if (es("pageup")) commands.moveSelection(-pagina);
    else if (es("pagedown")) commands.moveSelection(pagina);
    else if (es("home")) commands.moveSelection(-SALTO_EXTREMO);
    else if (es("end")) commands.moveSelection(SALTO_EXTREMO);
  });

  // ── render ────────────────────────────────────────────────────────────────

  if (splash) return <Splash t={avance} width={width} />;
  // RNF-2: render condicional, no estado ⇒ agrandar la terminal lo deshace solo.
  if (width < MIN_COLS || height < MIN_ROWS) return <TooSmall width={width} height={height} />;
  // CA-1.1: la vinculación va DESPUÉS de `<TooSmall/>` —abajo de 60×15 no se
  // dibuja ni el panel de "el QR no entra"— y ANTES de todo lo demás.
  if (enLogin) return <Login width={width} height={height} qrPngPath={qrPngPath} />;

  // El `↑↓` sólo se anuncia si la ayuda de verdad no entra entera (terminal muy
  // baja): un hint que promete una tecla que no hace nada es ruido.
  const scrollAyuda =
    modo === "help" &&
    ayudaScrollea({ logPath, mini: disposicion === "mini", filas: filasVisibles });

  // El pie es UNA línea de 80 columnas y no entra todo: con un chat abierto se
  // cambian `^R reconectar` y `^G buscar` por las teclas de scroll, que son las
  // que el usuario necesita AHÍ.
  //
  // ⚠️ `^G buscar` (tarea 16) entró en el lugar de `^R reconectar`, no encima:
  // sin chat abierto el pie mide 68 de los 78 que entran y sumarlo lo dejaba en
  // 80. De los dos, `^R` es el que NO hace falta descubrir por el pie —cuando de
  // verdad sirve lo nombra el banner de conexión
  // (`MOTIVO_CONEXION_REEMPLAZADA`)—, mientras que una búsqueda global que no se
  // anuncia en ningún lado no existe. Los dos siguen en la ayuda (`?`).
  const cola = convo.jid ? "? ayuda · ^C salir" : "? ayuda · ^G buscar · ^C salir";
  // ⚠️ Con un chat abierto esta línea mide EXACTAMENTE 78 caracteres, que es lo
  // que entra a 80 columnas (RNF-1) descontando el padding. No es holgura: el
  // próximo hint que se sume tiene que sacar otro.
  const teclasChat = convo.jid ? ` · ^E escribí · ${HINTS_CONVO}` : "";
  const hints =
    modo === "compose"
      ? `${HINTS_COMPOSER} · ^C salir`
      : modo === "candado"
        ? `${candado.fase === "listo" ? "⏎ / Esc cerrar" : "⏎ seguir · Esc cancelar"} · ^C salir`
        : modo === "search"
        ? `${HINTS_BUSQUEDA} · ^C salir`
        : modo === "help"
          ? `${scrollAyuda ? "↑↓ desplazar · " : ""}^R reconectar · Esc / ? cerrar la ayuda`
          : !verBandeja
            ? `↑↓ scroll · ^E escribí · Esc bandeja · ${cola}`
            : `${HINTS_BANDEJA}${teclasChat} · ${cola}`;

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={BG}>
      <Header conTabs />

      {banner ? (
        <box height={1} paddingLeft={1} paddingRight={1} backgroundColor={ELEVATED}>
          <text fg={WARN} wrapMode="none">
            {clip(`⚠ ${banner}`, Math.max(0, width - 2))}
          </text>
        </box>
      ) : null}

      {modo === "help" ? (
        <Help
          logPath={logPath}
          width={width}
          filas={filasVisibles}
          mini={disposicion === "mini"}
          cajaRef={ayudaRef}
        />
      ) : modo === "candado" ? (
        /* Mismo criterio que la ayuda: REEMPLAZA el cuerpo. La bandeja se
           desmonta, así que mientras se fija el código no hay ningún `<input>`
           enfocado que pueda recibir un dígito. */
        <LockCode estado={candado} yaHay={commands.hasLockCode()} ancho={width} alto={filasVisibles} />
      ) : modo === "search" ? (
        /* §7.1: el overlay REEMPLAZA el cuerpo (no se dibuja encima). La bandeja
           y la conversación se desmontan, así que el `<input>` de la búsqueda es
           el único con foco y al cerrarla el de la bandeja se remonta y lo
           recupera — el mismo camino que ya hace la ayuda. */
        <SearchOverlay
          ancho={width - 2}
          alto={filasVisibles}
          apiRef={busquedaRef}
          onAbrir={() => salirDeBusqueda(false)}
        />
      ) : (
        <box flexDirection="row" flexGrow={1}>
          {verBandeja ? (
            <box
              flexDirection="column"
              flexGrow={disposicion === "mini" ? 1 : 0}
              flexShrink={0}
              width={disposicion === "mini" ? undefined : anchoBandeja}
              border
              borderColor={BORDER}
              backgroundColor={SURFACE}
              // El `· candado` es el ÚNICO rastro en pantalla de que los chats
              // con candado están a la vista. Sin él no habría cómo saber si lo
              // que se está viendo es la bandeja de siempre o la de después del
              // código —y el `Esc` que los esconde parecería no hacer nada—.
              title={` chats ${inbox.counts.all}${ui.lockedRevealed ? " · candado" : ""} `}
            >
              {/* El buscador de la bandeja tiene el foco SALVO mientras se
                  redacta: el reconciliador de OpenTUI aplica `focused` sólo
                  cuando la prop CAMBIA, así que si el `<input>` la tuviera
                  clavada en `true`, al volver del campo de redacción nadie se lo
                  devolvería y tipear no filtraría más (CA-5.1). */}
              <Inbox
                ancho={anchoInterior}
                alto={filasVisibles}
                enfocado={modo !== "compose"}
              />
            </box>
          ) : null}

          {verConvo ? (
            <box
              flexDirection="column"
              flexGrow={1}
              border
              borderColor={BORDER}
              backgroundColor={SURFACE}
              // El título dice QUÉ chat se está leyendo: en `mini` la bandeja no
              // está a la vista y sin esto no habría forma de saberlo. Se recorta
              // a mano porque un título más ancho que el panel rompe el marco.
              title={` ${chatAbierto ? clip(etiquetaChat(chatAbierto), Math.max(8, anchoConvo - 4)) : "conversación"} `}
            >
              <Conversation ancho={anchoConvo} cajaRef={convoRef} />
              {/* CA-8.1: el campo sólo existe con un chat abierto. Se monta y se
                  desmonta (no cambia de rama en el lugar), así que el gotcha de
                  las props que no se resetean no aplica acá. */}
              {convo.jid ? (
                <Composer
                  jid={convo.jid}
                  ancho={anchoConvo}
                  enfocado={modo === "compose"}
                  onEnfocar={() => setModo("compose")}
                />
              ) : null}
            </box>
          ) : null}
        </box>
      )}

      <Footer hints={hints} width={width} />
    </box>
  );
}
