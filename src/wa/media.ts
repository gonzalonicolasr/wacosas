// Bajar UNA imagen recibida, cuando el usuario la pide (`^O`).
//
// ⚠️ **Este archivo enmienda CA-7.4, que decía que wacosas no descarga el
// contenido de ningún adjunto ni escribe archivos multimedia en disco.** La
// enmienda es acotada y conviene tenerla escrita, porque el criterio existía por
// buenos motivos (un directorio que crece solo, contenido de terceros en tu
// máquina sin haberlo pedido, permisos que cuidar):
//
//   1. **Sólo imágenes, y sólo a demanda.** Nada se baja solo. Lo que llega
//      sigue viéndose `📷 imagen` y no cuesta ni un byte de red hasta que alguien
//      aprieta una tecla sobre esa imagen en particular. No hay prefetch, no hay
//      "bajá las últimas N", no hay descarga en el sync de historial.
//   2. **Los archivos van a `<dataDir>/media/`**, que nace `0700`, con permisos
//      `0600` cada uno. Nunca a `/tmp` —ahí los ve cualquier usuario de la
//      máquina— y nunca al directorio actual.
//   3. **Es un caché descartable.** Borrar `media/` entero no pierde nada: la
//      próxima vez que se pida la imagen se vuelve a bajar. Y lo que ya está no
//      se vuelve a bajar nunca (es lo que hace que mirar dos veces la misma foto
//      no sea tráfico dos veces).
//   4. **Un fallo no puede voltear la aplicación.** Igual que en
//      `boot/clipboard.ts`: nada de acá lanza, hay tope de tamaño y tope de
//      tiempo, y el tope de tiempo **destruye el stream** en vez de sólo
//      resolver —una promesa abandonada sobre un socket abierto queda viva hasta
//      que el proceso muera—.
//
// Lo que este módulo NO hace, a propósito: no toca el socket. `downloadContent-
// FromMessage` es un `fetch` al CDN de WhatsApp con la clave del mensaje, sin
// sesión ni autenticación, así que una imagen se puede mirar incluso con la
// conexión caída (lo único que hace falta es internet). Tampoco pide el
// **reenvío** (`reuploadRequest`) de una imagen que el CDN ya borró: eso sí
// necesitaría el socket y una stanza, y el caso —una foto vieja que WhatsApp ya
// no sirve— se resuelve avisando, que es lo honesto.
import { downloadContentFromMessage } from "baileys";
import { chmodSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { mimeDeImagen } from "../boot/clipboard";
import type { Logger } from "../boot/log";
import type { MessageRow } from "../db/types";

/**
 * Tope de una imagen a bajar, en bytes.
 *
 * Mismo número que el de subida (`wa/send.ts`, `LIMITE_IMAGEN_BYTES`) y por el
 * mismo motivo: no hay un límite publicado del protocolo del consumidor, y de
 * los dos errores posibles quedarse corto es el peor —rechazaría una foto que sí
 * se podía ver—. Se chequea DOS veces: contra el `fileLength` que declara el
 * mensaje (antes de tocar la red) y contra lo que de verdad va llegando (por si
 * el declarado miente).
 */
export const LIMITE_DESCARGA_BYTES = 16 * 1024 * 1024;

/**
 * Cuánto se espera a que el CDN entregue la imagen entera.
 *
 * Generoso a propósito: son megas por una conexión que puede ser un celular
 * compartiendo datos. Lo que NO puede pasar es que se espere para siempre, y de
 * eso se encarga el `destroy()` del stream.
 */
export const TIMEOUT_DESCARGA_MS = 20_000;

export const MOTIVO_SIN_REFERENCIA =
  "de esta imagen no guardamos la referencia: es de antes de que wacosas supiera mostrarlas";
export const MOTIVO_NO_ES_IMAGEN = "ese mensaje no es una imagen";
export const MOTIVO_TIMEOUT = "WhatsApp no entregó la imagen a tiempo";
export const MOTIVO_YA_NO_ESTA = "WhatsApp ya no tiene esta imagen en su servidor";
export const MOTIVO_VACIA = "lo que devolvió WhatsApp está vacío";

/** Los MB con un decimal, redondeando para arriba (mismo criterio que `send.ts`). */
const mb = (bytes: number): string => (Math.ceil((bytes / (1024 * 1024)) * 10) / 10).toString();

export const motivoDemasiadoGrande = (bytes: number): string =>
  `la imagen pesa ${mb(bytes)} MB y el tope es ${Math.floor(LIMITE_DESCARGA_BYTES / (1024 * 1024))} MB: no se bajó`;

export type ResultadoMedia =
  | { ok: true; path: string; reason?: undefined }
  | { ok: false; path?: undefined; reason: string };

export type MediaStore = {
  /**
   * La ruta local de la imagen de ese mensaje, bajándola si todavía no está.
   * **Nunca lanza y nunca cuelga**: todo error vuelve por el `reason`.
   */
  ensureImage(msg: MessageRow): Promise<ResultadoMedia>;
  /** ¿Ya está en disco? Lo pregunta la interfaz para no decir "bajando…" de gusto. */
  cached(msg: MessageRow): string | null;
};

/** Lo que devuelve una lectura de stream: bytes, o un motivo explicable. */
type Lectura = { ok: true; bytes: Uint8Array; reason?: undefined } | { ok: false; bytes?: undefined; reason: string };

export type Descargar = (ref: {
  mediaKey: Uint8Array;
  directPath?: string;
  url?: string;
}) => Promise<NodeJS.ReadableStream>;

export type MediaDeps = {
  /** `<dataDir>/media` (`boot/paths.ts`). Se crea a demanda, con `0700`. */
  dir: string;
  log: Logger;
  /** La descarga real. Se inyecta para que el test no salga a internet. */
  descargar?: Descargar;
  maxBytes?: number;
  timeoutMs?: number;
};

/**
 * Extensiones que se conocen, en el orden en que se buscan en el caché. El
 * archivo se nombra `<id>.<ext>` con la extensión que digan LOS BYTES (no el
 * mime que anunció el mensaje): así lo que abra `xdg-open` es de verdad lo que
 * dice ser.
 */
const EXTENSIONES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** Todas las extensiones posibles + la de "no se reconoció la firma". */
const TODAS = [...Object.values(EXTENSIONES), "img"];

function motivo(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** El `statusCode` de un Boom de baileys, si lo trae. */
function codigo(e: unknown): number | null {
  const n = (e as { output?: { statusCode?: number }; status?: number })?.output?.statusCode ?? (e as { status?: number })?.status;
  return typeof n === "number" ? n : null;
}

/**
 * Lee un stream con tope de tamaño y tope de tiempo. **El tope de tiempo
 * destruye el stream**: resolver la promesa y dejar el socket abierto sería
 * cambiar un cuelgue visible por una fuga invisible (mismo razonamiento que la
 * carrera de `boot/clipboard.ts`, con la diferencia de que acá sí hay un objeto
 * al que pedirle que se corte).
 */
export function leerStream(
  stream: NodeJS.ReadableStream & { destroy?: (e?: Error) => void },
  maxBytes: number,
  timeoutMs: number,
): Promise<Lectura> {
  return new Promise((resolver) => {
    const trozos: Uint8Array[] = [];
    let total = 0;
    let cerrado = false;

    const terminar = (r: Lectura): void => {
      if (cerrado) return;
      cerrado = true;
      clearTimeout(reloj);
      try {
        stream.destroy?.();
      } catch {
        /* si ya estaba muerto, mejor */
      }
      resolver(r);
    };

    const reloj = setTimeout(() => terminar({ ok: false, reason: MOTIVO_TIMEOUT }), Math.max(1, timeoutMs));

    stream.on("data", (c: Uint8Array) => {
      total += c.length;
      if (total > maxBytes) {
        terminar({ ok: false, reason: motivoDemasiadoGrande(total) });
        return;
      }
      trozos.push(c);
    });
    stream.on("end", () => {
      const out = new Uint8Array(total);
      let i = 0;
      for (const t of trozos) {
        out.set(t, i);
        i += t.length;
      }
      terminar(out.length === 0 ? { ok: false, reason: MOTIVO_VACIA } : { ok: true, bytes: out });
    });
    stream.on("error", (e: unknown) => terminar({ ok: false, reason: motivo(e) }));
  });
}

/** La descarga de verdad: baileys contra el CDN de WhatsApp. */
const descargarReal: Descargar = async (ref) =>
  (await downloadContentFromMessage(
    { mediaKey: ref.mediaKey, directPath: ref.directPath ?? null, url: ref.url ?? null },
    "image",
  )) as unknown as NodeJS.ReadableStream;

export function createMediaStore(deps: MediaDeps): MediaStore {
  const { dir, log } = deps;
  const bajar = deps.descargar ?? descargarReal;
  const maxBytes = deps.maxBytes ?? LIMITE_DESCARGA_BYTES;
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_DESCARGA_MS;

  /** Descargas en curso, por id: dos `^O` seguidos no bajan la misma foto dos veces. */
  const enVuelo = new Map<number, Promise<ResultadoMedia>>();

  /** Crea `media/` con `0700` y lo endurece aunque ya existiera con permisos laxos. */
  function asegurarDir(): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }

  function rutaCacheada(id: number): string | null {
    for (const ext of TODAS) {
      const p = join(dir, `${id}.${ext}`);
      try {
        if (existsSync(p) && statSync(p).size > 0) return p;
      } catch {
        // Un `stat` que falla es un archivo que no sirve: se sigue buscando.
      }
    }
    return null;
  }

  async function bajarYGuardar(msg: MessageRow): Promise<ResultadoMedia> {
    const ref = msg.attachment?.media;
    if (!ref?.key) return { ok: false, reason: MOTIVO_SIN_REFERENCIA };
    // ⚠️ El tope se mira ANTES de tocar la red: bajar 40 MB para descartarlos es
    // tiempo y datos del usuario tirados a la basura (mismo criterio que el tope
    // de subida de `wa/send.ts`).
    if (ref.bytes && ref.bytes > maxBytes) return { ok: false, reason: motivoDemasiadoGrande(ref.bytes) };

    let bytes: Uint8Array;
    try {
      const stream = await bajar({
        mediaKey: Uint8Array.from(Buffer.from(ref.key, "base64")),
        ...(ref.directPath ? { directPath: ref.directPath } : {}),
        ...(ref.url ? { url: ref.url } : {}),
      });
      const leido = await leerStream(stream as never, maxBytes, timeoutMs);
      if (!leido.ok) return { ok: false, reason: leido.reason };
      bytes = leido.bytes;
    } catch (e) {
      // 404/410 = el CDN ya no tiene el archivo. Es el caso más común con una
      // foto vieja y merece un motivo propio: no es un error de red ni algo que
      // reintentar sirva de nada.
      const c = codigo(e);
      const razon = c === 404 || c === 410 ? MOTIVO_YA_NO_ESTA : motivo(e);
      log.warn("media.descarga_fallida", { id: msg.id, motivo: razon });
      return { ok: false, reason: razon };
    }

    // La extensión sale de la FIRMA de los bytes y no del mime que anunció el
    // mensaje (mismo criterio que `boot/clipboard.ts`): así lo que abra el visor
    // del sistema es de verdad lo que dice ser.
    const ext = EXTENSIONES[mimeDeImagen(bytes) ?? ""] ?? "img";
    const destino = join(dir, `${msg.id}.${ext}`);
    const temporal = `${destino}.parcial`;
    try {
      asegurarDir();
      // Se escribe aparte y se renombra: si el proceso muere en el medio, en el
      // caché no queda media imagen haciéndose pasar por una entera.
      writeFileSync(temporal, bytes, { mode: 0o600 });
      chmodSync(temporal, 0o600);
      renameSync(temporal, destino);
    } catch (e) {
      try {
        unlinkSync(temporal);
      } catch {
        /* no quedó nada que borrar */
      }
      const razon = motivo(e);
      log.warn("media.guardado_fallido", { id: msg.id, motivo: razon });
      return { ok: false, reason: `no se pudo guardar la imagen: ${razon}` };
    }

    // Ni el nombre del chat ni el caption (CA-14.7): sólo qué se bajó y cuánto.
    log.info("media.bajada", { id: msg.id, bytes: bytes.length, ext });
    return { ok: true, path: destino };
  }

  return {
    cached(msg) {
      return msg?.id ? rutaCacheada(msg.id) : null;
    },

    ensureImage(msg) {
      if (!msg || msg.kind !== "image") {
        return Promise.resolve<ResultadoMedia>({ ok: false, reason: MOTIVO_NO_ES_IMAGEN });
      }
      const ya = rutaCacheada(msg.id);
      if (ya) return Promise.resolve<ResultadoMedia>({ ok: true, path: ya });

      const corriendo = enVuelo.get(msg.id);
      if (corriendo) return corriendo;

      const tarea = bajarYGuardar(msg)
        .catch((e: unknown) => {
          // `bajarYGuardar` atrapa todo; esto es el último seguro para que un
          // rechazo inesperado no termine en un unhandled rejection (que en esta
          // aplicación cierra el proceso, ver `index.tsx`).
          log.error("media.error_inesperado", { id: msg.id, motivo: motivo(e) });
          return { ok: false, reason: motivo(e) } as ResultadoMedia;
        })
        .finally(() => {
          enVuelo.delete(msg.id);
        });
      enVuelo.set(msg.id, tarea);
      return tarea;
    },
  };
}
