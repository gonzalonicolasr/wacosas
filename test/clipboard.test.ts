// Tests del portapapeles (`^V`): `src/boot/clipboard.ts`.
//
// Cómo está armado y por qué:
//
//   · **Los backends son BINARIOS DE VERDAD**, no un doble inyectado: scripts de
//     shell escritos en un directorio temporal, y `readClipboard` los encuentra
//     por un `PATH` de juguete. Es a propósito — lo que hay que probar acá es
//     justamente lo que pasa cuando se spawnea un proceso externo (que no exista,
//     que se cuelgue, que devuelva basura), y un doble en memoria no reproduce
//     nada de eso: no hay pipe, no hay `SIGKILL`, no hay nietos que hereden el
//     descriptor.
//   · **La aserción que más importa es que la función VUELVA.** Cada caso mide
//     cuánto tardó: un cuelgue no se ve como un fallo, se ve como un test que
//     nunca termina, y eso en una TUI es "se me congeló wacosas".
//   · **Nada toca el portapapeles real de Gon** ni el `PATH` del proceso: el
//     `PATH` viaja por parámetro en cada llamada.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  limpiarTexto,
  mimeDeImagen,
  MOTIVO_BINARIO,
  MOTIVO_NO_ES_IMAGEN,
  MOTIVO_SIN_BACKEND,
  MOTIVO_TIMEOUT,
  readClipboard,
  TOPE_TEXTO,
} from "../src/boot/clipboard";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const NUL = String.fromCharCode(0);

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x11, 0x22, 0x33]);

const raiz = mkdtempSync(join(tmpdir(), "wacosas-clip-"));
afterAll(() => rmSync(raiz, { recursive: true, force: true }));

let n = 0;

/**
 * Un `PATH` con los binarios que le pasemos, y NADA más. Cada caso se lleva su
 * propio directorio: así "no existe `wl-paste`" es de verdad que no existe, y no
 * "existe pero en otro test".
 */
function pathCon(binarios: Record<string, string>): string {
  const dir = join(raiz, `bin-${++n}`);
  rmSync(dir, { recursive: true, force: true });
  require("node:fs").mkdirSync(dir, { recursive: true });
  for (const [nombre, cuerpo] of Object.entries(binarios)) {
    const ruta = join(dir, nombre);
    writeFileSync(ruta, `#!/bin/sh\n${cuerpo}\n`);
    chmodSync(ruta, 0o755);
  }
  return dir;
}

/** El fixture del PNG en disco, para que los scripts lo puedan `cat`ear. */
const rutaPng = join(raiz, "captura.png");
writeFileSync(rutaPng, PNG);

/**
 * Un `wl-paste` de mentira: `--list-types` imprime `tipos` y cualquier otra cosa
 * corre `cuerpo`. Es la forma real del binario (el primer argumento decide).
 */
function fakeWlPaste(tipos: string, cuerpo: string): string {
  return [
    'if [ "$1" = "--list-types" ]; then',
    `  ${tipos}`,
    "  exit 0",
    "fi",
    cuerpo,
  ].join("\n");
}

/** Corre `readClipboard` y devuelve, además, cuánto tardó. */
async function leer(path: string, timeoutMs = 2_000, maxBytes?: number) {
  const t0 = performance.now();
  const r = await readClipboard({ path, timeoutMs, ...(maxBytes ? { maxBytes } : {}) });
  return { r, ms: performance.now() - t0 };
}

// ── los tres modos de falla que NO pueden voltear la TUI ─────────────────────

describe("un backend roto no cuelga ni tira la aplicación", () => {
  test("no hay NINGÚN backend instalado: lo dice y no lanza", async () => {
    const { r, ms } = await leer(pathCon({}));
    expect(r).toEqual({ kind: "error", reason: MOTIVO_SIN_BACKEND });
    // Sin binario que buscar, ni siquiera se spawnea nada.
    expect(ms).toBeLessThan(500);
  });

  test("wl-paste se CUELGA: vuelve por el timeout, no cuando el proceso termina", async () => {
    // El `sleep` es un NIETO: matar al `sh` no cierra el pipe que el `sleep`
    // heredó. Es exactamente el caso que obliga a que el timeout sea una carrera
    // contra la lectura y no un `kill` a secas (ver `correrReal`).
    const path = pathCon({ "wl-paste": "sleep 30" });
    const { r, ms } = await leer(path, 300);
    expect(r).toEqual({ kind: "error", reason: MOTIVO_TIMEOUT });
    // El número que importa: volvió por el timeout y no a los 30 s. Y por UN
    // timeout, no por dos: un backend que ya se colgó listando tipos no se
    // vuelve a consultar por el texto (si no, serían 6 s reales de campo mudo).
    expect(ms).toBeLessThan(600);
  });

  test("wl-paste ANUNCIA una imagen y devuelve basura: no se manda nada", async () => {
    // El caso real: más de un navegador anuncia `image/png` sobre un pedazo de
    // HTML. Si confiáramos en el anuncio, esos bytes se le subirían a WhatsApp.
    const path = pathCon({
      "wl-paste": fakeWlPaste('echo "image/png"', 'printf "%s" "<html>no soy un png</html>"'),
    });
    const { r, ms } = await leer(path);
    expect(r).toEqual({ kind: "error", reason: MOTIVO_NO_ES_IMAGEN });
    expect(ms).toBeLessThan(3_000);
  });

  test("wl-paste explota con código ≠ 0 y sin salida: es el portapapeles vacío", async () => {
    const path = pathCon({ "wl-paste": 'exit 1' });
    const { r } = await leer(path);
    expect(r).toEqual({ kind: "empty" });
  });

  test("el binario existe pero no es ejecutable: no lanza, avisa", async () => {
    const dir = pathCon({});
    const ruta = join(dir, "wl-paste");
    writeFileSync(ruta, "#!/bin/sh\ntrue\n");
    chmodSync(ruta, 0o644);
    // `Bun.which` sólo devuelve ejecutables, así que esto cae en "no hay backend".
    const { r } = await leer(dir);
    expect(r.kind).toBe("error");
  });
});

// ── el camino feliz ─────────────────────────────────────────────────────────

describe("leer una imagen", () => {
  test("una captura PNG vuelve con sus bytes y su mime", async () => {
    const path = pathCon({
      "wl-paste": fakeWlPaste('printf "text/html\\nimage/png\\n"', `cat ${rutaPng}`),
    });
    const { r } = await leer(path);
    expect(r.kind).toBe("image");
    expect(r.mime).toBe("image/png");
    expect(Array.from(r.bytes as Uint8Array)).toEqual(Array.from(PNG));
  });

  test("la imagen GANA aunque también haya texto", async () => {
    const path = pathCon({
      "wl-paste": fakeWlPaste(
        'printf "text/plain\\nimage/png\\n"',
        `if [ "$1" = "--type" ] && [ "$2" = "image/png" ]; then cat ${rutaPng}; else printf "hola"; fi`,
      ),
    });
    const { r } = await leer(path);
    // El que acaba de hacer una captura espera la imagen, no el texto que tenía
    // copiado antes.
    expect(r.kind).toBe("image");
  });

  test("el mime sale de la FIRMA, no del anuncio", async () => {
    // Anuncia `image/webp` pero manda un JPEG: se cree a los bytes.
    const jpeg = join(raiz, "foto.jpg");
    writeFileSync(jpeg, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]));
    const path = pathCon({
      "wl-paste": fakeWlPaste('echo "image/webp"', `cat ${jpeg}`),
    });
    const { r } = await leer(path);
    expect(r.kind).toBe("image");
    expect(r.mime).toBe("image/jpeg");
  });
});

describe("leer texto", () => {
  test("texto plano, con el ANSI y los caracteres de control ya limpios", async () => {
    const path = pathCon({
      "wl-paste": fakeWlPaste("true", `printf 'ho\\033[31mla\\r\\nqué tal\\033]0;titulo\\007'`),
    });
    const { r } = await leer(path);
    // Un `\\e[2J` pegado desde un log NO puede llegar a la terminal.
    expect(r).toEqual({ kind: "text", text: "hola\nqué tal" });
  });

  test("puros espacios es lo mismo que vacío", async () => {
    const path = pathCon({ "wl-paste": fakeWlPaste("true", `printf '   \\n  '`) });
    const { r } = await leer(path);
    expect(r).toEqual({ kind: "empty" });
  });

  test("un binario sin tipo de imagen se rechaza en vez de pegarse como sopa de �", async () => {
    const path = pathCon({ "wl-paste": fakeWlPaste("true", `printf 'ab\\000cd'`) });
    const { r } = await leer(path);
    expect(r).toEqual({ kind: "error", reason: MOTIVO_BINARIO });
  });

  test("lo que se pasa de `maxBytes` se corta y se explica", async () => {
    const path = pathCon({ "wl-paste": fakeWlPaste("true", "head -c 200000 /dev/zero | tr '\\0' 'a'") });
    const { r, ms } = await leer(path, 2_000, 1024);
    expect(r.kind).toBe("error");
    expect(r.reason).toContain("portapapeles");
    expect(ms).toBeLessThan(3_000);
  });
});

// ── el orden de los backends (el patrón de `miscosas`) ──────────────────────

describe("elección del backend", () => {
  test("sin wl-paste se cae a xclip", async () => {
    const path = pathCon({
      xclip: `if [ "$4" = "TARGETS" ]; then echo "image/png"; exit 0; fi\ncat ${rutaPng}`,
    });
    const { r } = await leer(path);
    expect(r.kind).toBe("image");
  });

  test("wl-paste GANA cuando están los dos", async () => {
    const path = pathCon({
      "wl-paste": fakeWlPaste("true", `printf 'vino por wl-paste'`),
      xclip: `printf 'vino por xclip'`,
    });
    const { r } = await leer(path);
    expect(r).toEqual({ kind: "text", text: "vino por wl-paste" });
  });

  test("xsel y pbpaste sólo saben de texto y no rompen", async () => {
    // Ninguno de los dos puede pedir un target arbitrario, así que ni se les
    // pregunta por una imagen: se les pide el texto directo.
    for (const bin of ["xsel", "pbpaste"]) {
      const path = pathCon({ [bin]: `printf 'texto por ${bin}'` });
      const { r } = await leer(path);
      expect(r).toEqual({ kind: "text", text: `texto por ${bin}` });
    }
  });
});

// ── las funciones puras ─────────────────────────────────────────────────────

describe("mimeDeImagen", () => {
  test("reconoce png, jpeg, gif y webp por su firma", () => {
    expect(mimeDeImagen(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(mimeDeImagen(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(mimeDeImagen(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe("image/gif");
    const webp = new Uint8Array(16);
    webp.set([0x52, 0x49, 0x46, 0x46], 0);
    webp.set([0x57, 0x45, 0x42, 0x50], 8);
    expect(mimeDeImagen(webp)).toBe("image/webp");
  });

  test("no inventa nada ante basura, vacío o null", () => {
    expect(mimeDeImagen(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBe(null);
    expect(mimeDeImagen(new Uint8Array([]))).toBe(null);
    expect(mimeDeImagen(null)).toBe(null);
    // Un PNG truncado antes de completar su firma tampoco pasa.
    expect(mimeDeImagen(new Uint8Array([0x89, 0x50, 0x4e]))).toBe(null);
  });
});

describe("limpiarTexto", () => {
  test("saca CSI, OSC y escapes de dos caracteres", () => {
    expect(limpiarTexto(`a${ESC}[31mb${ESC}[0m`)).toBe("ab");
    expect(limpiarTexto(`a${ESC}]0;titulo${BEL}b`)).toBe("ab");
    expect(limpiarTexto(`a${ESC}7b`)).toBe("ab");
  });

  test("conserva lo que SÍ es texto", () => {
    // `\n` y `\t` se quedan; `\r\n` se normaliza; el resto de los controles vuela.
    expect(limpiarTexto("uno\r\ndos\ttres")).toBe("uno\ndos\ttres");
    expect(limpiarTexto(`hola${NUL}mundo`)).toBe("holamundo");
    expect(limpiarTexto("acentos á é ñ 🌻")).toBe("acentos á é ñ 🌻");
  });

  test("no lanza con null ni undefined", () => {
    expect(limpiarTexto(null as unknown as string)).toBe("");
    expect(limpiarTexto(undefined as unknown as string)).toBe("");
  });
});

test("el texto pegado se corta en TOPE_TEXTO", async () => {
  // Sin esto, pegar un log de 30 MB deja la TUI midiendo el envolvimiento del
  // `<textarea>` para siempre.
  const largo = TOPE_TEXTO + 5_000;
  const path = pathCon({ "wl-paste": fakeWlPaste("true", `head -c ${largo} /dev/zero | tr '\\0' 'x'`) });
  const { r } = await leer(path);
  expect(r.kind).toBe("text");
  expect((r.text as string).length).toBe(TOPE_TEXTO);
});
