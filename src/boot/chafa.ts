// Convertir una imagen en celdas de texto con color, para poder DIBUJARLA
// adentro del layout de OpenTUI (`^O`).
//
// ⚠️ **Por qué `chafa` y no el protocolo gráfico de la terminal.** Ghostty
// soporta el protocolo de kitty y se ve infinitamente mejor, pero **OpenTUI es
// el dueño de la pantalla**: mantiene su propio buffer de celdas y lo vuelca en
// cada frame, así que una imagen escrita por fuera la pisa el frame siguiente —y
// para que no la pise habría que pelearse con el renderer (posicionar el cursor
// a mano, adivinar cuándo repinta, sacar la imagen antes de cada scroll). No hay
// forma de hacerlo bien desde acá sin tocar OpenTUI: queda descartado y escrito.
//
// `chafa` en cambio devuelve **celdas de texto normales** —medio bloque `▄` con
// un color de frente y uno de fondo, o sea dos píxeles por celda— que se pintan
// como cualquier otro `<text>`: entran en el layout, scrollean con el panel,
// sobreviven a un redibujo y no rompen nada. Menos fidelidad, cero conflicto.
//
// Es el MISMO enfoque que ya usa el QR (D10, `wa/qr.ts` dibuja la matriz con
// medios bloques): acá los medios bloques los calcula `chafa` porque decodificar
// un JPEG en JS sería una dependencia nueva (D12).
//
// Tres cuidados, los mismos que `boot/clipboard.ts`:
//   1. es un proceso externo ⇒ puede no existir, colgarse o devolver basura, y
//      nada de eso puede voltear la TUI: hay timeout, la lectura es acotada y
//      **nada de acá lanza**;
//   2. lo que devuelve es entrada no confiable que va a parar a una terminal ⇒ se
//      PARSEA (no se escupe crudo): del ANSI sólo se entienden los colores, y
//      cualquier otra secuencia se descarta;
//   3. el set de símbolos se restringe a `space+vhalf+solid` (` ▀▄█`), que son
//      todos de ancho 1 sin ambigüedad. Con el set completo entran caracteres de
//      ancho ambiguo y la imagen se desalinea sola en la mitad de las terminales.
import type { Correr } from "./clipboard";
// `correrReal` es el mismo "spawneá esto sin que nos cuelgue" del portapapeles
// (timeout que es una CARRERA contra la lectura, tope de bytes, `stderr` a
// `ignore`). Se reusa en vez de copiarlo: es el detalle que más caro salió
// afinar y no puede haber dos versiones que se desincronicen.
import { correrReal } from "./clipboard";

/** Un tramo de celdas seguidas con el mismo color. Es lo que se pinta como `<span>`. */
export type Tramo = { texto: string; fg: string; bg: string };
/** Una fila de la imagen. */
export type FilaImagen = Tramo[];

export type ResultadoImagen =
  | { ok: true; filas: FilaImagen[]; reason?: undefined }
  | { ok: false; filas?: undefined; reason: string };

export const MOTIVO_SIN_CHAFA = "no encontré `chafa`: instalalo para poder ver las imágenes acá adentro";
export const MOTIVO_VACIO = "chafa no devolvió nada";

/** Cuánto se le da a `chafa` antes de matarlo. Convertir una foto son milisegundos. */
export const TIMEOUT_MS = 5_000;

/**
 * Tope de la salida de `chafa`, en bytes. Una celda son ~40 bytes de secuencias
 * ANSI, así que 8 MB cubren una imagen de 200×200 celdas con holgura y ponen un
 * techo a lo que puede entrar en memoria si `chafa` se vuelve loco.
 */
export const TOPE_SALIDA = 8 * 1024 * 1024;

/** Techo de celdas que se le piden. Más que esto no entra en ninguna terminal. */
const MAX_COLS = 400;
const MAX_FILAS = 200;

/** Dos dígitos hexa, siempre. */
const hex2 = (n: number): string => Math.max(0, Math.min(255, Math.floor(n))).toString(16).padStart(2, "0");

const rgb = (r: number, g: number, b: number): string => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

/**
 * Secuencias ANSI: CSI (`\e[…`), OSC y los escapes de dos caracteres. Se captura
 * el cuerpo y la letra final para poder quedarse SÓLO con los `m` (colores) y
 * tirar todo lo demás —`chafa` manda `\e[?25l` / `\e[?25h` alrededor de la
 * imagen, y una imagen no tiene por qué poder esconder el cursor—.
 */
const SECUENCIA = /\u001b\[([0-9;:?]*)([ -\/]*)([@-~])|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[0-~]/g;

/**
 * Convierte la salida de `chafa -f symbols -c full` en filas de tramos.
 *
 * Es PURA y está exportada para poder testearla sin spawnear nada. Lo que
 * entiende del ANSI es deliberadamente poquísimo:
 *   · `0` (o vacío) ⇒ vuelve a los colores del panel;
 *   · `38;2;r;g;b` ⇒ color de frente; `48;2;r;g;b` ⇒ color de fondo;
 *   · `39` / `49` ⇒ frente / fondo por defecto;
 *   · **cualquier otra cosa se ignora** y el color sigue como estaba.
 *
 * Los colores son de ESTADO y no de tramo: `chafa` sólo emite la secuencia
 * cuando cambia algo, así que una fila puede empezar heredando el color de la
 * anterior. Por eso el estado NO se resetea entre filas.
 */
export function parsearChafa(salida: string): FilaImagen[] {
  const texto = String(salida ?? "");
  const filas: FilaImagen[] = [];
  let fila: FilaImagen = [];
  let fg = "";
  let bg = "";

  /** Acumula un texto en el tramo actual, o abre uno nuevo si cambió el color. */
  const escribir = (s: string): void => {
    if (s === "") return;
    const ultimo = fila[fila.length - 1];
    if (ultimo && ultimo.fg === fg && ultimo.bg === bg) ultimo.texto += s;
    else fila.push({ texto: s, fg, bg });
  };

  const cerrarFila = (): void => {
    filas.push(fila);
    fila = [];
  };

  const aplicarSgr = (cuerpo: string): void => {
    // `\e[m` pelado es lo mismo que `\e[0m`.
    const params = (cuerpo === "" ? "0" : cuerpo).split(";").map((p) => Number(p.split(":")[0]));
    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      if (p === 0) {
        fg = "";
        bg = "";
      } else if (p === 39) fg = "";
      else if (p === 49) bg = "";
      else if ((p === 38 || p === 48) && params[i + 1] === 2) {
        const color = rgb(params[i + 2] ?? 0, params[i + 3] ?? 0, params[i + 4] ?? 0);
        if (p === 38) fg = color;
        else bg = color;
        i += 4;
      } else if ((p === 38 || p === 48) && params[i + 1] === 5) {
        // 256 colores: no se pide (`-c full`), pero si llegara se saltea el
        // índice en vez de tomarlo por un atributo suelto.
        i += 2;
      }
      // El resto (negrita, itálica, colores de la paleta de 16) no aplica a una
      // imagen y se ignora en silencio.
    }
  };

  let pos = 0;
  SECUENCIA.lastIndex = 0;
  for (let m = SECUENCIA.exec(texto); m !== null; m = SECUENCIA.exec(texto)) {
    // El texto plano que quedó ANTES de la secuencia, partido por saltos.
    const plano = texto.slice(pos, m.index);
    for (const [i, trozo] of plano.split("\n").entries()) {
      if (i > 0) cerrarFila();
      escribir(trozo.replace(/\r/g, ""));
    }
    // Sólo los SGR (`m`) y sólo si no son privados (`?`): `\e[?25l` no es color.
    if (m[3] === "m" && !(m[1] ?? "").includes("?")) aplicarSgr(m[1] ?? "");
    pos = m.index + m[0].length;
  }
  for (const [i, trozo] of texto.slice(pos).split("\n").entries()) {
    if (i > 0) cerrarFila();
    escribir(trozo.replace(/\r/g, ""));
  }
  cerrarFila();

  // La última fila suele quedar vacía (la salida termina en `\n`), y una fila
  // vacía en el medio es una fila de la imagen: sólo se tiran las del final.
  while (filas.length > 0 && (filas[filas.length - 1] as FilaImagen).length === 0) filas.pop();
  return filas;
}

export type OpcionesChafa = {
  /** Ruta del binario. Default: se busca en el `PATH`. */
  bin?: string | null;
  /** Busca el binario. Default `Bun.which`; el test le pasa uno de juguete. */
  which?: (bin: string) => string | null;
  /** Corre el comando. Default `correrReal` (el mismo del portapapeles). */
  correr?: Correr;
  timeoutMs?: number;
  maxBytes?: number;
};

/**
 * Los argumentos con los que se llama a `chafa`. Exportado para poder afirmarlos
 * en un test: son la diferencia entre una imagen alineada y uno de esos
 * "dibujitos" corridos que hacen dudar de todo lo demás.
 */
export function argsChafa(ruta: string, cols: number, filas: number): string[] {
  const c = Math.max(1, Math.min(MAX_COLS, Math.floor(cols)));
  const f = Math.max(1, Math.min(MAX_FILAS, Math.floor(filas)));
  return [
    "--format=symbols",
    // Color de 24 bits: hace que la única secuencia de color que puede llegar
    // sea `38;2;…` / `48;2;…`, que es la que el parser entiende.
    "--colors=full",
    // ` ▀▄█`: todos de ancho 1. Con el set completo entran glifos de ancho
    // ambiguo y la imagen se desalinea sola.
    "--symbols=space+vhalf+solid",
    // Un GIF animado es una imagen, no una película: se pinta el primer cuadro.
    "--animate=off",
    // Sin marco, sin leyenda: acá el marco lo pone el panel.
    "--margin-bottom=0",
    "--margin-right=0",
    `--size=${c}x${f}`,
    "--",
    ruta,
  ];
}

/**
 * Lado de la grilla con la que se le saca UN color a una foto de perfil.
 *
 * ⚠️ **No es 1: el PROMEDIO de un retrato es barro.** Medido sobre doce fotos de
 * perfil plausibles (piel + fondo + ropa, que es de lo que está hecho un
 * retrato), el color medio dio: `#9b8e80 #bda599 #7f7865 #9b9b8b #b8aeab #7d765c
 * #b3a08a #756056 #828e96 #8f9b50 #b4a096 #676b6c`. O sea **doce beiges
 * grisáceos**: como cosa para distinguir un chat de otro, no sirve para nada.
 *
 * Con una grilla de 5×5 y quedándose con la celda de más CROMA, las mismas doce
 * fotos dan: `#c58b59 #a13056 #fbb61b #e9c39e #d9a679 #c68541 #8d5524 #cd625d
 * #a86b3c #6a8e22 #77498c #ddaa68` — carmín, ámbar, rojo, verde, violeta y una
 * familia de tostados. Sigue habiendo un grupo parecido (la piel es lo más
 * saturado de muchos retratos), pero ya hay con qué reconocer una fila de un
 * vistazo, que es todo lo que se le pide.
 */
const GRILLA_COLOR = 5;

/**
 * Argumentos para muestrear una imagen en una grilla chica.
 *
 * `--stretch` es lo que garantiza que salga exactamente la grilla pedida: sin él,
 * `chafa` respeta la proporción y una foto vertical puede dar menos filas.
 * `--symbols=solid` fuerza el bloque lleno `█`, o sea una celda con UN color de
 * frente (con medios bloques saldrían dos y habría que elegir).
 */
export function argsColorDominante(ruta: string): string[] {
  return [
    "--format=symbols",
    "--colors=full",
    "--symbols=solid",
    "--animate=off",
    "--stretch",
    `--size=${GRILLA_COLOR}x${GRILLA_COLOR}`,
    "--",
    ruta,
  ];
}

/** Un color a sus tres canales. Devuelve `null` si no es un `#rrggbb`. */
function canalesDe(hex: string): [number, number, number] | null {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

/**
 * De un puñado de colores, el que MÁS COLOR tiene (el de más croma).
 *
 * Es puro y está exportado para poder testearlo sin spawnear nada. Dos guardas:
 * un color casi negro se descarta —el croma de una sombra es ruido, y encima
 * sobre el panel oscuro no se vería— y, a igual croma, gana el más claro.
 */
export function masSaturado(colores: string[]): string | null {
  let mejor: string | null = null;
  let mejorCroma = -1;
  let mejorValor = -1;
  for (const c of colores) {
    const rgb = canalesDe(c);
    if (!rgb) continue;
    const valor = Math.max(...rgb);
    // Debajo de esto es una sombra: no hay color que rescatar.
    if (valor <= 40) continue;
    const croma = valor - Math.min(...rgb);
    if (croma > mejorCroma || (croma === mejorCroma && valor > mejorValor)) {
      mejor = c;
      mejorCroma = croma;
      mejorValor = valor;
    }
  }
  return mejor;
}

/**
 * El color con el que se tiñe el glifo de un chat en la bandeja: el más vivo de
 * su foto de perfil. `null` si no se pudo sacar ninguno.
 * **Nunca lanza y nunca cuelga.**
 *
 * Una celda no alcanza para reconocer una cara —por eso no se dibuja la foto—,
 * pero sí para que cada chat tenga SU color y la lista se recorra con el ojo en
 * vez de leyéndola entera.
 */
export async function colorDominante(ruta: string, opts: OpcionesChafa = {}): Promise<string | null> {
  const r = await correrChafa(argsColorDominante(ruta), opts);
  if (!r.ok) return null;
  const colores: string[] = [];
  for (const fila of r.filas) for (const t of fila) if (t.fg) colores.push(t.fg);
  return masSaturado(colores);
}

/**
 * Convierte la imagen de `ruta` a celdas de a lo sumo `cols`×`filas`.
 * **Nunca lanza y nunca cuelga.**
 */
export async function renderizarImagen(
  ruta: string,
  cols: number,
  filas: number,
  opts: OpcionesChafa = {},
): Promise<ResultadoImagen> {
  return correrChafa(argsChafa(ruta, cols, filas), opts);
}

/** El tramo común: encontrar el binario, correrlo acotado y parsear la salida. */
async function correrChafa(args: string[], opts: OpcionesChafa): Promise<ResultadoImagen> {
  const buscar = opts.which ?? ((bin: string) => Bun.which(bin));
  let bin = opts.bin ?? null;
  if (!bin) {
    try {
      bin = buscar("chafa");
    } catch {
      // Un `which` que lanza es un `which` que no encontró nada.
      bin = null;
    }
  }
  if (!bin) return { ok: false, reason: MOTIVO_SIN_CHAFA };

  const correr = opts.correr ?? correrReal;
  const salida = await correr(
    [bin, ...args],
    opts.timeoutMs ?? TIMEOUT_MS,
    opts.maxBytes ?? TOPE_SALIDA,
  );
  // Salida ≠ 0 sin motivo es "chafa no pudo con este archivo" (`correrReal`
  // devuelve `reason: ""` para eso, ver su comentario).
  if (!salida.ok) return { ok: false, reason: salida.reason || "chafa no pudo con esa imagen" };

  const parseadas = parsearChafa(new TextDecoder("utf-8", { fatal: false }).decode(salida.bytes));
  if (parseadas.length === 0) return { ok: false, reason: MOTIVO_VACIO };
  return { ok: true, filas: parseadas };
}
