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
import { placeholderFor } from "../lib/placeholder";
import { createLimiter, MIN_GAP_MS, type Limiter } from "../lib/ratelimit";
import type { Cancelar, Store } from "../state/store";
import { previewFor } from "./map";

/** Últimos mensajes propios que quedan en memoria para `getMessage` (§8.6). */
export const MAX_SENT_CACHE = 200;

/**
 * A partir de esta espera estimada el usuario merece una explicación: su mensaje
 * quedó en la fila y no se está por mandar (D8, CA-19.5). Abajo de esto el `⏳`
 * de la fila alcanza y un aviso sería ruido.
 *
 * Se mide en DOS momentos, porque uno solo no alcanza:
 *
 *  · **Al encolar**, contra los mensajes que ya tiene adelante (uno por segundo
 *    cada uno). Es el caso común: una ráfaga de seis mensajes.
 *  · **Al pedir turno**, con lo que devuelve el limitador. Es el caso del tope de
 *    20 por minuto, que no se ve en el largo de la cola.
 *
 * ⚠️ Medirlo SÓLO en el turno —como estaba— no avisa nunca en una ráfaga: el
 * worker es serial y pide turno recién cuando toma el job, y para entonces el
 * anterior ya salió, así que la espera da 1 s siempre.
 *
 * DESVÍO de D8: el glifo `⏳ en cola (Ns)` de la fila NO está: pide una cuenta
 * regresiva por mensaje en la conversación (`ui/MessageRow.tsx`, tarea 13) y un
 * re-render por segundo, que es justo lo que RNF-5 evita. Queda el toast, que es
 * lo que explica el silencio. Anotado en `tasks.md` (tarea 14).
 */
export const UMBRAL_AVISO_MS = 2_000;

export const MOTIVO_SIN_CONEXION = "sin conexión: el mensaje no se mandó, el texto queda acá";
export const MOTIVO_CERRANDO = "wacosas se está cerrando: el mensaje no se mandó";
export const MOTIVO_SIN_CHAT = "no hay ningún chat abierto";
export const MOTIVO_VACIO = "no hay nada para enviar";
export const MOTIVO_NO_GUARDADO = "no se pudo guardar el mensaje en la base";
export const MOTIVO_NO_ESTA = "ese mensaje ya no está en la base";
export const MOTIVO_NO_FALLADO = "ese mensaje no está fallado";
export const AVISO_EN_COLA = "espaciando los envíos: 1 por segundo, 20 por minuto";

// ── imágenes salientes (`^V`) ───────────────────────────────────────────────
//
// ⚠️ **La asimetría es a propósito**: wacosas MANDA imágenes pero **no descarga
// ninguna**. CA-7.4 sigue valiendo entero para el camino de RECEPCIÓN —una
// imagen que llega se ve `📷 imagen` y no se baja ni un byte— y acá los bytes
// vienen del portapapeles del usuario, nunca de WhatsApp. Por eso el `grep` con
// el que se verifica CA-7.4 (la API de descarga de medios de baileys) sigue
// dando cero: no se nombra en ningún lado, ni siquiera acá.
//
// Y no se guardan en la base: la fila que queda es la misma que la de una imagen
// recibida (`kind: "image"` + el placeholder), así que el `.sqlite` sigue sin
// tener un solo byte binario adentro. La consecuencia práctica está abajo, en
// `retry`.

/** Una imagen lista para subir. Los bytes viven SÓLO en memoria, nunca en la base. */
export type ImagenSaliente = { bytes: Uint8Array; mime: string };

/**
 * Tope de una imagen saliente, en bytes.
 *
 * ⚠️ **De dónde sale este número, porque no es obvio**: baileys **no impone
 * ningún límite** (verificado: no hay una sola constante de tamaño en
 * `Utils/messages-media.js` ni en `Defaults/index.js`), así que si no frenamos
 * acá el rechazo llega recién después de subir el archivo entero —minutos, en el
 * peor caso— y disfrazado de error de red. El único número que se pudo verificar
 * en documentación de primera mano es el de la referencia de medios de la Cloud
 * API de Meta (`developers.facebook.com/docs/whatsapp/cloud-api/reference/media/`,
 * consultada el 2026-08-25): **imagen 5 MB, video 16 MB, audio 16 MB, documento
 * 100 MB**. Esa es OTRA API —la de negocios—, no el protocolo de WhatsApp Web que
 * habla baileys, y del consumidor no hay número publicado: el que se cita en todos
 * lados (16 MB para foto/video) **no se pudo confirmar en una fuente de primera
 * mano**, así que queda dicho que es lo mejor que hay y no un dato duro.
 *
 * Se tomó **16 MB** y no 5 MB porque los dos errores no cuestan lo mismo: pasarse
 * termina en un `failed` con el motivo del servidor a la vista y un `^V` de nuevo,
 * mientras que quedarse corto **rechaza capturas de pantalla que sí habrían
 * salido** (un PNG de un monitor 4K pasa los 5 MB sin esfuerzo) y el usuario no
 * tiene forma de saber que el que se plantó fuimos nosotros. Si algún día las
 * imágenes de entre 5 y 16 MB empiezan a rebotar del lado de WhatsApp, esto es
 * una constante: bajala a 5 MB y listo.
 */
export const LIMITE_IMAGEN_BYTES = 16 * 1024 * 1024;

export const MOTIVO_IMAGEN_VACIA = "la imagen no tiene contenido";
export const MOTIVO_IMAGEN_NO_REINTENTABLE =
  "esa imagen ya no está en memoria: copiala de nuevo y pegala con ^V";

/** Los MB con un decimal, sin `NaN` ni `1.0999999`. */
const mb = (bytes: number): string => (Math.round((bytes / (1024 * 1024)) * 10) / 10).toString();

/**
 * Lo mismo pero redondeando HACIA ARRIBA. No es un detalle: con redondeo normal,
 * una imagen de un byte por encima del tope daba el mensaje
 * "la imagen pesa 16 MB y el tope es 16 MB", que se lee como un bug nuestro.
 */
const mbArriba = (bytes: number): string => (Math.ceil((bytes / (1024 * 1024)) * 10) / 10).toString();

export const motivoImagenGrande = (bytes: number): string =>
  `la imagen pesa ${mbArriba(bytes)} MB y el tope es ${mb(LIMITE_IMAGEN_BYTES)} MB: no se mandó`;

/**
 * Un envío pendiente. `attempt` son los REINTENTOS ya gastados (0 = primero).
 *
 * `image` es lo único que distingue un envío de imagen de uno de texto: con él,
 * `text` pasa a ser el **caption** (lo que hace WhatsApp cuando mandás una foto
 * con algo escrito). Los bytes viajan en el job y NO se persisten en ningún lado.
 */
export type SendJob = {
  chatJid: string;
  waId: string;
  text: string;
  attempt: number;
  image?: ImagenSaliente | null;
};

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
  /**
   * Lo mismo pero con una imagen del portapapeles (`^V`): **la MISMA cola**, o
   * sea el mismo ritmo de RNF-8 (1/s, 20/min), los mismos reintentos 1/3/9 s de
   * RNF-9, la misma fila optimista con id propio y el mismo eco que no duplica.
   * No hay un camino paralelo para las imágenes — todo lo que este archivo cuida
   * para no comerse un ban (R8) vale igual acá.
   *
   * `caption` es el texto que había en el campo de redacción: viaja pegado a la
   * imagen, que es lo que hace WhatsApp. Puede ser vacío (una foto sola es un
   * mensaje válido, así que acá NO aplica CA-8.3).
   */
  enqueueImage(chatJid: string, image: ImagenSaliente, caption?: string): ResultadoEnvio;
  /** `Ctrl-Y` (CA-9.3): vuelve a encolar un mensaje que quedó en `failed`. */
  retry(chatJid: string, waId: string): ResultadoEnvio;
  /** El trabajo en vuelo, para el tope de 2 s del cierre ordenado (CA-17.7). */
  inFlight(): Promise<void> | null;
  /**
   * Corta el ingreso de trabajo nuevo (paso 2 de §6.6). Lo llama el cierre
   * ordenado ANTES de esperar el envío en vuelo: sin esto, el worker seguiría
   * tomando los que quedaban en la cola —uno por segundo, RNF-8— y el tope de
   * 2 s no alcanzaría nunca. El que ya está en la red se termina (`inFlight`);
   * los que no salieron los deja `failed` el cierre (`boot/shutdown.ts`).
   *
   * §5.8 no lo definía: lo pidió la revisión de la tarea 14 y lo necesita la 17.
   */
  stop(): void;
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
  /** `stop()`: el cierre ya empezó y no entra ni sale trabajo nuevo. */
  let detenido = false;
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

  /**
   * Guarda el proto para `getMessage` (§8.6).
   *
   * `fallback` es `null` cuando el mensaje NO se puede reconstruir sin los bytes
   * —o sea, en un envío de imagen—: ahí es preferible no cachear nada (baileys
   * no re-entrega ese mensaje puntual, riesgo ya aceptado y documentado en
   * `getMessage`) antes que guardar un `{conversation: caption}` que convertiría
   * la foto en un mensaje de texto suelto al re-cifrarla.
   */
  function recordar(waId: string, msg: proto.IMessage | null | undefined, fallback: string | null): void {
    const guardar = msg ?? (fallback === null ? null : { conversation: fallback });
    if (!guardar) return;
    sentCache.set(waId, guardar);
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
    // Acá el aviso cubre el tope de 20/minuto (el de la ráfaga sale al encolar).
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

    // ⚠️ Este `try` envuelve SÓLO la llamada a la red, y no es un detalle de
    // estilo: `fallar` REINTENTA. Si acá adentro cayera también lo de abajo, un
    // error de la BASE (SQLITE_BUSY, disco lleno, la base cerrada por el apagado)
    // volvería a la red y el destinatario recibiría el mismo mensaje hasta 4
    // veces —el peor bug posible en un cliente de mensajería—.
    // Texto o imagen con caption: mismo `sendMessage`, mismo id, misma cola. La
    // única diferencia es el contenido. `caption: undefined` cuando no hay texto,
    // para no mandarle a WhatsApp un caption vacío.
    const contenido = job.image
      ? {
          image: Buffer.from(job.image.bytes),
          mimetype: job.image.mime,
          ...(job.text ? { caption: job.text } : {}),
        }
      : { text: job.text };

    let sent: Awaited<ReturnType<typeof sock.sendMessage>>;
    try {
      sent = await sock.sendMessage(job.chatJid, contenido, { messageId: job.waId });
    } catch (e) {
      await fallar(job, motivo(e));
      return;
    }

    // De acá para abajo el mensaje YA SALIÓ. Nada de esto puede volver a la red:
    // si algo lanza se loguea y se sigue, la fila se queda en `pending` (⏳) y la
    // corrige el eco de `messages.upsert` o el ack de `messages.update`.
    try {
      // No debería pasar (le pasamos el id nosotros), pero si WhatsApp devuelve
      // otro hay que quedarse con el suyo: es el que va a traer el eco (CA-9.2).
      const idFinal = texto(sent?.key?.id) || job.waId;
      // El cache va PRIMERO por ser memoria: así una base que no acepta escrituras
      // no se lleva puesto el `getMessage` de §8.6 (el retry receipt del peer
      // llega segundos después y no espera a que la base se recupere).
      recordar(idFinal, sent?.message, job.image ? null : job.text);
      repo.tx(() => {
        if (idFinal !== job.waId) repo.setMessageWaId(job.chatJid, job.waId, idFinal);
        // `setMessageStatus` sólo avanza: si el `DELIVERY_ACK` llegó antes de que
        // esta promesa volviera, este `sent` no lo pisa (ver `ORDEN_ESTADO`).
        repo.setMessageStatus(job.chatJid, idFinal, "sent", null);
      });
      marcar(job.chatJid);
      log.info("send.ok", {
        chat_grupo: !!isJidGroup(job.chatJid),
        reintentos: job.attempt,
        // Ni el caption ni los bytes: sólo QUÉ se mandó (CA-14.7).
        imagen: !!job.image,
      });
    } catch (e) {
      log.error("send.post_envio", { motivo: motivo(e) });
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
    // Con el cierre en marcha no se reintenta: el primer reintento es a 1 s y el
    // tercero a 9 s, o sea que la cadena sola se come el tope de 2 s del apagado
    // y el mensaje terminaría igual en `failed`, pero cuatro segundos después.
    if (proximo <= SEND_MAX_ATTEMPTS && !detenido) {
      const delay = sendRetryDelayMs(proximo);
      // El cuerpo del mensaje NO se loguea (CA-14.7): sólo el intento y el motivo.
      log.warn("send.reintento", { intento: proximo, en_ms: delay, motivo: razon });
      await esperar(delay);
      await procesar({ ...job, attempt: proximo });
      return;
    }
    // ⚠️ Antes de escribir `failed` hay que mirar la fila. El repo acepta
    // `sent → failed` (esa es la vía del ERROR ack de WhatsApp, ver
    // `ORDEN_ESTADO`), así que la escalera sola ya NO frena este caso: la stanza
    // pudo haber salido y el server haberla acusado mientras nuestra promesa
    // lanzaba —un timeout del socket, por ejemplo—. Marcar `failed` un mensaje
    // que SÍ salió es peor que no marcar nada: le pone el `✗` y el `Ctrl-Y`
    // adelante al usuario, que lo manda de nuevo y lo duplica.
    const fila = repo.getMessageByWaId(job.chatJid, job.waId);
    if (fila && fila.status !== "pending") {
      log.warn("send.fallo_ignorado", { estado: fila.status, motivo: razon });
      return;
    }
    repo.setMessageStatus(job.chatJid, job.waId, "failed", razon);
    marcar(job.chatJid);
    store.toast(`no se pudo enviar: ${razon}`);
    log.error("send.fallido", { intentos: job.attempt, motivo: razon });
  }

  async function trabajar(): Promise<void> {
    try {
      // `!detenido` en la condición y no adentro: el job que ya se sacó de la
      // cola se termina (eso es lo que espera `inFlight`), pero no se toma
      // ninguno más una vez que empezó el cierre.
      while (!detenido && cola.length > 0) await procesar(cola.shift() as SendJob);
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

  /**
   * El tramo COMÚN de `enqueue` y `enqueueImage`: persistir la fila optimista,
   * avisar si va a esperar y empujar el job.
   *
   * Existe para que las imágenes no puedan tener su propio camino. Lo que cambia
   * entre un texto y una imagen es QUÉ se valida antes (arriba); de acá para
   * abajo —id propio, fila `pending` antes de tocar la red, aviso de cola, rate
   * limit, worker— es exactamente lo mismo, y duplicarlo sería la forma más fácil
   * de que un día un `^V` se saltee el ritmo de RNF-8.
   */
  function admitir(jid: string, cuerpo: string, image: ImagenSaliente | null): ResultadoEnvio {
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
      kind: image ? "image" : "text",
      body: cuerpo,
      // La fila de una imagen que MANDAMOS es idéntica a la de una que recibimos:
      // el placeholder y el mime, cero bytes. Así la conversación la pinta
      // `📷 imagen` con el caption debajo (CA-7.1, CA-7.2) sin enterarse de quién
      // la mandó, y la base sigue sin un solo byte binario adentro.
      attachment: image ? { label: placeholderFor("image"), mimetype: image.mime } : null,
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
    // D8 / CA-19.5: cuánto va a esperar ESTE mensaje ≈ uno por segundo por cada
    // uno que tiene adelante. `corriendo` ya está seteado con el job todavía en
    // la cola (el worker arranca un microtask después), así que en una ráfaga
    // esto cuenta uno de más y el aviso sale desde el SEGUNDO mensaje: es
    // exactamente lo que se quiere avisar —"hay más de uno encolado, por eso el
    // ⏳"— y no una medición fina.
    const adelante = cola.length + (corriendo ? 1 : 0);
    if (adelante * MIN_GAP_MS >= UMBRAL_AVISO_MS) store.toast(AVISO_EN_COLA);
    cola.push({ chatJid: jid, waId, text: cuerpo, attempt: 0, image });
    bombear();
    return { ok: true, waId };
  }

  // ── API ───────────────────────────────────────────────────────────────────

  return {
    enqueue(chatJid, text) {
      const jid = texto(chatJid);
      // CA-8.3: sólo espacios no es un mensaje. Se recorta en las PUNTAS: los
      // saltos de línea del medio son del usuario y viajan tal cual (CA-8.4).
      const cuerpo = texto(text).trim();
      if (detenido) return { ok: false, reason: MOTIVO_CERRANDO };
      if (!jid) return { ok: false, reason: MOTIVO_SIN_CHAT };
      if (!cuerpo) return { ok: false, reason: MOTIVO_VACIO };
      // CA-8.7: sin conexión no se encola NI se inserta. El aviso lo da el
      // comando; acá sólo se devuelve el motivo.
      if (!wa.isOpen()) return { ok: false, reason: MOTIVO_SIN_CONEXION };
      return admitir(jid, cuerpo, null);
    },

    enqueueImage(chatJid, image, caption) {
      const jid = texto(chatJid);
      const bytes = image?.bytes;
      // El caption se recorta igual que un mensaje de texto, pero acá vacío NO es
      // un error: una foto sola es un mensaje válido (CA-8.3 no aplica).
      const cuerpo = texto(caption).trim();
      if (detenido) return { ok: false, reason: MOTIVO_CERRANDO };
      if (!jid) return { ok: false, reason: MOTIVO_SIN_CHAT };
      if (!bytes || bytes.length === 0) return { ok: false, reason: MOTIVO_IMAGEN_VACIA };
      // ⚠️ El tope se chequea ACÁ, ANTES de persistir y ANTES de tocar la red:
      // subir 40 MB para que WhatsApp los rechace es tiempo del usuario tirado a
      // la basura, y encima el rechazo llegaría disfrazado de error de red. Ver
      // `LIMITE_IMAGEN_BYTES` para de dónde sale el número.
      if (bytes.length > LIMITE_IMAGEN_BYTES) {
        return { ok: false, reason: motivoImagenGrande(bytes.length) };
      }
      if (!wa.isOpen()) return { ok: false, reason: MOTIVO_SIN_CONEXION };
      // El `|| "image/png"` es defensivo: el portapapeles resuelve el mime por la
      // firma de los bytes (`boot/clipboard.ts`) y nunca manda uno vacío.
      return admitir(jid, cuerpo, { bytes, mime: texto(image.mime) || "image/png" });
    },

    retry(chatJid, waId) {
      const jid = texto(chatJid);
      const id = texto(waId);
      if (detenido) return { ok: false, reason: MOTIVO_CERRANDO };
      if (!jid || !id) return { ok: false, reason: MOTIVO_NO_ESTA };
      const fila = repo.getMessageByWaId(jid, id);
      if (!fila) return { ok: false, reason: MOTIVO_NO_ESTA };
      if (fila.status !== "failed") return { ok: false, reason: MOTIVO_NO_FALLADO };
      // ⚠️ Consecuencia directa de NO guardar bytes en la base (CA-7.4): la fila
      // de una imagen tiene el placeholder y el caption, no el archivo. Los
      // reintentos AUTOMÁTICOS (1/3/9 s) sí funcionan —el job vive en memoria y
      // se lleva los bytes—, pero un `^Y` puede llegar horas después, y ahí ya no
      // hay qué mandar. Se dice en vez de fallar en silencio.
      if (fila.kind === "image") return { ok: false, reason: MOTIVO_IMAGEN_NO_REINTENTABLE };
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

    stop() {
      detenido = true;
      // La cola se vacía acá y no en el cierre: las filas de esos mensajes ya
      // están en la base con `pending`, y el que las pasa a `failed` con motivo
      // es `cerrarEnviosAbiertos` (`boot/shutdown.ts`, CA-17.7). Vaciarla evita
      // que un `bombear()` tardío arranque otro worker.
      cola.length = 0;
    },

    size() {
      return cola.length + (corriendo ? 1 : 0);
    },

    async getMessage(key) {
      return sentCache.get(texto(key?.id)) ?? undefined;
    },
  };
}
