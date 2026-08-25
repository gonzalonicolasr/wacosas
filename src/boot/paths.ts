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
  /** Hash del código que revela los chats con candado (`boot/lockcode.ts`). */
  lockCodePath: string;
  /**
   * Las imágenes que el usuario pidió ver con `^O` (`wa/media.ts`).
   *
   * ⚠️ Es el ÚNICO lugar donde wacosas escribe contenido que le mandaron —lo que
   * CA-7.4 prohibía—, y por eso vive acá, adentro del `dataDir` que ya nace
   * `0700`, y no en `/tmp`: los archivos quedan `0600` y nadie más los ve.
   *
   * Se puede **borrar entero cuando se quiera**: es un caché, y lo que se borre
   * se vuelve a bajar la próxima vez que se apriete `^O`.
   */
  mediaDir: string;
  /**
   * Las fotos de perfil (miniaturas) de los chats de la bandeja
   * (`wa/avatars.ts`), de donde sale el color de cada glifo.
   *
   * Aparte de `mediaDir` porque son otra cosa: éstas se piden **solas** (para las
   * filas que se ven) y son de terceros que no te mandaron nada, así que tienen
   * que poder borrarse sin llevarse las imágenes que sí pediste. Mismos permisos:
   * el directorio `0700`, los archivos `0600`.
   */
  avatarsDir: string;
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
  const mediaDir = join(dataDir, "media");
  const avatarsDir = join(dataDir, "avatars");

  ensurePrivateDir(dataDir);
  ensurePrivateDir(stateDir);
  // Se crean SIEMPRE, aunque nunca se baje una imagen: así el permiso `0700` es
  // una propiedad del arranque —verificable con un `stat`— y no algo que dependa
  // de que alguien haya apretado `^O` alguna vez.
  ensurePrivateDir(mediaDir);
  ensurePrivateDir(avatarsDir);

  return {
    dataDir,
    stateDir,
    mediaDir,
    avatarsDir,
    dbPath: join(dataDir, "wacosas.sqlite"),
    credsDir: join(dataDir, "creds"),
    logPath: join(stateDir, "wacosas.log"),
    lockPath: join(dataDir, "wacosas.lock"),
    configPath: join(dataDir, "config.json"),
    // Nombre distinto de `wacosas.lock` a propósito: aquél es el pidfile de la
    // instancia única y éste el candado de los chats. Se parecen en el nombre y
    // no tienen nada que ver.
    lockCodePath: join(dataDir, "lock-code.json"),
  };
}
