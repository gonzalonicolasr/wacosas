// Instancia única: UN proceso por directorio de datos (CA-18.1 … CA-18.4, RNF-11).
//
// Por qué hace falta: dos wacosas sobre el mismo `dataDir` no se pisan sólo la
// base —SQLite en WAL se banca dos escritores—, se pisan la **sesión**. Los dos
// levantan las mismas credenciales, abren dos sockets contra WhatsApp y cada
// `creds.update` reescribe lo que acaba de guardar el otro; el final del camino
// es una sesión corrupta y una re-vinculación. Y como el ingest de los dos
// escribe los mismos mensajes, los contadores de no leídos quedan al azar.
//
// El mecanismo es el clásico **pidfile**, con la verificación que evita el falso
// positivo que lo hace inservible: que el PID de la marca vieja se lo haya
// reciclado OTRO programa. Por eso la marca guarda dos líneas —el pid y el
// `cmdline` del dueño— y para creerle a la marca tienen que dar las dos:
//
//   pid vivo  +  mismo cmdline   ⇒ hay otra instancia (CA-18.2)
//   pid muerto                   ⇒ marca huérfana, se pisa y se arranca (CA-18.3)
//   pid vivo con OTRO cmdline    ⇒ PID reciclado, se pisa y se arranca (CA-18.3)
//
// La creación es `open(..., "wx")` —exclusiva, la resuelve el kernel—: si dos
// wacosas arrancan en el mismo milisegundo, uno crea el archivo y el otro se
// come el `EEXIST` y pasa a evaluar la marca. Sin locks de archivo (`flock`)
// porque haría falta FFI y un fd abierto toda la corrida, y sin deps (D12).
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";

/** Lo que hay adentro del pidfile: quién lo tomó. */
export type Marca = { pid: number; cmdline: string };

export type Lock = {
  path: string;
  pid: number;
  /** Borra la marca si sigue siendo nuestra. Idempotente y nunca lanza (CA-18.4). */
  release(): void;
};

/**
 * El `lock?: undefined` / `ajena?: undefined` de las ramas que no los usan no es
 * adorno: el proyecto compila con `strict: false` y sin `strictNullChecks`
 * TypeScript **no angosta una unión por un booleano literal** (mismo motivo que
 * `ResultadoEnvio` en `wa/send.ts`).
 */
export type ResultadoLock =
  | { ok: true; lock: Lock; ajena?: undefined; aviso: string | null }
  | { ok: false; lock?: undefined; ajena: Marca; aviso?: undefined };

export type LockOpts = {
  /** PID propio. Default `process.pid`; el test le pasa uno inventado. */
  pid?: number;
  /** `cmdline` propio. Default el de `/proc/self`. */
  cmdline?: string;
  /** ¿Existe ese proceso? Default `kill(pid, 0)`. */
  vivo?: (pid: number) => boolean;
  /** `cmdline` de un PID, o `null` si no se puede leer. Default `/proc/<pid>`. */
  cmdlineDe?: (pid: number) => string | null;
};

/** Cuántas veces se reintenta la carrera "estaba huérfana ⇒ la borro ⇒ la creo". */
const MAX_INTENTOS = 3;

/**
 * `/proc/<pid>/cmdline` con los NUL cambiados por espacios, o `null` si no se
 * puede leer (el proceso murió, no hay `/proc`, o es de otro usuario y el kernel
 * lo esconde). **`null` no significa "está vivo"**: significa "no sé", y quien
 * decide lo trata como marca huérfana — el `kill(pid, 0)` ya filtró los muertos.
 */
export function cmdlineDelProceso(pid: number): string | null {
  try {
    const crudo = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return crudo.replace(/\0+$/, "").split("\0").join(" ").trim();
  } catch {
    return null;
  }
}

/** `kill(pid, 0)`: `EPERM` también es "existe" (es de otro usuario). */
function vivoReal(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** El contenido del pidfile, o `null` si no está / está ilegible / no tiene pid. */
function leerMarca(path: string): Marca | null {
  try {
    const [linea, ...resto] = readFileSync(path, "utf8").split("\n");
    const pid = Number.parseInt((linea ?? "").trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return { pid, cmdline: (resto.join("\n") ?? "").trim() };
  } catch {
    return null;
  }
}

function borrar(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* ya no está, o no es nuestra: el que sigue lo va a ver igual */
  }
}

/**
 * Toma la marca de instancia única.
 *
 * Se llama en el entry ANTES de abrir la base y ANTES de tocar `creds/`
 * (CA-18.2: la segunda instancia no puede tocar nada). Si el archivo no se puede
 * escribir —directorio de sólo lectura— **no se aborta el arranque**: se
 * devuelve `ok: true` con un `aviso` para el log y un `release()` que no hace
 * nada. Negarse a abrir por no poder escribir un pidfile sería cambiar un riesgo
 * chico (dos instancias) por uno seguro (no hay app).
 */
export function acquireLock(path: string, opts: LockOpts = {}): ResultadoLock {
  const pid = opts.pid ?? process.pid;
  const vivo = opts.vivo ?? vivoReal;
  const cmdlineDe = opts.cmdlineDe ?? cmdlineDelProceso;
  const cmdline = opts.cmdline ?? cmdlineDe(pid) ?? process.argv.join(" ");

  const lock: Lock = {
    path,
    pid,
    release() {
      // Sólo si sigue siendo NUESTRA: si una instancia posterior la pisó (porque
      // nos dio por muertos), borrarla la dejaría a ella sin marca.
      const actual = leerMarca(path);
      if (actual?.pid === pid) borrar(path);
    },
  };

  for (let intento = 0; intento < MAX_INTENTOS; intento++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, `${pid}\n${cmdline}\n`);
      } finally {
        closeSync(fd);
      }
      return { ok: true, lock, aviso: null };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST") {
        // No es que esté tomada: no se puede escribir ahí. Se sigue sin marca.
        return {
          ok: true,
          lock: { path, pid, release() {} },
          aviso: e instanceof Error ? e.message : String(e),
        };
      }
    }

    const marca = leerMarca(path);
    if (marca && vivo(marca.pid)) {
      const actual = cmdlineDe(marca.pid);
      // Las dos condiciones: el proceso existe Y es el mismo programa. Si el
      // `cmdline` guardado quedó vacío (marca de una versión vieja o `/proc`
      // ilegible al escribirla), alcanza con que el PID esté vivo.
      if (actual === null ? false : marca.cmdline === "" || actual === marca.cmdline) {
        return { ok: false, ajena: marca };
      }
    }

    // Huérfana (PID muerto, PID reciclado por otro programa, o archivo ilegible):
    // se borra y se vuelve a intentar la creación exclusiva. El reintento no es
    // paranoia: entre el `unlink` y el `open` puede colarse otra instancia, y en
    // ese caso la vuelta siguiente la va a ver viva y devolver `ok:false`.
    borrar(path);
  }

  // Tres vueltas sin poder crearla: hay alguien más peleándola. Ante la duda, no
  // se arranca (CA-18.1 es la regla; la marca huérfana es la excepción).
  return { ok: false, ajena: leerMarca(path) ?? { pid: 0, cmdline: "" } };
}
