// El panel de conversación (CA-6.*, CA-7.*): la ventana fija de 500 mensajes,
// el scroll pegado al final y el aviso de mensajes nuevos cuando el usuario está
// leyendo más arriba.
//
// Seis decisiones que gobiernan este archivo:
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
import type { ScrollBoxRenderable } from "@opentui/core";
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
    claveRef.current = { jid, ancla: convo.anchorId };
    mensajes = ventana;
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
        <Tope lleno={hayMasArriba(mensajes, convo.anchorId)} ancho={anchoFila} />
        {mensajes.length === 0 ? (
          <text fg={MUT} wrapMode="none">
            {clip("todavía no hay mensajes en este chat", Math.max(0, anchoFila))}
          </text>
        ) : (
          mensajes.map((m) => (
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
