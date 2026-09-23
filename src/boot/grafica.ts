// Ver una imagen a CALIDAD REAL: suspender la TUI y dibujar con el protocolo
// gráfico de la terminal.
//
// ⚠️ **Por qué esto existe teniendo `boot/chafa.ts`.** Los medios bloques de
// `chafa` son DOS píxeles por celda: para una cara alcanza, para una captura de
// pantalla con texto es una mancha blanca. Medido sobre una captura real de
// 1600×900 en un panel de 76×18 celdas: en símbolos no se lee una sola palabra;
// con el protocolo de kitty se leen el título, la barra de direcciones y los
// marcadores. No es "un poco mejor": es la diferencia entre ver la imagen y no
// verla.
//
// ⚠️ **Y por qué no se dibuja adentro del layout.** Sigue valiendo lo que dice
// el encabezado de `chafa.ts`: OpenTUI es el dueño de la pantalla y vuelca su
// buffer en cada frame, así que una imagen escrita por fuera la pisa el frame
// siguiente. Lo que cambia acá es que **no se pelea con el renderer: se lo
// suspende**. `CliRenderer.suspend()` (OpenTUI 0.4.2) para el loop, apaga el
// mouse, suelta `stdin` y sale de la pantalla alternativa; `resume()` vuelve a
// entrar y repinta entero (`forceFullRepaintRequested`). El árbol de React nunca
// se desmonta: el scroll, la selección y el chat abierto siguen donde estaban
// —verificado con un contador vivo que siguió corriendo durante la suspensión—.
// Es el mismo patrón con el que cualquier TUI abre `$EDITOR` o `$PAGER`.
//
// Tres cuidados propios de escribirle CRUDO a la terminal:
//
//   1. **La pantalla alternativa es NUESTRA mientras dura.** Se entra con
//      `\e[?1049h` y se sale con `\e[?1049l`, así que el prompt que el usuario
//      tenía antes de abrir wacosas queda intacto: la imagen no le come el
//      scrollback (que es justo lo que se ve al salir con `^C`).
//   2. **La secuencia gráfica NO se puede parsear** (es el punto: son píxeles,
//      no celdas). El único emisor es `chafa`, invocado por nosotros con una
//      lista de argumentos fija y `--`, y lo que devuelve para el protocolo de
//      kitty es base64 —alfabeto que no puede cerrar la secuencia—. Los topes de
//      `correrReal` (tiempo y bytes) siguen puestos: una imagen que se vuelve
//      loca no puede vomitar 100 MB en la terminal. En el camino de SÍMBOLOS, en
//      cambio, se sigue pintando desde el parser de `chafa.ts` (`pintarFilas`),
//      así que ahí no se escupe nada crudo.
//   3. **Se DETECTA, no se asume.** Se le pregunta a la terminal con la consulta
//      del propio protocolo (`a=q`) y se espera su respuesta; el `\e[c` que va
//      pegado atrás es el que hace que un "no" tarde milisegundos en vez del
//      timeout entero. Sin respuesta ⇒ símbolos, sin romperse.
//
// **tmux**: el protocolo gráfico no atraviesa tmux salvo por su passthrough
// (`\ePtmux;…\e\\` + `allow-passthrough on`). Con eso anda —verificado en tmux
// 3.6b sobre Ghostty—, así que tanto la consulta como el dibujo se envuelven
// cuando hay `$TMUX`. Si el passthrough está apagado, la consulta se la come
// tmux, nadie contesta y caemos a símbolos: exactamente el mismo camino que una
// terminal sin gráficos. ⚠️ Lo que NO se usa es el `4` (sixel) que tmux anuncia
// en su DA1: probado en tmux+Ghostty, tmux dice que sí y no se dibuja NADA
// —pantalla en blanco—, porque el que no soporta sixel es la terminal de afuera.
import type { FilaImagen } from "./chafa";
import { MOTIVO_SIN_CHAFA, renderizarImagen } from "./chafa";
import type { Correr } from "./clipboard";
import { correrReal } from "./clipboard";
import { clip } from "../lib/fmt";

/** Lo único que se detecta hoy. `null` es "no hay: pintá símbolos". */
export type Protocolo = "kitty" | null;

/** Con qué se terminó dibujando. Va al log y al aviso del pie. */
export type Calidad = "kitty" | "simbolos";

export type ResultadoVista =
  | { ok: true; calidad: Calidad; reason?: undefined }
  | { ok: false; calidad?: undefined; reason: string };

export const MOTIVO_SIN_TERMINAL = "esto no es una terminal de verdad: no hay dónde dibujar";
export const MOTIVO_OCUPADO = "ya hay una imagen abierta";

/** Cuánto se espera la respuesta de la terminal. Local vuelve en ~6 ms; el resto es para ssh. */
export const TIMEOUT_CONSULTA_MS = 600;

/**
 * La espera EXTRA de tmux, y por qué existe (medido en tmux 3.6b + Ghostty):
 *
 * el `\e[c` que cierra la consulta lo contesta **tmux mismo**, al instante,
 * mientras que la respuesta gráfica tiene que ir hasta la terminal de afuera y
 * volver. Llegan en ese orden —`\e[?1;2;4c` primero, `\e_Gi=31;OK\e\\` 5 ms
 * después—, así que cortar en el DA1 es cortar JUSTO antes del sí. Sin estos
 * milisegundos, adentro de tmux la respuesta era siempre "no hay protocolo".
 */
export const GRACIA_TMUX_MS = 250;

/**
 * Topes del render gráfico. Son MÁS GRANDES que los de `chafa.ts` porque acá el
 * payload son píxeles de verdad: medido con la captura real, 90×25 celdas son
 * 2,4 MB y 240×70 llegan a ~18 MB (el cuadro es `celdas × 10×20 px`, RGBA, en
 * base64). Y el primer `chafa` de la sesión tardó 1,3 s contra los 35 ms de los
 * siguientes —el loader de JPEG arrancando en frío—, así que 5 s quedaba corto.
 */
export const TIMEOUT_GRAFICO_MS = 10_000;
export const TOPE_GRAFICO = 24 * 1024 * 1024;

/**
 * Techo de celdas que se le piden al render gráfico. No es un límite de la
 * terminal sino del payload: sin esto, una terminal de 300×80 (4K con fuente
 * chica) pide 24 MB y se pasa del tope de arriba. A 240×70 la imagen mide
 * 2400×1400 px, que es más resolución de la que tiene cualquier pantalla para
 * ese rectángulo.
 */
const MAX_COLS_GRAFICO = 240;
const MAX_FILAS_GRAFICO = 70;

/** El renglón de abajo: qué teclas hay mientras la imagen está en pantalla. */
export const PIE_IMAGEN = "cualquier tecla vuelve a wacosas · ^C sale";

/**
 * Y el aviso cuando se dibujó con símbolos: sin esto, alguien en una terminal
 * sin protocolo gráfico ve la misma mancha de siempre —ahora más grande— y no
 * tiene forma de saber que le falta la terminal, no la imagen.
 */
export const PIE_SIMBOLOS = "esta terminal no dibuja imágenes: va con símbolos";

// ── secuencias ───────────────────────────────────────────────────────────────

/** Entrar a la pantalla alternativa, limpiarla y esconder el cursor. */
const ENTRAR = "\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l";
/** Mostrar el cursor y volver a la pantalla de siempre (el prompt queda igual). */
const SALIR = "\x1b[?25h\x1b[?1049l";
/** Borra las imágenes que quedaron pegadas en la pantalla (`a=d`). */
const BORRAR_IMAGENES = "\x1b_Ga=d\x1b\\";

/**
 * La consulta del protocolo de kitty: transmite una imagen de 1×1 píxel en modo
 * "preguntá" (`a=q`) con el id 31. La terminal que lo entiende contesta
 * `\e_Gi=31;OK\e\\`; la que no, lo ignora entero.
 *
 * Atrás va un `\e[c` (DA1), que contesta CUALQUIER terminal: es el que marca "ya
 * llegó todo lo que iba a llegar" y hace que un "no" cueste milisegundos en vez
 * del timeout completo.
 */
export const CONSULTA_KITTY = "\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\";
const DA1 = "\x1b[c";

/**
 * Envuelve una secuencia para que tmux la deje pasar tal cual a la terminal de
 * afuera: `\ePtmux;` + el cuerpo con cada `\e` DUPLICADO + `\e\\`. Necesita
 * `set -g allow-passthrough on` del otro lado; sin eso tmux se la come y no pasa
 * nada (que es un "no hay protocolo", no un error).
 */
export function envolverTmux(seq: string): string {
  return `\x1bPtmux;${seq.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`;
}

/** Lo que hay que escribir para preguntar. Dentro de tmux va envuelto. */
export function consultaGrafica(enTmux: boolean): string {
  return (enTmux ? envolverTmux(CONSULTA_KITTY) : CONSULTA_KITTY) + DA1;
}

/** Lo que hay que escribir para despegar las imágenes de la pantalla. */
export function borradoGrafico(enTmux: boolean): string {
  return enTmux ? envolverTmux(BORRAR_IMAGENES) : BORRAR_IMAGENES;
}

/**
 * ¿Qué contestó la terminal? Es PURA y está exportada para poder testearla sin
 * ninguna terminal: es la línea entre "dibujo píxeles" y "dibujo símbolos".
 *
 * Sólo se mira el `OK` con NUESTRO id (`i=31`): una respuesta de otro id sería
 * de otro programa (o de otra pane), y un `EBADF`/`ENOENT` en vez de `OK` es un
 * "entiendo el protocolo pero eso no lo puedo hacer" que no sirve de garantía.
 */
export function leerProtocolo(respuesta: string): Protocolo {
  return /\x1b_Gi=31;OK\x1b\\/.test(respuesta) ? "kitty" : null;
}

/** ¿Ya llegó el DA1? O sea: ya contestó todo lo que iba a contestar. */
export function respuestaCompleta(respuesta: string): boolean {
  return /\x1b\[\?[0-9;]*c/.test(respuesta);
}

/**
 * Argumentos de `chafa` para el dibujo GRÁFICO. Exportados por lo mismo que
 * `argsChafa`: son la diferencia entre una imagen y un rectángulo raro.
 */
export function argsChafaGrafico(ruta: string, cols: number, filas: number, enTmux: boolean): string[] {
  const c = Math.max(1, Math.min(MAX_COLS_GRAFICO, Math.floor(cols)));
  const f = Math.max(1, Math.min(MAX_FILAS_GRAFICO, Math.floor(filas)));
  return [
    "--format=kitty",
    // Un GIF animado es una imagen, no una película (igual que en `argsChafa`).
    "--animate=off",
    // El passthrough se dice EXPLÍCITO y no se deja en `auto`: nuestro `stdout`
    // es un pipe (lo lee `correrReal`), así que chafa no está mirando la misma
    // terminal que nosotros y su detección automática no tiene por qué acertar.
    `--passthrough=${enTmux ? "tmux" : "none"}`,
    "--margin-bottom=0",
    "--margin-right=0",
    `--size=${c}x${f}`,
    "--",
    ruta,
  ];
}

/**
 * El renglón de teclas, CLAVADO en la última fila y sin salto al final.
 *
 * ⚠️ Las dos cosas son a propósito y las dos costaron una verificación:
 *
 *  · **posición absoluta** (`\e[<fila>;1H`) en vez de "donde haya quedado el
 *    cursor": medido en Ghostty **sin** tmux, escribir el pie a continuación de
 *    la imagen lo dejaba INVISIBLE —la imagen del protocolo gráfico ocupa su
 *    rectángulo de celdas y el texto que cae ahí abajo no se ve—. Con tmux no
 *    pasaba, porque ahí el texto lo dibuja tmux y la imagen la terminal de
 *    afuera: el mismo código se veía distinto en cada lado;
 *  · **sin `\n` final**: un salto de línea en la ÚLTIMA fila hace scroll, y un
 *    scroll con una imagen puesta arrastra la imagen media fila para arriba.
 *
 * Y va recortado a `cols - 1` para que tampoco haga scroll por auto-wrap en una
 * terminal angosta.
 */
export function pieEnElBorde(texto: string, cols: number, filas: number): string {
  const fila = Math.max(1, Math.floor(filas));
  // `\e[2K` limpia la fila entera: abajo puede haber quedado media imagen.
  return `\x1b[${fila};1H\x1b[0m\x1b[2K${clip(texto, Math.max(1, cols - 1))}`;
}

/**
 * Filas parseadas → texto con color, listo para escribirle a la terminal.
 *
 * Es el camino de SÍMBOLOS, y va por acá —y no escupiendo la salida de `chafa`—
 * para no perder el cuidado 2 del encabezado de `chafa.ts`: lo que se escribe
 * son colores que ARMAMOS nosotros a partir de `#rrggbb` ya parseados, no ANSI
 * ajeno. `\r\n` y no `\n` porque en modo crudo el `\n` no vuelve al margen.
 */
export function pintarFilas(filas: FilaImagen[]): string {
  const sgr = (hex: string, fondo: boolean): string => {
    const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex);
    if (!m) return fondo ? "\x1b[49m" : "\x1b[39m";
    return `\x1b[${fondo ? 48 : 38};2;${parseInt(m[1], 16)};${parseInt(m[2], 16)};${parseInt(m[3], 16)}m`;
  };
  let out = "";
  for (const fila of filas) {
    for (const t of fila) out += sgr(t.fg, false) + sgr(t.bg, true) + t.texto;
    out += "\x1b[0m\r\n";
  }
  return out;
}

// ── la terminal ──────────────────────────────────────────────────────────────

/**
 * Todo lo que esta pantalla necesita de la terminal. Se inyecta entero para que
 * el test pueda correr el camino completo sin un TTY (y sin dejar a `bun test`
 * en modo crudo, que es lo que pasa si alguien toca `process.stdin` de verdad).
 */
export type Terminal = {
  esTerminal(): boolean;
  columnas(): number;
  filas(): number;
  escribir(datos: string | Uint8Array): void;
  /**
   * Espera a que TODO lo escrito haya salido de verdad.
   *
   * No es paranoia: la imagen son megabytes (2,4 MB a 90×25) y `write` vuelve
   * enseguida dejando el resto encolado. Sin esta espera, una tecla apretada
   * mientras la imagen todavía está saliendo reanudaría la TUI con media
   * secuencia gráfica todavía en camino —y esos bytes caerían encima del primer
   * frame—.
   */
  vaciar(): Promise<void>;
  /** Modo crudo: sin eco, sin línea, y `^C` llega como `\x03` en vez de matar. */
  crudo(activo: boolean): void;
  /** Espera lo que sea que llegue. `hasta` corta antes por respuesta completa. */
  leer(timeoutMs: number, hasta?: (acumulado: string) => boolean): Promise<string>;
};

/** La terminal de verdad (`process.stdin`/`process.stdout`). */
export function terminalReal(): Terminal {
  const stdin = process.stdin;
  const stdout = process.stdout;
  return {
    esTerminal: () => Boolean(stdout.isTTY && stdin.isTTY && stdin.setRawMode),
    columnas: () => stdout.columns ?? 80,
    filas: () => stdout.rows ?? 24,
    escribir: (datos) => void stdout.write(datos as string),
    // Una escritura vacía se encola DETRÁS de lo anterior, así que su callback
    // es el "ya salió todo" que buscamos, sin tener que enhebrar un callback por
    // cada `escribir`.
    vaciar: () => new Promise<void>((listo) => stdout.write("", () => listo())),
    crudo(activo) {
      stdin.setRawMode?.(activo);
      if (activo) stdin.resume();
      else stdin.pause();
    },
    leer(timeoutMs, hasta) {
      return new Promise<string>((resolver) => {
        let visto = "";
        let reloj: ReturnType<typeof setTimeout> | null = null;
        const terminar = (): void => {
          if (reloj) clearTimeout(reloj);
          stdin.off("data", alLlegar);
          resolver(visto);
        };
        function alLlegar(b: Buffer): void {
          // `binary` (latin1) y no `utf8`: acá lo que importa son los BYTES de
          // una secuencia de control, no el texto —y un `\x1b` partido al medio
          // de un chunk no tiene que convertirse en un `�`—.
          visto += b.toString("binary");
          if (!hasta || hasta(visto)) terminar();
        }
        stdin.on("data", alLlegar);
        reloj = setTimeout(terminar, Math.max(1, timeoutMs));
      });
    },
  };
}

// ── el protocolo, una vez por proceso ────────────────────────────────────────

/**
 * Lo detectado. Se cachea porque una terminal no cambia de protocolo en el medio
 * de una sesión, y porque la consulta cuesta una ida y vuelta con la terminal
 * (que en modo crudo hay que abrir y cerrar). `undefined` es "todavía no se
 * preguntó"; `null`, "se preguntó y no hay".
 */
let cacheProtocolo: Protocolo | undefined;

/** Para los tests: la próxima vista vuelve a preguntar. */
export function olvidarProtocolo(): void {
  cacheProtocolo = undefined;
}

/**
 * Le pregunta a la terminal qué protocolo gráfico tiene. **Nunca lanza.** Se
 * llama con el modo crudo YA puesto (si no, la respuesta se la come la línea de
 * comandos y encima se ve en pantalla).
 */
export async function detectarProtocolo(term: Terminal, enTmux: boolean, timeoutMs = TIMEOUT_CONSULTA_MS): Promise<Protocolo> {
  if (cacheProtocolo !== undefined) return cacheProtocolo;
  try {
    term.escribir(consultaGrafica(enTmux));
    let respuesta = await term.leer(timeoutMs, (v) => leerProtocolo(v) !== null || respuestaCompleta(v));
    // Adentro de tmux el DA1 no es el final: lo contesta tmux antes de que llegue
    // la respuesta de la terminal de afuera (ver `GRACIA_TMUX_MS`).
    if (enTmux && leerProtocolo(respuesta) === null) {
      respuesta += await term.leer(GRACIA_TMUX_MS, (v) => leerProtocolo(v) !== null);
    }
    cacheProtocolo = leerProtocolo(respuesta);
  } catch {
    // Preguntar no puede voltear nada: si la terminal se portó raro, símbolos.
    cacheProtocolo = null;
  }
  return cacheProtocolo;
}

// ── la vista ─────────────────────────────────────────────────────────────────

export type OpcionesVista = {
  /** La imagen, ya bajada (esto no baja nada). */
  ruta: string;
  /** El renderer de OpenTUI. Se suspende mientras la imagen está en pantalla. */
  renderer: { suspend(): void; resume(): void };
  /** Qué hacer con `^C`: el cierre ordenado (CA-17.1). Sin esto, `^C` sólo vuelve. */
  alSalir?: () => void;
  term?: Terminal;
  correr?: Correr;
  which?: (bin: string) => string | null;
  /** Default: `$TMUX`. Se inyecta para poder probar los dos caminos. */
  enTmux?: boolean;
  /** Símbolos, para el camino sin protocolo gráfico. Default el de `chafa.ts`. */
  simbolos?: typeof renderizarImagen;
  timeoutMs?: number;
  maxBytes?: number;
  /** Cuánto se espera la respuesta de la consulta. */
  timeoutConsultaMs?: number;
};

/** Una imagen por vez (dos `⏎` en el mismo tick no pueden suspender dos veces). */
let enCurso = false;

/**
 * Suspende la TUI, dibuja la imagen lo mejor que la terminal permita, espera una
 * tecla y devuelve la TUI **como estaba**. **Nunca lanza.**
 *
 * El `finally` no es adorno: pase lo que pase en el medio —`chafa` que no está,
 * una terminal que no contesta, un error inesperado— la pantalla alternativa se
 * cierra y el renderer se reanuda. Una TUI que quedó suspendida es una terminal
 * muerta que sólo se arregla con `reset`.
 */
export async function verEnGrande(o: OpcionesVista): Promise<ResultadoVista> {
  const term = o.term ?? terminalReal();
  if (!term.esTerminal()) return { ok: false, reason: MOTIVO_SIN_TERMINAL };
  if (enCurso) return { ok: false, reason: MOTIVO_OCUPADO };

  const enTmux = o.enTmux ?? Boolean(process.env.TMUX);
  enCurso = true;
  o.renderer.suspend();

  /** `^C` no vuelve a la TUI: cierra la aplicación (CA-17.1). */
  let cerrar = false;
  let resultado: ResultadoVista = { ok: false, reason: "no se pudo dibujar la imagen" };

  try {
    term.escribir(ENTRAR);
    // Crudo desde ACÁ y hasta el final: la consulta necesita que la respuesta no
    // se la coma la línea de comandos, y la espera de tecla necesita que `^C`
    // llegue como `\x03` en vez de como una señal. El `\n` sigue funcionando
    // igual (el modo crudo de libuv conserva `OPOST|ONLCR`), así que la salida
    // de `chafa` no se escalona.
    term.crudo(true);

    const protocolo = await detectarProtocolo(term, enTmux, o.timeoutConsultaMs);
    const cols = term.columnas();
    const alto = term.filas();
    // −1 del renglón de teclas de abajo.
    const filas = Math.max(1, alto - 1);

    if (protocolo === "kitty") {
      const bytes = await bytesGraficos(o.ruta, cols, filas, enTmux, o);
      if (bytes.ok) {
        term.escribir(bytes.bytes);
        resultado = { ok: true, calidad: "kitty" };
      } else {
        resultado = { ok: false, reason: bytes.reason };
      }
    } else {
      // Sin protocolo gráfico: los mismos medios bloques de siempre, pero con la
      // PANTALLA ENTERA en vez del panel (a 80×24 son 80×23 celdas contra 76×19,
      // y sin el marco). No es calidad real, pero es lo que hay y no rompe nada.
      const r = await (o.simbolos ?? renderizarImagen)(o.ruta, cols, filas);
      if (r.ok) {
        term.escribir(pintarFilas(r.filas));
        resultado = { ok: true, calidad: "simbolos" };
      } else {
        resultado = { ok: false, reason: r.reason };
      }
    }

    if (!resultado.ok) term.escribir(`\x1b[0m⚠ ${resultado.reason}\r\n`);
    const aviso = resultado.calidad === "simbolos" ? `${PIE_SIMBOLOS} · ` : "";
    term.escribir(pieEnElBorde(`${aviso}${PIE_IMAGEN}`, cols, alto));
    // Recién cuando la imagen SALIÓ entera se empieza a escuchar el teclado.
    await term.vaciar();

    const tecla = await term.leer(0x7fff_ffff);
    cerrar = tecla.includes("\x03");
  } catch (e) {
    resultado = { ok: false, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    // El orden importa: primero despegar la imagen (en tmux la dibujó la
    // terminal de AFUERA y no sale sola al limpiar), después soltar el modo
    // crudo, después volver de la pantalla alternativa.
    try {
      term.escribir(borradoGrafico(enTmux));
      term.crudo(false);
      term.escribir(SALIR);
    } catch {
      /* si la terminal ya no está, igual hay que reanudar el renderer */
    }
    enCurso = false;
    // Con `^C` no se reanuda: lo que sigue es el cierre ordenado, y repintar la
    // TUI para borrarla medio segundo después es un parpadeo de gusto.
    if (cerrar) o.alSalir?.();
    else o.renderer.resume();
  }

  return resultado;
}

/** El `chafa` gráfico: encontrar el binario y correrlo acotado. **No lanza.** */
async function bytesGraficos(
  ruta: string,
  cols: number,
  filas: number,
  enTmux: boolean,
  o: OpcionesVista,
): Promise<{ ok: true; bytes: Uint8Array; reason?: undefined } | { ok: false; bytes?: undefined; reason: string }> {
  const buscar = o.which ?? ((bin: string) => Bun.which(bin));
  let bin: string | null;
  try {
    bin = buscar("chafa");
  } catch {
    bin = null;
  }
  if (!bin) return { ok: false, reason: MOTIVO_SIN_CHAFA };

  const salida = await (o.correr ?? correrReal)(
    [bin, ...argsChafaGrafico(ruta, cols, filas, enTmux)],
    o.timeoutMs ?? TIMEOUT_GRAFICO_MS,
    o.maxBytes ?? TOPE_GRAFICO,
  );
  if (!salida.ok) return { ok: false, reason: salida.reason || "chafa no pudo con esa imagen" };
  if (salida.bytes.length === 0) return { ok: false, reason: "chafa no devolvió nada" };
  return { ok: true, bytes: salida.bytes };
}
