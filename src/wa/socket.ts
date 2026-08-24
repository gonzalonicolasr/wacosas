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
// mira `registered: true`, no la mera existencia del archivo) en cada conexión.
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
import pino from "pino";

import type { Logger } from "../boot/log";
import { reconnectDelayMs } from "../lib/backoff";
import type { Cancelar, Store } from "../state/store";
import { hardenCreds, hasCreds, loadAuth, wipeCreds } from "./auth";
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

/** Eventos que consume el controlador. También son los que se dan de baja al descartar. */
const EVENTOS = [
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
] as const satisfies readonly (keyof BaileysEventMap)[];

// ── máquina de cierre (pura) ────────────────────────────────────────────────

/**
 * Con qué intención se abrió el socket:
 *  · `link` — no hay sesión vinculada en disco: se ESPERA un QR.
 *  · `reconnect` — hay creds `registered:true`: un QR acá significa que dejaron
 *    de servir (CA-3.4).
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
    if (ok) return true;

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
      const { state, saveCreds } = await loadAuth(credsDir);

      // El `stop()` pudo llegar mientras se resolvía la versión: no abrir nada.
      if (detenido) return;

      const s = crearSocket({
        ...(version ? { version } : {}),
        auth: state,
        browser: Browsers.ubuntu("Chrome"), // WA rechaza clientes sin browser
        logger: pino({ level: "silent" }), // CA-16.2: ni una línea a la terminal
        markOnlineOnConnect: false, // CA-15.8
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
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
      // CA-3.4: había creds `registered:true` y WhatsApp igual pide QR ⇒ no
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
