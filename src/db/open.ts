// Apertura de la base: PRAGMAs → migración → validación (design §4.2).
//
// Todo lo que salga mal acá termina en un `DbCorruptError` con la ruta y el
// motivo, para que `index.tsx` pinte `<ErrorScreen>` y salga con 2 (CA-13.6).
// Nunca un stack trace crudo sobre la terminal —que además sería imposible de
// ver, con el fd 2 redirigido al log por `boot/stderr.ts`—.
import { Database } from "bun:sqlite";

import { migrate, PRAGMAS } from "./schema";

/**
 * La base no se puede abrir, no es una base o no pasa el `quick_check`.
 * `path` y `reason` son lo que la pantalla de error le muestra al usuario.
 */
export class DbCorruptError extends Error {
  readonly path: string;
  readonly reason: string;

  constructor(path: string, reason: string) {
    super(`no se pudo abrir la base ${path}: ${reason}`);
    this.name = "DbCorruptError";
    this.path = path;
    this.reason = reason;
  }
}

/** El texto más útil que se pueda sacar de lo que sea que se haya lanzado. */
function motivo(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Abre (o crea) la base en `path`, deja la conexión lista para usar y devuelve
 * el `Database`. El llamador es dueño de cerrarla (`repo.close()`).
 *
 * `path` puede ser `":memory:"`: los tests y el arranque en seco lo usan igual
 * que un archivo.
 */
export function openDb(path: string): Database {
  let db: Database | null = null;
  try {
    db = new Database(path, { create: true });
    // Los PRAGMAs van por `query().all()` y no por `exec()`: varios devuelven
    // fila (journal_mode, busy_timeout) y así el error sale acá y no después.
    for (const p of PRAGMAS) db.query(`PRAGMA ${p}`).all();
    migrate(db);
    return db;
  } catch (e) {
    try {
      db?.close();
    } catch {
      /* si ni cerrar se puede, el motivo original es el que importa */
    }
    throw new DbCorruptError(path, motivo(e));
  }
}
