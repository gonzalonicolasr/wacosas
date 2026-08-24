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
// Lo que TODAVÍA no cuelga de acá, con su tarea: `<Inbox/>` (12),
// `<Conversation/>` + `<Composer/>` (13 y 14) y `<SearchOverlay/>` (16). Los
// huecos están marcados abajo.
import type { KeyEvent, ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useRef, useState } from "react";

import { clip } from "../lib/fmt";
import { commands } from "../state/commands";
import { useSlice } from "../state/hooks";
import { store } from "../state/store";
import { ALTO_FOOTER, Footer } from "./Footer";
import { ALTO_HEADER, Header } from "./Header";
import { ayudaScrollea, Help } from "./Help";
import { Login, metodoDe } from "./Login";
import { Splash } from "./Splash";
import { MIN_COLS, MIN_ROWS, TooSmall } from "./TooSmall";
import { BG, BORDER, ELEVATED, MUT, SURFACE, TEXT_DIM, WARN } from "./theme";

type Modo = "browse" | "help";
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

/**
 * Nombre visible de un chat. Un chat creado por un mensaje SALIENTE queda con
 * `name` vacío (el ingest no renombra con el `pushName` de un eco propio) y un
 * grupo sin subject también: sin este fallback la fila se vería en blanco.
 */
function nombreDe(chat: { name: string; jid: string }): string {
  return chat.name || (chat.jid.split("@")[0] as string);
}

export function App({ noSplash, logPath }: { noSplash: boolean; logPath: string }) {
  const { width, height } = useTerminalDimensions();
  const conn = useSlice("conn");
  const link = useSlice("link");
  const inbox = useSlice("inbox");
  const ui = useSlice("ui");

  const [modo, setModo] = useState<Modo>("browse");
  const [panelMini, setPanelMini] = useState<PanelMini>("inbox");
  const [splash, setSplash] = useState(!noSplash);
  const [avance, setAvance] = useState(0);
  // El cuerpo de la ayuda se scrollea desde acá: el `useKeyboard` es uno solo
  // (§7.4) y el `<scrollbox>` no tiene el foco, así que se lo mueve por la ref.
  const ayudaRef = useRef<ScrollBoxRenderable | null>(null);

  const disposicion = disposicionDe(width);
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

  // La vinculación se lleva la pantalla entera: si la ayuda quedó abierta cuando
  // WhatsApp desvinculó la sesión, dejarla "abierta abajo" haría que reaparezca
  // sola al volver a vincular, sin que nadie la haya pedido.
  useEffect(() => {
    if (enLogin) setModo("browse");
  }, [enLogin]);

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
    // ACÁ ARRIBA van las combinaciones con `Shift` (§7.3): `Shift-↑/↓` y
    // `Shift-PgUp/PgDn` scrollean la conversación (tarea 13). Tienen que quedar
    // ANTES de las teclas peladas, o el `↑` pelado se las come.

    // `?` abre la ayuda. Cuando la tarea 12 monte el buscador, sólo con el campo
    // vacío: con texto tipeado el `?` es un carácter más (§7.3).
    if (es("?")) {
      setModo("help");
      return;
    }

    // `mini`: un panel por vez, `⏎` entra y `Esc` vuelve (§7.2).
    if (disposicion === "mini") {
      if (enter && panelMini === "inbox") {
        setPanelMini("convo");
        return;
      }
      if (es("escape") && panelMini === "convo") {
        setPanelMini("inbox");
        return;
      }
    }
  });

  // ── render ────────────────────────────────────────────────────────────────

  if (splash) return <Splash t={avance} width={width} />;
  // RNF-2: render condicional, no estado ⇒ agrandar la terminal lo deshace solo.
  if (width < MIN_COLS || height < MIN_ROWS) return <TooSmall width={width} height={height} />;
  // CA-1.1: la vinculación va DESPUÉS de `<TooSmall/>` —abajo de 60×15 no se
  // dibuja ni el panel de "el QR no entra"— y ANTES de todo lo demás.
  if (enLogin) return <Login width={width} height={height} />;

  const banner = ui.connBanner;
  const altoCuerpo = Math.max(1, height - ALTO_HEADER - ALTO_FOOTER - (banner ? 1 : 0));
  // −2 por los bordes del panel. Es la única medida calculada a mano, y se
  // recalcula en cada render: no hay nada cacheado que se desincronice al
  // redimensionar (CA-19.4).
  const filasVisibles = Math.max(0, altoCuerpo - 2);
  const anchoBandeja =
    disposicion === "wide" ? Math.floor(width * RATIO_BANDEJA_WIDE) : ANCHO_BANDEJA_COMPACT;
  const verBandeja = disposicion !== "mini" || panelMini === "inbox";
  const verConvo = disposicion !== "mini" || panelMini === "convo";

  // El `↑↓` sólo se anuncia si la ayuda de verdad no entra entera (terminal muy
  // baja): un hint que promete una tecla que no hace nada es ruido.
  const scrollAyuda =
    modo === "help" &&
    ayudaScrollea({ logPath, mini: disposicion === "mini", filas: filasVisibles });

  const hints =
    modo === "help"
      ? `${scrollAyuda ? "↑↓ desplazar · " : ""}^R reconectar · Esc / ? cerrar la ayuda`
      : disposicion === "mini"
        ? "⏎ conversación · Esc bandeja · ? ayuda · ^R reconectar · ^C salir"
        : "? ayuda · ^R reconectar · ^C salir";

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={BG}>
      <Header />

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
              title={` chats ${inbox.counts.all} `}
            >
              {/* Lista MÍNIMA de la bandeja: la fila real (preview, fecha
                  relativa, badge de no leídos), los filtros, el buscador y el
                  mouse los construye la tarea 12 con <Inbox/>. Las filas ya van
                  con `height={1}` + `wrapMode="none"` (§7.4.1). */}
              {inbox.chats.length === 0 ? (
                <text fg={MUT}>{"  (todavía no hay chats)"}</text>
              ) : (
                inbox.chats.slice(0, filasVisibles).map((c) => (
                  <box key={c.jid} height={1} paddingLeft={1}>
                    <text fg={TEXT_DIM} wrapMode="none">
                      {clip(nombreDe(c), Math.max(4, (verConvo ? anchoBandeja : width) - 3))}
                    </text>
                  </box>
                ))
              )}
            </box>
          ) : null}

          {verConvo ? (
            <box
              flexDirection="column"
              flexGrow={1}
              border
              borderColor={BORDER}
              backgroundColor={SURFACE}
              title=" conversación "
            >
              {/* Acá van <Conversation/> (tarea 13) y <Composer/> (tarea 14). */}
              <text fg={MUT}>{"  (ningún chat abierto)"}</text>
            </box>
          ) : null}
        </box>
      )}

      <Footer hints={hints} width={width} />
    </box>
  );
}
