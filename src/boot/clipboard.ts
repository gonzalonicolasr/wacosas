// Leer el portapapeles DEL SISTEMA (la tecla `^V` del campo de redacción).
//
// ⚠️ **Lo más contraintuitivo de todo el archivo, y conviene leerlo antes de
// tocar nada: el terminal NO le puede pasar una imagen a una TUI.** El pegado de
// una terminal —bracketed paste, `\e[200~ … \e[201~`— entrega **texto** y nada
// más; no existe un evento "acá va un PNG". Así que `^V` no *recibe* la imagen:
// es la tecla con la que el usuario nos autoriza a salir NOSOTROS a leer el
// portapapeles del sistema, spawneando `wl-paste` (o su equivalente) y leyendo
// los bytes por un pipe.
//
// De ahí se desprende todo lo demás:
//
//  1. **Es un proceso externo, o sea que puede no existir, colgarse o devolver
//     basura.** Ninguna de las tres cosas puede voltear la TUI ni congelarla:
//     hay `TIMEOUT_MS` con `kill(9)`, la lectura es ACOTADA (`TOPE_LECTURA`) y
//     esta función **nunca lanza** — todos los caminos vuelven por el
//     `ClipboardResult`.
//  2. **Lo que llega es entrada NO CONFIABLE que va a parar a una terminal.** El
//     texto se limpia de secuencias ANSI y de caracteres de control antes de
//     devolverlo (`limpiarTexto`): un portapapeles con `\e[2J` adentro no puede
//     borrarle la pantalla al usuario.
//  3. **Que el portapapeles ANUNCIE `image/png` no significa que lo sea.** Los
//     bytes se validan por firma (`mimeDeImagen`) y el mime que se devuelve es el
//     que dicen los bytes, no el que dijo el anuncio. Sin esto podríamos subirle
//     a WhatsApp cualquier cosa.
//
// El orden de los backends va del más capaz al menos capaz: `wl-paste`
// (Wayland) → `xclip` → `xsel` → `pbpaste` (macOS), el primero que exista. Los
// dos últimos **sólo saben de texto** —`xsel` no tiene forma de pedir un target
// arbitrario y `pbpaste` necesitaría `osascript`—, así que ahí `^V` pega texto y
// avisa que no puede leer imágenes.
//
// Este módulo vive en `boot/` y no en `lib/` por lo mismo que `lock.ts`: `lib/`
// es puro y esto habla con el sistema operativo.

/** Lo que había en el portapapeles. Es una unión CERRADA: no hay excepciones. */
export type ClipboardResult =
  /** Una imagen válida. `mime` sale de la FIRMA de los bytes, no del anuncio. */
  | { kind: "image"; bytes: Uint8Array; mime: string; text?: undefined; reason?: undefined }
  /** Texto plano, ya limpio de ANSI y de caracteres de control. */
  | { kind: "text"; text: string; bytes?: undefined; mime?: undefined; reason?: undefined }
  /** No había nada (o lo que había estaba vacío). No es un error. */
  | { kind: "empty"; text?: undefined; bytes?: undefined; mime?: undefined; reason?: undefined }
  /** Algo salió mal y se puede explicar en una línea. */
  | { kind: "error"; reason: string; text?: undefined; bytes?: undefined; mime?: undefined };

/**
 * Tope de lo que se lee de un pipe, en bytes. **No es el límite de WhatsApp**
 * (ese vive en `wa/send.ts` y es más bajo): esto es la red que impide que un
 * portapapeles con un video de 2 GB se cargue entero en memoria y se lleve
 * puesto el proceso. Cómodamente por encima del límite de envío, así que el
 * mensaje que el usuario va a leer casi siempre es el de `wa/send.ts`, que
 * explica el motivo REAL.
 */
export const TOPE_LECTURA = 32 * 1024 * 1024;

/**
 * Tope del texto que se pega en el campo, en caracteres. No es una regla de
 * WhatsApp: es lo que evita que pegar un log de 30 MB deje la TUI midiendo el
 * envolvimiento de un `<textarea>` para siempre.
 */
export const TOPE_TEXTO = 65_536;

/** Cuánto se le da a `wl-paste` y compañía antes de matarlo. */
export const TIMEOUT_MS = 3_000;

export const MOTIVO_SIN_BACKEND =
  "no encontré wl-paste, xclip, xsel ni pbpaste: instalá uno para poder pegar";
export const MOTIVO_TIMEOUT = "el portapapeles no contestó a tiempo";
export const MOTIVO_NO_ES_IMAGEN =
  "el portapapeles dice tener una imagen pero lo que devolvió no lo es";
export const MOTIVO_BINARIO = "lo que hay en el portapapeles no es ni texto ni una imagen";
export const motivoDemasiadoGrande = (mb: number): string =>
  `lo que hay en el portapapeles pasa los ${mb} MB: demasiado para leerlo`;

// ── backends ────────────────────────────────────────────────────────────────

type Backend = {
  bin: string;
  /** Argumentos que listan los tipos MIME disponibles. `null` = no sabe hacerlo. */
  tipos: string[] | null;
  /** Argumentos que bajan un tipo MIME concreto. `null` = sólo sabe de texto. */
  leerTipo: ((mime: string) => string[]) | null;
  /** Argumentos que bajan el texto plano. */
  leerTexto: string[];
};

/** En orden de preferencia. El primero que exista en el `PATH` gana. */
export const BACKENDS: Backend[] = [
  {
    bin: "wl-paste",
    tipos: ["--list-types"],
    // `--no-newline` es importante: sin él `wl-paste` le agrega un `\n` al final
    // de TODO, incluidos los bytes de un PNG, y el archivo queda corrupto.
    leerTipo: (mime) => ["--type", mime, "--no-newline"],
    leerTexto: ["--no-newline"],
  },
  {
    bin: "xclip",
    tipos: ["-selection", "clipboard", "-t", "TARGETS", "-o"],
    leerTipo: (mime) => ["-selection", "clipboard", "-t", mime, "-o"],
    leerTexto: ["-selection", "clipboard", "-o"],
  },
  // `xsel` no tiene forma de pedir un target arbitrario del selection: sólo texto.
  { bin: "xsel", tipos: null, leerTipo: null, leerTexto: ["--clipboard", "--output"] },
  // `pbpaste` sí puede dar otros tipos, pero pedirle una imagen es una vuelta por
  // `osascript` + archivo temporal, que es exactamente lo que CA-7.4 no quiere.
  { bin: "pbpaste", tipos: null, leerTipo: null, leerTexto: [] },
];

// ── firmas de imagen ────────────────────────────────────────────────────────

/**
 * `[mime, firma]`. Se compara byte a byte contra el arranque del archivo: es la
 * única fuente de verdad sobre qué es lo que se está por subir.
 */
const FIRMAS: Array<[string, number[]]> = [
  ["image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ["image/jpeg", [0xff, 0xd8, 0xff]],
  ["image/gif", [0x47, 0x49, 0x46, 0x38]], // "GIF8"
];

/** `RIFF` … `WEBP`: la única que no es un prefijo corrido. */
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];

function arranca(bytes: Uint8Array, firma: number[], desde = 0): boolean {
  if (bytes.length < desde + firma.length) return false;
  for (let i = 0; i < firma.length; i++) if (bytes[desde + i] !== firma[i]) return false;
  return true;
}

/**
 * El mime REAL de estos bytes, o `null` si no son una imagen que sepamos
 * reconocer. Se mira la firma y nunca el anuncio del portapapeles: un
 * `--list-types` que dice `image/png` sobre un HTML es un caso que pasa (lo hace
 * más de un navegador) y subirlo sería mandarle basura a la otra persona.
 */
export function mimeDeImagen(bytes: Uint8Array | null | undefined): string | null {
  if (!bytes || bytes.length < 4) return null;
  for (const [mime, firma] of FIRMAS) if (arranca(bytes, firma)) return mime;
  if (arranca(bytes, RIFF) && arranca(bytes, WEBP, 8)) return "image/webp";
  return null;
}

// ── limpieza del texto ──────────────────────────────────────────────────────

/**
 * Secuencias ANSI: CSI (`\e[…`), OSC (`\e]…` cerrado con BEL o ST) y los escapes
 * de dos caracteres. Lo que se pega viene de cualquier lado —de un `cat` de un
 * log con color, por ejemplo— y en una TUI un `\e[2J` suelto borra la pantalla.
 */
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[0-~]/g;

/**
 * Texto listo para meter en el `<textarea>`: sin ANSI, con los finales de línea
 * normalizados a `\n` y sin caracteres de control (salvo `\n` y `\t`, que son
 * texto de verdad).
 */
export function limpiarTexto(raw: string): string {
  return String(raw ?? "")
    .replace(ANSI, "")
    .replace(/\r\n?/g, "\n")
    // C0 menos `\t`(09) y `\n`(0a), DEL y C1.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

// ── ejecutar un proceso sin que nos cuelgue ─────────────────────────────────

/** Lo que devuelve un comando: bytes, o un motivo para explicarle al usuario. */
export type Salida =
  | { ok: true; bytes: Uint8Array; reason?: undefined }
  | { ok: false; bytes?: undefined; reason: string };

export type Correr = (cmd: string[], timeoutMs: number, maxBytes: number) => Promise<Salida>;

function unir(trozos: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let i = 0;
  for (const t of trozos) {
    out.set(t, i);
    i += t.length;
  }
  return out;
}

/** Matar sin ruido: si ya murió, no hay nada que hacer ni a quién avisarle. */
function matar(proc: { kill: (n: number) => void }): void {
  try {
    proc.kill(9);
  } catch {
    /* ya estaba muerto */
  }
}

/**
 * Corre un comando y devuelve su `stdout`, con DOS topes que no se negocian:
 *
 *  · **tiempo**: pasados `timeoutMs` la función VUELVE, pase lo que pase.
 *  · **tamaño**: se lee de a trozos y se corta apenas se pasa de `maxBytes`, sin
 *    llegar a tener el archivo entero en memoria.
 *
 * ⚠️ **El tope de tiempo es una CARRERA contra la lectura, no sólo un `kill`**, y
 * la diferencia importa: matar al hijo no alcanza para destrabar el `read()`. Si
 * el hijo dejó un NIETO vivo (un `wl-paste` que a su vez espera a otra cosa, o un
 * script que hace `sleep`), el nieto hereda la punta de escritura del pipe y lo
 * mantiene abierto: el `read()` nunca recibe su `done` y la promesa queda colgada
 * para siempre. Con la carrera, el `kill` es el intento de limpiar y la carrera
 * es la garantía — la lectura se ABANDONA y el que espera sigue.
 *
 * `stderr` va a `ignore` a propósito: `wl-paste` escribe "No selection" ahí
 * cuando el portapapeles está vacío, y eso no es un error que valga la pena
 * mostrar (además, redirigir fd 2 es asunto de `boot/stderr.ts`).
 */
export const correrReal: Correr = async (cmd, timeoutMs, maxBytes) => {
  // Los tres parámetros son los `stdin`/`stdout`/`stderr` de abajo: sin ellos
  // `proc.stdout` queda tipado `number | ReadableStream` y no se le puede pedir
  // el `getReader()`.
  let proc: Bun.Subprocess<"ignore", "pipe", "ignore">;
  try {
    proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }

  const lector = proc.stdout.getReader();
  let reloj: ReturnType<typeof setTimeout> | null = null;

  const vencimiento = new Promise<Salida>((resolver) => {
    reloj = setTimeout(() => {
      matar(proc);
      resolver({ ok: false, reason: MOTIVO_TIMEOUT });
    }, Math.max(1, timeoutMs));
  });

  const lectura = (async (): Promise<Salida> => {
    const trozos: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await lector.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      total += value.length;
      if (total > maxBytes) {
        matar(proc);
        return { ok: false, reason: motivoDemasiadoGrande(Math.floor(maxBytes / (1024 * 1024))) };
      }
      trozos.push(value);
    }
    const code = await proc.exited;
    // Salida ≠ 0 NO es un error que se muestre: es como `wl-paste` dice "no hay
    // nada de este tipo". El que decide qué significa es el llamador.
    if (code !== 0) return { ok: false, reason: "" };
    return { ok: true, bytes: unir(trozos, total) };
  })();

  try {
    return await Promise.race([lectura, vencimiento]);
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    if (reloj) clearTimeout(reloj);
    // Suelta el pipe. Un `read()` pendiente se resuelve con `done` (así lo pide
    // la spec), o sea que esto también destraba la promesa abandonada de la
    // carrera en vez de dejarla viva hasta el fin del proceso.
    lector.cancel().catch(() => {});
    // Y que nadie se queje de que la lectura perdedora "rechazó sin dueño".
    lectura.catch(() => {});
  }
};

// ── API ─────────────────────────────────────────────────────────────────────

export type OpcionesPortapapeles = {
  /** `PATH` donde buscar los binarios. Default el del proceso; el test le pasa uno de juguete. */
  path?: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** Busca un binario. Default `Bun.which`. */
  which?: (bin: string, path: string | undefined) => string | null;
  /** Corre un comando. Default `correrReal`. */
  correr?: Correr;
};

/** El primer backend disponible con su ruta absoluta, o `null` si no hay ninguno. */
export function elegirBackend(opts?: OpcionesPortapapeles): { backend: Backend; ruta: string } | null {
  const buscar = opts?.which ?? ((bin: string, path?: string) => Bun.which(bin, path ? { PATH: path } : undefined));
  for (const backend of BACKENDS) {
    let ruta: string | null = null;
    try {
      ruta = buscar(backend.bin, opts?.path ?? process.env.PATH);
    } catch {
      // Un `which` que lanza es un `which` que no encontró nada.
      ruta = null;
    }
    if (ruta) return { backend, ruta };
  }
  return null;
}

/**
 * Qué hay en el portapapeles AHORA. **Nunca lanza y nunca cuelga.**
 *
 * Se prefiere la imagen: si el portapapeles anuncia un tipo `image/*`, se pide
 * ése; y sólo si no hay ninguno (o el backend no sabe listar tipos) se cae al
 * texto. Es el orden que espera el usuario que acaba de hacer una captura.
 */
export async function readClipboard(opts?: OpcionesPortapapeles): Promise<ClipboardResult> {
  const elegido = elegirBackend(opts);
  if (!elegido) return { kind: "error", reason: MOTIVO_SIN_BACKEND };

  const { backend, ruta } = elegido;
  const correr = opts?.correr ?? correrReal;
  const timeoutMs = opts?.timeoutMs ?? TIMEOUT_MS;
  const maxBytes = opts?.maxBytes ?? TOPE_LECTURA;
  const decodificar = new TextDecoder("utf-8", { fatal: false });

  // ── ¿hay una imagen? ──────────────────────────────────────────────────────
  if (backend.tipos && backend.leerTipo) {
    // Los tipos son una lista corta: acotarla evita que un `--list-types` que
    // escupe para siempre nos haga esperar el timeout entero por nada.
    const lista = await correr([ruta, ...backend.tipos], timeoutMs, 64 * 1024);
    // ⚠️ Un fallo CON motivo (se colgó, no se pudo spawnear) corta acá y no sigue
    // al texto: el backend ya demostró que no contesta, y volver a preguntarle
    // sólo duplica la espera —eran 2 × `timeoutMs` de campo congelado por nada—.
    // Un fallo SIN motivo es el "no hay nada de ese tipo" (salida ≠ 0) y ése sí
    // tiene que seguir de largo: es un portapapeles con texto y sin imagen.
    if (!lista.ok && lista.reason) return { kind: "error", reason: lista.reason };
    if (lista.ok) {
      const tipos = limpiarTexto(decodificar.decode(lista.bytes))
        .split("\n")
        .map((t) => t.trim())
        .filter(Boolean);
      const mimeAnunciado = tipos.find((t) => t.toLowerCase().startsWith("image/"));
      if (mimeAnunciado) {
        const img = await correr([ruta, ...backend.leerTipo(mimeAnunciado)], timeoutMs, maxBytes);
        if (!img.ok) return { kind: "error", reason: img.reason || MOTIVO_NO_ES_IMAGEN };
        // El anuncio no manda: manda la firma. Ver `mimeDeImagen`.
        const mime = mimeDeImagen(img.bytes);
        if (!mime) return { kind: "error", reason: MOTIVO_NO_ES_IMAGEN };
        return { kind: "image", bytes: img.bytes, mime };
      }
    }
  }

  // ── entonces, texto ───────────────────────────────────────────────────────
  const txt = await correr([ruta, ...backend.leerTexto], timeoutMs, maxBytes);
  // Sin `reason` es el "no hay nada de este tipo" de `correrReal` (salida ≠ 0):
  // portapapeles vacío, no un error que haya que explicar.
  if (!txt.ok) return txt.reason ? { kind: "error", reason: txt.reason } : { kind: "empty" };
  if (txt.bytes.length === 0) return { kind: "empty" };
  // Un NUL adentro es la señal clásica de que esto es binario, no texto (el mismo
  // criterio que usa `grep`). Sin esta guarda, un archivo copiado desde un
  // gestor de archivos entraría al campo de redacción como una sopa de `�`.
  if (txt.bytes.includes(0)) return { kind: "error", reason: MOTIVO_BINARIO };

  const texto = limpiarTexto(decodificar.decode(txt.bytes));
  if (texto.trim() === "") return { kind: "empty" };
  return { kind: "text", text: texto.slice(0, TOPE_TEXTO) };
}
