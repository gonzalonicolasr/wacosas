// Backoff puro: reconexión del socket (CA-15.2) y reintentos de envío (RNF-9).
// Sólo aritmética — el que agenda los timers es `wa/socket.ts` / `wa/send.ts`,
// que además guardan el `attempt` afuera del socket para que sobreviva a su
// muerte (D6).

/** Primer reintento de conexión: 2 s (CA-15.2). */
export const RECONNECT_BASE_MS = 2_000;
/** Techo entre reintentos de conexión: 60 s (CA-15.2). */
export const RECONNECT_MAX_MS = 60_000;
/** Primer reintento de un envío: 1 s (RNF-9). */
export const SEND_RETRY_BASE_MS = 1_000;
/** Tope de reintentos automáticos de un envío; después queda `failed` (RNF-9). */
export const SEND_MAX_ATTEMPTS = 3;

/** Un intento siempre es un entero ≥ 1: cualquier basura cuenta como el primero. */
function normalizar(attempt: number): number {
  return Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
}

/**
 * Espera antes del intento `attempt` de reconexión: `2 s · 2^(n-1)` con tope de
 * 60 s (CA-15.2) ⇒ 2, 4, 8, 16, 32, 60, 60…
 *
 * El contador lo resetea el caller en `connection === "open"` **y también cuando
 * llega un `qr`** (D6): un 408 después de emitir un QR significa "nadie lo
 * escaneó", no un error de red, y si contara como fallo el segundo QR saldría a
 * los 60 s.
 */
export function reconnectDelayMs(attempt: number): number {
  const n = normalizar(attempt);
  // `2 ** n` desborda a Infinity con un `attempt` disparatado; el `min` lo tapa.
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (n - 1));
}

/**
 * Espera antes del reintento `attempt` de un envío: 1 s, 3 s, 9 s (RNF-9).
 * Del cuarto en adelante devuelve el mismo 9 s, pero no debería llegar: el
 * caller corta en `SEND_MAX_ATTEMPTS` y deja la fila en `failed` con motivo,
 * a la espera de que el usuario apriete `Ctrl-Y` (CA-9.3).
 */
export function sendRetryDelayMs(attempt: number): number {
  const n = Math.min(SEND_MAX_ATTEMPTS, normalizar(attempt));
  return SEND_RETRY_BASE_MS * 3 ** (n - 1);
}
