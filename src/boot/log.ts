// Logger de archivo: una línea por evento, con timestamp (CA-16.1), rotación a
// los 5 MB conservando como máximo un anterior (CA-16.4) y campos acotados a
// escalares, con una lista de nombres prohibidos que frena cuerpos y material de
// sesión (CA-14.7).
//
// La protección es de DOS capas y conviene saber hasta dónde llega:
//   1. el tipo `Fields` rechaza los nombres prohibidos y todo lo que no sea
//      escalar → el error salta en el editor, pero SÓLO con objetos literales;
//   2. `fmtLinea` vuelve a filtrar en runtime (case-insensitive) → tapa el
//      agujero de pasar un `Record<string, string>` armado en otro lado, que el
//      chequeo de tipos deja entrar sin chistar.
// Lo que NO puede garantizar: es una lista de NOMBRES, no un detector de
// contenido. Si alguien mete el cuerpo de un mensaje en un campo `motivo`, va a
// parar al log. La regla sigue siendo no pasarle cuerpos al logger.
//
// Sin deps (D12): son treinta líneas contra un `appendFileSync`. Escribe al MISMO
// archivo al que apunta el fd 2 redirigido por `boot/stderr.ts`, en modo append:
// los dos caminos conviven sin pisarse.
import { appendFileSync, chmodSync, copyFileSync, statSync, truncateSync } from "node:fs";

/** Lo único que puede viajar como valor de un campo. */
export type Scalar = string | number | boolean | null;

/**
 * Nombres de campo prohibidos: son los que arrastrarían el cuerpo de un mensaje
 * o material de sesión al log (CA-14.7). Una sola lista para las dos capas —el
 * tipo `Fields` y el filtro de `fmtLinea`— así no se desincronizan. Todo en
 * minúscula: la comparación en runtime es case-insensitive.
 */
const PROHIBIDOS = [
  "body",
  "text",
  "caption",
  "content",
  "message",
  "msg",
  "payload",
  "creds",
  "credentials",
  "key",
  "keys",
  "secret",
  "token",
  "password",
  "auth",
  "qr",
  // El código que revela los chats con candado (`boot/lockcode.ts`) y todo lo
  // que se deriva de él. `hash`/`salt` también: solos no sirven para entrar, pero
  // con ellos en el log alcanza para probar los 10⁶ códigos de seis dígitos sin
  // tocar el archivo de 0600.
  //
  // ⚠️ `code` NO está en la lista, a propósito: es el código de desconexión de
  // WhatsApp (401, 440, 515) y es lo primero que se mira cuando la sesión se
  // cae (`wa.close`). El código del candado se llama `codigo` en todos lados
  // justamente para no tener que elegir entre las dos cosas — y de todas formas
  // la regla de fondo sigue siendo la de arriba: al logger no se le pasan
  // secretos, la lista de nombres es la red, no la puerta.
  "codigo",
  "pin",
  "hash",
  "salt",
] as const;

/** Los mismos nombres como unión, para tiparlos `never` en `Fields`. */
type Prohibido = (typeof PROHIBIDOS)[number];

const PROHIBIDOS_SET: ReadonlySet<string> = new Set(PROHIBIDOS);

/**
 * Campos de una línea de log: sólo escalares (nada de objetos, así no se cuela
 * un `WAMessage` ni el objeto de creds entero) y ninguna de las claves de
 * `Prohibido`. Los strings además se recortan en runtime a `MAX_VALOR`.
 */
export type Fields = Record<string, Scalar> & { [K in Prohibido]?: never };

export type Logger = {
  info(ev: string, f?: Fields): void;
  warn(ev: string, f?: Fields): void;
  error(ev: string, f?: Fields): void;
  /** Ruta del archivo, para mostrarla en la ayuda (CA-16.3). */
  path: string;
};

const MAX_BYTES_DEFAULT = 5 * 1024 * 1024;
/** Tope de un valor string: red de seguridad de CA-14.7 si algo se cuela. */
const MAX_VALOR = 200;

/** Todo lo que rompería el formato `clave=valor` de una sola línea. */
const NECESITA_COMILLAS = /[\s"'=]/;

function fmtValor(v: Scalar): string {
  if (v === null) return "null";
  if (typeof v !== "string") return String(v);
  const s = v.length > MAX_VALOR ? `${v.slice(0, MAX_VALOR)}…` : v;
  return s === "" || NECESITA_COMILLAS.test(s) ? JSON.stringify(s) : s;
}

/** Lo único que `fmtValor` sabe imprimir sin arrastrar sorpresas. */
function esEscalar(v: unknown): v is Scalar {
  return v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/**
 * Arma la línea filtrando de nuevo en runtime (CA-14.7): el denylist del tipo
 * `Fields` sólo alcanza a los objetos literales, y un `Record<string, string>`
 * con `body` adentro compila igual. Se descarta por nombre —sin importar
 * mayúsculas— y cualquier valor que no sea escalar. Lo omitido deja rastro en
 * `omitidos=N`: borrar en silencio es peor para debuggear que borrar a la vista.
 */
function fmtLinea(nivel: string, ev: string, f?: Fields): string {
  let linea = `[${new Date().toISOString()}] ${nivel.padEnd(5)} ${ev}`;
  if (f) {
    let omitidos = 0;
    for (const [k, v] of Object.entries(f)) {
      if (v === undefined) continue;
      if (PROHIBIDOS_SET.has(k.toLowerCase()) || !esEscalar(v)) {
        omitidos++;
        continue;
      }
      linea += ` ${k}=${fmtValor(v)}`;
    }
    if (omitidos > 0) linea += ` omitidos=${omitidos}`;
  }
  return `${linea}\n`;
}

/** Deja el archivo en 0600 aunque ya existiera con permisos laxos (RNF-12). */
function endurecer(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    /* si todavía no existe, el próximo append lo crea con el umask 0o077 */
  }
}

/**
 * Rota por copia + truncado (el "copytruncate" de logrotate) en vez de renombrar.
 * Es a propósito: el fd 2 del proceso apunta a este archivo por `dup2` (D9) y un
 * `rename` lo dejaría escribiendo para siempre en el inodo viejo — o sea, los
 * warnings de Bun terminarían en un archivo que la rotación siguiente pisa.
 * Truncando, el inodo es el mismo y el fd sigue sirviendo.
 */
function rotarSiHaceFalta(path: string, maxBytes: number): void {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return;
  }
  if (size <= maxBytes) return;

  const previo = `${path}.1`;
  copyFileSync(path, previo); // pisa el anterior: nunca hay más de uno (CA-16.4)
  endurecer(previo);
  truncateSync(path, 0);
}

/**
 * Logger de archivo. Nunca lanza: un problema para escribir el log no puede
 * voltear la app (por eso cada escritura va en su propio try/catch).
 */
export function createLogger(path: string, maxBytes = MAX_BYTES_DEFAULT): Logger {
  // Toque inicial: si el archivo lo creó el `2>>` del wrapper con el umask de la
  // shell del usuario puede estar en 0644, y un `open` sobre algo que ya existe
  // NO corrige el modo.
  try {
    appendFileSync(path, "", { mode: 0o600 });
    endurecer(path);
  } catch {
    /* el dir puede no existir todavía; se reintenta en cada escritura */
  }

  const escribir = (nivel: string, ev: string, f?: Fields): void => {
    try {
      appendFileSync(path, fmtLinea(nivel, ev, f), { mode: 0o600 });
      rotarSiHaceFalta(path, maxBytes);
    } catch {
      /* sin log no se puede hacer nada: no hay adónde avisar y la app sigue */
    }
  };

  return {
    info: (ev, f) => escribir("INFO", ev, f),
    warn: (ev, f) => escribir("WARN", ev, f),
    error: (ev, f) => escribir("ERROR", ev, f),
    path,
  };
}
