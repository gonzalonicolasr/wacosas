// El código que revela los chats con candado (Chat Lock), derivado con scrypt y
// guardado en `$XDG_DATA_HOME/wacosas/lock-code.json` con permisos 0600.
//
// ⚠️ **NO es el código de WhatsApp verificado contra WhatsApp.** El código de
// Chat Lock viaja en el protocolo como `UserPassword` con PBKDF2
// (`WAProto/index.d.ts:13320`), pero **baileys nunca emite `chatLockSettings`**
// (0 usos en `lib/`), así que del lado nuestro ese material no existe. Lo que
// hace wacosas es guardar el hash de **los mismos dígitos** que el usuario ya usa
// en el teléfono —para no obligarlo a recordar un código nuevo— y compararlos
// contra ESE hash local. Dos consecuencias que hay que tener presentes:
//
//   · si el código cambia en el teléfono, wacosas no se entera: hay que volver a
//     fijarlo acá (`Ctrl-P`);
//   · es **más débil** que el candado del teléfono, donde hay biometría y el
//     sistema operativo. Acá es un hash en un disco donde la base de mensajes
//     está SIN cifrar: sirve contra una mirada de reojo a la terminal, no contra
//     alguien que ya está sentado en tu sesión (ese lee la base con `sqlite3` sin
//     preguntarle a nadie, y también puede volver a fijar el código).
//
// Sin deps nuevas (D12): `node:crypto` trae `scrypt` y `timingSafeEqual`.
//
// Tres reglas del módulo:
//
//  1. **Los dígitos NUNCA se escriben en ningún lado**: ni en el archivo (va la
//     sal y el hash), ni en el log (los eventos de acá no llevan ni el código ni
//     su largo, que ya sería una pista).
//  2. **La comparación es en tiempo constante** (`timingSafeEqual`). No es
//     paranoia inútil: es la diferencia entre un código y un adorno.
//  3. **La verificación es ASINCRÓNICA**. Se llama en cada tecla del buscador de
//     la bandeja y una derivación scrypt cuesta ~30 ms — sincrónica sería tragarse
//     un frame por tecla (RNF-5). El `scrypt` de `node:crypto` la corre fuera del
//     hilo del event loop (medido: el loop siguió tickeando durante los 28 ms).
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";

import type { Logger } from "./log";

/**
 * Largo aceptado del código, en dígitos. El mínimo existe para que un número de
 * teléfono corto tipeado en el buscador no dispare una derivación por tecla; el
 * máximo, para que nadie pegue medio mensaje adentro del campo y nos cueste
 * scrypt.
 */
export const MIN_DIGITOS = 4;
export const MAX_DIGITOS = 16;

/** Parámetros de derivación de los códigos NUEVOS (los viejos usan los suyos). */
const N = 16_384;
const R = 8;
const P = 1;
const LARGO_HASH = 32;
const LARGO_SAL = 16;
/** Tope de memoria de scrypt: `128 · N · r` son 16 MB con los parámetros de arriba. */
const MAXMEM = 64 * 1024 * 1024;

/** Formato del archivo. Si algún día cambian los parámetros, esto los distingue. */
const VERSION = 1;

export type LockCode = {
  /** ¿Hay un código fijado? */
  exists(): boolean;
  /** Fija (o reemplaza) el código. Devuelve el motivo cuando no se pudo. */
  set(digits: string): { ok: true; reason?: undefined } | { ok: false; reason: string };
  /**
   * ¿Estos dígitos son el código? Siempre `false` si no hay código fijado o si
   * el texto ni siquiera tiene forma de código (ahí ni deriva).
   */
  verify(digits: string): Promise<boolean>;
  /** Ruta del archivo, para poder nombrarla en pantalla. */
  path: string;
};

/** Lo que hay guardado, ya decodificado. */
type Guardado = { salt: Buffer; hash: Buffer; n: number; r: number; p: number };

export const MOTIVO_NO_DIGITOS = "sólo dígitos, sin espacios ni símbolos";
export const motivoLargo = (n: number): string =>
  `el código tiene ${n} ${n === 1 ? "dígito" : "dígitos"}: van entre ${MIN_DIGITOS} y ${MAX_DIGITOS}`;

/**
 * ¿Este texto puede ser un código? Es el mismo filtro para fijarlo y para
 * verificarlo, así que un código que se pudo fijar siempre se puede verificar.
 *
 * El `reason?: undefined` de la rama buena no es adorno (mismo motivo que
 * `Resultado` en `state/commands.ts`): el proyecto compila **sin
 * `strictNullChecks`** y ahí TypeScript no angosta una unión por un booleano
 * literal, así que sin declarar la propiedad en las dos ramas un
 * `v.ok ? … : v.reason` no compila.
 */
export function validarCodigo(
  raw: string | null | undefined,
): { ok: true; digits: string; reason?: undefined } | { ok: false; reason: string; digits?: undefined } {
  const texto = String(raw ?? "");
  if (texto === "" || /\D/.test(texto)) return { ok: false, reason: MOTIVO_NO_DIGITOS };
  if (texto.length < MIN_DIGITOS || texto.length > MAX_DIGITOS) {
    return { ok: false, reason: motivoLargo(texto.length) };
  }
  return { ok: true, digits: texto };
}

/** Un entero adentro del rango, o `null`: un archivo tocado a mano no puede colgar scrypt. */
function entero(v: unknown, min: number, max: number): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null;
}

/** Un base64 que decodifica a `largo` bytes exactos, o `null`. */
function bytes(v: unknown, largo: number): Buffer | null {
  if (typeof v !== "string" || v === "") return null;
  const b = Buffer.from(v, "base64");
  return b.length === largo ? b : null;
}

/**
 * El código guardado en disco, o `null` si no hay ninguno (el caso normal la
 * primera vez) o si el archivo no se entiende.
 *
 * Nunca lanza, por lo mismo que `loadConfig`: un archivo roto no puede impedir
 * que la aplicación abra. Un archivo roto se comporta como "no hay código": los
 * chats con candado siguen escondidos, que es el lado seguro del error.
 */
function leer(path: string, log?: Logger): Guardado | null {
  let crudo: string;
  try {
    crudo = readFileSync(path, "utf8");
  } catch {
    return null; // no existe todavía: es lo habitual
  }
  try {
    const o = JSON.parse(crudo) as Record<string, unknown>;
    if (!o || typeof o !== "object" || o.kdf !== "scrypt") throw new Error("no es un código de wacosas");
    const salt = bytes(o.salt, LARGO_SAL);
    const hash = bytes(o.hash, LARGO_HASH);
    const n = entero(o.n, 2, 1 << 20);
    const r = entero(o.r, 1, 32);
    const p = entero(o.p, 1, 16);
    if (!salt || !hash || n === null || r === null || p === null) throw new Error("campos inválidos");
    return { salt, hash, n, r, p };
  } catch (e) {
    // El motivo sí, el contenido NO: adentro está la sal y el hash.
    log?.warn("candado.archivo_invalido", {
      path,
      motivo: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/**
 * El código del candado, colgado de un archivo.
 *
 * Lo leído se CACHEA: `verify` se llama en cada tecla del buscador y wacosas es
 * de instancia única (`boot/lock.ts`), así que nadie más escribe ese archivo. El
 * cache se invalida solo en `set`.
 */
export function createLockCode(path: string, log?: Logger): LockCode {
  let cache: Guardado | null = null;
  let leido = false;

  const actual = (): Guardado | null => {
    if (!leido) {
      cache = leer(path, log);
      leido = true;
    }
    return cache;
  };

  return {
    path,

    exists() {
      return actual() !== null;
    },

    set(digits) {
      const v = validarCodigo(digits);
      if (!v.ok) return v;
      const salt = randomBytes(LARGO_SAL);
      // Sincrónica a propósito: es UNA derivación, en una acción deliberada del
      // usuario (fijar el código). Los ~30 ms no se notan y evitan tener que
      // arrastrar una promesa hasta el handler de teclado.
      const hash = scryptSync(v.digits, salt, LARGO_HASH, { N, r: R, p: P, maxmem: MAXMEM });
      const json = `${JSON.stringify(
        {
          version: VERSION,
          kdf: "scrypt",
          n: N,
          r: R,
          p: P,
          salt: salt.toString("base64"),
          hash: hash.toString("base64"),
          updatedAt: Math.floor(Date.now() / 1000),
        },
        null,
        2,
      )}\n`;
      try {
        writeFileSync(path, json, { mode: 0o600 });
        // El `umask(0o077)` del arranque ya lo hace nacer 0600; el `chmod` es
        // para el archivo que quedó de antes con permisos laxos —un `open` sobre
        // algo que ya existe NO corrige el modo— (mismo criterio que `boot/log.ts`
        // y `wa/auth.ts`).
        chmodSync(path, 0o600);
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
      cache = { salt, hash, n: N, r: R, p: P };
      leido = true;
      // Ni el código ni su largo: el largo ya es media pista.
      log?.info("candado.codigo_fijado", { path });
      return { ok: true };
    },

    verify(digits) {
      const g = actual();
      if (!g) return Promise.resolve(false);
      const v = validarCodigo(digits);
      // Ni siquiera tiene forma de código: se corta antes de gastar scrypt. Es lo
      // que hace que escribir un nombre en el buscador no cueste una derivación.
      if (!v.ok) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        scrypt(
          v.digits,
          g.salt,
          g.hash.length,
          { N: g.n, r: g.r, p: g.p, maxmem: MAXMEM },
          (err, derivado) => {
            // Un error de scrypt (parámetros imposibles en un archivo tocado a
            // mano) es "no coincide": el lado seguro.
            if (err || !derivado) return resolve(false);
            resolve(derivado.length === g.hash.length && timingSafeEqual(derivado, g.hash));
          },
        );
      });
    },
  };
}
