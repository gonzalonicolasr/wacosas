// Cierre ordenado (design §6.6, CA-17.1 … CA-17.7).
//
// Es el ÚNICO camino de salida del proceso: el renderer se crea con
// `exitOnCtrlC:false` y `exitSignals:[]` justamente para que nadie más llame a
// `process.exit` por su cuenta y se saltee el drenado de la cola o el checkpoint
// de la base.
//
// El orden importa, y no es el mismo que el de §6.6 en un punto:
//
//   1. marcar `cerrando` — un segundo `Ctrl-C` sale YA con 1, sin esperar nada;
//   2. parar el worker de envío, el drenador del ingest, la reparación de
//      app-state y el resolvedor de identidades: de acá en adelante nadie acepta
//      trabajo nuevo;
//   3. esperar el envío EN VUELO contra el único tope global de 2 s (CA-17.4);
//   4. lo que no salió queda `failed` con motivo, no en `⏳` para siempre (CA-17.7);
//   5. `ingest.drainNow()` — lo que quedaba en la cola se escribe sin timers;
//   6. `wa.stop()` ⇒ `end()`. **Nunca `logout()`**: cerrar la app no desvincula
//      la sesión (CA-17.1, CA-17.6);
//   7. `store.stop()` — VA ACÁ, después del drenador, del worker y del socket, y
//      no antes: cualquiera de los tres hace `markDirty` al terminar y eso vuelve
//      a armar el timer de 33 ms que el `stop()` acababa de cancelar (medido en
//      la revisión de la tarea 6). Igual `stop()` es TERMINAL —después de él un
//      `markDirty` ya no agenda nada—, así que esto es cinturón y tiradores;
//   8. `repo.close()` (checkpoint del WAL);
//   9. `renderer.destroy()` — sale de la pantalla alternativa, apaga el mouse y
//      vuelve a mostrar el cursor: el prompt queda usable sin `reset` (CA-17.2);
//  10. `lock.release()` (CA-18.4) y `exit(code)` (CA-17.3).
//
// Del paso 4 al 10 no hay un solo `await`: es un bloque sincrónico a propósito.
// Si en el medio se colara un turno del event loop, un timer del store podría
// disparar un flush contra una base ya cerrada.
import type { Repo } from "../db/repo";
import type { Cancelar, Store } from "../state/store";
import type { Ingest } from "../wa/ingest";
import type { SendQueue } from "../wa/send";
import type { WaController } from "../wa/socket";
import type { Logger } from "./log";

/** Tope global del cierre (CA-17.4). Uno solo: no hay un timeout por paso. */
export const TOPE_CIERRE_MS = 2_000;

/** Lo que se le escribe al mensaje que no llegó a salir (CA-17.7). */
export const MOTIVO_CIERRE = "el envío quedó a medias al cerrar wacosas";

/** Lo mismo, pero para las filas que dejó un proceso que murió de golpe. */
export const MOTIVO_CAIDA = "wacosas se cerró de golpe con el envío en curso";

/**
 * Las piezas que se arman DESPUÉS del primer render (baileys tarda en cargar).
 * Se leen al cerrar y no al cablear: si el usuario aprieta `Ctrl-C` mientras
 * carga la máquina, ninguna de las cinco existe todavía y cada paso se saltea
 * solo (por eso todos los campos son opcionales).
 */
export type Maquina = {
  ingest?: Pick<Ingest, "stop" | "drainNow">;
  send?: Pick<SendQueue, "stop" | "inFlight">;
  wa?: Pick<WaController, "stop">;
  appstate?: { stop(): void };
  identity?: { stop(): void };
  /** La cola de fotos de perfil de la bandeja (`wa/avatars.ts`). */
  avatars?: { stop(): void };
};

export type ShutdownDeps = {
  log: Logger;
  maquina?: () => Maquina;
  store?: Pick<Store, "stop">;
  repo?: Pick<Repo, "openSends" | "setMessageStatus" | "close">;
  renderer?: { destroy(): void };
  lock?: { release(): void };
  /** Default `process.exit`. El test le pasa uno que sólo anota el código. */
  exit?: (code: number) => void;
  /** Agendador del tope. Default `setTimeout`; el test le pasa uno manual. */
  schedule?: (fn: () => void, ms: number) => Cancelar;
  timeoutMs?: number;
};

/** `motivo` es sólo para el log: de dónde salió la orden de cerrar. */
export type Shutdown = (code?: number, motivo?: string) => void;

const agendarReal = (fn: () => void, ms: number): Cancelar => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

function motivoDe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Deja en `failed` los envíos que quedaron abiertos, con el motivo a la vista y
 * el reintento en manos del usuario (`Ctrl-Y`).
 *
 * Se usa por DOS caminos y por eso está suelta:
 *  · al cerrar, para el mensaje que no alcanzó a salir dentro del tope (CA-17.7);
 *  · al ARRANCAR, para lo que dejó un proceso muerto de golpe (`kill -9`, un
 *    corte de luz). Sin esto esas filas se quedan en `⏳ enviando` para siempre:
 *    la cola es de memoria (D8) y nadie las va a volver a tomar.
 *
 * Sólo toca las `pending`: una `failed` ya tiene su motivo, y `setMessageStatus`
 * no baja de escalón (`ORDEN_ESTADO`), así que un mensaje que SÍ salió y ya tenía
 * ack no se puede marcar como fallado desde acá.
 */
export function cerrarEnviosAbiertos(
  repo: Pick<Repo, "openSends" | "setMessageStatus">,
  motivo: string,
  log?: Logger,
): number {
  let n = 0;
  try {
    for (const m of repo.openSends()) {
      if (m.status !== "pending") continue;
      repo.setMessageStatus(m.chatJid, m.waId, "failed", motivo);
      n++;
    }
  } catch (e) {
    log?.error("cierre.envios_abiertos", { motivo: motivoDe(e) });
  }
  if (n > 0) log?.warn("cierre.envios_fallados", { cantidad: n });
  return n;
}

/**
 * Arma el cierre ordenado. Devuelve la función que hay que enganchar a
 * `Ctrl-C`/`Ctrl-Q`, a las señales y a los dos handlers de error del proceso.
 *
 * Es idempotente: llamarla dos veces no repite los pasos. El SEGUNDO llamado
 * mientras el primero está esperando el envío en vuelo sale con 1 en el acto —es
 * el `Ctrl-C` del que ya se cansó de esperar—.
 */
export function createShutdown(deps: ShutdownDeps): Shutdown {
  const { log } = deps;
  const agendar = deps.schedule ?? agendarReal;
  const tope = deps.timeoutMs ?? TOPE_CIERRE_MS;
  const salir = deps.exit ?? ((code: number) => process.exit(code));

  let cerrando = false;
  let finalizado = false;
  let cancelarTope: Cancelar | null = null;
  /** Cuándo empezó el cierre: el `ms` de `app.cerrado` es lo que TARDÓ en salir. */
  let t0 = 0;

  /** Un paso del cierre no puede impedir los que siguen (RNF-11 del §9). */
  function paso(nombre: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      log.error("cierre.paso_fallido", { paso: nombre, motivo: motivoDe(e) });
    }
  }

  function finalizar(code: number): void {
    if (finalizado) return;
    finalizado = true;
    cancelarTope?.();
    cancelarTope = null;
    const m = maquinaDe();

    // ── de acá abajo, NADA de `await` (ver el encabezado) ────────────────────
    if (deps.repo) paso("envios", () => cerrarEnviosAbiertos(deps.repo, MOTIVO_CIERRE, log));
    paso("ingest.drain", () => m.ingest?.drainNow());
    // `end()`, nunca `logout()`: el controlador ya lo resuelve así (CA-17.6). Es
    // sincrónico por dentro; el `catch` es para que un rechazo tardío no salga
    // como `unhandledRejection` —que en este proceso vuelve a llamar acá—.
    paso("wa.stop", () => void Promise.resolve(m.wa?.stop()).catch(() => {}));
    paso("store.stop", () => deps.store?.stop());
    paso("repo.close", () => deps.repo?.close());
    paso("renderer.destroy", () => deps.renderer?.destroy());
    paso("lock.release", () => deps.lock?.release());

    log.info("app.cerrado", { code, ms: Date.now() - t0 });
    salir(code);
  }

  function maquinaDe(): Maquina {
    try {
      return deps.maquina?.() ?? {};
    } catch (e) {
      log.error("cierre.maquina_ilegible", { motivo: motivoDe(e) });
      return {};
    }
  }

  return function shutdown(code = 0, motivo = "?"): void {
    if (cerrando) {
      // Segundo `Ctrl-C`: el usuario no quiere esperar más. Se sale sin pasos
      // —la terminal la deja usable el `destroy()` del renderer si el primer
      // cierre llegó hasta ahí; si no, el shell la recupera igual al volver el
      // prompt— con código 1, que es lo que se espera de una salida forzada.
      log.warn("app.cierre_forzado", { motivo });
      salir(1);
      return;
    }
    cerrando = true;
    t0 = Date.now();
    log.info("app.cerrando", { code, motivo, pid: process.pid });

    const m = maquinaDe();
    paso("send.stop", () => m.send?.stop());
    paso("ingest.stop", () => m.ingest?.stop());
    paso("appstate.stop", () => m.appstate?.stop());
    paso("identity.stop", () => m.identity?.stop());
    paso("avatars.stop", () => m.avatars?.stop());

    let enVuelo: Promise<void> | null = null;
    paso("send.inFlight", () => {
      enVuelo = m.send?.inFlight() ?? null;
    });

    // Nada en vuelo ⇒ el cierre entero es sincrónico y el proceso muere en el
    // mismo tick que la tecla. El tope de 2 s es para el otro caso.
    if (!enVuelo) {
      finalizar(code);
      return;
    }

    log.info("cierre.esperando_envio", { tope_ms: tope });
    cancelarTope = agendar(() => finalizar(code), tope);
    // `then` con las dos ramas: que el envío falle no cambia nada del cierre.
    void (enVuelo as Promise<void>).then(
      () => finalizar(code),
      () => finalizar(code),
    );
  };
}
