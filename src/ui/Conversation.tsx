// El panel de conversación (CA-6.*, CA-7.*): la ventana fija de 500 mensajes,
// el scroll pegado al final y el aviso de mensajes nuevos cuando el usuario está
// leyendo más arriba.
//
// Siete decisiones que gobiernan este archivo:
//
//  1. **El scroll lo maneja el `<scrollbox>`, no nosotros** (V7). `stickyScroll`
//     + `stickyStart="bottom"` dan gratis las dos mitades de CA-6.4: mientras el
//     usuario esté abajo, cada mensaje nuevo lo sigue dejando abajo; en cuanto
//     scrollea hacia arriba, OpenTUI marca el scroll como manual y deja de
//     moverlo solo. No hay una sola cuenta de offsets a mano.
//  2. **Cambiar de chat es MONTAR OTRO `<scrollbox>`** (`key={jid}`): un
//     renderable nuevo nace en 0 y con el scroll manual apagado, así que la
//     conversación nueva abre al final sin resetear nada a mano (CA-6.7).
//  3. **La ventana es FIJA: 500 mensajes y no se carga nada al llegar arriba**
//     (R2, CA-6.8 recortado). No hay `loadOlder` ni disparo por scroll; lo único
//     que se hace es DECIR que la ventana está llena, para que el usuario no crea
//     que ese es el principio de la charla.
//  4. **El ancla se SUELTA** (⚠️ de la tarea 13). `anchorId` sirve para UNA cosa:
//     posicionar la ventana en el salto desde la búsqueda global (CA-12.3). Si se
//     queda pegada, `construirConvo` la usa en todos los flush siguientes y el
//     chat se congela: en un chat de 900 mensajes abierto desde un resultado
//     viejo, los mensajes nuevos no entran nunca en la ventana. Se suelta en dos
//     momentos, los dos observables desde acá (ver `useEffect` de abajo):
//       · cuando entra actividad nueva al chat abierto, y
//       · cuando el usuario vuelve al final de la ventana.
//  5. **`convo.hasMoreAbove` NO se usa**: por el camino anclado miente (una
//     ventana de 252 filas devuelve `false` con 650 mensajes arriba). El aviso
//     de "hay más arriba" se calcula acá, con `hayMasArriba()`, que sí distingue
//     los dos caminos.
//  6. **Con el usuario leyendo arriba, la ventana NO rueda** (`fusionarVentana`).
//     El store reconsulta los últimos 500 en cada flush, así que con la ventana
//     llena cada entrante tira al más viejo y sube todo una fila: el `scrollTop`,
//     que es absoluto, deja de apuntar a lo mismo. Mientras `!alFinal()` la lista
//     local se congela y sólo se le appendea lo nuevo; al volver al final se
//     resincroniza con el store.
//  7. **Las filas se montan por LOTES, de abajo hacia arriba** (tarea 13b). Abrir
//     un chat de 909 mensajes costaba ~700 ms, y el **97 %** era el commit de
//     React creando los renderables de OpenTUI (~0,2 ms cada uno × 7 por fila ×
//     500 filas); SQLite son 1-4 ms y el layout+dibujo, 7-19 ms. Virtualizar no
//     es opción: el `viewportCulling` del `<scrollbox>` saltea el DIBUJO, no la
//     CREACIÓN (medido: 695 ms igual), y las filas tienen alto variable —wrap por
//     palabra—, así que a mano no hay `scrollHeight` que calcular. Lo que sí se
//     puede es montar primero lo ÚNICO que se ve —la cola— y dejar entrar el
//     resto de a `LOTE` filas con `setTimeout(0)` en el medio, como el drenador
//     del ingest (D4). El `stickyStart="bottom"` hace que crecer hacia ARRIBA no
//     mueva la vista, así que el usuario ya está leyendo mientras se termina de
//     montar. El camino ANCLADO no se lotea (ahí `stickyScroll` está apagado y
//     prependear filas sí correría la vista).
import type { ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import type { RefObject } from "react";
import { memo, useCallback, useEffect, useRef, useState } from "react";

import { VENTANA_DEFAULT } from "../db/repo";
import type { MessageRow as Mensaje } from "../db/types";
import { clip } from "../lib/fmt";
import { commands, etiquetaChat } from "../state/commands";
import { useSlice } from "../state/hooks";
import { idFila, MessageRow } from "./MessageRow";
import { ACCENT, FAINT, MUT, SEL_FG, SURFACE } from "./theme";

/** Teclas de la conversación para el pie (`App` las concatena con las globales). */
export const HINTS_CONVO = "⇧↑↓ scroll";

/**
 * Cada cuánto se mira la posición del scroll.
 *
 * Hace falta un muestreo y no alcanza con un efecto porque las dos fuentes de
 * movimiento son invisibles para React: la rueda la resuelve el `<scrollbox>`
 * por dentro (nunca pasa por un handler nuestro) y el `stickyScroll` acomoda la
 * posición durante el LAYOUT, o sea después del commit. Sólo llama a `setState`
 * cuando el número cambió, así que en reposo no provoca un solo render.
 */
const MUESTREO_MS = 200;

/** Un frame y monedas: lo que tarda el layout en darle una `y` real a una fila nueva. */
const RETARDO_SALTO_MS = 40;

/**
 * Filas que entran por vuelta cuando la conversación se monta por lotes
 * (decisión 7).
 *
 * Medido en el chat de 909 mensajes del arnés (`tools/demo.tsx`, ventana llena
 * de 500 filas) con `capture-pane` hasta el primer cambio del pane: montar todo
 * de una tardaba 679-703 ms; de a 48, **95-105 ms**. El montaje COMPLETO tarda
 * un poco más en total —entre 0,6 s y 1 s, medido apretando `⇧Inicio` a
 * distintos tiempos: a los 0,6 s todavía falta, al segundo ya está—, pero
 * ocurre detrás del usuario, que hace rato está leyendo la cola.
 *
 * El tamaño sale de dos presiones opuestas: más chico baja el primer frame (de
 * a 25 el revisor midió 84 ms) pero alarga el montaje total, y más grande deja
 * un salto más feo si el usuario scrollea justo en el medio (el rescate de acá
 * abajo lo arregla, pero el frame malo que se dibuja antes es de un lote).
 */
const LOTE = 48;

/**
 * Cuántas veces se espera al layout antes de reponer la lectura tras montar el
 * resto de la conversación de un saque. A `RETARDO_SALTO_MS` cada uno son ~200
 * ms de paciencia: de sobra para el frame que sigue a un commit de 500 filas.
 */
const INTENTOS_REPOSICION = 5;

/**
 * Columnas que se le restan al panel para saber cuánto mide una fila: el padding
 * izquierdo y derecho del contenido, más **la columna de la barra de scroll**.
 *
 * ⚠️ Gotcha nuevo de OpenTUI 0.4.2, medido acá: dentro de un `<scrollbox>` CON
 * barra, una caja de ancho automático se MIDE con una columna menos de las que
 * después se DIBUJAN —la barra se descuenta del layout pero no del dibujo—, así
 * que un mensaje que se pasa por un solo carácter se mide en dos filas y se
 * pinta en una: queda una fila EN BLANCO fantasma debajo. Fijándole el ancho a
 * la fila, medida y dibujo coinciden. La columna de la barra se reserva SIEMPRE,
 * aunque la barra no esté: así el ancho no cambia cuando aparece y el texto no
 * se re-envuelve entero.
 */
const RESERVA_FILA = 3;

/**
 * ¿Quedó historial arriba de la ventana? (aviso de CA-6.8 recortado).
 *
 * NO se usa `convo.hasMoreAbove`: ese flag mira `messages.length >= 500`, que es
 * correcto para la ventana del final —`lastMessages` trae las últimas 500— pero
 * MIENTE en la anclada, donde `messagesAround` reparte el tope entre las dos
 * mitades y puede devolver 252 filas con 650 mensajes arriba.
 *
 * Por el camino anclado se cuenta cuántas filas quedaron en la mitad de arriba:
 * si esa mitad llegó a su tope, hay más historial del que se pidió.
 */
export function hayMasArriba(mensajes: Mensaje[], anchorId: number | null): boolean {
  const n = mensajes?.length ?? 0;
  if (n === 0) return false;
  if (anchorId === null) return n >= VENTANA_DEFAULT;
  const i = mensajes.findIndex((m) => m.id === anchorId);
  // El ancla puede no estar en la ventana (el mensaje se borró entre el
  // resultado de la búsqueda y el salto): en la duda se avisa.
  return i < 0 ? true : i + 1 >= Math.floor(VENTANA_DEFAULT / 2);
}

/**
 * La lista que se PINTA cuando la ventana del store rodó bajo los pies de quien
 * está leyendo más arriba (CA-6.4).
 *
 * `construirConvo()` reconsulta `lastMessages(jid, 500)` en cada flush: con la
 * ventana LLENA, cada entrante empuja al más viejo fuera, todo el contenido sube
 * una fila y el `scrollTop` —que es ABSOLUTO— deja de apuntar a lo mismo. Con un
 * mensaje es imperceptible; con una ráfaga de grupo el texto se te va yendo para
 * arriba mientras leés (medido: deriva 1:1 con los entrantes).
 *
 * El arreglo es no dejar rodar la ventana mientras el usuario no está al final:
 * se conserva el PREFIJO que se cayó del tope y se appendea la ventana nueva
 * entera. Las filas que siguen DENTRO de la ventana se toman de ella y no de la
 * copia vieja, así un revoke o un cambio de estado de entrega se sigue viendo al
 * instante; lo único que queda congelado es lo que ya se cayó, que sin que el
 * store lo publique de nuevo no puede cambiar igual.
 *
 * Es local al panel a propósito: el store publica LA ventana (D2, una sola
 * verdad) y quién puede tolerar que se mueva es una pregunta de la vista.
 */
export function fusionarVentana(previa: Mensaje[], ventana: Mensaje[]): Mensaje[] {
  if (previa.length === 0 || ventana.length === 0) return ventana;
  const enVentana = new Set(ventana.map((m) => m.id));
  const corte = previa.findIndex((m) => enVentana.has(m.id));
  // Sin un solo id en común la ventana saltó entera (más de 500 mensajes entre
  // dos flush): lo de antes sigue siendo más viejo, así que va delante igual.
  const prefijo = corte < 0 ? previa : previa.slice(0, corte);
  return prefijo.length === 0 ? ventana : [...prefijo, ...ventana];
}

/**
 * A cuántas líneas del final QUISO quedar el usuario cuando movió el scroll con
 * el montaje por lotes a medio camino (decisión 7).
 *
 * No alcanza con `scrollHeight - viewport - scrollTop`, y el porqué es una
 * carrera fina, medida con el arnés: el commit de React mete las filas del lote,
 * pero el `scrollTop` recién se re-pega abajo cuando corre el LAYOUT, que es del
 * renderer. Si la tecla cae en el medio, el `scrollBy(-1)` de OpenTUI se aplica
 * sobre la posición VIEJA y después el layout ve un scroll "manual" y ya no lo
 * mueve: el usuario pidió tres líneas y quedó a 51 del final —justo el alto del
 * lote— (medido: `top` 33 → 30 mientras el contenido pasaba de 50 a 98 líneas).
 *
 * Como en el lote anterior el scroll SÍ estaba pegado abajo, lo que el usuario
 * movió es la diferencia contra ese pin. Si en cambio scrolleó después del
 * layout, su referencia ya es la nueva y el pin viejo queda por debajo: ahí vale
 * la distancia al final de siempre. Las dos lecturas dan lo mismo cuando no hay
 * carrera.
 */
export function lejosDelFinal(pin: number, top: number, max: number): number {
  return Math.max(0, pin > top ? pin - top : max - top);
}

/** El aviso de arriba de todo: qué hay —o qué no hay— antes del primer mensaje. */
function Tope({ lleno, ancho }: { lleno: boolean; ancho: number }) {
  const texto = lleno
    ? `⋯ ventana de ${VENTANA_DEFAULT} mensajes · lo anterior no se carga`
    : "· principio de la conversación ·";
  return (
    <text fg={FAINT} wrapMode="none">
      {clip(texto, Math.max(0, ancho))}
    </text>
  );
}

/** CA-6.4: "indicar que hay mensajes nuevos abajo" sin moverle la lectura. */
function BadgeNuevos({ n, onIr }: { n: number; onIr: () => void }) {
  return (
    <box
      height={1}
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={ACCENT}
      onMouseDown={onIr}
    >
      <text fg={SEL_FG} wrapMode="none">
        {`↓ ${n} ${n === 1 ? "mensaje nuevo" : "mensajes nuevos"}`}
      </text>
    </box>
  );
}

export type PropsConversacion = {
  /** Ancho INTERIOR del panel (sin bordes): sólo para recortar las líneas sueltas. */
  ancho: number;
  /** La caja de scroll la maneja el `useKeyboard` de `App` (§7.4.2: uno solo). */
  cajaRef: RefObject<ScrollBoxRenderable | null>;
};

function Panel({ ancho, cajaRef }: PropsConversacion) {
  const convo = useSlice("convo");
  // La bandeja es la señal de "pasó algo en este chat": el ingest marca sucios
  // `inbox` y `convo` en el mismo movimiento (§6.2), y `last_message_at` se mueve
  // con cada mensaje —propio o ajeno— pero NO con un `markRead`.
  const inbox = useSlice("inbox");

  const jid = convo.jid;
  const chat = jid === null ? null : (inbox.chats.find((c) => c.jid === jid) ?? null);
  const nombreChat = chat ? etiquetaChat(chat) : "";
  const grupo = chat ? chat.isGroup : String(jid ?? "").endsWith("@g.us");
  const actividad = chat ? chat.lastMessageAt : 0;

  /** Lo que publicó el store: la ventana de 500, que puede haber rodado. */
  const ventana = convo.messages;
  const ultimoId = ventana.length > 0 ? (ventana[ventana.length - 1] as Mensaje).id : 0;
  const anchoFila = Math.max(1, ancho - RESERVA_FILA);

  /**
   * Cuántas filas entran en el PRIMER lote (decisión 7).
   *
   * Tiene que tapar el panel entero: si entra menos contenido del que mide el
   * viewport, el `<scrollbox>` lo apoya ARRIBA y las filas se ven bajar mientras
   * llegan los lotes siguientes. Cada fila ocupa como mínimo una línea, así que
   * con tantas filas como líneas tiene la terminal alcanza y sobra —el panel
   * siempre es más bajo que la terminal, que además trae header y pie—. El alto
   * se pide acá y no se recibe por props porque `App` sólo pasa el ancho.
   */
  const { height: altoTerminal } = useTerminalDimensions();
  const arranque = Math.max(LOTE, altoTerminal + 2);

  /** Mensaje señalado por el salto de la búsqueda (CA-12.3). */
  const [marcado, setMarcado] = useState<number | null>(null);
  /** Cuántos mensajes entraron desde que el usuario dejó de mirar el final. */
  const [nuevos, setNuevos] = useState(0);

  const mensajesRef = useRef<Mensaje[]>(ventana);
  const ultimoIdRef = useRef(ultimoId);
  /** La lista pintada en el frame anterior: la base del congelado de arriba. */
  const vistaRef = useRef<Mensaje[]>(ventana);
  /** La ventana del store del frame anterior, para saber si hubo flush. */
  const ventanaRef = useRef<Mensaje[]>(ventana);
  /** Chat + ancla: cuando cambia cualquiera de los dos, la lista se rehace. */
  const claveRef = useRef<{ jid: string | null; ancla: number | null }>({
    jid,
    ancla: convo.anchorId,
  });
  /** Último id que el usuario vio ESTANDO al final. Todo lo posterior es "nuevo". */
  const vistoRef = useRef(ultimoId);
  const nuevosRef = useRef(0);
  /** Actividad del chat en el momento en que se fijó el ancla (línea de base). */
  const baseRef = useRef(actividad);
  /** Fila a la que hay que volver después de soltar el ancla, si la hay. */
  const reponerRef = useRef<number | null>(null);
  /**
   * Al soltar el ancla, el `ts` que separa "lo que ya estaba" de "lo que acaba
   * de llegar", para recontar el aviso contra la ventana NUEVA.
   *
   * Sin esto el contador miente feo: al pasar de la ventana anclada a la del
   * final entran de golpe cientos de mensajes VIEJOS que estaban fuera de la
   * ventana anterior, y el aviso los cuenta a todos como nuevos ("↓ 260 mensajes
   * nuevos" cuando llegó uno).
   */
  const recontarRef = useRef<number | null>(null);
  const marcadoRef = useRef<number | null>(null);
  /** El ancla vigente, para el muestreo, que corre fuera del render. */
  const anclaRef = useRef<number | null>(convo.anchorId);
  /**
   * Hay un salto agendado y todavía sin ejecutar.
   *
   * Mientras esté en `true`, la posición del scroll NO significa nada: la fila
   * de destino todavía no tiene `y`. Sin esta guarda el ancla se soltaba sola
   * antes de saltar, porque la caja recién montada dice estar "al final".
   */
  const saltoPendienteRef = useRef(false);
  /**
   * Índice de la primera fila MONTADA: todo lo anterior todavía no existe como
   * renderable (decisión 7). `0` = ya está montada la conversación entera.
   *
   * Es un índice desde el PRINCIPIO de la lista y no un contador desde el final
   * a propósito: los mensajes que llegan mientras se monta se appendean, y con
   * un contador desde el final cada entrante le comería una fila al borde de
   * arriba —desmontando lo que el usuario podría estar mirando—.
   */
  const desdeRef = useRef(convo.anchorId === null ? Math.max(0, ventana.length - arranque) : 0);
  /**
   * Vueltas del montaje por lotes. No se lee en ningún lado: está para repintar
   * cuando `desdeRef` avanza y para volver a disparar el efecto del lote
   * siguiente (la verdad de qué se pinta vive en la ref, que se decide durante
   * el render como todo lo demás de este archivo).
   */
  const [vuelta, setVuelta] = useState(0);
  /**
   * El rescate en curso cuando el usuario mueve el scroll con el montaje a
   * medio camino (ver el efecto del lote). Guarda a cuántas líneas del final
   * quiso quedar (`lejos`) y, una vez montado el resto, cuánto medía el
   * contenido justo antes de montarlo (`alto`, `null` mientras no se montó).
   *
   * Se guarda la distancia AL FINAL y no el `scrollTop`: el `scrollTop` es
   * absoluto y todo lo que entra arriba se lo corre, que es justamente el
   * problema; el final, en cambio, no se mueve mientras se monta —sólo se
   * agregan filas ARRIBA—. El `alto` es para saber si el layout ya midió.
   */
  const rescateRef = useRef<{ lejos: number; alto: number | null } | null>(null);
  /**
   * Dónde dejó el `stickyScroll` al scroll en el último lote, o sea la posición
   * que el usuario tenía delante cuando apretó la tecla. Es la referencia de
   * `lejosDelFinal`.
   */
  const pinRef = useRef(0);

  ultimoIdRef.current = ultimoId;
  marcadoRef.current = marcado;
  anclaRef.current = convo.anchorId;

  /** ¿El scroll está pegado al final? Es la pregunta que decide todo lo de abajo. */
  const alFinal = useCallback((): boolean => {
    const c = cajaRef.current;
    if (!c) return true; // todavía no hay caja: la posición inicial ES el final
    return c.scrollTop >= Math.max(0, c.scrollHeight - c.viewport.height) - 1;
  }, [cajaRef]);

  // ── la ventana no rueda mientras se está leyendo más arriba (CA-6.4) ───────
  // Se decide en el RENDER y no en un efecto a propósito: la geometría que se lee
  // acá es la del frame ANTERIOR, o sea la posición en la que estaba el usuario
  // cuando llegó el mensaje —que es justo la pregunta—. Un efecto correría después
  // del commit, con el contenido ya corrido abajo de sus pies.
  let mensajes: Mensaje[];
  if (claveRef.current.jid !== jid || claveRef.current.ancla !== convo.anchorId) {
    // Otro chat, o la ventana pasó a anclada (o volvió del ancla): no hay nada
    // que conservar, la lista se rehace con lo que publicó el store.
    const chatNuevo = claveRef.current.jid !== jid;
    claveRef.current = { jid, ancla: convo.anchorId };
    mensajes = ventana;
    // ⚠️ El loteo es SÓLO para el camino del final al ABRIR un chat. Con ancla
    // —el salto de la búsqueda, CA-12.3— `stickyScroll` está apagado y meter
    // filas arriba SÍ corre la vista; y al SOLTARLA hay un `scrollChildIntoView`
    // a una fila vieja, que si no está montada no encuentra nada y no scrollea.
    // Los dos caminos raros se montan de una, como antes.
    desdeRef.current = chatNuevo && convo.anchorId === null ? Math.max(0, mensajes.length - arranque) : 0;
    // Un rescate a medio hacer es de la lista VIEJA: aplicarlo acá movería el
    // scroll de una conversación que el usuario recién abre.
    rescateRef.current = null;
    pinRef.current = 0;
  } else if (ventana === ventanaRef.current) {
    // Re-render por otra cosa (una tecla, el badge): misma lista y MISMA
    // identidad, si no las 500 filas se repintarían por nada.
    mensajes = vistaRef.current;
  } else {
    mensajes = alFinal() ? ventana : fusionarVentana(vistaRef.current, ventana);
  }
  vistaRef.current = mensajes;
  ventanaRef.current = ventana;
  mensajesRef.current = mensajes;

  // El montaje puede quedar apuntando fuera de una lista que se ACORTÓ (volver
  // del congelado de `fusionarVentana` a la ventana pelada del store).
  if (desdeRef.current > mensajes.length) desdeRef.current = mensajes.length;
  const desde = desdeRef.current;
  /** Las filas que existen como renderable hoy: la cola primero, el resto por lotes. */
  const visibles = desde === 0 ? mensajes : mensajes.slice(desde);

  /**
   * ¿La caja ya tiene medidas de verdad?
   *
   * En el primer efecto después del montaje la caja existe pero el layout todavía
   * no corrió: alto y contenido valen 0, y con esos números `alFinal()` dice que
   * sí. Sin esta guarda, un chat abierto ANCLADO soltaba el ancla en el acto —
   * antes de poder saltar— y aparecía al final en vez de en el mensaje buscado.
   */
  const conMedidas = useCallback((): boolean => {
    const c = cajaRef.current;
    return !!c && c.scrollHeight > 0 && c.viewport.height > 0;
  }, [cajaRef]);

  const irAlFinal = useCallback((): void => {
    const c = cajaRef.current;
    if (!c) return;
    c.scrollTo(Math.max(0, c.scrollHeight - c.viewport.height));
  }, [cajaRef]);

  /**
   * Mira dónde quedó el scroll y recalcula el contador del aviso.
   *
   * Leer la geometría justo después del commit devuelve la del frame ANTERIOR, y
   * está bien que así sea: la pregunta es si el usuario estaba al final cuando
   * llegó el mensaje, no dónde lo dejó el `stickyScroll` un frame después.
   */
  const revisar = useCallback((): void => {
    // Con un salto agendado la posición todavía no es la definitiva: medirla acá
    // daría "estoy al final" y se perdería la cuenta del aviso. El muestreo la
    // vuelve a mirar apenas el salto se ejecuta.
    if (saltoPendienteRef.current) return;
    // Lo mismo mientras se monta por lotes (decisión 7): el contenido crece
    // hacia ARRIBA en cada vuelta, así que `scrollHeight` sube sin que el
    // usuario haya tocado nada y la caja parece haberse ido del final. Sin esta
    // guarda se prendía el aviso de mensajes nuevos sin que hubiera llegado
    // nada. El muestreo vuelve a mirar apenas termina de montar.
    if (false && desdeRef.current > 0) return;
    const lista = mensajesRef.current;
    let n = 0;
    if (alFinal()) {
      vistoRef.current = ultimoIdRef.current;
      // ⚠️ El segundo momento en que se suelta el ancla: el usuario volvió al
      // final, así que la ventana anclada ya no le da nada que no le dé la del
      // final —y la del final, además, crece con lo que llegue.
      if (anclaRef.current !== null && conMedidas() && !saltoPendienteRef.current) {
        commands.releaseAnchor();
      }
    } else {
      const visto = vistoRef.current;
      for (let i = lista.length - 1; i >= 0 && (lista[i] as Mensaje).id > visto; i--) n++;
    }
    if (n !== nuevosRef.current) {
      nuevosRef.current = n;
      setNuevos(n);
    }
  }, [alFinal, conMedidas]);

  /** Manda el scroll a una fila concreta, una vez que el layout le dio una `y`. */
  const saltarA = useCallback(
    (id: number): (() => void) => {
      saltoPendienteRef.current = true;
      const t = setTimeout(() => {
        cajaRef.current?.scrollChildIntoView(idFila(id));
        saltoPendienteRef.current = false;
      }, RETARDO_SALTO_MS);
      return () => {
        clearTimeout(t);
        saltoPendienteRef.current = false;
      };
    },
    [cajaRef],
  );

  /**
   * Devuelve la vista a `lejos` líneas del final, una vez que el layout midió
   * lo que se acaba de montar de golpe (decisión 7).
   *
   * Mismo truco que `saltarA`: el alto de una fila recién montada no existe
   * hasta que corre el LAYOUT, que es del renderer y no del commit de React. Se
   * reintenta mientras el contenido siga midiendo lo mismo que antes —montar 450
   * filas de una deja al renderer bastante atrasado— y se corta a los
   * `INTENTOS_REPOSICION` para no quedar mirando una caja que no cambia más.
   */
  const reponerLectura = useCallback(
    (lejos: number, alto: number): (() => void) => {
      saltoPendienteRef.current = true;
      let t: ReturnType<typeof setTimeout>;
      const probar = (quedan: number): void => {
        t = setTimeout(() => {
          const c = cajaRef.current;
          if (!c) {
            saltoPendienteRef.current = false;
            return;
          }
          const midio = c.scrollHeight !== alto;
          if (!midio && quedan > 0) {
            probar(quedan - 1);
            return;
          }
          // Si el layout nunca llegó a medir, se lo deja pegado al final —donde
          // el `stickyScroll` lo va a poner solo en cuanto mida— y no en una
          // posición que ya no significa nada.
          const max = Math.max(0, c.scrollHeight - c.viewport.height);
          c.scrollTo(midio ? Math.max(0, max - lejos) : max);
          saltoPendienteRef.current = false;
        }, RETARDO_SALTO_MS);
      };
      probar(INTENTOS_REPOSICION);
      return () => {
        clearTimeout(t);
        saltoPendienteRef.current = false;
      };
    },
    [cajaRef],
  );

  // ── cambio de chat (CA-6.7) ───────────────────────────────────────────────
  // El `<scrollbox>` se remonta por su `key`, así que el scroll ya arranca al
  // final; lo que se resetea acá es lo que vive en este componente.
  useEffect(() => {
    setMarcado(null);
    nuevosRef.current = 0;
    setNuevos(0);
    vistoRef.current = ultimoIdRef.current;
  }, [jid]);

  // ── salto desde la búsqueda global (CA-12.3) ──────────────────────────────
  // La marca visual es estado LOCAL y no `convo.anchorId` a propósito: el ancla
  // se suelta apenas deja de hacer falta (regla 4) y la señal tiene que
  // sobrevivirla, "hasta el próximo cambio de chat" (§6.4).
  useEffect(() => {
    if (convo.anchorId === null) return;
    setMarcado(convo.anchorId);
    return saltarA(convo.anchorId);
  }, [jid, convo.anchorId, saltarA]);

  // ── línea de base del ancla ───────────────────────────────────────────────
  // Se re-arma en cada salto y en cada cambio de chat. `actividad` NO va en las
  // dependencias: justamente lo que se quiere detectar es que se mueva.
  useEffect(() => {
    baseRef.current = actividad;
  }, [jid, convo.anchorId]);

  // ── ⚠️ soltar el ancla ────────────────────────────────────────────────────
  // Entró algo nuevo al chat abierto y la ventana está anclada a un mensaje
  // viejo: si el ancla se queda, ese mensaje nuevo NO entra en la ventana
  // (`messagesAround` trae 250 antes y 250 después del ancla, nada más) y la
  // conversación queda congelada mientras la bandeja se actualiza.
  //
  // Al soltarla, la ventana vuelve a ser "los últimos 500" y el mensaje entra.
  // Si el usuario estaba leyendo más arriba, se lo devuelve a la fila señalada:
  // la ventana cambió abajo de sus pies y el `scrollTop` viejo apuntaría a otro
  // lado.
  useEffect(() => {
    if (jid === null || convo.anchorId === null) return;
    if (actividad <= baseRef.current) return;
    if (!alFinal()) reponerRef.current = marcadoRef.current ?? convo.anchorId;
    recontarRef.current = baseRef.current;
    commands.releaseAnchor();
  }, [jid, convo.anchorId, actividad, alFinal]);

  // ── mensajes nuevos ───────────────────────────────────────────────────────
  useEffect(() => {
    if (jid === null) return;

    // Los dos ajustes de abajo son para la ventana NUEVA, así que esperan a que
    // el ancla ya esté soltada: `releaseAnchor()` marca sucio el slice y la
    // ventana recién llega en el flush siguiente. Consumirlos en el mismo
    // commit los aplicaría contra la ventana vieja —que es justo la que se está
    // por reemplazar— y el aviso terminaba contando 260 mensajes viejos.
    if (convo.anchorId !== null) {
      revisar();
      return;
    }

    // La ventana cambió de forma (se soltó el ancla): lo que ya existía antes de
    // ese momento NO es "nuevo", aunque recién ahora aparezca en la ventana.
    const corte = recontarRef.current;
    if (corte !== null) {
      recontarRef.current = null;
      let ultimoViejo = 0;
      for (const m of mensajes) if (m.ts <= corte && m.id > ultimoViejo) ultimoViejo = m.id;
      vistoRef.current = ultimoViejo;
    }

    const reponer = reponerRef.current;
    reponerRef.current = null;

    // El salto se agenda ANTES de revisar: `saltarA` deja marcado que la posición
    // está por cambiar, y así el aviso no se recalcula con una posición que ya no
    // vale.
    let cancelarSalto: (() => void) | undefined;
    if (reponer !== null) {
      // La fila señalada puede haber quedado FUERA de la ventana nueva (el ancla
      // apuntaba más atrás de los últimos 500). En ese caso se va a lo más viejo
      // que quedó cargado, que es lo más cerca que se puede estar de donde el
      // usuario estaba leyendo.
      const hay = mensajes.some((m) => m.id === reponer);
      const destino = hay ? reponer : (mensajes[0]?.id ?? null);
      if (destino !== null) cancelarSalto = saltarA(destino);
    }

    revisar();
    return cancelarSalto;
  }, [jid, mensajes, convo.anchorId, revisar, saltarA]);

  // ── montaje por lotes (decisión 7) ────────────────────────────────────────
  // Una vuelta por `setTimeout(0)`, igual que el drenador del ingest (D4): entre
  // lote y lote el event loop respira, así que la tecla que apretás mientras se
  // termina de montar se atiende (RNF-5). El `stickyStart="bottom"` se encarga de
  // que las filas que entran ARRIBA no muevan lo que se está leyendo.
  //
  // ⚠️ …mientras el scroll esté pegado al final. **Si el usuario lo movió, el
  // `stickyScroll` se apaga solo** (OpenTUI marca el scroll como manual) y cada
  // lote que entra arriba le corre la lectura hacia atrás: medido en el arnés,
  // tres `⇧↑` a los 150 ms de abrir terminaban 400 mensajes más arriba, con el
  // texto pasando solo durante un segundo. Por eso la vuelta empieza mirando la
  // posición, y cuando el usuario toma el control se lo RESCATA en tres pasos:
  //
  //   1. se corrige la vista con lo que ya está montado —`lejosDelFinal` sabe
  //      cuánto quiso moverse—, así el frame que queda mientras se monta el
  //      resto es el que él pidió y no el que le corrió el lote;
  //   2. un frame después (para eso el `RETARDO_SALTO_MS`, si no el commit se
  //      come el paso 1 sin que se llegue a dibujar) entra TODO lo que falta de
  //      un saque: un tirón de ~400 ms, lo que costaba abrir un chat antes de
  //      esta tarea, y ni un lote más que le corra la lectura;
  //   3. medido el layout, se lo devuelve a la misma distancia del final.
  //
  // Queda un parpadeo de un frame entre 2 y 3 —el layout dibuja una vez con el
  // contenido nuevo y el `scrollTop` viejo—: medido, 48 ms. Es el precio de que
  // el layout viva en el renderer y no en el commit de React.
  useEffect(() => {
    const rescate = rescateRef.current;

    // Paso 3: ya está todo montado y falta devolver la vista.
    if (rescate !== null && rescate.alto !== null) {
      rescateRef.current = null;
      return reponerLectura(rescate.lejos, rescate.alto);
    }
    if (desdeRef.current === 0) return;

    // Paso 2: la vista corregida ya se dibujó; entra todo lo que falta.
    if (rescate !== null) {
      const t = setTimeout(() => {
        const c = cajaRef.current;
        rescateRef.current = { lejos: rescate.lejos, alto: c ? c.scrollHeight : 0 };
        desdeRef.current = 0;
        setVuelta((v) => v + 1);
      }, RETARDO_SALTO_MS);
      return () => clearTimeout(t);
    }

    const t = setTimeout(() => {
      const c = cajaRef.current;
      if (c && !alFinal()) {
        // Paso 1: el usuario tomó el control.
        const max = Math.max(0, c.scrollHeight - c.viewport.height);
        const lejos = lejosDelFinal(pinRef.current, c.scrollTop, max);
        c.scrollTo(Math.max(0, max - lejos));
        rescateRef.current = { lejos, alto: null };
      } else {
        // El pin es la posición que el usuario tiene DELANTE mientras entra el
        // lote: la referencia contra la que se mide su próxima tecla.
        if (c) pinRef.current = c.scrollTop;
        desdeRef.current = Math.max(0, desdeRef.current - LOTE);
      }
      setVuelta((v) => v + 1);
    }, 0);
    return () => clearTimeout(t);
  }, [jid, mensajes, vuelta, alFinal, cajaRef, reponerLectura]);

  // ── muestreo de la posición ───────────────────────────────────────────────
  useEffect(() => {
    if (jid === null) return;
    const t = setInterval(revisar, MUESTREO_MS);
    return () => clearInterval(t);
  }, [jid, revisar]);

  // ── render ────────────────────────────────────────────────────────────────
  //
  // ⚠️ Las dos ramas cuelgan de la MISMA caja raíz y con las MISMAS props, a
  // propósito. Gotcha nuevo de OpenTUI 0.4.2: su reconciliador de React aplica
  // las props nuevas pero **no resetea las que desaparecieron**, así que dos
  // ramas del mismo tipo de elemento en la misma posición se contaminan entre
  // sí. Con la raíz "sin chat" llevando `paddingLeft/Right`, al abrir un chat el
  // `<scrollbox>` heredaba ese padding: aparecía corrido una columna a la
  // derecha, dos columnas más angosto y con el último `✓` comido. Sólo pasaba al
  // abrir un chat DESPUÉS del montaje —abriéndolo antes, la rama vacía nunca se
  // pintaba—, que es exactamente el camino del usuario.
  return (
    <box flexDirection="column" flexGrow={1}>
      {jid === null ? (
        <box flexGrow={1} paddingLeft={1} paddingRight={1}>
          <text fg={MUT} wrapMode="none">
            {/* Corto a propósito: a 80×24 el panel mide 41 columnas útiles y un
                texto más largo se recortaría justo en la tecla que hay que
                apretar. */}
            {clip("ningún chat abierto · ⏎ para abrir", Math.max(0, ancho - RESERVA_FILA))}
          </text>
        </box>
      ) : (
      <scrollbox
        // CA-6.7: chat nuevo ⇒ `<scrollbox>` nuevo ⇒ scroll al final del nuevo.
        key={jid}
        ref={cajaRef}
        flexGrow={1}
        scrollX={false}
        // Con un ancla pendiente el `stickyScroll` va APAGADO: si no, el primer
        // layout clava la vista abajo de todo y el salto al mensaje buscado
        // (CA-12.3) se ve como un pantallazo. Vuelve solo al soltarse el ancla, y
        // al reactivarse NO tira la vista al final —OpenTUI marca el scroll como
        // manual cuando no está en la posición pegajosa—.
        stickyScroll={convo.anchorId === null}
        stickyStart="bottom"
        backgroundColor={SURFACE}
        contentOptions={{ flexDirection: "column", paddingLeft: 1, paddingRight: 1 }}
      >
        {/* Mientras se monta por lotes, el borde de arriba de lo montado NO es
            el principio de la ventana: el aviso diría "lo anterior no se carga"
            justo cuando está entrando lo anterior. Aparece al terminar, y como
            crece hacia arriba no mueve la vista. */}
        {desde === 0 ? <Tope lleno={hayMasArriba(mensajes, convo.anchorId)} ancho={anchoFila} /> : null}
        {mensajes.length === 0 ? (
          <text fg={MUT} wrapMode="none">
            {clip("todavía no hay mensajes en este chat", Math.max(0, anchoFila))}
          </text>
        ) : (
          visibles.map((m) => (
            <MessageRow
              key={m.id}
              msg={m}
              ancho={anchoFila}
              grupo={grupo}
              nombreChat={nombreChat}
              marcado={m.id === marcado}
            />
          ))
        )}
      </scrollbox>
      )}

      {jid !== null && nuevos > 0 ? <BadgeNuevos n={nuevos} onIr={irAlFinal} /> : null}
    </box>
  );
}

/**
 * Memoizada: `App` se re-renderiza con cualquier cambio del slice `ui` —tipear
 * en el buscador de la bandeja es uno— y sin esto cada tecla repintaría los 500
 * mensajes. Las props son escalares y una ref estable, así que la comparación de
 * fábrica alcanza; lo que sí tiene que seguir re-renderizando es el `useSlice`
 * de adentro, y `memo` no lo toca.
 */
export const Conversation = memo(Panel);
