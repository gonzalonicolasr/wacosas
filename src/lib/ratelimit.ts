// Limitador de ritmo de envío (RNF-8): mínimo 1 s entre mensajes y tope de 20
// por minuto. Es el techo conservador que elegimos para no parecer un bot y
// comerse un ban (R8 del §9), no un límite de WhatsApp.
//
// El tiempo se INYECTA: `reserve(now)` no lee el reloj por su cuenta salvo que
// el caller no le pase nada. Gracias a eso el test del corte a 20/60 s corre en
// microsegundos en vez de esperar un minuto de verdad.
//
// No duerme ni agenda nada: devuelve el instante en que le toca al mensaje y el
// worker de `wa/send.ts` hace `await sleep(at - now)` (design §6.3). Si esa
// espera pasa de 2 s, la fila muestra `⏳ en cola (Ns)` (D8).

/** Mínimo entre dos envíos consecutivos (RNF-8). */
export const MIN_GAP_MS = 1_000;
/** Máximo de envíos dentro de la ventana (RNF-8). */
export const MAX_PER_WINDOW = 20;
/** Largo de la ventana deslizante (RNF-8). */
export const WINDOW_MS = 60_000;

export type LimiterOpts = {
  minGapMs?: number;
  maxPerWindow?: number;
  windowMs?: number;
};

export type Limiter = {
  /**
   * Reserva el próximo turno y devuelve el instante (epoch ms) en que puede
   * salir. Nunca devuelve algo anterior a `now`. Cada llamada CONSUME un turno:
   * llamarla para "espiar" correría la cola.
   */
  reserve(now?: number): number;
};

/**
 * Cola de turnos: guarda las últimas `maxPerWindow` reservas otorgadas y arma la
 * próxima respetando las dos reglas a la vez.
 *
 * Reserva sobre lo YA RESERVADO, no sobre lo ya enviado: si el usuario manda
 * cinco mensajes en el mismo tick, los cinco piden turno de una y salen a 0, 1,
 * 2, 3 y 4 s. Si midiera envíos reales, los cinco se creerían "el primero".
 */
export function createLimiter(opts: LimiterOpts = {}): Limiter {
  const minGap = opts.minGapMs ?? MIN_GAP_MS;
  const max = Math.max(1, opts.maxPerWindow ?? MAX_PER_WINDOW);
  const ventana = opts.windowMs ?? WINDOW_MS;

  /** Las últimas `max` reservas, en orden. Más viejas no cambian el resultado. */
  const otorgadas: number[] = [];

  return {
    reserve(now: number = Date.now()): number {
      const ahora = Number.isFinite(now) ? now : Date.now();
      const ultima = otorgadas.length > 0 ? otorgadas[otorgadas.length - 1] : -Infinity;

      // Regla 1: 1 s desde la reserva anterior. El `max` con `ahora` cubre el
      // caso de un reloj que retrocede (NTP) sin devolver un instante pasado.
      let at = Math.max(ahora, ultima + minGap);

      // Regla 2: la ventana. Con `max` reservas en el aire, la próxima no puede
      // salir antes de que la más vieja de esas `max` cumpla el minuto.
      if (otorgadas.length >= max) {
        at = Math.max(at, otorgadas[otorgadas.length - max] + ventana);
      }

      otorgadas.push(at);
      if (otorgadas.length > max) otorgadas.shift();
      return at;
    },
  };
}
