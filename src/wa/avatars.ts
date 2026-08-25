// El color de cada chat en la bandeja: el promedio de su foto de perfil.
//
// ⚠️ **Esto es riesgo de ban, no cosmética.** La cuenta real tiene ~890 chats y
// pedirle a WhatsApp la foto de cada uno es una consulta por chat. Todo el
// proyecto viene cuidando el ritmo (1 mensaje por segundo, recibos sólo si había
// no leídos, `groupMetadata` una vez por grupo, `resyncAppState` topeado) y esto
// no puede ser la excepción. De ahí las cuatro reglas:
//
//   1. **Sólo las filas que se VEN.** La bandeja pide el color de los chats que
//      tiene en pantalla —a 80×24 son 18—, nunca de la lista entera, y recién
//      cuando aparecen. Abrir la aplicación son 18 consultas, no 890.
//   2. **Una vez por jid, y para siempre.** Lo que se preguntó una vez queda en
//      disco (`<dataDir>/avatars/`): el arranque siguiente no consulta nada. Lo
//      que NO tiene foto —o no la comparte— queda anotado igual, con fecha, y se
//      vuelve a preguntar recién a los 7 días.
//   3. **Espaciadas y en serie**: un pedido por vez, con `GAP_MS` entre uno y
//      otro. Recorrer los 890 chats a mano tardaría ~15 minutos en pintarse del
//      todo, y eso está BIEN: nadie mira 890 filas de un saque, y el que scrollea
//      hasta el fondo no genera una ráfaga.
//   4. **Un fallo no se nota.** Sin foto, sin privacidad para mostrarla, sin
//      conexión o con `chafa` sin instalar, el glifo se queda del color de
//      siempre. Nada de acá lanza y nada de acá avisa por el pie: es un adorno.
//
// Lo que se guarda en disco es **la foto miniatura** (la que WhatsApp llama
// `preview`, unos pocos KB) con permisos `0600`, igual que las imágenes de los
// mensajes. El directorio se puede borrar entero: lo único que pasa es que la
// próxima vez se vuelve a preguntar.
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
    const bytes = new Uint8Array(await r.arrayBuffer());
    return bytes.length > 0 && bytes.length <= TOPE_FOTO_BYTES ? bytes : null;
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
    memoria.set(jid, color);
    publicar(jid, color);
  }

  /**
   * Resuelve UN chat. Devuelve `true` si tuvo que preguntarle a WhatsApp, que es
   * lo que decide cuánto se espera antes del siguiente.
   */
  async function resolver(jid: string): Promise<boolean> {
    // 1. ¿Ya está bajada de una corrida anterior? Cero red.
    const foto = rutaFoto(jid);
    if (frescoHasta(foto, Infinity)) {
      recordar(jid, await sacarColor(foto));
      return false;
    }
    // 2. ¿Ya sabemos que no tiene, y hace poco? Cero red.
    if (frescoHasta(rutaSinFoto(jid), TTL_SIN_FOTO_MS)) {
      recordar(jid, null);
      return false;
    }

    // 3. Recién acá se le pregunta a WhatsApp.
    consultasHechas++;
    let url: string | null = null;
    try {
      url = await urlDe(jid);
    } catch (e) {
      // El que cablea `urlDe` ya atrapa; esto es el último seguro.
      log.warn("avatar.url_fallida", { motivo: motivo(e) });
      url = null;
    }

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

    recordar(jid, bytes ? await sacarColor(foto) : null);
    return true;
  }

  async function trabajar(): Promise<void> {
    try {
      while (!detenido && cola.length > 0) {
        const jid = cola.shift() as string;
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
        for (const j of jids ?? []) {
          const jid = String(j ?? "");
          if (!jid || pedidos.has(jid)) continue;
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
