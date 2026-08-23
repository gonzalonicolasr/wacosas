// Redirección de fd 2 al archivo de log (D9, RNF-4, CA-16.2).
//
// Bun escribe estos dos warnings cuando Baileys arma su socket:
//
//   [bun] Warning: ws.WebSocket 'upgrade' event is not implemented in bun
//   [bun] Warning: ws.WebSocket 'unexpected-response' event is not implemented in bun
//
// Verificado en el diseño (V1/V2/V3): salen por **stderr**, los escribe código
// nativo de Bun y por eso parchear `process.stderr.write` NO los intercepta. La
// única palanca es el descriptor: `dup2(logFd, 2)` por FFI contra libc. Beneficio
// colateral: los stack traces de Bun y cualquier `console.error` de una dep
// también terminan en el log en vez de arriba del render.
//
// Se llama desde `src/index.tsx` ANTES de importar baileys / ws / OpenTUI.
// Sin deps nuevas: `bun:ffi` es built-in (D12).
import { chmodSync, closeSync, openSync } from "node:fs";

/** Motivo del último fallo, para que el entry lo pueda loguear (R1 del §9). */
let lastError: string | null = null;

/**
 * Apunta el fd 2 del proceso al archivo de log (append, 0600).
 *
 * NUNCA lanza: si `dlopen` falla (otra libc, FFI deshabilitado) devuelve `false`
 * y el programa sigue — el wrapper de `~/.local/bin/wacosas` ya redirige con
 * `2>>` al mismo archivo, así que la pantalla queda limpia igual (R1 del §9).
 */
export function redirectStderrTo(path: string): boolean {
  lastError = null;
  try {
    const { dlopen, FFIType, suffix } = require("bun:ffi") as typeof import("bun:ffi");

    const lib = dlopen(`libc.${suffix}.6`, {
      dup2: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    });

    // `openSync(..., "a")` respeta el umask 0o077, pero si el archivo YA existía
    // (lo pudo crear el `2>>` del wrapper con el umask de la shell del usuario)
    // el modo no se toca: hay que forzarlo a mano (RNF-12).
    const fd = openSync(path, "a", 0o600);
    try {
      chmodSync(path, 0o600);
    } catch {
      /* endurecer es deseable, pero no vale perder la redirección por eso */
    }

    const ok = lib.symbols.dup2(fd, 2) === 2;
    // El duplicado ya vive en el fd 2: el original sobra. El guard es por si el
    // proceso arrancó con fd 2 cerrado y `open` nos devolvió justo ese número.
    if (fd !== 2) closeSync(fd);

    if (!ok) lastError = "dup2 no devolvió 2";
    return ok;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    return false;
  }
}

/** Motivo del último `redirectStderrTo` fallido (`null` si salió bien). */
export function stderrRedirectError(): string | null {
  return lastError;
}
