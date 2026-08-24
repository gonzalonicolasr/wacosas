// Cola de envío: el único camino por el que un mensaje nuestro sale a WhatsApp
// (design §6.3, §5.8, D7, D8, RNF-8, RNF-9).
//
// Las cuatro reglas que gobiernan este archivo:
//
//  1. **El id lo generamos NOSOTROS** (`generateMessageIDV2`, D7) y la fila se
//     persiste con ese id y `status:'pending'` ANTES de tocar la red. Cuando
//     WhatsApp reenvía el eco por `messages.upsert` trae el MISMO id, choca
//     contra el índice único `(chat_jid, wa_id)` y se descarta solo: no hace
//     falta ninguna heurística de "¿será el mismo mensaje?" (CA-9.4).
//  2. **Los envíos van SERIALIZADOS y espaciados** (RNF-8): un worker, un job por
//     vez, 1 s entre mensajes y 20 por minuto. No es un límite de WhatsApp, es el
//     techo conservador que elegimos para no parecer un bot y comernos un ban
//     (R8 del §9). **No se relaja.** El limitador reserva turno UNA vez por
//     intento de red —cada reintento es un mensaje más para WhatsApp, así que
//     también paga su turno—.
//  3. **Sin conexión no se encola NADA** (CA-8.7): `enqueue` devuelve
//     `{ok:false}` sin insertar ni una fila, y el texto se le queda al usuario en
//     el campo. No existe el outbox diferido: un mensaje que sale solo tres horas
//     después, cuando la conversación ya siguió, hace más daño que no salir.
//  4. **La cola es de MEMORIA** (D8). Lo único que sobrevive al proceso es la
//     fila `pending`/`failed` en la base, que la tarea 17 levanta con
//     `repo.openSends()` para dejarla en `failed` al arrancar.
//
// El reloj y el agendador se INYECTAN, igual que en `state/store.ts`,
// `wa/ingest.ts` y `wa/socket.ts`: gracias a eso el test mide un minuto entero de
// ritmo de envío sin esperar un minuto.
import { generateMessageIDV2, isJidGroup, jidNormalizedUser } from "baileys";
import type { WAMessageKey, proto } from "baileys";

import type { Logger } from "../boot/log";
import type { Repo } from "../db/repo";
import type { MappedMessage } from "../db/types";
import { SEND_MAX_ATTEMPTS, sendRetryDelayMs } from "../lib/backoff";
import { createLimiter, type Limiter } from "../lib/ratelimit";
import type { Cancelar, Store } from "../state/store";
import { previewFor } from "./map";

/** Últimos mensajes propios que quedan en memoria para `getMessage` (§8.6). */
export const MAX_SENT_CACHE = 200;

/**
 * A partir de esta espera del limitador el usuario merece una explicación: su
 * mensaje quedó en la fila y no se está por mandar (D8, CA-19.5). Abajo de esto
 * el `⏳` de la fila alcanza y un aviso sería ruido.
 */
export const UMBRAL_AVISO_MS = 2_000;

export const MOTIVO_SIN_CONEXION = "sin conexión: el mensaje no se mandó, el texto queda acá";
export const MOTIVO_SIN_CHAT = "no hay ningún chat abierto";
export const MOTIVO_VACIO = "no hay nada para enviar";
export const MOTIVO_NO_GUARDADO = "no se pudo guardar el mensaje en la base";
export const MOTIVO_NO_ESTA = "ese mensaje ya no está en la base";
export const MOTIVO_NO_FALLADO = "ese mensaje no está fallado";
export const AVISO_EN_COLA = "espaciando los envíos: 1 por segundo, 20 por minuto";

/** Un envío pendiente. `attempt` son los REINTENTOS ya gastados (0 = primero). */
export type SendJob = { chatJid: string; waId: string; text: string; attempt: number };

/**
 * El `reason?: undefined` / `waId?: undefined` de las ramas que no los usan no es
 * adorno: el proyecto compila con `strict: false` y sin `strictNullChecks`
 * TypeScript **no angosta una unión por un booleano literal**, así que sin
 * declarar la propiedad en las dos ramas un `r.ok ? r.waId : r.reason` no
 * compila (mismo motivo que `Resultado` en `state/commands.ts`).
 */
export type ResultadoEnvio =
  | { ok: true; waId: string; reason?: undefined }
  | { ok: false; waId?: undefined; reason: string };

export type SendQueue = {
  /** Persiste la fila optimista y encola. NO manda: eso lo hace el worker. */
  enqueue(chatJid: string, text: string): ResultadoEnvio;
  /** `Ctrl-Y` (CA-9.3): vuelve a encolar un mensaje que quedó en `failed`. */
  retry(chatJid: string, waId: string): ResultadoEnvio;
  /** El trabajo en vuelo, para el tope de 2 s del cierre ordenado (CA-17.7). */
  inFlight(): Promise<void> | null;
  /** Mensajes esperando turno, incluido el que se está mandando. */
  size(): number;
  /**
   * `getMessage` de §8.6: Baileys lo llama para re-cifrar un mensaje propio
   * cuando un peer manda un retry receipt. El proto NO se guarda en la base
   * (inflaría el historial y no aporta a la pantalla): vive en un `Map` acotado a
   * los últimos `MAX_SENT_CACHE` envíos, que cubre el caso real (el retry llega
   * segundos después). Fuera de esa ventana ese mensaje puntual no se re-entrega:
   * riesgo aceptado y documentado.
   */
  getMessage(key: WAMessageKey): Promise<proto.IMessage | undefined>;
};

export type SendDeps = {
  repo: Repo;
  store: Store;
  log: Logger;
  /** Sólo lo que hace falta del controlador: así el test no arma un socket entero. */
  wa: Pick<import("./socket").WaController, "isOpen" | "socket" | "selfJid">;
  /** Reloj en ms. Default `Date.now`. */
  now?: () => number;
  /** Agendador. Default `setTimeout`; el test le pasa uno virtual. */
  schedule?: (fn: () => void, ms: number) => Cancelar;
  /** Limitador de ritmo. Default el de RNF-8 (1 s / 20 por minuto). */
  limiter?: Limiter;
  /** Generador de ids. Default `generateMessageIDV2` (D7). */
  newId?: (selfJid: string) => string;
};

const agendarReal = (fn: () => void, ms: number): Cancelar => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

function motivo(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function texto(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function createSendQueue(deps: SendDeps): SendQueue {
  const { repo, store, log, wa } = deps;
  const ahora = deps.now ?? Date.now;
  const agendar = deps.schedule ?? agendarReal;
  const limiter = deps.limiter ?? createLimiter();
  const nuevoId = deps.newId ?? ((self: string) => generateMessageIDV2(self || undefined));

  /** FIFO en memoria. Un solo worker la consume, así que no hay reentrada. */
  const cola: SendJob[] = [];
  /** El worker en vuelo, o `null`. Es lo que devuelve `inFlight()`. */
  let corriendo: Promise<void> | null = null;
  /** `wa_id` → proto del mensaje, para `getMessage` (§8.6). */
  const sentCache = new Map<string, proto.IMessage>();

  /** Espera sobre el agendador inyectado, nunca sobre `setTimeout` directo. */
  function esperar(ms: number): Promise<void> {
    return new Promise((resolver) => {
      agendar(() => resolver(), Math.max(0, ms));
    });
  }

  /** El `convo` sólo se marca si el chat que cambió es el que se está mirando (§6.2). */
  function marcar(chatJid: string): void {
    store.markDirty("inbox", chatJid === store.openChatJid() ? "convo" : null);
  }

  function recordar(waId: string, msg: proto.IMessage | null | undefined, fallback: string): void {
    sentCache.set(waId, msg ?? { conversation: fallback });
    // `Map` conserva el orden de inserción: la primera clave es la más vieja.
    while (sentCache.size > MAX_SENT_CACHE) {
      const vieja = sentCache.keys().next().value;
      if (vieja === undefined) break;
      sentCache.delete(vieja);
    }
  }

  // ── worker ────────────────────────────────────────────────────────────────

  /**
   * Un intento de red. Nunca lanza: todo camino de error termina en `fallar`,
   * que reintenta o deja la fila en `failed` con motivo (RNF-9, CA-9.3).
   */
  async function procesar(job: SendJob): Promise<void> {
    // RNF-8. `reserve()` CONSUME turno: se llama una sola vez por intento, y lo
    // que devuelve es el instante en que le toca (el que duerme es el caller).
    const turno = limiter.reserve(ahora());
    const espera = turno - ahora();
    if (espera >= UMBRAL_AVISO_MS) store.toast(AVISO_EN_COLA); // D8 / CA-19.5
    if (espera > 0) await esperar(espera);

    // La conexión se re-chequea ACÁ, no al encolar: entre el `enqueue` y el turno
    // pudo pasar un minuto entero. `isOpen()` sale de un flag del controlador y
    // no del snapshot, que está cacheado hasta el próximo flush (D3).
    const sock = wa.socket();
    if (!wa.isOpen() || !sock) {
      await fallar(job, MOTIVO_SIN_CONEXION);
      return;
    }

    try {
      const sent = await sock.sendMessage(job.chatJid, { text: job.text }, { messageId: job.waId });
      // No debería pasar (le pasamos el id nosotros), pero si WhatsApp devuelve
      // otro hay que quedarse con el suyo: es el que va a traer el eco (CA-9.2).
      const idFinal = texto(sent?.key?.id) || job.waId;
      repo.tx(() => {
        if (idFinal !== job.waId) repo.setMessageWaId(job.chatJid, job.waId, idFinal);
        // `setMessageStatus` sólo avanza: si el `DELIVERY_ACK` llegó antes de que
        // esta promesa volviera, este `sent` no lo pisa (ver `ORDEN_ESTADO`).
        repo.setMessageStatus(job.chatJid, idFinal, "sent", null);
      });
      recordar(idFinal, sent?.message, job.text);
      marcar(job.chatJid);
      log.info("send.ok", { chat_grupo: !!isJidGroup(job.chatJid), reintentos: job.attempt });
    } catch (e) {
      await fallar(job, motivo(e));
    }
  }

  /**
   * Un intento que no salió: reintenta hasta `SEND_MAX_ATTEMPTS` veces con
   * 1/3/9 s (RNF-9) y, agotados, deja la fila en `failed` con el motivo a la
   * vista y el reintento en manos del usuario (CA-9.3).
   *
   * El reintento es EN LÍNEA (no se re-encola al final): mientras espera, el
   * worker no toma otro job, así que los mensajes de un mismo chat no se pueden
   * adelantar entre sí. Con el ritmo de RNF-8 —un mensaje por segundo— parar 9 s
   * la cola entera es un costo chico al lado de mandar las cosas desordenadas.
   */
  async function fallar(job: SendJob, razon: string): Promise<void> {
    const proximo = job.attempt + 1;
    if (proximo <= SEND_MAX_ATTEMPTS) {
      const delay = sendRetryDelayMs(proximo);
      // El cuerpo del mensaje NO se loguea (CA-14.7): sólo el intento y el motivo.
      log.warn("send.reintento", { intento: proximo, en_ms: delay, motivo: razon });
      await esperar(delay);
      await procesar({ ...job, attempt: proximo });
      return;
    }
    repo.setMessageStatus(job.chatJid, job.waId, "failed", razon);
    marcar(job.chatJid);
    store.toast(`no se pudo enviar: ${razon}`);
    log.error("send.fallido", { intentos: job.attempt, motivo: razon });
  }

  async function trabajar(): Promise<void> {
    try {
      while (cola.length > 0) await procesar(cola.shift() as SendJob);
    } catch (e) {
      // `procesar` ya atrapa todo; esto es el último seguro para que una
      // excepción inesperada no deje la cola trabada con `corriendo` colgado.
      log.error("send.worker_fallido", { motivo: motivo(e) });
    } finally {
      // Sincrónico con la salida del `while`: entre que la cola queda vacía y
      // esta línea no corre nadie más, así que no hay ventana para que un
      // `enqueue` vea `corriendo` y no arranque el worker de nuevo.
      corriendo = null;
    }
  }

  /**
   * Arranca el worker si no hay uno. El `Promise.resolve().then` difiere la
   * primera línea de `trabajar` un microtask **a propósito**: así `corriendo` ya
   * está asignado cuando el worker corre, y su `finally` no puede limpiar una
   * variable que todavía no se escribió.
   */
  function bombear(): void {
    if (corriendo || cola.length === 0) return;
    corriendo = Promise.resolve().then(trabajar);
  }

  // ── API ───────────────────────────────────────────────────────────────────

  return {
    enqueue(chatJid, text) {
      const jid = texto(chatJid);
      // CA-8.3: sólo espacios no es un mensaje. Se recorta en las PUNTAS: los
      // saltos de línea del medio son del usuario y viajan tal cual (CA-8.4).
      const cuerpo = texto(text).trim();
      if (!jid) return { ok: false, reason: MOTIVO_SIN_CHAT };
      if (!cuerpo) return { ok: false, reason: MOTIVO_VACIO };
      // CA-8.7: sin conexión no se encola NI se inserta. El aviso lo da el
      // comando; acá sólo se devuelve el motivo.
      if (!wa.isOpen()) return { ok: false, reason: MOTIVO_SIN_CONEXION };

      const self = jidNormalizedUser(wa.selfJid() || undefined);
      const waId = nuevoId(wa.selfJid());
      const fila: MappedMessage = {
        chatJid: jid,
        waId,
        fromMe: true,
        senderJid: self,
        // Vacío a propósito: la conversación pinta "vos" en todo mensaje propio
        // (`MessageRow.autorDe`), congelar acá el `pushName` propio no aporta.
        senderName: "",
        ts: Math.floor(ahora() / 1000),
        kind: "text",
        body: cuerpo,
        attachment: null,
        status: "pending",
      };

      try {
        repo.tx(() => {
          // El chat va primero: la FK de `messages.chat_jid` aborta si no existe
          // (§8.4). Con un chat abierto ya está, pero el envío no puede depender
          // de eso.
          repo.upsertChat({ jid, isGroup: !!isJidGroup(jid) });
          repo.insertMessage(fila);
          repo.touchChatActivity(jid, fila.ts, previewFor(fila), true);
        });
      } catch (e) {
        log.error("send.no_persistido", { motivo: motivo(e) });
        return { ok: false, reason: MOTIVO_NO_GUARDADO };
      }

      // CA-9.1: la fila aparece al toque en `⏳ enviando`, sin esperar la red.
      marcar(jid);
      cola.push({ chatJid: jid, waId, text: cuerpo, attempt: 0 });
      bombear();
      return { ok: true, waId };
    },

    retry(chatJid, waId) {
      const jid = texto(chatJid);
      const id = texto(waId);
      if (!jid || !id) return { ok: false, reason: MOTIVO_NO_ESTA };
      const fila = repo.getMessageByWaId(jid, id);
      if (!fila) return { ok: false, reason: MOTIVO_NO_ESTA };
      if (fila.status !== "failed") return { ok: false, reason: MOTIVO_NO_FALLADO };
      if (!wa.isOpen()) return { ok: false, reason: MOTIVO_SIN_CONEXION };

      // Vuelve a `pending` (⏳) y el contador de reintentos arranca de cero: es
      // una decisión NUEVA del usuario, no la continuación de la anterior.
      repo.setMessageStatus(jid, id, "pending", null);
      marcar(jid);
      cola.push({ chatJid: jid, waId: id, text: fila.body, attempt: 0 });
      bombear();
      log.info("send.reintento_manual", {});
      return { ok: true, waId: id };
    },

    inFlight() {
      return corriendo;
    },

    size() {
      return cola.length + (corriendo ? 1 : 0);
    },

    async getMessage(key) {
      return sentCache.get(texto(key?.id)) ?? undefined;
    },
  };
}
