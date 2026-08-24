// Ciclo de vida del socket de WhatsApp: UNO solo por proceso, con guard de
// identidad en todos los handlers, backoff afuera del socket y una máquina de
// cierre que decide qué hacer con cada código (design §5.6, §6.1, D5, D6).
//
// Las cuatro reglas que salen del prior art (`concesionaria-api/wa-worker/
// worker.mjs`, corriendo en producción) y que NO son negociables:
//
//   1. **`fetchLatestBaileysVersion()` antes de abrir** (CA-1.2/RNF-10). Con una
//      versión vieja WhatsApp corta con 405 y NUNCA emite el QR. Si la llamada
//      falla se sigue con la bundleada y queda la línea en el log (CA-1.3).
//   2. **Guard `if (s !== actual) return;` en TODOS los handlers** (D5, CA-15.6).
//      Un socket viejo que reescribe las creds después de que las borramos
//      resucita una sesión inválida y deja un loop de 401 eterno.
//   3. **El backoff se resetea al emitir un QR**, no sólo al abrir (D6). El 408
//      que llega después de un QR es "nadie lo escaneó", no un error de red: sin
//      el reset el segundo QR saldría a los 60 s y la pantalla de vinculación
//      sería inusable.
//   4. **Antes de descartar un socket**: `removeAllListeners()` + `end()`, y
//      recién después crear el nuevo (nunca hay dos vivos, CA-15.7/RNF-11).
//
// Y una que sale de `auth.ts`: **un `qr` durante una RECONEXIÓN significa que las
// creds no sirven** (CA-3.4). Por eso el `flujo` se calcula con `hasCreds()` (que
// mira `creds.me?.id`, el mismo criterio que baileys, no la mera existencia del
// archivo) en cada conexión.
//
// NINGÚN handler puede lanzar: una excepción adentro de un handler de Baileys se
// lleva puesta la conexión. Todos cierran contra un `try/catch` que loguea.
import {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion as fetchLatestBaileysVersionReal,
  makeWASocket as makeWASocketReal,
} from "baileys";
import type {
  BaileysEventMap,
  UserFacingSocketConfig,
  WAMessageKey,
  WASocket,
  WAVersion,
  proto,
} from "baileys";

import type { Logger } from "../boot/log";
import { reconnectDelayMs } from "../lib/backoff";
import type { Cancelar, Store } from "../state/store";
import { hardenCreds, hasCreds, loadAuth, wipeCreds, type Auth } from "./auth";
import type { Ingest } from "./ingest";

/**
 * Tope para resolver la versión de WhatsApp Web. `fetchLatestBaileysVersion`
 * pega a raw.githubusercontent.com y **descarta el `signal`** que uno le pase
 * (`Utils/generics.js:182` sólo reenvía `dispatcher` y `headers`), así que el
 * timeout tiene que ser nuestro: sin esto, una red que traga los paquetes deja
 * la vinculación colgada sin QR y sin explicación.
 */
export const VERSION_TIMEOUT_MS = 8_000;

/**
 * Cooldown entre el `end()` y el borrado de las creds en el camino 401/500
 * (§6.1 paso 7). Es el respiro del prior art para que el socket moribundo no
 * alcance a reescribir lo que estamos por borrar.
 */
export const COOLDOWN_WIPE_MS = 1_500;

/**
 * Eventos que consume el controlador. También son los que se dan de baja al
 * descartar. Se exporta para que el test pueda afirmar que **cada uno tiene su
 * handler**: agregar el nombre acá y olvidarse del `s.ev.on` deja el evento
 * "dado de baja" sin haber estado nunca enganchado, y no se nota hasta que falta
 * un dato en la pantalla.
 */
export const EVENTOS = [
  "connection.update",
  "creds.update",
  "messages.upsert",
  "messages.update",
  "message-receipt.update",
  "messaging-history.set",
  "chats.upsert",
  "chats.update",
  "contacts.upsert",
  "contacts.update",
  "groups.upsert",
  "groups.update",
  "lid-mapping.update",
  "chats.lock",
  "blocklist.set",
  "blocklist.update",
] as const satisfies readonly (keyof BaileysEventMap)[];

// ── logger de Baileys ───────────────────────────────────────────────────────

/** La forma que Baileys le pide al logger (su `ILogger`, que no re-exporta). */
type BaileysLogger = NonNullable<UserFacingSocketConfig["logger"]>;

/**
 * Nivel del logger de Baileys. **`info`** — y el camino hasta acá tiene historia,
 * porque cada escalón lo pagamos con un bug que tardó semanas:
 *
 *  · `silent` (copiado del prior art) nos tapó el aviso que decía textualmente qué
 *    estaba roto en la configuración del historial (`Socket/socket.js:33-37`, ver
 *    el comentario de `shouldSyncHistoryMessage` más abajo);
 *  · `warn` nos mostró que una colección de app-state quedaba **estacionada**
 *    ("blocked on missing key … parking after 2 attempts") pero NO si la
 *    sincronización llegaba a correr: `'Doing app state sync'` y `'App state sync
 *    complete'` son `info` (`Socket/chats.js:997` y `:1001`), igual que
 *    `'resyncing <col> from vN'` (`:454`), `'synced <col> to vN'` (`:497`) y las
 *    tres líneas que dicen qué rama de la máquina de sincronización se tomó
 *    (`:1081`, `:1090`, `:1095`). Sin esas cinco, el diagnóstico de por qué no
 *    llegaban los nombres de la agenda salió leyendo el fuente de Baileys.
 *
 * **Qué cuesta**, medido con un socket real contra WhatsApp y `creds/` temporal,
 * sin vincular: **3 líneas en 300 s** (0,6 por minuto; en `warn` fueron 0). El
 * repaso del fuente dice que en régimen tampoco escala: los `logger.info` de
 * Baileys son de UNA vez —por conexión (`Socket/socket.js`), por trozo de
 * historial (`Utils/process-message.js:246`) o por resync de app-state
 * (`Socket/chats.js`)— y **ninguno cuelga del camino de un mensaje**. El único que
 * depende del tráfico es `Signal/libsignal.js:92`, que sólo salta con un `pkmsg`
 * de un peer nuevo. Y la rotación de `boot/log.ts` (5 MB, un anterior) le pone
 * techo igual.
 *
 * `trace`/`debug` siguen afuera a propósito: Baileys compara `logger.level`
 * contra esos dos valores —y sólo contra esos dos— para decidir si serializa
 * nodos binarios enteros (`Socket/socket.js:75,450,466`), o sea que subirlo cuesta
 * CPU **y** volcaría contenido de mensajes al log (CA-14.7). Con `info` esas tres
 * comparaciones dan `false`, igual que con `warn`: el cambio no altera en nada lo
 * que Baileys hace, sólo lo que cuenta.
 */
export const NIVEL_BAILEYS = "info";

/**
 * Adaptador del logger de Baileys a nuestro logger de archivo (CA-16.2, CA-14.7).
 *
 * Por qué no es un `pino` con destino a un archivo: pino escribiría por su
 * cuenta a un fd, y lo único que no puede pasar acá es que algo toque stdout o
 * stderr crudo —la TUI está pintando ahí y una línea suelta le rompe el frame—.
 * El `ILogger` de Baileys son seis métodos; implementarlos contra
 * `boot/log.ts` es menos código que configurar un transport, y garantiza que
 * TODO pase por el filtro de campos prohibidos.
 *
 * Del aviso se queda **sólo el mensaje**: Baileys llama de las dos formas
 * (`warn("texto")` y `warn(obj, "texto")`) y ese `obj` puede traer un sobre
 * entero, con cuerpo y claves adentro. Se descarta sin mirarlo — y esto vale
 * igual para `info`, que es el nivel donde más objetos gordos viajan
 * (`logger.info({histNotification}, …)`, `Utils/process-message.js:246`). El texto
 * viaja en el campo `aviso`, que `fmtLinea` además recorta a 200 caracteres.
 * Ese descarte es lo que hace que subir el nivel NO pueda filtrar un cuerpo ni una
 * credencial al archivo (CA-14.7): lo único que se copia es una cadena literal del
 * fuente de Baileys.
 *
 * `onAviso` recibe ese mismo texto (nunca el objeto). Existe por una sola razón:
 * **hay cosas que Baileys no expone de ninguna otra forma**. La que nos importa es
 * qué colección de app-state quedó ESTACIONADA por una clave que falta —
 * `blockedCollections` es un `Set` local de su closure (`Socket/chats.js:55`), no
 * está en el socket, y el único rastro es este `warn` (ver `wa/appstate.ts`).
 */
export function createBaileysLogger(
  log: Logger,
  level: string = NIVEL_BAILEYS,
  onAviso?: (texto: string) => void,
): BaileysLogger {
  const escribir =
    (nivel: "info" | "warn" | "error") =>
    (obj: unknown, msg?: string): void => {
      const texto = typeof msg === "string" ? msg : typeof obj === "string" ? obj : "";
      log[nivel]("baileys", { aviso: texto || "(aviso sin texto)" });
      // Un oyente que lance se llevaría puesta la conexión: esto corre adentro
      // del camino de Baileys, no en un handler nuestro.
      try {
        onAviso?.(texto);
      } catch {
        /* leer un aviso no puede romper nada */
      }
    };
  const nada = (): void => {};

  const logger: BaileysLogger = {
    level,
    // Baileys hace `logger.child({class:"..."})` en varias capas. Devolver el
    // mismo objeto alcanza: el contexto del hijo iría al `obj` que igual se tira.
    child: () => logger,
    // `trace`/`debug` se tiran SIEMPRE, no según `level`: son los dos niveles que
    // vuelcan nodos binarios (CA-14.7) y ninguna versión de esta función los tiene
    // que poder escribir.
    trace: nada,
    debug: nada,
    info: level === "info" ? escribir("info") : nada,
    warn: escribir("warn"),
    error: escribir("error"),
  };
  return logger;
}

// ── máquina de cierre (pura) ────────────────────────────────────────────────

/**
 * Con qué intención se abrió el socket:
 *  · `link` — no hay sesión vinculada en disco: se ESPERA un QR.
 *  · `reconnect` — hay una sesión vinculada en disco (`creds.me.id`): un QR acá
 *    significa que dejó de servir (CA-3.4).
 */
export type Flow = "link" | "reconnect";

export type CloseCtx = {
  /** Intentos de reconexión acumulados (el backoff vive afuera del socket, D6). */
  attempt: number;
  /** ¿Este proceso llegó a ver algún QR? Si sí, la versión no es el problema. */
  sawQr: boolean;
};

export type CloseAction =
  /** 401/500: creds muertas ⇒ borrarlas y volver a vincular (CA-3.1). */
  | { kind: "wipe"; reason: string }
  /** 515: el cierre normal de después del escaneo ⇒ reabrir YA (CA-1.8). */
  | { kind: "respawn" }
  /** 405 sin haber visto nunca un QR ⇒ versión desactualizada (CA-1.4). */
  | { kind: "failed"; reason: string }
  /**
   * 440/403: frenar en seco, SIN reintento automático. Las creds siguen sirviendo
   * (no se borra nada) y la salida es manual (`Ctrl-R` ⇒ `reconnectNow`).
   */
  | { kind: "halt"; reason: string }
  /** Todo lo demás ⇒ backoff exponencial (CA-15.2). */
  | { kind: "reconnect"; attempt: number; delayMs: number };

export const MOTIVO_LOGGED_OUT = "la sesión fue desvinculada desde el teléfono";
export const MOTIVO_BAD_SESSION = "las credenciales locales dejaron de ser válidas";
export const MOTIVO_VERSION = "la versión de WhatsApp Web quedó desactualizada";
export const MOTIVO_QR_EN_RECONEXION = "las credenciales guardadas dejaron de servir";
export const MOTIVO_CONEXION_REEMPLAZADA =
  "otra sesión de WhatsApp Web tomó esta conexión — cerrala y apretá Ctrl-R";
export const MOTIVO_CUENTA_RECHAZADA =
  "WhatsApp rechazó la conexión de esta cuenta (403) — reintentar solo no la destraba";

/**
 * Motivo del wipe imposible. Va con el directorio adentro a propósito: "revisá
 * los permisos" sin decir CUÁL carpeta no le sirve a nadie.
 */
export const motivoWipeFallido = (dir: string): string =>
  `no se pudieron borrar las credenciales, revisá los permisos de ${dir}`;

/**
 * Qué hacer ante un `connection: "close"`. **Pura a propósito**: es la única
 * parte de este archivo que se puede testear sin socket ni red, y es donde vive
 * la diferencia entre "reconectar" y "perder la sesión".
 *
 * Ojo con el 405: sólo es "versión desactualizada" si NUNCA se vio un QR. Si ya
 * hubo uno, la versión está probada y ese 405 es otra cosa ⇒ backoff.
 *
 * El 440 y el 403 salen del backoff genérico que pedía CA-15.2 textualmente
 * (decisión tomada después de la revisión de la tarea 8, §6.1 no los nombraba):
 * reintentarlos es peor que no hacer nada, y el backoff ni siquiera protege
 * —cada conexión EXITOSA resetea el contador—, así que el 440 se quedaría pegado
 * en 2 s para siempre sin escalar nunca a 60. Ver el caso `halt` de `alCerrar`.
 */
export function decideOnClose(code: number | null | undefined, ctx: CloseCtx): CloseAction {
  const intentos = Number.isFinite(ctx?.attempt) ? Math.max(0, Math.floor(ctx.attempt)) : 0;

  switch (code) {
    case DisconnectReason.loggedOut: // 401
      return { kind: "wipe", reason: MOTIVO_LOGGED_OUT };
    case DisconnectReason.badSession: // 500
      return { kind: "wipe", reason: MOTIVO_BAD_SESSION };
    case DisconnectReason.restartRequired: // 515
      return { kind: "respawn" };
    case DisconnectReason.connectionReplaced: // 440
      return { kind: "halt", reason: MOTIVO_CONEXION_REEMPLAZADA };
    case DisconnectReason.forbidden: // 403
      return { kind: "halt", reason: MOTIVO_CUENTA_RECHAZADA };
    case 405:
      if (!ctx?.sawQr) return { kind: "failed", reason: MOTIVO_VERSION };
      break;
  }

  const attempt = intentos + 1;
  return { kind: "reconnect", attempt, delayMs: reconnectDelayMs(attempt) };
}

// ── contrato ────────────────────────────────────────────────────────────────

export type WaController = {
  /** Arranca el ciclo. No bloquea: la conexión se resuelve sola en background. */
  start(): void;
  /** Conecta en el acto, salteando lo que quede de backoff (CA-15.5). */
  reconnectNow(): void;
  /** Pide el código de 8 caracteres y lo publica en el slice `link` (CA-2.3). */
  requestPairingCode(phoneDigits: string): Promise<void>;
  isOpen(): boolean;
  /**
   * `creds.accountSyncCounter`, o `null` si todavía no se cargaron las creds.
   *
   * Es el contador que decide si Baileys va a hacer su sincronización INICIAL
   * completa: con `> 0` la saltea siempre (`Socket/chats.js:1089`). Ver
   * `resetSyncCounter`.
   */
  syncCounter(): number | null;
  /**
   * Pone `accountSyncCounter` en **0** y lo persiste. `true` si pudo.
   *
   * ── QUÉ ES ESTO Y POR QUÉ EXISTE ──────────────────────────────────────────
   *
   * Es la reparación del agujero que dejó la cuenta real con 844 contactos y 32
   * nombres. La secuencia, toda en `Socket/chats.js`:
   *
   *   1. primera conexión después de vincular: `syncState` va a
   *      `AwaitingInitialSync` y Baileys espera hasta **20 s** un mensaje de
   *      historial (`:1097-1099`, el tope está HARDCODEADO, no es configurable);
   *   2. si no llega a tiempo —899 chats tardan más—, salta el timeout, pasa a
   *      `Online` y, acá está el problema, **se auto-incrementa el contador**:
   *      `accountSyncCounter = (creds.accountSyncCounter || 0) + 1` (`:1104-1107`);
   *   3. desde entonces, TODA conexión ve `accountSyncCounter > 0` y se va
   *      derecho a `Online` (`:1086-1092`), así que `doAppStateSync` —el único
   *      lugar que sincroniza las CINCO colecciones de app-state (`:1092-1106`)—
   *      **no vuelve a correr nunca**. Ni reiniciando: el contador está en
   *      `creds.json`.
   *
   * Poniéndolo en 0 la próxima conexión vuelve a esperar el historial y, si
   * llega, rehace el sync completo. **Sin desvincular ni perder el historial
   * local**, que es la única otra salida que había.
   *
   * ⚠️ Lo que esto **no** puede hacer: traer las CLAVES de app-state que falten.
   * Esas sólo llegan por un `APP_STATE_SYNC_KEY_SHARE` del teléfono
   * (`Utils/process-message.js:278-293`) y Baileys no implementa el pedido
   * (`APP_STATE_SYNC_KEY_REQUEST`, 0 usos). Si una colección quedó estacionada
   * por una clave que no tenemos, el sync completo la va a volver a estacionar.
   *
   * Se escribe la MISMA propiedad que escribe Baileys y por el mismo camino
   * (mutar `creds` + `saveCreds`, igual que su handler de `creds.update`): no
   * hay un segundo formato ni un archivo aparte que se pueda desincronizar. Si
   * el `saveCreds` falla, el valor viejo se restaura en memoria — mentir sobre
   * lo que hay en disco sería peor que no haber intentado.
   */
  resetSyncCounter(): Promise<boolean>;
  /** SÓLO para `send.ts`/`read.ts`, que tienen que re-chequear en cada uso. */
  socket(): WASocket | null;
  /** Jid propio (crudo, como lo da WhatsApp) o `""` si todavía no hay sesión. */
  selfJid(): string;
  /** `end()` SIN `logout()`: cerrar la app no puede desvincular la cuenta (CA-17.1). */
  stop(opts?: { timeoutMs?: number }): Promise<void>;
};

export type WaDeps = {
  ingest: Ingest;
  store: Store;
  log: Logger;
  credsDir: string;
  /** Reloj en ms. Default `Date.now` (mismo criterio que `state/store.ts`). */
  now?: () => number;
  /**
   * Agendador. Default `setTimeout`; el test le pasa uno manual. Lo usan TODAS
   * las esperas de este archivo (backoff, cooldown del wipe, tope de la versión):
   * un solo mecanismo de tiempo, el mismo que `state/store.ts` y `wa/ingest.ts`.
   */
  schedule?: (fn: () => void, ms: number) => Cancelar;
  /** Fábrica del socket. El test inyecta un doble; producción usa `makeWASocket`. */
  makeSocket?: (config: UserFacingSocketConfig) => WASocket;
  /** Resolución de la versión de WhatsApp Web (CA-1.2). */
  fetchVersion?: () => Promise<{ version: WAVersion; isLatest: boolean; error?: unknown }>;
  /**
   * `getMessage` de §8.6: Baileys lo llama para re-cifrar un mensaje propio
   * cuando un peer pide reenvío. El `sentCache` que lo alimenta es de la tarea
   * 14; hasta entonces devolver `undefined` es exactamente lo que hace Baileys
   * sin la opción (ese mensaje puntual no se re-entrega).
   */
  getMessage?: (key: WAMessageKey) => Promise<proto.IMessage | undefined>;
  /**
   * Cada aviso de Baileys, como texto pelado. Lo usa `wa/appstate.ts` para
   * enterarse de qué colección quedó estacionada, que es un dato que Baileys no
   * publica de ninguna otra manera (ver `createBaileysLogger`). Nunca puede
   * lanzar hacia acá: el adaptador lo envuelve.
   */
  onAviso?: (texto: string) => void;
  /**
   * Las credenciales se BORRARON (401/500, o un QR durante una reconexión): lo
   * que venga después es otra sesión. Lo usa `index.tsx` para soltar las marcas
   * que eran de la anterior (hoy, la de la reparación del sync completo). Nunca
   * puede lanzar: corre adentro del camino de error del socket.
   */
  onCredsWiped?: () => void;
};

const agendarReal = (fn: () => void, ms: number): Cancelar => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

function motivo(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** El `statusCode` de Boom que trae el cierre, o `null` si el error no lo tiene. */
function codigoDe(err: unknown): number | null {
  const n = (err as { output?: { statusCode?: unknown } })?.output?.statusCode;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** `5491133445566:12@s.whatsapp.net` → `5491133445566`. */
function telefonoDe(id: string | undefined | null): string | null {
  const s = (id ?? "").split(":")[0]!.split("@")[0]!;
  return s || null;
}

// ── controlador ─────────────────────────────────────────────────────────────

export function createWaController(deps: WaDeps): WaController {
  const { ingest, store, log, credsDir } = deps;
  const ahora = deps.now ?? Date.now;
  const agendar = deps.schedule ?? agendarReal;
  const crearSocket = deps.makeSocket ?? makeWASocketReal;
  const traerVersion = deps.fetchVersion ?? (() => fetchLatestBaileysVersionReal());
  const getMessage = deps.getMessage ?? (async () => undefined);

  /** EL socket. `null` entre uno y otro; nunca hay dos a la vez (D5, RNF-11). */
  let actual: WASocket | null = null;
  /** Hay un `conectar()` en vuelo (todavía sin socket): cierra la ventana de carrera. */
  let conectando = false;
  /** `stop()` ya corrió: no se abre nada más. */
  let detenido = false;
  /** Intentos de reconexión. Vive ACÁ para sobrevivir a la muerte del socket (D6). */
  let intento = 0;
  /** ¿Este proceso vio algún QR? Decide el 405 (CA-1.4). */
  let vioQr = false;
  /** Con qué intención se abrió el socket vigente (CA-3.4). */
  let flujo: Flow = "link";
  /** Última versión de WhatsApp Web resuelta OK: se reusa si el fetch falla. */
  let versionCache: WAVersion | null = null;
  /**
   * ¿La conexión está abierta AHORA? Se lleva acá y no se lee del store porque
   * el snapshot está cacheado hasta el próximo flush (≤ 33 ms de atraso, D3) y
   * `send.ts`/`read.ts` van a preguntar `isOpen()` justo antes de tocar la red.
   */
  let abierto = false;

  /**
   * Las credenciales VIVAS (el mismo objeto que lee baileys) más su `saveCreds`.
   * Se guardan para poder tocar `accountSyncCounter` (ver `resetSyncCounter`):
   * es la única propiedad de `creds` que esta app escribe por su cuenta.
   */
  let auth: Auth | null = null;

  let cancelarReintento: Cancelar | null = null;

  // ── helpers de estado ─────────────────────────────────────────────────────

  function cancelarEspera(): void {
    cancelarReintento?.();
    cancelarReintento = null;
  }

  /** Espera sobre el agendador inyectado (no sobre `setTimeout` directo). */
  function esperar(ms: number): Promise<void> {
    return new Promise((resolver) => {
      agendar(() => resolver(), ms);
    });
  }

  /**
   * Mata un socket para siempre: baja los handlers y cierra el ws. Después de
   * esto sus eventos ya no llegan y, si llegaran, el guard los descarta igual.
   * Nunca lanza: se llama desde caminos de error.
   */
  function descartar(s: WASocket | null): void {
    if (!s) return;
    if (actual === s) {
      actual = null;
      abierto = false;
    }
    for (const ev of EVENTOS) {
      try {
        s.ev.removeAllListeners(ev);
      } catch {
        /* un evento que no se puede dar de baja no puede frenar a los otros */
      }
    }
    try {
      // `end()` devuelve una promesa que puede rechazar si el ws ya estaba roto.
      void Promise.resolve(s.end?.(undefined)).catch(() => {});
    } catch {
      /* ya estaba cerrado */
    }
  }

  /** Estado de conexión mientras se está marcando: primer intento vs. reintento. */
  function estadoDiscando(): "connecting" | "reconnecting" {
    return intento === 0 ? "connecting" : "reconnecting";
  }

  /**
   * Borra las creds y devuelve si PUDO. El resultado no se puede ignorar: los dos
   * caminos que llaman acá dejan `intento` en 0 y reconectan enseguida, así que
   * con las creds todavía en disco el próximo socket levanta la MISMA sesión
   * muerta, cierra con el mismo código y vuelve a caer acá ⇒ loop cada 1,5 s
   * (`COOLDOWN_WIPE_MS`) sin backoff que lo frene. Martillar a WhatsApp a ese
   * ritmo es el riesgo R2 del diseño: la cuenta real puede terminar baneada.
   *
   * Y no es un problema que se arregle solo esperando: si no se puede escribir en
   * el directorio (FS de sólo lectura, permisos del padre), la re-vinculación no
   * va a poder funcionar NUNCA. Se frena en `failed` con el path a revisar y la
   * salida queda en `Ctrl-R`, como en el 405.
   */
  function borrarCreds(motivoOriginal: string): boolean {
    const ok = wipeCreds(credsDir);
    log.info("wa.creds_borradas", { ok, motivo: motivoOriginal });
    if (ok) {
      // Lo que quedó en memoria ya no describe nada de lo que hay en disco: un
      // `saveCreds` sobre eso reescribiría la sesión que se acaba de borrar.
      auth = null;
      try {
        deps.onCredsWiped?.();
      } catch (e) {
        // Nunca hacia afuera: esto corre en el camino de error del socket.
        log.warn("wa.creds_wiped_hook_fallido", { motivo: motivo(e) });
      }
      return true;
    }

    log.error("wa.wipe_imposible", { dir: credsDir, motivo: motivoOriginal });
    store.setConn({ state: "offline", nextAttemptAt: null });
    store.setLink({
      phase: "failed",
      qr: null,
      pairingCode: null,
      pairingRequestedAt: null,
      reason: motivoWipeFallido(credsDir),
    });
    return false;
  }

  // ── versión de WhatsApp Web (CA-1.2/1.3, RNF-10) ──────────────────────────

  async function resolverVersion(): Promise<WAVersion | null> {
    let cancelarTope: Cancelar | null = null;
    try {
      const r = await new Promise<Awaited<ReturnType<typeof traerVersion>>>((resolver, rechazar) => {
        cancelarTope = agendar(
          () => rechazar(new Error(`timeout de ${VERSION_TIMEOUT_MS} ms`)),
          VERSION_TIMEOUT_MS,
        );
        traerVersion().then(resolver, rechazar);
      });
      // `fetchLatestBaileysVersion` NO rechaza cuando falla: devuelve la versión
      // bundleada con un `error` adentro. Si no se mira ese campo, un fallo de
      // red pasaría por éxito y CA-1.3 no se cumpliría nunca.
      if (r?.error !== undefined) throw r.error;
      if (!Array.isArray(r?.version)) throw new Error("respuesta sin versión");
      versionCache = r.version;
      log.info("wa.version.ok", { version: r.version.join("."), latest: !!r.isLatest });
      return r.version;
    } catch (e) {
      log.warn("wa.version.fallback", {
        motivo: motivo(e),
        // Sin cache se sigue con la que trae la librería (CA-1.3).
        usando: versionCache ? versionCache.join(".") : "bundleada",
      });
      return versionCache;
    } finally {
      // El tope tiene que morir sí o sí: si no, un timer suelto mantendría vivo
      // el event loop hasta 8 s después de cada conexión.
      (cancelarTope as Cancelar | null)?.();
    }
  }

  // ── conexión ──────────────────────────────────────────────────────────────

  async function conectar(): Promise<void> {
    // CA-15.7 / RNF-11: un solo socket. `conectando` tapa la ventana entre que
    // arranca este `await` y que el socket existe.
    if (detenido || actual || conectando) return;
    conectando = true;
    cancelarEspera();

    try {
      flujo = hasCreds(credsDir) ? "reconnect" : "link";
      store.setConn({ state: estadoDiscando(), nextAttemptAt: null });
      if (flujo === "reconnect") {
        // Con sesión vinculada se va derecho a la bandeja: el historial local ya
        // está y la TUI tiene que quedar navegable mientras conecta (CA-15.3).
        store.setLink({ phase: "linked", qr: null, reason: null });
      } else if (!store.getSnapshot("link").phase.startsWith("pairing")) {
        // Durante el pairing la pantalla la maneja la máquina de vinculación
        // (tarea 10): reciclar el socket no puede borrarle el código al usuario.
        //
        // Es la ÚNICA lectura del snapshot que queda en un camino de decisión, y
        // se banca el atraso del cache (D3): las fases `pairing-*` las escribe la
        // interfaz, y si la interfaz las está mostrando es porque ya hubo flush.
        store.setLink({ phase: "qr-waiting", qr: null });
      }
      log.info("wa.connect", { flujo, intento });

      const version = await resolverVersion();
      // Se guarda la referencia: `resetSyncCounter` necesita el MISMO objeto de
      // creds que va a leer baileys, no una copia leída del disco.
      auth = await loadAuth(credsDir);
      const { state, saveCreds } = auth;

      // El `stop()` pudo llegar mientras se resolvía la versión: no abrir nada.
      if (detenido) return;

      // ── opciones del socket ────────────────────────────────────────────────
      //
      // ⚠️ **`shouldSyncHistoryMessage` NO se overridea.** El diseño (§5.6) y el
      // prior art traían `shouldSyncHistoryMessage: () => false`, y eso dejaba la
      // bandeja VACÍA para siempre: 0 chats, 0 mensajes, 0 contactos con la
      // sesión conectada de verdad. Por qué, en el fuente:
      //
      //   · `Socket/chats.js:931-934` — `shouldProcessHistoryMsg =
      //     shouldSyncHistoryMessage(historyMsg) && PROCESSABLE_HISTORY_TYPES
      //     .includes(...)`. Con `() => false` el `&&` corta SIEMPRE, así que
      //     `messaging-history.set` no se emite NUNCA y el ingest no recibe un
      //     solo job. Y ese evento no es "mensajes viejos": el
      //     `INITIAL_BOOTSTRAP` es literalmente la lista de chats.
      //   · `Socket/socket.js:33-37` — Baileys detecta esta configuración y avisa
      //     ("DANGER: DISABLING ALL SYNC ... PREVENTS BAILEYS FROM ACCESSING
      //     INITIAL LID MAPPINGS"). El aviso estaba: lo tapaba el
      //     `pino({level:"silent"})` (ver `createBaileysLogger`).
      //   · `Defaults/index.js:65-67` — el default de Baileys es
      //     `({syncType}) => syncType !== HistorySyncType.FULL`, o sea: aceptá
      //     `INITIAL_BOOTSTRAP`, `RECENT` y `PUSH_NAME`, y dejá afuera sólo el
      //     volcado completo. Es exactamente lo que queremos ⇒ **no se overridea**.
      //
      // **De dónde salió**: la config se copió de `concesionaria-api/wa-worker/
      // worker.mjs`, que es un **bot** — sólo le importan los mensajes nuevos
      // entrantes y el historial le sobra. wacosas es un **cliente**: sin
      // historial no tiene nada que mostrar. No lo "optimices" de vuelta
      // copiando el worker.
      //
      // **Los dos parámetros del historial NO son el mismo**, y por eso uno se
      // queda y el otro se va:
      //
      //   · `syncFullHistory` es lo que **pedimos**: viaja como `requireFullSync`
      //     en el nodo de registro (`Utils/validate-connection.js:86`).
      //   · `shouldSyncHistoryMessage` es lo que **aceptamos** de lo que llega
      //     (`Socket/chats.js:931`).
      //
      // `syncFullHistory: false` es una **decisión tomada** (del usuario, no un
      // default olvidado): "reciente, no todo" — todos los chats con sus mensajes
      // recientes, que es lo que WhatsApp manda al vincular, sin el volcado
      // completo (que tarda mucho y engorda la base). Sin tope artificial nuestro
      // de chats: se evaluó y se descartó. Si algún día se activa el volcado
      // completo, hay que acordarse de que llega con `syncType: FULL`
      // (`Utils/history.js:50-53`) y que ENTONCES sí haría falta un
      // `shouldSyncHistoryMessage` propio que lo acepte — con el default se
      // descargaría y se tiraría (`Utils/process-message.js:244`).
      const s = crearSocket({
        ...(version ? { version } : {}),
        auth: state,
        browser: Browsers.ubuntu("Chrome"), // WA rechaza clientes sin browser
        // CA-16.2: nada a la terminal — pero sus avisos SÍ van a nuestro log (y,
        // de paso, al oyente que lee las colecciones estacionadas).
        logger: createBaileysLogger(log, NIVEL_BAILEYS, deps.onAviso),
        markOnlineOnConnect: false, // CA-15.8
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        getMessage, // §8.6
      });
      actual = s;

      // ── handlers. TODOS con el guard y TODOS envueltos: una excepción acá
      //    voltea la conexión entera.
      const guardado =
        <T,>(nombre: string, fn: (arg: T) => void) =>
        (arg: T): void => {
          if (s !== actual) return; // D5 / CA-15.6: socket viejo ⇒ no existe
          try {
            fn(arg);
          } catch (e) {
            log.error("wa.handler_fallido", { evento: nombre, motivo: motivo(e) });
          }
        };

      s.ev.on(
        "creds.update",
        guardado("creds.update", () => {
          // CA-3.3: sólo el socket vigente puede persistir credenciales.
          saveCreds().catch((e) => log.error("wa.creds_no_guardadas", { motivo: motivo(e) }));
        }),
      );

      s.ev.on(
        "connection.update",
        guardado("connection.update", (u: Partial<BaileysEventMap["connection.update"]>) =>
          alActualizarConexion(s, u),
        ),
      );

      s.ev.on(
        "messages.upsert",
        guardado("messages.upsert", (up: BaileysEventMap["messages.upsert"]) => {
          ingest.push({ kind: "messages", msgs: up?.messages ?? [], source: up?.type ?? "notify" });
        }),
      );

      s.ev.on(
        "messages.update",
        guardado("messages.update", (updates: BaileysEventMap["messages.update"]) => {
          ingest.push({ kind: "msg-updates", updates });
        }),
      );

      s.ev.on(
        "message-receipt.update",
        guardado("message-receipt.update", (receipts: BaileysEventMap["message-receipt.update"]) => {
          ingest.push({ kind: "receipts", receipts });
        }),
      );

      // El sync inicial: chats + contactos + mensajes viejos. Los mensajes van
      // como `history` porque NO suman no leídos (el contador absoluto llega en
      // los chats del mismo evento y sumar de a uno lo contaría dos veces).
      s.ev.on(
        "messaging-history.set",
        guardado("messaging-history.set", (h: BaileysEventMap["messaging-history.set"]) => {
          // Los pares LID ↔ número van PRIMERO: son el mapeo que le da sentido a
          // los nombres que vienen atrás. WhatsApp manda los nombres de la agenda
          // pegados al LID y los chats bajo el número; sin esto, la bandeja
          // muestra números (`Utils/history.js:42`).
          ingest.push({ kind: "aliases", pairs: h?.lidPnMappings ?? [] });
          ingest.push({ kind: "chats", chats: h?.chats ?? [] });
          ingest.push({ kind: "contacts", contacts: h?.contacts ?? [] });
          ingest.push({ kind: "messages", msgs: h?.messages ?? [], source: "history" });
        }),
      );

      s.ev.on(
        "chats.upsert",
        guardado("chats.upsert", (chats: BaileysEventMap["chats.upsert"]) => {
          ingest.push({ kind: "chats", chats });
        }),
      );

      s.ev.on(
        "chats.update",
        guardado("chats.update", (updates: BaileysEventMap["chats.update"]) => {
          ingest.push({ kind: "chat-updates", updates });
        }),
      );

      s.ev.on(
        "contacts.upsert",
        guardado("contacts.upsert", (contacts: BaileysEventMap["contacts.upsert"]) => {
          ingest.push({ kind: "contacts", contacts });
        }),
      );

      s.ev.on(
        "contacts.update",
        guardado("contacts.update", (contacts: BaileysEventMap["contacts.update"]) => {
          // `contacts.update` trae parciales; el ingest ya ignora lo que no sirve.
          ingest.push({ kind: "contacts", contacts: contacts as BaileysEventMap["contacts.upsert"] });
        }),
      );

      // El subject de un grupo. Sin estos dos, un grupo que aparece EN VIVO —o
      // que se renombra con la app abierta— se queda como "grupo sin nombre"
      // para siempre: `messaging-history.set` sólo trae el subject de los grupos
      // que entraron por la sincronización inicial.
      //   · `groups.upsert` — te acaban de meter en un grupo nuevo
      //     (`Socket/messages-recv.js:607`).
      //   · `groups.update` — cambió el asunto, o alguien pidió los metadatos
      //     (`Utils/process-message.js:485`, `Socket/groups.js:56`).
      s.ev.on(
        "groups.upsert",
        guardado("groups.upsert", (groups: BaileysEventMap["groups.upsert"]) => {
          ingest.push({ kind: "groups", groups });
        }),
      );

      s.ev.on(
        "groups.update",
        guardado("groups.update", (groups: BaileysEventMap["groups.update"]) => {
          ingest.push({ kind: "groups", groups });
        }),
      );

      // El par LID ↔ número que baileys aprende por su cuenta: del app-state
      // (`pnForLidChatAction`, `Utils/chat-utils.js:806`) o de un mensaje
      // entrante (`Socket/messages-recv.js:260`). Es la misma equivalencia que
      // trae el history sync, pero EN VIVO: un contacto que se renombra o un chat
      // que aparece después de la sincronización inicial.
      s.ev.on(
        "lid-mapping.update",
        guardado("lid-mapping.update", (par: BaileysEventMap["lid-mapping.update"]) => {
          ingest.push({ kind: "aliases", pairs: [par] });
        }),
      );

      // **Chat Lock**: los chats que el usuario escondió detrás de un código
      // secreto y que en el teléfono sólo aparecen si escribe ese código en el
      // buscador. Llega por app-state (`lockChatAction`,
      // `Utils/chat-utils.js:818`), o sea que sólo empezó a llegar cuando se
      // destrabaron las colecciones. Acá NO hay código que pedir: un chat con
      // candado no se lista, y punto.
      //
      // (`proto.IChatLockSettings.hideLockedChats` —el "mostrar chats
      // bloqueados" del teléfono— existe en el proto pero baileys NUNCA lo
      // emite: `processSyncAction` no tiene rama para `chatLockSettings`. No
      // llega, y aunque llegara no cambiaría nada de esto.)
      s.ev.on(
        "chats.lock",
        guardado("chats.lock", (l: BaileysEventMap["chats.lock"]) => {
          ingest.push({ kind: "chat-lock", locks: [{ jid: l?.id ?? "", locked: !!l?.locked }] });
        }),
      );

      // Contactos BLOQUEADOS. Son otra cosa que el candado y se guardan aparte.
      //
      // ⚠️ `blocklist.set` está declarado en el mapa de eventos
      // (`Types/Events.d.ts:117`) pero **baileys 7.0.0-rc14 no lo emite nunca**
      // (0 apariciones en `lib/`): el único que emite es `blocklist.update`, de a
      // UN jid por vez, desde la notificación `account_sync`
      // (`Socket/messages-recv.js:872-877`). Se engancha igual —cuesta tres
      // líneas y el día que baileys lo emita ya está—, pero la lista completa la
      // trae `pedirBloqueados()` al abrir; sin eso, alguien bloqueado desde antes
      // de instalar wacosas no se ocultaría nunca.
      s.ev.on(
        "blocklist.set",
        guardado("blocklist.set", (b: BaileysEventMap["blocklist.set"]) => {
          ingest.push({ kind: "blocklist", jids: b?.blocklist ?? [] });
        }),
      );

      s.ev.on(
        "blocklist.update",
        guardado("blocklist.update", (b: BaileysEventMap["blocklist.update"]) => {
          // El tipo es `'add' | 'remove'`, pero llega de la red: cualquier cosa
          // que no sea un `remove` explícito se trata como alta.
          ingest.push({
            kind: "block-updates",
            jids: b?.blocklist ?? [],
            op: b?.type === "remove" ? "remove" : "add",
          });
        }),
      );
    } catch (e) {
      // Falló armando la conexión (versión, auth, `makeWASocket`, enganchar un
      // handler): se trata como un cierre cualquiera para que el backoff lo
      // cubra y el proceso no quede mudo esperando un evento que no va a llegar.
      // El `descartar` es por si murió DESPUÉS de asignar `actual`: dejarlo ahí
      // a medio cablear trabaría todos los `conectar()` siguientes.
      log.error("wa.connect_fallido", { motivo: motivo(e) });
      descartar(actual);
      programarReintento();
    } finally {
      conectando = false;
    }
  }

  // ── connection.update ─────────────────────────────────────────────────────

  function alActualizarConexion(s: WASocket, u: Partial<BaileysEventMap["connection.update"]>): void {
    const hayQr = typeof u?.qr === "string" && u.qr !== "";
    if (hayQr) {
      alLlegarQr(s, u.qr as string);
      // El QR pudo haber descartado este socket (CA-3.4): re-chequear.
      if (s !== actual) return;
    }

    if (u?.connection === "open") return alAbrir(s);
    if (u?.connection === "close") return alCerrar(s, u.lastDisconnect?.error);
    // El `connecting` NO pisa lo que acaba de dejar el QR: baileys manda los dos
    // campos en el MISMO evento, y con el QR en pantalla el estado honesto es
    // "no hay sesión vinculada", no "conectando…" (ya está conectado: falta que
    // alguien escanee).
    if (u?.connection === "connecting" && !hayQr) {
      store.setConn({ state: estadoDiscando() });
    }
  }

  function alLlegarQr(s: WASocket, qr: string): void {
    vioQr = true;
    // D6: el 408 que sigue a un QR es "no lo escanearon", no un error de red.
    // Sin este reset el próximo QR saldría a los 60 s (lección de `worker.mjs`).
    intento = 0;
    // Y el ESTADO también cambia, no sólo el contador: un QR sobre la mesa no es
    // "reconectando", es que no hay sesión vinculada y WhatsApp está esperando
    // que alguien lo escanee. Resetear `attempt` dejando `state` en
    // `reconnecting` producía un `reconnecting` con `attempt: 0` —una
    // combinación que `ConnSnapshot` no contempla— y el badge terminaba
    // diciendo "reconectando · intento 0" (lo levantaron las revisiones de las
    // tareas 8 y 9; la guarda del `Header` se queda igual, como defensa).
    store.setConn({ state: "unlinked", attempt: 0, nextAttemptAt: null, selfPhone: null });
    // `intento` va SIEMPRE en 0 acá (lo acaba de resetear la línea de arriba):
    // es la evidencia en el log de que el backoff no se comió la vinculación.
    // El payload del QR NO se loguea (CA-14.7); sólo su largo.
    log.info("wa.qr", { flujo, largo: qr.length, intento });

    if (flujo === "reconnect") {
      // CA-3.4: había una sesión vinculada en disco y WhatsApp igual pide QR ⇒ no
      // sirven. Se borran y se vuelve a vincular UNA vez, nunca en loop: el
      // próximo `conectar()` ya arranca con flujo `link` y el QR es lo esperado.
      log.warn("wa.qr_con_creds", { flujo });
      descartar(s);
      store.setLink({
        phase: "need-link",
        qr: null,
        pairingCode: null,
        pairingRequestedAt: null,
        reason: MOTIVO_QR_EN_RECONEXION,
      });
      // El estado de conexión ya quedó en `unlinked` arriba, con el reset.
      esperar(COOLDOWN_WIPE_MS)
        .then(() => {
          // Si no se pudieron borrar, `borrarCreds` ya frenó todo: reconectar acá
          // sería volver a caer en este mismo camino cada 1,5 s.
          if (!borrarCreds(MOTIVO_QR_EN_RECONEXION)) return;
          if (!detenido) void conectar();
        })
        .catch((e) => log.error("wa.relink_fallido", { motivo: motivo(e) }));
      return;
    }

    // Baileys sigue rotando el QR aunque ya se haya pedido un código de
    // emparejamiento (`Socket/socket.js:711`: `genPairQR` se re-arma cada 20-60 s).
    // Pisar la fase acá le borraría el código de la pantalla al usuario a los ~20 s
    // — y en una pane de 24×80 el QR NO entra (mide 34×67, RNF-3), o sea que el
    // código es su único camino de vinculación. Mismo guard que en `conectar()`.
    // El payload igual se guarda: si vuelve al QR con `Tab` ve el vigente, no uno
    // vencido, y no tiene que esperar la próxima rotación.
    if (store.getSnapshot("link").phase.startsWith("pairing")) {
      store.setLink({ qr });
      return;
    }

    store.setLink({ phase: "qr-shown", qr, reason: null });
  }

  /**
   * Pide la lista COMPLETA de bloqueados, UNA vez por conexión abierta.
   *
   * Existe porque `blocklist.set` no lo emite nadie en esta versión de baileys
   * (ver el handler): sin esto sólo llegarían las altas y bajas que ocurran con
   * wacosas abierto, y los que ya estaban bloqueados seguirían en la bandeja para
   * siempre. Es **una** stanza `iq blocklist` por conexión —lo mismo que hace
   * WhatsApp Web al arrancar—, así que no mueve la aguja de R2/R8.
   *
   * Nunca lanza y nunca espera: cuelga de `alAbrir`, que corre adentro de un
   * handler de Baileys. La respuesta entra por la cola del ingest como un job
   * más, que es el único camino de escritura.
   */
  function pedirBloqueados(s: WASocket): void {
    if (typeof s.fetchBlocklist !== "function") return;
    let pendiente: Promise<(string | undefined)[]>;
    try {
      pendiente = Promise.resolve(s.fetchBlocklist());
    } catch (e) {
      log.warn("wa.blocklist_fallida", { motivo: motivo(e) });
      return;
    }
    pendiente.then(
      (jids) => {
        // Un socket reemplazado en el medio ⇒ esa lista ya no es de esta sesión.
        if (s !== actual) return;
        const limpios = (Array.isArray(jids) ? jids : []).filter((j): j is string => !!j);
        log.info("wa.blocklist", { bloqueados: limpios.length });
        ingest.push({ kind: "blocklist", jids: limpios });
      },
      (e: unknown) => log.warn("wa.blocklist_fallida", { motivo: motivo(e) }),
    );
  }

  function alAbrir(s: WASocket): void {
    intento = 0;
    abierto = true;
    // Abrir prueba la versión igual (o mejor) que un QR: un 405 posterior ya no
    // puede ser "versión desactualizada", así que la bandera NO se resetea acá.
    vioQr = true;
    const telefono = telefonoDe(s.user?.id);
    // Las creds recién escritas por el handshake: dejarlas 0600 (RNF-12). Una
    // sola pasada por apertura, no por `creds.update` (serían cientos).
    hardenCreds(credsDir);
    store.setConn({
      state: "open",
      attempt: 0,
      nextAttemptAt: null,
      lastCode: null,
      selfPhone: telefono,
    });
    store.setLink({ phase: "linked", qr: null, pairingCode: null, reason: null });
    log.info("wa.open", { flujo, telefono: telefono ? "sí" : "no" });
    // Después de publicar el estado: es red, y la pantalla no la espera.
    pedirBloqueados(s);
  }

  function alCerrar(s: WASocket, err: unknown): void {
    const code = codigoDe(err);
    const estabaAbierto = abierto;
    // Primero se mata el socket: todo lo que venga después de esta línea ya es
    // de un socket que no existe (y el guard lo descarta).
    descartar(s);
    store.setConn({ lastCode: code });

    const accion = decideOnClose(code, { attempt: intento, sawQr: vioQr });
    log.info("wa.close", { code, accion: accion.kind, intento, motivo: motivo(err) });

    switch (accion.kind) {
      case "respawn":
        // CA-1.8: el cierre normal de después del escaneo. Reabre YA, con las
        // creds recién guardadas, sin sumar al backoff y sin pedir QR de nuevo.
        log.info("wa.restart_required");
        // Si la sesión ya estaba abierta, la pantalla es la bandeja y ahí se
        // queda: sólo la vinculación en curso pasa por `restarting` (§6.1).
        if (!estabaAbierto) store.setLink({ phase: "restarting" });
        store.setConn({ state: estadoDiscando() });
        cancelarEspera();
        cancelarReintento = agendar(() => {
          cancelarReintento = null;
          void conectar();
        }, 0);
        return;

      case "wipe": {
        // CA-3.1: sesión muerta. La espera es el cooldown del prior art para que
        // el socket moribundo no reescriba lo que estamos por borrar. La BASE no
        // se toca: re-vincular no puede costarle el historial al usuario (CA-3.2).
        intento = 0;
        store.setConn({ state: "unlinked", attempt: 0, nextAttemptAt: null, selfPhone: null });
        store.setLink({
          phase: "need-link",
          qr: null,
          pairingCode: null,
          pairingRequestedAt: null,
          reason: accion.reason,
        });
        cancelarEspera();
        esperar(COOLDOWN_WIPE_MS)
          .then(() => {
            // Un wipe fallido NO se puede seguir de largo: con `intento` en 0 esto
            // sería un loop de reconexión cada 1,5 s sin backoff (ver `borrarCreds`).
            if (!borrarCreds(accion.reason)) return;
            if (!detenido) void conectar();
          })
          .catch((e) => log.error("wa.wipe_fallido", { motivo: motivo(e) }));
        return;
      }

      case "halt":
        // 440 `connectionReplaced` y 403 `forbidden`: reintentar es PEOR que no
        // hacer nada. El 440 no es un corte, es un desalojo —otra sesión de
        // WhatsApp Web tomó el slot—: reconectar echa al otro cliente, que
        // reconecta y nos echa a nosotros, con las dos puntas inutilizables. El
        // backoff tampoco salva, porque cada conexión EXITOSA lo resetea: el
        // ping-pong se queda clavado en 2 s y nunca escala a 60. El 403 es la
        // cuenta rechazada: insistir cada 60 s no la destraba.
        //
        // Las creds SIGUEN sirviendo (no es un 401), así que no se borra nada y
        // `link.phase` no se toca: sólo viaja el motivo. La salida es manual,
        // `Ctrl-R` ⇒ `reconnectNow()`, el mismo camino ya probado del 405.
        cancelarEspera();
        store.setConn({ state: "offline", nextAttemptAt: null });
        store.setLink({ reason: accion.reason });
        log.warn("wa.halt", { code, motivo: accion.reason });
        return;

      case "failed":
        // CA-1.4: 405 sin haber visto nunca un QR. NO se reintenta solo —
        // insistir con la misma versión da el mismo 405— pero tampoco se queda
        // en "conectando…": queda en `failed` con motivo y `Ctrl-R` a mano.
        store.setConn({ state: "offline", nextAttemptAt: null });
        store.setLink({ phase: "failed", qr: null, reason: accion.reason });
        return;

      case "reconnect":
        intento = accion.attempt;
        programarReintento(accion.delayMs);
        return;
    }
  }

  /**
   * Agenda el próximo intento. Sin `delayMs` suma uno al contador y calcula el
   * backoff (es el camino de "falló antes de tener socket").
   */
  function programarReintento(delayMs?: number): void {
    if (detenido) return;
    let espera = delayMs;
    if (espera === undefined) {
      const a = decideOnClose(null, { attempt: intento, sawQr: vioQr });
      if (a.kind !== "reconnect") return;
      intento = a.attempt;
      espera = a.delayMs;
    }
    const cuando = ahora() + espera;
    store.setConn({ state: "reconnecting", attempt: intento, nextAttemptAt: cuando });
    log.info("wa.reintento", { intento, en_ms: espera });
    cancelarEspera();
    cancelarReintento = agendar(() => {
      cancelarReintento = null;
      void conectar();
    }, espera);
  }

  // ── API ───────────────────────────────────────────────────────────────────

  return {
    start() {
      if (detenido) return;
      void conectar();
    },

    reconnectNow() {
      if (detenido) return;
      // CA-15.5: en el acto. Se recicla lo que haya —también un socket abierto o
      // uno pegado en "connecting"—, que es el mismo camino ya probado del
      // backoff (y el plan B de R2 para el alternar código ↔ QR).
      log.info("wa.reconnect_now", { habia_socket: !!actual, intento });
      cancelarEspera();
      intento = 0;
      store.setConn({ attempt: 0, nextAttemptAt: null, state: "connecting" });
      descartar(actual);
      void conectar();
    },

    async requestPairingCode(phoneDigits) {
      const s = actual;
      if (!s) throw new Error("todavía no hay conexión con WhatsApp");
      store.setLink({ phase: "pairing-requesting", reason: null });
      let codigo: string;
      try {
        codigo = await s.requestPairingCode(phoneDigits);
      } catch (e) {
        // §6.1 paso 4 / CA-2.4: el motivo va a la pantalla y el input queda
        // reusable sin reiniciar el proceso. El throw igual sube, para que el
        // comando de la interfaz pueda decidir qué más hacer.
        store.setLink({ phase: "failed", reason: motivo(e) });
        log.warn("wa.pairing_fallido", { motivo: motivo(e) });
        throw e;
      }
      // Un socket reemplazado en el medio ⇒ el código ya no vale para nadie.
      if (s !== actual) throw new Error("la conexión se reinició mientras se pedía el código");
      store.setLink({
        phase: "pairing-shown",
        pairingCode: codigo,
        pairingRequestedAt: ahora(),
        reason: null,
      });
      log.info("wa.pairing_code", { largo: codigo?.length ?? 0 });
    },

    isOpen() {
      return abierto;
    },

    syncCounter() {
      const n = auth?.state?.creds?.accountSyncCounter;
      return typeof n === "number" && Number.isFinite(n) ? n : null;
    },

    async resetSyncCounter() {
      const a = auth;
      if (!a?.state?.creds) return false;
      const previo = a.state.creds.accountSyncCounter ?? 0;
      // Ya está en 0: baileys va a intentar el sync completo solo en la próxima
      // conexión y no hay nada que reparar (ni que escribir).
      if (previo === 0) return false;
      a.state.creds.accountSyncCounter = 0;
      try {
        await a.saveCreds();
      } catch (e) {
        a.state.creds.accountSyncCounter = previo;
        log.error("wa.sync_counter_no_guardado", { motivo: motivo(e), previo });
        return false;
      }
      log.warn("wa.sync_counter_reset", { previo });
      return true;
    },

    socket() {
      return actual;
    },

    selfJid() {
      return actual?.user?.id ?? "";
    },

    async stop() {
      // `timeoutMs` viaja en la firma por el contrato de §5.6, pero el cierre es
      // sincrónico: `end()` cierra el ws en el acto y los handlers ya se dieron
      // de baja. El tope global de 2 s del apagado lo pone la tarea 17.
      detenido = true;
      cancelarEspera();
      const s = actual;
      descartar(s);
      store.setConn({ state: "offline", nextAttemptAt: null });
      log.info("wa.stop", { habia_socket: !!s });
    },
  };
}
