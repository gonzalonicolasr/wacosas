// Rutas de wacosas según la spec XDG (CA-14.5) y permisos privados (CA-14.6, RNF-12).
//
//   $XDG_DATA_HOME/wacosas   (default ~/.local/share/wacosas)  base + creds + config + lock
//   $XDG_STATE_HOME/wacosas  (default ~/.local/state/wacosas)  log
//
// Nada de deps: sólo node:fs / node:path / node:os (D12).
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export type Paths = {
  dataDir: string;
  stateDir: string;
  dbPath: string;
  credsDir: string;
  logPath: string;
  lockPath: string;
  configPath: string;
};

/** La spec XDG manda ignorar los valores relativos y usar el default. */
function xdgBase(value: string | undefined, fallback: string): string {
  return value && isAbsolute(value) ? value : fallback;
}

/** Crea el dir si no está y le deja 0700 aunque ya existiera con permisos laxos. */
function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/**
 * Resuelve las rutas, crea los dos directorios raíz y endurece los permisos.
 * Es idempotente: se puede llamar todas las veces que haga falta.
 *
 * El `umask` también se setea acá (design §5.9) además de en el entry: así todo
 * archivo que cree el proceso —incluidos los que escribe `useMultiFileAuthState`
 * por dentro— nace 0600 y todo directorio 0700.
 */
export function resolvePaths(env: Record<string, string | undefined> = process.env): Paths {
  process.umask(0o077);

  const home = env.HOME || homedir();
  const dataDir = join(xdgBase(env.XDG_DATA_HOME, join(home, ".local", "share")), "wacosas");
  const stateDir = join(xdgBase(env.XDG_STATE_HOME, join(home, ".local", "state")), "wacosas");

  ensurePrivateDir(dataDir);
  ensurePrivateDir(stateDir);

  return {
    dataDir,
    stateDir,
    dbPath: join(dataDir, "wacosas.sqlite"),
    credsDir: join(dataDir, "creds"),
    logPath: join(stateDir, "wacosas.log"),
    lockPath: join(dataDir, "wacosas.lock"),
    configPath: join(dataDir, "config.json"),
  };
}
