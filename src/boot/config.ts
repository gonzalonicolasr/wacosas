// `config.json` — la ÚNICA configuración de wacosas (design §3, recorte R3).
//
// No hay pantalla de ajustes: el archivo se edita a mano en
// `$XDG_DATA_HOME/wacosas/config.json` y se lee UNA vez, en el arranque. De ahí
// que no haya watcher ni recarga: cambiar un valor implica reiniciar la app.
//
// Tres reglas:
//
//  1. **Nunca lanza.** Es la primera lectura de disco del arranque y un JSON con
//     una coma de más no puede impedir que la aplicación abra: se cae al default
//     y queda la línea en el log.
//  2. **Nunca escribe.** El archivo se crea a mano; no existir es el caso normal
//     (todos los defaults) y no un error que haya que "arreglar" materializando
//     un archivo que el usuario no pidió.
//  3. **Sólo se acepta lo que es del tipo correcto.** `"readReceipts": "no"` es
//     un string, no un `false`: se ignora y se avisa, en vez de tomarlo como
//     verdadero (que es lo que haría un `!!` y sería justo el default silencioso
//     que el usuario intentó cambiar).
import { readFileSync } from "node:fs";

import type { Logger } from "./log";

export type Config = {
  /**
   * Recibos de lectura (CA-11.2/11.3). `true` por default: es el comportamiento
   * de un cliente de WhatsApp normal (decisión P1 del plan).
   *
   * En `false` el chat se marca leído SOLO en local y no sale ni una llamada a
   * WhatsApp — nada de "llamar y descartar": un recibo de lectura lo VE la otra
   * persona, así que la única implementación aceptable de "deshabilitado" es que
   * la llamada no exista.
   */
  readReceipts: boolean;
};

export const CONFIG_DEFAULT: Config = { readReceipts: true };

/** Un booleano de verdad, o `undefined` si el JSON traía otra cosa. */
function booleano(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

/**
 * Lee `config.json`. Sin archivo (el caso normal) devuelve los defaults sin
 * decir nada; con un archivo ilegible o mal formado, los defaults y un `warn`.
 */
export function loadConfig(path: string, log?: Logger): Config {
  let crudo: string;
  try {
    crudo = readFileSync(path, "utf8");
  } catch {
    // No existe (lo habitual), o no se puede leer: defaults y a otra cosa.
    return { ...CONFIG_DEFAULT };
  }

  let json: unknown;
  try {
    json = JSON.parse(crudo);
  } catch (e) {
    log?.warn("config.invalido", {
      path,
      motivo: e instanceof Error ? e.message : String(e),
    });
    return { ...CONFIG_DEFAULT };
  }

  if (!json || typeof json !== "object" || Array.isArray(json)) {
    log?.warn("config.invalido", { path, motivo: "no es un objeto JSON" });
    return { ...CONFIG_DEFAULT };
  }

  const o = json as Record<string, unknown>;
  const config: Config = {
    readReceipts: booleano(o.readReceipts) ?? CONFIG_DEFAULT.readReceipts,
  };
  if (o.readReceipts !== undefined && booleano(o.readReceipts) === undefined) {
    log?.warn("config.campo_invalido", { path, campo: "readReceipts", tipo: typeof o.readReceipts });
  }
  log?.info("config.leido", { path, readReceipts: config.readReceipts });
  return config;
}
