// Reparación de la sincronización de **app-state**: las colecciones que WhatsApp
// usa para la agenda, los silenciados, los archivados y los fijados. De ahí salen
// los NOMBRES de los contactos, y por eso este archivo existe.
//
// ── EL BUG, tal como se ve en la cuenta real ────────────────────────────────
//
// 844 contactos guardados y sólo 32 con nombre. Los 32 llegaron por
// `lidContactAction` (`Utils/chat-utils.js:833`), o sea por app-state; los otros
// 812 nunca llegaron. En `creds/` se ve por qué: de las cinco colecciones
// (`ALL_WA_PATCH_NAMES`) hay **un solo** `app-state-sync-version-*.json`, el de
// `regular_high`. Las otras cuatro —incluida `critical_unblock_low`, que es donde
// vive `contactAction` (`Utils/chat-utils.js:506`)— **nunca se sincronizaron**.
//
// ── POR QUÉ NO SE ARREGLA SOLO ──────────────────────────────────────────────
//
// El único lugar de baileys que sincroniza las cinco colecciones es
// `doAppStateSync` (`Socket/chats.js:993-1006`), y para que corra hace falta que
// `syncState` llegue a `Syncing`, que sólo pasa con un mensaje de historial en una
// conexión con `accountSyncCounter === 0` (`Socket/chats.js:977-992`). Apenas ese
// contador pasa de 0 —lo incrementa tanto el sync completo (`:1003`) como el
// **timeout** de 20 s de `AwaitingInitialSync` (`:1107`)—, toda conexión posterior
// se va derecho a `Online` (`:1089`) y **`doAppStateSync` no vuelve a correr
// nunca**. En la cuenta real el contador quedó en 1 por el timeout, con el sync
// sin hacer: el agujero es permanente y no se cierra reiniciando.
//
// Lo único que sigue moviendo app-state después de eso son los `server_sync` que
// empuja WhatsApp (`Socket/messages-recv.js:827-832`), y esos vienen por UNA
// colección, la que cambió. Por eso `regular_high` está en v23 y las otras cuatro
// en nada.
//
// ── LA CAUSA RAÍZ, Y LA REPARACIÓN DE VERDAD ────────────────────────────────
//
// Lo de arriba describe el síntoma. La causa está en dos números:
// `accountSyncCounter` y los 20 s HARDCODEADOS del `awaitingSyncTimeout`
// (`Socket/chats.js:1099`, no es configurable):
//
//   · la primera conexión después de vincular espera hasta 20 s a que llegue un
//     mensaje de historial para hacer el sync completo (`:1097`);
//   · si no llega a tiempo —899 chats tardan más—, salta el timeout y baileys
//     **se auto-incrementa el contador**: `accountSyncCounter = (…||0) + 1`
//     (`:1104-1107`), con el comentario "so subsequent reconnections skip the
//     20s wait";
//   · desde ese momento, TODA conexión ve `accountSyncCounter > 0`, se va
//     derecho a `Online` (`:1086-1092`) y `doAppStateSync` **no corre nunca
//     más**. El contador vive en `creds.json`: no lo arregla reiniciar.
//
// De ahí sale TODO lo demás: los nombres que no llegan, las colecciones sin
// estado y —porque el candado también viaja por app-state— los `chats.lock` que
// nunca aparecen.
//
// **La reparación**: poner `accountSyncCounter` en 0 y reconectar, para que
// baileys rehaga su sincronización inicial completa. Sin desvincular y sin
// tocar el historial local (`wa/socket.ts`, `resetSyncCounter`). Se hace **una
// sola vez por sesión** —queda marcado en `meta`, sobrevive al proceso— y sólo
// cuando el diagnóstico da: falta app-state Y el contador está en la posición
// que impide rehacerlo. Con todo sincronizado no se toca nada.
//
// ── ⚠️ HASTA DÓNDE LLEGA (probado EN VIVO con la cuenta real) ──────────────
//
// **El reset del contador NO alcanzó.** Poner el contador en 0 devuelve a
// baileys a `AwaitingInitialSync`, pero para pasar a `Syncing` —y recién ahí
// corre `doAppStateSync`— hace falta ADEMÁS que llegue una notificación de
// historial, y **el servidor no se la manda a un dispositivo ya vinculado**
// (lo dice el propio baileys en `Socket/chats.js:1086-1088`). Resultado medido:
// vuelve a saltar el timeout de 20 s y el contador vuelve a 1.
//
// **Lo que sí funcionó fue re-vincular.** La clave de app-state que faltaba sólo
// la comparte el teléfono al enlazar (`APP_STATE_SYNC_KEY_SHARE`,
// `Utils/process-message.js:278-293`; el pedido `APP_STATE_SYNC_KEY_REQUEST`
// existe en el proto pero baileys **no lo implementa**). Después de re-vincular
// aparecieron **3** claves donde había 2 y llegaron los **11 chats con candado**
// —`lockChatAction` viaja por `regular_low`, una de las colecciones que estaba
// estacionada—.
//
// Entonces, ¿para qué se queda esto? Porque es **necesario pero no suficiente**:
// con el contador en 1 baileys no rehace el sync completo NI cuando la clave
// llega, y el costo está topeado en una reconexión por sesión. Lo que sí cambia
// de verdad es el LOG: las frases con las que baileys cuenta cómo le fue
// (`appstate.sync_baileys fase=…`) son las que distinguen "el sync no corría"
// de "corre pero falta la clave" — y esa distinción es la que mandó a
// re-vincular en vez de seguir buscando del lado del cliente.
//
// ── LO QUE HACE ESTE MÓDULO ─────────────────────────────────────────────────
//
// Pide `resyncAppState(faltantes, false)` —el método que baileys expone en el
// socket (`Socket/chats.js:1182`)— **sólo para las colecciones que no tienen
// estado local**. Es la reparación, no un reintento a ciegas:
//
//   · si baileys pudo hacer su sync inicial, las cinco tienen estado y acá no sale
//     ni una consulta;
//   · si una colección ya tiene estado, no se toca: WhatsApp la mantiene al día
//     sola con los `server_sync`;
//   · `isInitialSync: false` a propósito. Con `true`, `processSyncAction` filtra
//     las actualizaciones de chat contra el buffer del history sync
//     (`getChatUpdateConditional`, `Utils/chat-utils.js:198`), que fuera de una
//     sincronización inicial está vacío ⇒ se tirarían casi todas. Los nombres
//     (`contactAction` y `lidContactAction`) no dependen de esa bandera.
//
// ── LAS COLECCIONES **ESTACIONADAS** (y por qué el reporte mentía) ───────────
//
// Cuando a un parche le falta la clave de descifrado, baileys lo reintenta con
// snapshot y, al segundo fallo, **estaciona** la colección
// (`isMissingKeyError && attemptsMap[name] >= MAX_SYNC_ATTEMPTS`,
// `Socket/chats.js:519-525`, con `MAX_SYNC_ATTEMPTS = 2`).
//
// Una colección estacionada **tiene estado local**: quedó en la versión vieja,
// la de antes de que faltara la clave. Y ahí estaba el bug de este módulo:
// contábamos "resuelta" a la que TENÍA ESTADO, no a la que había quedado AL DÍA.
// En la cuenta real eso se leía así, todo junto y todo mentira:
//
//   WARN  regular_high blocked on missing key from v23, parking after 2 attempts
//   WARN  regular_low  blocked on missing key from v68, parking after 2 attempts
//   INFO  appstate.resync_ok … resueltas=5 faltan=ninguna
//
// Y peor que la línea: con las cinco "con estado", `appstate.completo` ponía
// `listo` y la reparación automática **se apagaba para todo el proceso**.
//
// ── CÓMO SE SABE QUE UNA COLECCIÓN SE ESTACIONÓ ─────────────────────────────
//
// No se puede preguntar: `blockedCollections` es un `Set` local del closure de
// `makeChatsSocket` (`Socket/chats.js:55`) y **no sale en el objeto que devuelve
// el socket** (verificado en el `return` de `:1160-1195`). Lo único observable
// desde afuera es el `logger.warn` de `:522`, con el texto exacto
// `"<colección> blocked on missing key from v<N>, parking after <M> attempts"`.
//
// Ese aviso YA nos llega: el logger de baileys es el nuestro
// (`createBaileysLogger`, `wa/socket.ts`), así que alcanza con leerlo al pasar
// (`onAviso`, más abajo). Los dos avisos que dicen lo contrario —`synced <col> to
// vN` (`:497`) y `restored state of <col> from snapshot to vN` (`:487`)— sacan la
// marca: si la clave llegó y baileys re-sincronizó solo
// (`ev.on('creds.update', {myAppStateKeyId})`, `:1115-1128`), la colección deja de
// estar estacionada sin que nosotros hagamos nada.
//
// Es leer un string del fuente de otra librería, sí. Por eso hay un test que lo
// fija (`test/appstate.test.ts`) y por eso el día que baileys cambie la frase el
// efecto es el de ANTES de este arreglo (contar de más), nunca uno peor.
//
// ── QUÉ SE HACE CON UNA ESTACIONADA (y qué NO) ──────────────────────────────
//
// Cuenta como PENDIENTE: no hay `appstate.completo` con una estacionada, y el
// chequeo diferido la vuelve a pedir en la próxima conexión. Es lo único que
// puede destrabarla si la clave llegó, y es exactamente lo que hace `Ctrl-N`.
//
// Y se pide **desde cero**: antes de reintentarla se borra su estado local, así
// la MISMA stanza pasa de "mandame los parches desde v68" —que es lo que no se
// puede descifrar— a "mandame el snapshot completo" (`return_snapshot` sólo se
// pone con la versión en 0, `Socket/chats.js:456-462`). No es una idea: en el
// resync de la cuenta real, las dos colecciones que entraron bien
// (`critical_block`, `critical_unblock_low`) fueron justamente las que no tenían
// estado local, y las tres que se pidieron desde su versión (v23, v30, v68)
// quedaron estacionadas.
//
// Pero con TOPE, porque puede no alcanzar:
//
//   · **la clave no se puede pedir** — en baileys 7.0.0-rc14 no existe
//     `APP_STATE_SYNC_KEY_REQUEST` (0 apariciones en `lib/`): sólo entra por un
//     `APP_STATE_SYNC_KEY_SHARE` que manda el teléfono
//     (`Utils/process-message.js:278-293`). Del lado del cliente no hay palanca;
//   · **si el snapshot también viene con una clave que no tenemos**, se vuelve a
//     estacionar y no hay nada más que probar desde acá.
//
// Así que reintentar cada 30 s para siempre sería martillar a WhatsApp por algo
// que sólo puede resolver el teléfono (R2). El tope es `MAX_REPARACIONES` —el
// mismo que ya tenía el módulo, una reparación por conexión—, el pedido desde
// cero es UNO por colección y por proceso, y cuando se alcanza el tope queda
// dicho en el log (`appstate.tope_alcanzado`, con `salida=Ctrl-N`).
//
// ── COSTO EN CONSULTAS (R2/R8: nada de martillar a WhatsApp) ────────────────
//
// `resyncAppState` manda **una** stanza `iq w:sync:app:state` por vuelta de su
// bucle, con todas las colecciones pendientes adentro (`Socket/chats.js:434-479`).
// Una reparación son, como mucho, `MAX_SYNC_ATTEMPTS` (2) vueltas —el intento
// normal y el forzado con snapshot— más las vueltas que pida el propio WhatsApp
// con `has_more_patches`, que es el paginado del protocolo. Y las reparaciones
// automáticas están topeadas en `MAX_REPARACIONES` por proceso, una por conexión
// y recién `ESPERA_TRAS_ABRIR_MS` después de abrir.
import { ALL_WA_PATCH_NAMES } from "baileys";
import type { WAPatchName } from "baileys";

import type { Logger } from "../boot/log";
import type { Cancelar } from "../state/store";

/** Las cinco colecciones de app-state, tal como las nombra WhatsApp. */
export const COLECCIONES: readonly WAPatchName[] = ALL_WA_PATCH_NAMES;

/**
 * Cuánto se espera después de que la conexión ABRE antes de mirar si falta algo.
 *
 * No es un número al azar: baileys se da a sí mismo 20 s para su sincronización
 * inicial (`awaitingSyncTimeout`, `Socket/chats.js:1099-1110`). Esperando más que
 * eso, cuando llegamos a mirar el estado local baileys ya terminó —y entonces no
 * falta nada y no sale ninguna consulta— o ya se dio por vencido. Es lo que
 * convierte esto en una reparación y no en una carrera contra la librería.
 */
export const ESPERA_TRAS_ABRIR_MS = 30_000;

/**
 * Tope de reparaciones AUTOMÁTICAS por proceso. Con una por conexión, esto es lo
 * que separa "reparar" de "insistir": si a la tercera sigue faltando, insistir
 * cada vez que la red se corte y vuelva es exactamente el ritmo de bot que evita
 * R2. La salida queda en `Ctrl-N`.
 *
 * Es TAMBIÉN el tope de los reintentos de una colección **estacionada**: sin la
 * clave —que sólo puede mandar el teléfono— volver a pedirla da siempre el mismo
 * resultado, así que después del tercer intento se frena y se dice en el log.
 */
export const MAX_REPARACIONES = 3;

/**
 * Espera mínima entre dos `force()`. La tecla es GLOBAL (anda con la ayuda
 * abierta y con el campo de redacción enfocado), así que sin esto un `Ctrl-N`
 * apretado de nervioso son dos stanzas por pulsación. La guarda de "ya hay uno en
 * curso" no alcanza: el resync tarda menos de un segundo cuando WhatsApp contesta
 * rápido, y ahí las pulsaciones no se solapan, se encadenan.
 */
export const ESPERA_MANUAL_MS = 60_000;

/**
 * Clave de `meta` con la marca de "la reparación del sync completo ya se
 * intentó". Vive en la BASE (no en memoria) porque la reparación arrastra una
 * reconexión: si se pudiera repetir por proceso, un arranque tras otro sería un
 * ciclo de reconexiones contra WhatsApp (R2). El valor es el unixepoch del
 * intento, para poder mirarlo con `sqlite3` si algún día hay que revisarlo.
 */
export const META_SYNC_REPARADO = "appstate_sync_completo_intentado";

/** El estado local de una colección, tal como lo guarda baileys. */
type EstadoLocal = { version?: number } | undefined;

/**
 * Lo que NO está al día, partido en las dos formas de no estarlo:
 *  · `sinEstado` — nunca se sincronizó (no hay `app-state-sync-version-*.json`);
 *  · `estacionadas` — tiene estado local pero baileys la trabó por una clave que
 *    falta (ver el encabezado).
 * `todas` es la unión, que es lo que se pide y lo que decide si falta algo.
 */
export type Pendientes = {
  sinEstado: WAPatchName[];
  estacionadas: WAPatchName[];
  todas: WAPatchName[];
};

export type AppStateSync = {
  /**
   * La conexión abrió: agenda el chequeo diferido. Idempotente por conexión —
   * llamarlo dos veces no agenda dos.
   */
  onOpen(): void;
  /**
   * Fuerza el resync de las CINCO colecciones, ya. Es la tecla del usuario: la
   * única forma de volver a pedir una colección estacionada, por si la clave que
   * faltaba llegó. Nunca lanza.
   */
  force(): void;
  /**
   * Un aviso de baileys, tal cual lo escribió (lo pasa `createBaileysLogger`).
   * De acá sale lo único que baileys no expone de otra forma: qué colección quedó
   * **estacionada** por una clave que falta, y cuál volvió a sincronizar. Nunca
   * lanza: la llama el logger, adentro del camino de la conexión.
   */
  onAviso(texto: string): void;
  /** Corta lo agendado. Lo usa el cierre ordenado. */
  stop(): void;
};

export type AppStateDeps = {
  log: Logger;
  /**
   * Qué hay guardado en LOCAL de cada colección. Sale de
   * `sock.authState.keys.get("app-state-sync-version", nombres)`: es una lectura
   * de `creds/`, no toca la red.
   */
  localState(names: readonly WAPatchName[]): Promise<Record<string, EstadoLocal>>;
  /** `sock.resyncAppState`. Esta SÍ habla con WhatsApp. */
  resync(names: readonly WAPatchName[], isInitialSync: boolean): Promise<void>;
  /** Agendador. Default `setTimeout`; el test le pasa uno manual. */
  schedule?: (fn: () => void, ms: number) => Cancelar;
  /** Reloj en ms. Default `Date.now` (mismo criterio que `state/store.ts`). */
  now?: () => number;
  /** Aviso por el pie de la interfaz. Sólo lo usa el camino manual. */
  toast?: (texto: string) => void;

  // ── la reparación del sync completo (ver el encabezado) ───────────────────
  //
  // Las cinco son OPCIONALES y van juntas: sin ellas este módulo se comporta
  // como antes (repara pidiendo colecciones y nada más). Es lo que deja armarlo
  // en un test —o en la demo— sin socket ni base.

  /** `creds.accountSyncCounter`. `null` = todavía no hay creds cargadas. */
  syncCounter?: () => number | null;
  /** Lo pone en 0 y lo persiste (`wa/socket.ts`). `true` si pudo. */
  resetSyncCounter?: () => Promise<boolean>;
  /** Reconectar: es lo que hace que baileys rehaga su máquina de sincronización. */
  reconnect?: () => void;
  /** ¿La reparación ya se intentó alguna vez? (marca en `meta`, sobrevive al proceso). */
  yaReparado?: () => boolean;
  /** Deja la marca. Se llama ANTES de tocar nada: una reparación a medias no se repite. */
  marcarReparado?: () => void;
  /**
   * Borra el estado local de esas colecciones (el `app-state-sync-version-*` de
   * `creds/`), para que el próximo resync las pida **desde cero**.
   *
   * POR QUÉ EXISTE: es lo único que convierte la MISMA stanza en una pregunta
   * distinta. `resyncAppState` manda `version: <la local>` y pone
   * `return_snapshot` sólo si la versión es 0 (`Socket/chats.js:456-462`), así
   * que una colección estacionada se sigue pidiendo desde su versión vieja y el
   * servidor sigue contestando los mismos parches, cifrados con la misma clave
   * que falta. Con el estado en cero la pregunta pasa a ser "mandame el
   * SNAPSHOT completo", que es otra respuesta y otra clave.
   *
   * La evidencia de que sirve está en la cuenta real: en el mismo resync,
   * `critical_block` y `critical_unblock_low` —las dos que NO tenían estado
   * local, o sea las que se pidieron desde cero— entraron sin problema,
   * mientras que las tres que se pidieron desde su versión (v23, v30, v68)
   * quedaron estacionadas.
   *
   * No se pierde nada: ese archivo es la versión del LTHash, no los datos. Lo
   * que la colección tenga se vuelve a aplicar con el snapshot.
   */
  resetLocalState?: (names: readonly WAPatchName[]) => Promise<void>;
};

const agendarReal = (fn: () => void, ms: number): Cancelar => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

function motivo(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Para el log: `"regular,regular_low"`. Vacío ⇒ `"ninguna"`. */
function lista(names: readonly string[]): string {
  return names.length > 0 ? names.join(",") : "ninguna";
}

// ── los avisos de baileys que hablan de app-state ───────────────────────────
//
// Las tres frases son literales de `Socket/chats.js` y están ancladas con `^…$`
// (salvo la del snapshot, que sigue con `with mutations`): cualquier otra línea
// de baileys —y son muchas— no puede caer por accidente en ninguna.

/** `:522` — la colección quedó trabada por una clave que falta. */
const RE_ESTACIONADA = /^(\S+) blocked on missing key from v\d+, parking after \d+ attempts$/;
/** `:497` — la colección avanzó con los parches. */
const RE_SINCRONIZADA = /^synced (\S+) to v\d+$/;
/** `:487` — la colección se rehizo desde el snapshot completo. */
const RE_SNAPSHOT = /^restored state of (\S+) from snapshot to v\d+/;

/**
 * Las frases con las que baileys cuenta qué hizo su máquina de sincronización
 * inicial (`Socket/chats.js`). No cambian ninguna decisión: son el ÚNICO rastro
 * de si el sync completo llegó a correr, y por eso la reparación del contador
 * (ver el encabezado) las deja en el log. Sin esto, "reseteé el contador" no se
 * distingue de "reseteé el contador y no sirvió".
 */
const AVISOS_SYNC: ReadonlyArray<readonly [RegExp, string]> = [
  [/^First connection, awaiting history sync/, "esperando_historial"], // :1096
  [/^Transitioned to Syncing state$/, "sincronizando"], // :1082
  [/^Doing app state sync$/, "app_state_corriendo"], // :1095
  [/^App state sync complete/, "app_state_ok"], // :1100
  [/^Timeout in AwaitingInitialSync/, "timeout_sin_historial"], // :1101
  [/^Reconnection with existing sync data/, "salteado_por_contador"], // :1089
];

/** En qué anda la sincronización inicial de baileys, o `null`. */
export function leerAvisoSync(texto: string): string | null {
  const t = String(texto ?? "");
  for (const [re, fase] of AVISOS_SYNC) if (re.test(t)) return fase;
  return null;
}

/**
 * Qué dice un aviso de baileys sobre una colección, o `null` si no habla de
 * ninguna. Es PURA y se exporta para el test: es el único punto del proyecto que
 * depende del TEXTO de otra librería, así que tiene que poder fijarse.
 */
export function leerAviso(texto: string): { name: WAPatchName; estacionada: boolean } | null {
  const t = String(texto ?? "");
  for (const [re, estacionada] of [
    [RE_ESTACIONADA, true],
    [RE_SINCRONIZADA, false],
    [RE_SNAPSHOT, false],
  ] as const) {
    const m = re.exec(t);
    // Sólo los cinco nombres conocidos: un aviso con otra forma no puede meter
    // basura en el conjunto de estacionadas.
    if (m && (COLECCIONES as readonly string[]).includes(m[1] as string)) {
      return { name: m[1] as WAPatchName, estacionada };
    }
  }
  return null;
}

export function createAppStateSync(deps: AppStateDeps): AppStateSync {
  const { log, localState, resync } = deps;
  const agendar = deps.schedule ?? agendarReal;
  const ahora = deps.now ?? Date.now;

  let cancelar: Cancelar | null = null;
  /** Cuándo arrancó el último `force()`. `0` = nunca. */
  let ultimoManual = 0;
  let detenido = false;
  /** Hay un resync en vuelo: ni el automático ni el manual pueden solaparse. */
  let enVuelo = false;
  /** Reparaciones automáticas ya lanzadas (las manuales no cuentan). */
  let reparaciones = 0;
  /**
   * No hay nada más que reparar solo: o están las cinco al día, o ya se vio que
   * pedirlas no las trae. En los dos casos seguir agendando sería consultar de
   * gusto.
   */
  let listo = false;
  /**
   * Las colecciones que baileys dejó ESTACIONADAS por una clave que falta. Se
   * llena leyendo sus avisos (`onAviso`) porque no hay forma de preguntarlo (ver
   * el encabezado). Tener estado local y estar acá adentro son cosas distintas:
   * la estacionada tiene las dos.
   */
  const estacionadas = new Set<WAPatchName>();
  /** La reparación de fondo ya se disparó en ESTE proceso (la otra guarda es `meta`). */
  let syncReparado = false;
  /** Colecciones a las que ya se les borró el estado local para pedirlas desde cero. */
  const desdeCero = new Set<WAPatchName>();

  /**
   * Qué NO está al día. Es la corrección del bug del encabezado: "tiene estado
   * local" ya no alcanza para contarla resuelta.
   *
   * Nunca lanza: devuelve `null` si no se pudo leer el estado local.
   */
  async function pendientes(): Promise<Pendientes | null> {
    let estado: Record<string, EstadoLocal>;
    try {
      estado = await localState(COLECCIONES);
    } catch (e) {
      log.warn("appstate.estado_local_fallido", { motivo: motivo(e) });
      return null;
    }
    const sinEstado = COLECCIONES.filter((n) => !estado?.[n]);
    // Las dos listas se PISAN a propósito: una colección puede no tener estado
    // local **y** estar trabada (pasa justo después de pedirla desde cero, ver
    // `resetLocalState`). `todas` es la unión sin repetidos, que es lo que se
    // pide; si `estacionadas` excluyera a las que no tienen estado, esa
    // colección se leería como "WhatsApp no tiene nada acá" y la reparación se
    // apagaría por el corte de "sin novedades".
    const trabadas = COLECCIONES.filter((n) => estacionadas.has(n));
    const todas = COLECCIONES.filter((n) => !estado?.[n] || estacionadas.has(n));
    return { sinEstado, estacionadas: trabadas, todas };
  }

  /**
   * Pide el resync y **deja en el log qué pasó**: cuáles se pidieron, cuánto
   * tardó y cuáles quedaron resueltas. Sin esto, la próxima vez que la agenda no
   * llegue habría que volver a leer el fuente de baileys para entender nada.
   *
   * Devuelve las que SIGUEN faltando después del intento (`null` si no se pudo
   * saber), que es lo que decide si vale la pena volver a intentar.
   */
  async function correr(
    names: readonly WAPatchName[],
    origen: "auto" | "manual",
  ): Promise<Pendientes | null> {
    enVuelo = true;
    const t0 = Date.now();
    log.info("appstate.resync", {
      colecciones: lista(names),
      origen,
      intento: origen === "auto" ? reparaciones : 0,
    });
    // Las marcas viejas de lo que se está por pedir se sueltan ACÁ: si la
    // colección sigue trabada, baileys la vuelve a estacionar adentro de este
    // mismo `await` (su `attemptsMap` es por llamada, `Socket/chats.js:425`) y el
    // aviso nos llega antes de que la promesa resuelva. Sin esto, una colección
    // que se destrabó por un camino que no loguea `synced` quedaría marcada para
    // siempre.
    for (const n of names) estacionadas.delete(n);
    try {
      // `isInitialSync: false`: ver el encabezado. Con `true` se perderían las
      // actualizaciones de chat por el filtro contra el buffer del history sync.
      await resync(names, false);
    } catch (e) {
      log.warn("appstate.resync_fallido", {
        colecciones: lista(names),
        origen,
        ms: Date.now() - t0,
        motivo: motivo(e),
      });
      enVuelo = false;
      return null;
    }
    const ms = Date.now() - t0;
    const siguen = await pendientes();
    enVuelo = false;
    log.info("appstate.resync_ok", {
      colecciones: lista(names),
      origen,
      ms,
      // Las que quedaron AL DÍA de verdad —no las que "tienen estado"—, que es
      // justo lo que este campo contaba mal. `-1` = no se pudo leer el estado.
      resueltas: siguen === null ? -1 : names.filter((n) => !siguen.todas.includes(n)).length,
      faltan: siguen === null ? "?" : lista(siguen.todas),
      // Las trabadas por una clave que falta, dichas por su nombre: son las que
      // antes se contaban como resueltas y dejaban el `faltan=ninguna` mentiroso.
      estacionadas: siguen === null ? "?" : lista(siguen.estacionadas),
    });
    return siguen;
  }

  /**
   * La reparación de FONDO: volver a habilitar la sincronización inicial
   * completa de baileys (ver el encabezado). Devuelve `true` si la disparó —y
   * entonces viene una reconexión, así que no hay que pedir nada más acá—.
   *
   * Las cuatro guardas, en orden, son todo lo que la separa de un ciclo de
   * reconexiones: que esté cableada, que no se haya hecho ya en este proceso,
   * que no se haya hecho nunca (marca en `meta`) y que el diagnóstico DÉ.
   */
  async function repararSyncCompleto(p: Pendientes): Promise<boolean> {
    if (!deps.resetSyncCounter || !deps.reconnect) return false;
    if (syncReparado || deps.yaReparado?.()) return false;

    const contador = deps.syncCounter?.() ?? null;
    // Con el contador en 0 no hay nada que reparar: baileys va a intentar el
    // sync completo solo en la próxima conexión. Y sin creds cargadas (`null`)
    // no se toca nada a ciegas.
    if (contador === null || contador <= 0) return false;

    syncReparado = true;
    // La marca va ANTES de tocar nada: si el proceso se cae en el medio —o si
    // el reset falla— esto NO se puede repetir en el próximo arranque. Una
    // reparación que arrastra una reconexión no puede quedar a merced de un
    // camino de error (R2).
    deps.marcarReparado?.();
    log.warn("appstate.sync_completo_reparando", {
      contador,
      faltan: lista(p.sinEstado),
      estacionadas: lista(p.estacionadas),
    });

    const ok = await deps.resetSyncCounter();
    if (!ok) {
      log.warn("appstate.sync_completo_no_reseteado", { contador });
      return false;
    }
    // Con el contador en 0 hace falta una conexión NUEVA: la máquina de sync de
    // baileys se decide al abrir, y la que está viva ya decidió que no.
    deps.toast?.("rehaciendo la sincronización inicial de la agenda…");
    log.info("appstate.sync_completo_reconectando");
    deps.reconnect();
    return true;
  }

  /** El chequeo diferido: mira qué falta y repara UNA vez. */
  async function reparar(): Promise<void> {
    if (detenido || listo || enVuelo) return;

    const p = await pendientes();
    if (detenido) return;
    // Sin poder leer el estado local no se pide nada: mandar un resync a ciegas
    // es justo la consulta que este módulo trata de no hacer.
    if (p === null) return;

    if (p.todas.length === 0) {
      listo = true;
      // Con una colección estacionada esto NO se emite: ahí está la diferencia
      // entre "las cinco tienen estado" y "las cinco están al día".
      log.info("appstate.completo", { colecciones: lista(COLECCIONES) });
      return;
    }

    // ANTES de pedir nada: si se puede rehacer la sincronización inicial, ése es
    // el arreglo de fondo (el resync nuestro es el parche). Y arrastra una
    // reconexión, así que una stanza pedida acá se perdería con el socket.
    if (await repararSyncCompleto(p)) return;
    if (detenido) return;

    reparaciones++;
    // Una colección ESTACIONADA se pide desde cero, no desde su versión vieja:
    // es la misma stanza, pero pidiendo el snapshot completo en vez de los
    // parches que no se pueden descifrar (ver `resetLocalState`). Una vez por
    // colección y por proceso: si el snapshot tampoco entró, repetirlo es pedir
    // lo mismo.
    const aCero = p.estacionadas.filter((n) => !desdeCero.has(n));
    if (aCero.length > 0 && deps.resetLocalState) {
      try {
        await deps.resetLocalState(aCero);
        for (const n of aCero) desdeCero.add(n);
        log.info("appstate.desde_cero", { colecciones: lista(aCero) });
      } catch (e) {
        // Que no se pueda borrar el estado local no cancela el intento: se pide
        // desde la versión vieja, que es lo que se hacía antes.
        log.warn("appstate.desde_cero_fallido", { colecciones: lista(aCero), motivo: motivo(e) });
      }
      if (detenido) return;
    }
    // Se piden las que faltan Y las estacionadas: volver a pedir una estacionada
    // es lo único que puede destrabarla si la clave llegó (es lo que hace
    // `Ctrl-N`), y el costo está topeado por `MAX_REPARACIONES`.
    const siguen = await correr(p.todas, "auto");
    if (detenido) return;

    if (siguen !== null && siguen.todas.length === 0) {
      listo = true;
      return;
    }
    // El resync anduvo pero no trajo NINGUNA de las que faltaban: para WhatsApp
    // esas colecciones no tienen nada, y volver a pedirlas en cada reconexión
    // sería martillar sin ganar un nombre. Se frena acá; queda `Ctrl-N`.
    //
    // ⚠️ Salvo que lo que quede sea una ESTACIONADA: ahí "no trajo nada" es lo
    // esperado —falta una clave que sólo manda el teléfono, y puede llegar entre
    // dos conexiones—, así que no se apaga. El tope sigue siendo
    // `MAX_REPARACIONES`, unas líneas más abajo.
    if (siguen !== null && siguen.todas.length === p.todas.length && siguen.estacionadas.length === 0) {
      listo = true;
      log.info("appstate.sin_novedades", { colecciones: lista(siguen.todas) });
      return;
    }
    if (reparaciones >= MAX_REPARACIONES) {
      listo = true;
      log.warn("appstate.tope_alcanzado", {
        intentos: reparaciones,
        faltan: siguen === null ? "?" : lista(siguen.todas),
        estacionadas: siguen === null ? "?" : lista(siguen.estacionadas),
        // La salida deja de ser automática: se dice acá para no tener que
        // deducirlo leyendo este archivo.
        salida: "Ctrl-N",
      });
    }
  }

  /**
   * Agenda el chequeo diferido. Idempotente (una sola vez en vuelo) y con las
   * mismas guardas de siempre: nada que reparar, tope alcanzado o `stop`.
   */
  function agendarChequeo(): void {
    if (detenido || listo || cancelar || reparaciones >= MAX_REPARACIONES) return;
    cancelar = agendar(() => {
      cancelar = null;
      // Cuelga de un timer: no puede tirar nada hacia afuera.
      reparar().catch((e) => log.error("appstate.reparacion_fallida", { motivo: motivo(e) }));
    }, ESPERA_TRAS_ABRIR_MS);
  }

  return {
    onOpen() {
      agendarChequeo();
    },

    force() {
      if (detenido) return;
      if (enVuelo) {
        deps.toast?.("ya hay una sincronización de la agenda en curso");
        return;
      }
      // El espaciado va ANTES de cualquier stanza: apretar la tecla de nuevo no
      // le pregunta nada a WhatsApp, sólo dice cuánto falta (R2/R8).
      const falta = ultimoManual + ESPERA_MANUAL_MS - ahora();
      if (ultimoManual > 0 && falta > 0) {
        const s = Math.ceil(falta / 1000);
        log.info("appstate.manual_en_espera", { faltan_s: s });
        deps.toast?.(`recién sincronizada: probá de nuevo en ${s} s`);
        return;
      }
      ultimoManual = ahora();
      deps.toast?.("resincronizando la agenda…");
      // A mano se piden las CINCO, también las que ya tienen estado y las
      // estacionadas: es el único camino que puede destrabar una colección a la
      // que le faltaba la clave, si la clave finalmente llegó.
      correr(COLECCIONES, "manual")
        .then((siguen) => {
          if (detenido) return;
          if (siguen === null) {
            deps.toast?.("no se pudo resincronizar la agenda — mirá el log");
            return;
          }
          if (siguen.todas.length === 0) listo = true;
          // El aviso dice la MISMA verdad que el log: una colección trabada por
          // una clave que falta no es "sin datos", es algo que sólo puede
          // destrabar el teléfono, y decirle "sincronizada" al usuario sería
          // hacerle apretar la tecla de nuevo para siempre.
          deps.toast?.(
            siguen.todas.length === 0
              ? "agenda sincronizada"
              : siguen.estacionadas.length > 0
                ? `agenda: ${siguen.estacionadas.length} sin la clave (la manda el teléfono)`
                : `agenda sincronizada, sin datos de ${siguen.todas.length}`,
          );
        })
        // `correr` ya suelta `enVuelo` en los dos caminos: esto es por si tira el
        // `then` de arriba, y no puede subir a ningún lado (lo llama una tecla).
        .catch((e) => log.error("appstate.force_fallido", { motivo: motivo(e) }));
    },

    onAviso(texto) {
      // Cómo le fue a la sincronización inicial de baileys. No cambia ninguna
      // decisión: es el rastro que dice si la reparación del contador sirvió
      // (`app_state_ok`) o si el problema es otro —el servidor no manda el
      // historial (`timeout_sin_historial`), o el contador sigue tapándolo
      // (`salteado_por_contador`)—.
      const fase = leerAvisoSync(texto);
      if (fase) {
        log.info("appstate.sync_baileys", { fase });
        return;
      }
      const a = leerAviso(texto);
      if (!a) return;
      if (a.estacionada) {
        // La línea propia es para que el log diga que NOSOTROS nos enteramos (la
        // suya baileys ya la escribió). Sólo cuando la marca CAMBIA: dentro de un
        // mismo resync baileys puede avisar por varias colecciones, y una que
        // vuelve a trabarse después de que la pedimos sí es novedad.
        if (!estacionadas.has(a.name)) log.warn("appstate.estacionada", { coleccion: a.name });
        estacionadas.add(a.name);
        // Una colección trabada es algo que reparar: si el chequeo ya se había
        // dado por terminado (las cinco tenían estado), vuelve a estar en juego
        // —siempre atado al tope de `MAX_REPARACIONES`, que no se resetea acá—.
        listo = false;
        // Y se vuelve a agendar EN ESTA sesión: WhatsApp empuja los cambios de
        // app-state con `server_sync` en cualquier momento, así que enterarse de
        // que algo se trabó suele pasar mucho después de los 30 s de haber
        // abierto. Esperar a la próxima reconexión sería esperar horas. La guarda
        // de "ya hay uno agendado" evita que tres colecciones trabadas en la
        // misma vuelta agenden tres chequeos.
        agendarChequeo();
        return;
      }
      if (estacionadas.delete(a.name)) log.info("appstate.destrabada", { coleccion: a.name });
    },

    stop() {
      detenido = true;
      cancelar?.();
      cancelar = null;
    },
  };
}
