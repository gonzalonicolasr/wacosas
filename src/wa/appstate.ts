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
// ── LO QUE **NO** HACE, Y POR QUÉ ───────────────────────────────────────────
//
// **No reintenta una colección estacionada.** Cuando a un parche le falta la clave
// de descifrado, baileys la reintenta con snapshot y, al segundo fallo, la
// **estaciona** (`isMissingKeyError && attemptsMap[name] >= MAX_SYNC_ATTEMPTS`,
// `Socket/chats.js:519-525`, con `MAX_SYNC_ATTEMPTS = 2`). Insistir desde acá no
// sirve, por tres motivos comprobados en el fuente:
//
//   1. **Ya hay dos reintentos y no son nuestros.** Baileys re-sincroniza las
//      estacionadas cuando llega la clave (`ev.on('creds.update', {myAppStateKeyId})`,
//      `Socket/chats.js:1115-1128`) y WhatsApp además empuja un `server_sync` por
//      cada cambio. Un tercero sólo suma consultas.
//   2. **Sin la clave el resultado es siempre el mismo.** El segundo intento ya
//      pidió el snapshot completo (`forceSnapshotCollections`, `:526-530`) y ese
//      snapshot venía cifrado con la misma clave que falta. Volver a pedirlo desde
//      v0 pide exactamente ese snapshot otra vez.
//   3. **La clave no se puede pedir.** En baileys 7.0.0-rc14 no existe
//      `APP_STATE_SYNC_KEY_REQUEST` (0 apariciones en `lib/`): la clave sólo entra
//      por un `APP_STATE_SYNC_KEY_SHARE` que manda el teléfono
//      (`Utils/process-message.js:278-293`). Del lado del cliente no hay palanca.
//
// Por eso la colección estacionada sólo se vuelve a pedir **a mano** (`force()`,
// la tecla `Ctrl-N`): si la clave llegó, ahí sirve; si no llegó, es una decisión
// del usuario y no un martilleo automático.
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

/** El estado local de una colección, tal como lo guarda baileys. */
type EstadoLocal = { version?: number } | undefined;

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
   * No hay nada más que reparar solo: o están las cinco, o ya se vio que pedirlas
   * no las trae. En los dos casos seguir agendando sería consultar de gusto.
   */
  let listo = false;

  /** Las colecciones SIN estado local. Nunca lanza: devuelve `null` si no se pudo. */
  async function faltantes(): Promise<WAPatchName[] | null> {
    try {
      const estado = await localState(COLECCIONES);
      return COLECCIONES.filter((n) => !estado?.[n]);
    } catch (e) {
      log.warn("appstate.estado_local_fallido", { motivo: motivo(e) });
      return null;
    }
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
  ): Promise<WAPatchName[] | null> {
    enVuelo = true;
    const t0 = Date.now();
    log.info("appstate.resync", {
      colecciones: lista(names),
      origen,
      intento: origen === "auto" ? reparaciones : 0,
    });
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
    const siguen = await faltantes();
    enVuelo = false;
    log.info("appstate.resync_ok", {
      colecciones: lista(names),
      origen,
      ms,
      // Las que entraron de verdad. `-1` = no se pudo leer el estado local.
      resueltas: siguen === null ? -1 : names.filter((n) => !siguen.includes(n)).length,
      faltan: siguen === null ? "?" : lista(siguen),
    });
    return siguen;
  }

  /** El chequeo diferido: mira qué falta y repara UNA vez. */
  async function reparar(): Promise<void> {
    if (detenido || listo || enVuelo) return;

    const faltan = await faltantes();
    if (detenido) return;
    // Sin poder leer el estado local no se pide nada: mandar un resync a ciegas
    // es justo la consulta que este módulo trata de no hacer.
    if (faltan === null) return;

    if (faltan.length === 0) {
      listo = true;
      log.info("appstate.completo", { colecciones: lista(COLECCIONES) });
      return;
    }

    reparaciones++;
    const siguen = await correr(faltan, "auto");
    if (detenido) return;

    if (siguen !== null && siguen.length === 0) {
      listo = true;
      return;
    }
    // El resync anduvo pero no trajo NINGUNA de las que faltaban: para WhatsApp
    // esas colecciones no tienen nada, y volver a pedirlas en cada reconexión
    // sería martillar sin ganar un nombre. Se frena acá; queda `Ctrl-N`.
    if (siguen !== null && siguen.length === faltan.length) {
      listo = true;
      log.info("appstate.sin_novedades", { colecciones: lista(siguen) });
      return;
    }
    if (reparaciones >= MAX_REPARACIONES) {
      listo = true;
      log.warn("appstate.tope_alcanzado", {
        intentos: reparaciones,
        faltan: siguen === null ? "?" : lista(siguen),
      });
    }
  }

  return {
    onOpen() {
      if (detenido || listo || cancelar || reparaciones >= MAX_REPARACIONES) return;
      cancelar = agendar(() => {
        cancelar = null;
        // Cuelga de un timer: no puede tirar nada hacia afuera.
        reparar().catch((e) => log.error("appstate.reparacion_fallida", { motivo: motivo(e) }));
      }, ESPERA_TRAS_ABRIR_MS);
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
          if (siguen.length === 0) listo = true;
          deps.toast?.(
            siguen.length === 0
              ? "agenda sincronizada"
              : `agenda sincronizada, sin datos de ${siguen.length}`,
          );
        })
        // `correr` ya suelta `enVuelo` en los dos caminos: esto es por si tira el
        // `then` de arriba, y no puede subir a ningún lado (lo llama una tecla).
        .catch((e) => log.error("appstate.force_fallido", { motivo: motivo(e) }));
    },

    stop() {
      detenido = true;
      cancelar?.();
      cancelar = null;
    },
  };
}
