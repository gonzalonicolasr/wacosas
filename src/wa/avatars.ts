// Real profile preview photos, requested only for the current visible rows.
// One lookup at a time, at least 1s apart; replaced viewports cancel queued work.
// Private disk cache survives restarts; absent photos have a seven-day TTL.
// The optional color callback is retained for existing callers; production publishes
// file paths and the pixel renderer converts only visible photos.
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { colorDominante } from "../boot/chafa";
import type { Logger } from "../boot/log";
import type { Cancelar } from "../state/store";

/** Espera entre dos consultas a WhatsApp. Es el mismo ritmo que el de envío (RNF-8). */
export const GAP_MS = 1_000;

/** Cuánto vale un "no tiene foto" antes de volver a preguntar. */
export const TTL_SIN_FOTO_MS = 7 * 24 * 60 * 60 * 1000;

/** Tope de la miniatura: una `preview` son ~10 KB, así que 2 MB es de sobra. */
export const TOPE_FOTO_BYTES = 2 * 1024 * 1024;

/** Cuánto se espera a la descarga de la miniatura del CDN. */
export const TIMEOUT_FOTO_MS = 8_000;

export type Avatars = {
  /**
   * Pide el color de esos chats. Es O(n) sobre la lista, **no lanza** y no
   * consulta nada que ya sepa: se la puede llamar en cada render de la bandeja.
   */
  request(jids: string[]): void;
  /** Corta la cola. Lo llama el cierre ordenado. */
  stop(): void;
  /** Consultas a WhatsApp hechas en esta sesión (para el log y los tests). */
  consultas(): number;
};

export type AvatarDeps = {
  /** `<dataDir>/avatars`. Se crea a demanda, con `0700`. */
  dir: string;
  log: Logger;
  /**
   * La URL de la foto (`sock.profilePictureUrl`). Devuelve `null` cuando no hay
   * foto, no hay permiso o no hay conexión. **Nunca tiene que lanzar**: el que
   * la cablea la envuelve.
   */
  urlDe(jid: string): Promise<string | null>;
  /** Deja el color a la vista (lo escribe en el store). `null` = no hay foto. */
  publicar(jid: string, color: string | null): void;
  publicarFoto?: (jid: string, path: string | null) => void;
  /** Baja la miniatura. Default `fetch`; el test le pasa otra. */
  bajar?: (url: string) => Promise<Uint8Array | null>;
  /** Saca el color de un archivo. Default `chafa`. */
  color?: (ruta: string) => Promise<string | null>;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => Cancelar;
};

const agendarReal = (fn: () => void, ms: number): Cancelar => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

function motivo(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Nombre de archivo de un jid. Va por hash y no por el jid pelado a propósito:
 * un jid es un NÚMERO DE TELÉFONO y no tiene por qué quedar escrito en el nombre
 * de un archivo que se ve con un `ls` (la base ya guarda lo suyo, pero un
 * directorio de nombres de archivo con teléfonos se lee de reojo).
 */
export function nombreDeJid(jid: string): string {
  return createHash("sha256").update(String(jid ?? "")).digest("hex").slice(0, 24);
}

/** Descarga la miniatura con tope de tamaño y de tiempo. Nunca lanza. */
const bajarReal = async (url: string): Promise<Uint8Array | null> => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_FOTO_MS) });
    if (!r.ok) return null;
    const largo = Number(r.headers.get("content-length") ?? 0);
    if (Number.isFinite(largo) && largo > TOPE_FOTO_BYTES) return null;
    if (!r.body) return null;
    const reader = r.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > TOPE_FOTO_BYTES) { await reader.cancel(); return null; }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    return size ? new Uint8Array(Buffer.concat(chunks)) : null;
  } catch {
    // Sin red, DNS caído, timeout: es un adorno, no hay a quién avisarle.
    return null;
  }
};

export function createAvatars(deps: AvatarDeps): Avatars {
  const { dir, log, urlDe, publicar } = deps;
  const bajar = deps.bajar ?? bajarReal;
  const sacarColor = deps.color ?? ((ruta: string) => colorDominante(ruta));
  const ahora = deps.now ?? Date.now;
  const agendar = deps.schedule ?? agendarReal;

  /** Lo que ya se resolvió en esta sesión: `null` = ese chat no tiene foto. */
  const memoria = new Map<string, string | null>();
  /** Encolados o en curso: nadie se pide dos veces. */
  const pedidos = new Set<string>();
  const cola: string[] = [];
  let corriendo = false;
  let detenido = false;
  let consultasHechas = 0;
  let visibles = new Set<string>();
  let ultimoPedido = 0;

  const rutaFoto = (jid: string): string => join(dir, `${nombreDeJid(jid)}.jpg`);
  const rutaSinFoto = (jid: string): string => join(dir, `${nombreDeJid(jid)}.none`);

  function asegurarDir(): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }

  /** ¿Existe y es reciente? Sin `mtime` usable se lo toma por viejo. */
  function frescoHasta(ruta: string, vidaMs: number): boolean {
    try {
      if (!existsSync(ruta)) return false;
      if (vidaMs === Infinity) return true;
      return ahora() - statSync(ruta).mtimeMs < vidaMs;
    } catch {
      return false;
    }
  }

  function recordar(jid: string, color: string | null): void {
    memoria.delete(jid);
    memoria.set(jid, color);
    while (memoria.size > 128) {
      const oldest = memoria.keys().next().value!;
      memoria.delete(oldest); pedidos.delete(oldest);
    }
    if (!detenido && visibles.has(jid)) {
      publicar(jid, color);
      deps.publicarFoto?.(jid, existsSync(rutaFoto(jid)) ? rutaFoto(jid) : null);
    }
  }

  /**
   * Resuelve UN chat. Devuelve `true` si tuvo que preguntarle a WhatsApp, que es
   * lo que decide cuánto se espera antes del siguiente.
   */
  async function resolver(jid: string): Promise<boolean> {
    // 1. ¿Ya está bajada de una corrida anterior? Cero red.
    const foto = rutaFoto(jid);
    if (frescoHasta(foto, Infinity)) {
      asegurarDir();
      chmodSync(foto, 0o600);
      recordar(jid, deps.publicarFoto ? null : await sacarColor(foto));
      return false;
    }
    // 2. ¿Ya sabemos que no tiene, y hace poco? Cero red.
    if (frescoHasta(rutaSinFoto(jid), TTL_SIN_FOTO_MS)) {
      recordar(jid, null);
      return false;
    }

    // 3. Recién acá se le pregunta a WhatsApp.
    if (ultimoPedido && ahora() - ultimoPedido < GAP_MS) {
      await new Promise<void>(r => agendar(r, GAP_MS - (ahora() - ultimoPedido)));
    }
    if (detenido || !visibles.has(jid)) { pedidos.delete(jid); return false; }
    ultimoPedido = ahora();
    consultasHechas++;
    let url: string | null = null;
    try {
      url = await urlDe(jid);
    } catch (e) {
      // El que cablea `urlDe` ya atrapa; esto es el último seguro.
      log.warn("avatar.url_fallida", { motivo: motivo(e) });
      url = null;
    }

    if (detenido || !visibles.has(jid)) { pedidos.delete(jid); return true; }
    const bytes = url ? await bajar(url) : null;
    try {
      asegurarDir();
      if (bytes) {
        writeFileSync(foto, bytes, { mode: 0o600 });
        chmodSync(foto, 0o600);
      } else {
        // La marca de "no tiene": un archivo vacío cuya FECHA es todo el dato.
        writeFileSync(rutaSinFoto(jid), "", { mode: 0o600 });
        chmodSync(rutaSinFoto(jid), 0o600);
      }
    } catch (e) {
      // No poder escribir el caché no invalida el color: se sigue igual, y lo
      // único que se pierde es no tener que preguntar de nuevo mañana.
      log.warn("avatar.cache_fallido", { motivo: motivo(e) });
    }

    recordar(jid, bytes && !deps.publicarFoto ? await sacarColor(foto) : null);
    return true;
  }

  async function trabajar(): Promise<void> {
    try {
      while (!detenido && cola.length > 0) {
        const jid = cola.shift() as string;
        if (!visibles.has(jid)) { pedidos.delete(jid); continue; }
        let conRed = false;
        try {
          conRed = await resolver(jid);
        } catch (e) {
          // Un chat que explota no se lleva puesta la cola.
          log.warn("avatar.fallido", { motivo: motivo(e) });
          memoria.set(jid, null);
        }
        // El espaciado SÓLO después de una consulta de verdad: resolver desde el
        // caché de disco no le cuesta nada a WhatsApp y no tiene por qué hacer
        // esperar a la fila de al lado.
        if (conRed && !detenido && cola.length > 0) {
          await new Promise<void>((r) => agendar(() => r(), GAP_MS));
        }
      }
    } finally {
      corriendo = false;
      // Puede haber entrado trabajo mientras se cerraba el `while`.
      if (!detenido && cola.length > 0) bombear();
    }
  }

  function bombear(): void {
    if (corriendo || detenido || cola.length === 0) return;
    corriendo = true;
    // Un microtask de diferencia, igual que la cola de envío: así `corriendo` ya
    // está en `true` cuando el worker arranca.
    void Promise.resolve().then(trabajar);
  }

  return {
    request(jids) {
      if (detenido) return;
      try {
        visibles = new Set(jids ?? []);
        for (let i = cola.length - 1; i >= 0; i--) {
          if (!visibles.has(cola[i]!)) { pedidos.delete(cola[i]!); cola.splice(i, 1); }
        }
        for (const j of jids ?? []) {
          const jid = String(j ?? "");
          if (!jid) continue;
          if (memoria.has(jid)) { recordar(jid, memoria.get(jid) ?? null); continue; }
          if (pedidos.has(jid)) continue;
          pedidos.add(jid);
          // Lo que ya está en memoria se re-publica sin encolar: pasa cuando el
          // store se re-arma (no ocurre hoy) y es gratis.
          if (memoria.has(jid)) {
            publicar(jid, memoria.get(jid) ?? null);
            continue;
          }
          cola.push(jid);
        }
        bombear();
      } catch (e) {
        // Cuelga de un render: una excepción acá se lleva puesta la pantalla.
        log.warn("avatar.pedido_fallido", { motivo: motivo(e) });
      }
    },

    stop() {
      detenido = true;
      cola.length = 0;
    },

    consultas() {
      return consultasHechas;
    },
  };
}
