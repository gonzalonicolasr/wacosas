// Tests de `src/wa/media.ts`: bajar UNA imagen recibida cuando el usuario la
// pide (`^O`).
//
// Lo que se mira acá es lo que puede lastimar de verdad, y NO es el camino feliz:
//
//   · que **nunca cuelgue** — sin red, la promesa tiene que volver igual, y el
//     stream tiene que quedar DESTRUIDO (una promesa abandonada sobre un socket
//     abierto vive hasta que muera el proceso);
//   · que **nunca escriba de más** — ni el archivo enorme que se pasa del tope,
//     ni medio archivo cuando la descarga se corta a la mitad;
//   · que **nunca lance** — esto cuelga de una tecla, y una excepción ahí se
//     lleva puesta la pantalla;
//   · que los **permisos** sean los de siempre: directorio `0700`, archivo `0600`.
//
// La descarga se INYECTA (`descargar`): acá no sale un solo byte a internet.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import type { MessageRow } from "../src/db/types";
import {
  createMediaStore,
  leerStream,
  LIMITE_DESCARGA_BYTES,
  MOTIVO_NO_ES_IMAGEN,
  MOTIVO_SIN_REFERENCIA,
  MOTIVO_TIMEOUT,
  MOTIVO_VACIA,
  MOTIVO_YA_NO_ESTA,
} from "../src/wa/media";

const raiz = mkdtempSync(join(tmpdir(), "wacosas-media-"));
afterAll(() => rmSync(raiz, { recursive: true, force: true }));

const LOG = { info() {}, warn() {}, error() {}, path: "/tmp/wacosas-test.log" } as never;

/** Un PNG mínimo de verdad: la firma es lo que decide la extensión del archivo. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

let n = 0;
function dirNuevo(): string {
  return join(raiz, `caso-${++n}`);
}

/** Un mensaje de imagen con referencia (lo que guarda `wa/map.ts` desde ahora). */
function imagen(over: Partial<MessageRow> = {}): MessageRow {
  return {
    id: 7,
    chatJid: "549115000001@s.whatsapp.net",
    waId: "3EB0IMG",
    fromMe: false,
    senderJid: "549115000001@s.whatsapp.net",
    senderName: "Ana",
    ts: 1_700_000_000,
    kind: "image",
    body: "",
    attachment: { label: "📷 imagen", mimetype: "image/png", media: { key: "ZGVtbw==", directPath: "/x.enc" } },
    status: "received",
    error: null,
    ...over,
  } as MessageRow;
}

/** Un stream que entrega esos bytes y termina. */
const streamDe = (bytes: Uint8Array): NodeJS.ReadableStream => Readable.from([Buffer.from(bytes)]);

describe("leerStream", () => {
  test("junta los trozos y devuelve los bytes", async () => {
    const r = await leerStream(Readable.from([Buffer.from([1, 2]), Buffer.from([3])]) as never, 100, 1_000);
    expect(r.ok).toBe(true);
    expect([...(r.bytes ?? [])]).toEqual([1, 2, 3]);
  });

  test("un stream VACÍO no es un archivo: se avisa", async () => {
    const r = await leerStream(Readable.from([]) as never, 100, 1_000);
    expect(r).toEqual({ ok: false, reason: MOTIVO_VACIA });
  });

  test("⚠️ sin red la promesa VUELVE igual, y el stream queda destruido", async () => {
    // Un stream que nunca entrega nada y nunca termina: es lo que deja una
    // conexión que se abrió y se quedó muda (el caso que de verdad cuelga).
    const mudo = new Readable({ read() {} });
    const t0 = Date.now();
    const r = await leerStream(mudo as never, 1024, 40);
    expect(r).toEqual({ ok: false, reason: MOTIVO_TIMEOUT });
    expect(Date.now() - t0).toBeLessThan(2_000);
    // Y lo importante: no quedó nadie esperando del otro lado.
    expect(mudo.destroyed).toBe(true);
  });

  test("un archivo ENORME se corta apenas se pasa, sin juntarlo entero", async () => {
    const trozo = Buffer.alloc(64, 7);
    const r = await leerStream(Readable.from([trozo, trozo, trozo]) as never, 100, 1_000);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("el tope es");
  });

  test("un fallo A MITAD de la descarga vuelve como motivo, no como excepción", async () => {
    const cortado = new Readable({
      read() {
        this.push(Buffer.from([1, 2, 3]));
        this.destroy(new Error("se cortó la conexión"));
      },
    });
    const r = await leerStream(cortado as never, 1024, 1_000);
    expect(r).toEqual({ ok: false, reason: "se cortó la conexión" });
  });
});

describe("createMediaStore", () => {
  let dir = "";
  beforeEach(() => {
    dir = dirNuevo();
  });

  test("baja, guarda con los permisos de siempre y devuelve la ruta", async () => {
    const store = createMediaStore({ dir, log: LOG, descargar: async () => streamDe(PNG) });
    const r = await store.ensureImage(imagen());
    expect(r.ok).toBe(true);
    expect(r.path).toBe(join(dir, "7.png")); // la extensión sale de la FIRMA
    // RNF-12 / CA-14.6: directorio sólo para el usuario, archivo sólo para el usuario.
    expect((statSync(dir).mode & 0o777).toString(8)).toBe("700");
    expect((statSync(r.path as string).mode & 0o777).toString(8)).toBe("600");
  });

  test("la segunda vez sale del disco: no se baja nada dos veces", async () => {
    let veces = 0;
    const store = createMediaStore({
      dir,
      log: LOG,
      descargar: async () => {
        veces++;
        return streamDe(PNG);
      },
    });
    const a = await store.ensureImage(imagen());
    const b = await store.ensureImage(imagen());
    expect(veces).toBe(1);
    expect(b).toEqual(a);
    expect(store.cached(imagen())).toBe(a.path as string);
  });

  test("dos pedidos a la vez son UNA sola descarga", async () => {
    let veces = 0;
    const store = createMediaStore({
      dir,
      log: LOG,
      descargar: async () => {
        veces++;
        await Bun.sleep(10);
        return streamDe(PNG);
      },
    });
    const [a, b] = await Promise.all([store.ensureImage(imagen()), store.ensureImage(imagen())]);
    expect(veces).toBe(1);
    expect(a.ok && b.ok).toBe(true);
  });

  test("un mensaje que no es imagen no baja nada", async () => {
    let veces = 0;
    const store = createMediaStore({
      dir,
      log: LOG,
      descargar: async () => {
        veces++;
        return streamDe(PNG);
      },
    });
    const r = await store.ensureImage(imagen({ kind: "video" }));
    expect(r).toEqual({ ok: false, reason: MOTIVO_NO_ES_IMAGEN });
    expect(veces).toBe(0);
  });

  test("sin referencia se explica que es del historial viejo, y no se toca la red", async () => {
    let veces = 0;
    const store = createMediaStore({
      dir,
      log: LOG,
      descargar: async () => {
        veces++;
        return streamDe(PNG);
      },
    });
    const r = await store.ensureImage(imagen({ attachment: { label: "📷 imagen" } }));
    expect(r).toEqual({ ok: false, reason: MOTIVO_SIN_REFERENCIA });
    expect(veces).toBe(0);
  });

  test("⚠️ un archivo enorme se rechaza ANTES de tocar la red", async () => {
    let veces = 0;
    const store = createMediaStore({
      dir,
      log: LOG,
      descargar: async () => {
        veces++;
        return streamDe(PNG);
      },
    });
    const grande = imagen({
      attachment: {
        label: "📷 imagen",
        media: { key: "ZGVtbw==", directPath: "/x.enc", bytes: LIMITE_DESCARGA_BYTES + 1 },
      },
    });
    const r = await store.ensureImage(grande);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("no se bajó");
    // Lo que importa: NO se bajaron 16 MB para después tirarlos.
    expect(veces).toBe(0);
  });

  test("un archivo que MIENTE su tamaño se corta durante la descarga, y no queda a medias", async () => {
    const store = createMediaStore({
      dir,
      log: LOG,
      maxBytes: 32,
      descargar: async () => streamDe(new Uint8Array(128)),
    });
    const r = await store.ensureImage(imagen());
    expect(r.ok).toBe(false);
    // Nada escrito: ni el archivo final ni el `.parcial`.
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  test("sin red: vuelve con motivo y no escribe nada", async () => {
    const store = createMediaStore({
      dir,
      log: LOG,
      timeoutMs: 30,
      descargar: async () => new Readable({ read() {} }) as never,
    });
    const r = await store.ensureImage(imagen());
    expect(r).toEqual({ ok: false, reason: MOTIVO_TIMEOUT });
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  test("un fallo a mitad de camino no deja el archivo a medias en el caché", async () => {
    const store = createMediaStore({
      dir,
      log: LOG,
      descargar: async () =>
        new Readable({
          read() {
            this.push(Buffer.from(PNG));
            this.destroy(new Error("se cayó la red"));
          },
        }) as never,
    });
    const r = await store.ensureImage(imagen());
    expect(r).toEqual({ ok: false, reason: "se cayó la red" });
    expect(store.cached(imagen())).toBeNull();
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  test("410 / 404 del CDN se explica como 'WhatsApp ya no la tiene'", async () => {
    for (const codigo of [404, 410]) {
      const store = createMediaStore({
        dir: dirNuevo(),
        log: LOG,
        descargar: async () => {
          // La forma en la que baileys reporta un fallo HTTP (Boom).
          throw Object.assign(new Error("Failed to fetch stream"), { output: { statusCode: codigo } });
        },
      });
      const r = await store.ensureImage(imagen());
      expect({ codigo, r }).toEqual({ codigo, r: { ok: false, reason: MOTIVO_YA_NO_ESTA } });
    }
  });

  test("una descarga que LANZA no se propaga: vuelve como motivo", async () => {
    const store = createMediaStore({
      dir,
      log: LOG,
      descargar: () => {
        throw new Error("el socket ya no está");
      },
    });
    const r = await store.ensureImage(imagen());
    expect(r).toEqual({ ok: false, reason: "el socket ya no está" });
  });

  test("un archivo cacheado VACÍO no se toma por bueno", async () => {
    const store = createMediaStore({ dir, log: LOG, descargar: async () => streamDe(PNG) });
    // Un `0.png` de cero bytes es lo que dejaría un disco lleno: no puede contar
    // como caché, o la imagen no se vería nunca más.
    await store.ensureImage(imagen());
    writeFileSync(join(dir, "7.png"), "");
    expect(store.cached(imagen())).toBeNull();
  });
});
