// Tests de la marca de instancia única (`boot/lock.ts`, CA-18.1 … CA-18.4).
//
// Lo que importa acá no es el camino feliz —tomar un archivo que no existe es
// una línea—, son los DOS falsos positivos que hacen inservible a un pidfile:
//
//  · la marca **huérfana** que dejó un proceso que murió de golpe (`kill -9`,
//    un corte de luz): si se la cree, wacosas no arranca nunca más (CA-18.3);
//  · el **PID reciclado**: el kernel le dio ese número a otro programa y la
//    marca vieja parece viva. Por eso se compara también el `cmdline`.
//
// El proceso "vivo" y su `cmdline` se inyectan (`vivo` / `cmdlineDe`): así no
// hace falta arrancar procesos de verdad para probar los cuatro cruces.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireLock, cmdlineDelProceso } from "../src/boot/lock";

const tmp = mkdtempSync(join(tmpdir(), "wacosas-lock-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Un pidfile nuevo por test: nunca se comparten. */
let n = 0;
const rutaNueva = () => join(tmp, `wacosas-${++n}.lock`);

/** Los permisos efectivos, como los muestra `stat -c %a`. */
const modo = (p: string) => (statSync(p).mode & 0o777).toString(8);

const CMD_WACOSAS = "bun run src/index.tsx";

test("toma la marca, escribe pid + cmdline en 0600 y la suelta al liberar", () => {
  const path = rutaNueva();
  const r = acquireLock(path, { pid: 4242, cmdline: CMD_WACOSAS });

  expect(r.ok).toBe(true);
  expect(r.aviso).toBe(null);
  expect(readFileSync(path, "utf8")).toBe(`4242\n${CMD_WACOSAS}\n`);
  // RNF-12: todo lo que escribe el proceso nace privado.
  expect(modo(path)).toBe("600");

  r.lock.release();
  expect(() => readFileSync(path, "utf8")).toThrow();
  // Idempotente: soltar dos veces no explota (el cierre ordenado puede pasar por
  // acá más de una vez si algo falló antes).
  expect(() => r.lock.release()).not.toThrow();
});

test("con la primera instancia VIVA, la segunda no arranca y sabe qué pid la tiene (CA-18.2)", () => {
  const path = rutaNueva();
  const primera = acquireLock(path, { pid: 1001, cmdline: CMD_WACOSAS });
  expect(primera.ok).toBe(true);

  const segunda = acquireLock(path, {
    pid: 1002,
    cmdline: CMD_WACOSAS,
    vivo: (pid) => pid === 1001,
    cmdlineDe: () => CMD_WACOSAS,
  });

  expect(segunda.ok).toBe(false);
  expect(segunda.ajena.pid).toBe(1001);
  // Y no pisó la marca de la que sí está corriendo.
  expect(readFileSync(path, "utf8")).toBe(`1001\n${CMD_WACOSAS}\n`);
});

test("marca huérfana de un PID muerto ⇒ arranca normal y se queda con ella (CA-18.3)", () => {
  const path = rutaNueva();
  writeFileSync(path, `999999\n${CMD_WACOSAS}\n`, { mode: 0o600 });

  const r = acquireLock(path, {
    pid: 7,
    cmdline: CMD_WACOSAS,
    vivo: () => false, // el proceso ya no existe
    cmdlineDe: () => null,
  });

  expect(r.ok).toBe(true);
  expect(readFileSync(path, "utf8")).toBe(`7\n${CMD_WACOSAS}\n`);
});

test("PID vivo con OTRO cmdline ⇒ se lo reciclaron: arranca normal (CA-18.3)", () => {
  const path = rutaNueva();
  writeFileSync(path, `1234\n${CMD_WACOSAS}\n`, { mode: 0o600 });

  const r = acquireLock(path, {
    pid: 8,
    cmdline: CMD_WACOSAS,
    vivo: () => true, // el número existe…
    cmdlineDe: () => "/usr/bin/firefox", // …pero es otro programa
  });

  expect(r.ok).toBe(true);
  expect(readFileSync(path, "utf8")).toBe(`8\n${CMD_WACOSAS}\n`);
});

test("PID vivo pero sin cmdline legible ⇒ no alcanza para creerle a la marca", () => {
  // `/proc/<pid>/cmdline` puede no leerse (proceso de otro usuario, un `/proc`
  // que no está). "No sé" no puede significar "no arranques nunca más".
  const path = rutaNueva();
  writeFileSync(path, `1234\n${CMD_WACOSAS}\n`, { mode: 0o600 });

  const r = acquireLock(path, {
    pid: 9,
    cmdline: CMD_WACOSAS,
    vivo: () => true,
    cmdlineDe: () => null,
  });

  expect(r.ok).toBe(true);
  expect(readFileSync(path, "utf8")).toBe(`9\n${CMD_WACOSAS}\n`);
});

test("una marca ilegible (vacía, basura, truncada) no frena el arranque", () => {
  for (const basura of ["", "\n", "no soy un pid\n", "-3\ncualquiera\n"]) {
    const path = rutaNueva();
    writeFileSync(path, basura, { mode: 0o600 });
    const r = acquireLock(path, {
      pid: 11,
      cmdline: CMD_WACOSAS,
      vivo: () => true,
      cmdlineDe: () => CMD_WACOSAS,
    });
    expect(r.ok).toBe(true);
  }
});

test("release() NO borra la marca de otro: la que pisó la nuestra se queda", () => {
  const path = rutaNueva();
  const mia = acquireLock(path, { pid: 21, cmdline: CMD_WACOSAS });
  expect(mia.ok).toBe(true);

  // Otra instancia me dio por muerto y tomó la marca (es el caso de CA-18.3).
  writeFileSync(path, `22\n${CMD_WACOSAS}\n`, { mode: 0o600 });
  mia.lock.release();

  expect(readFileSync(path, "utf8")).toBe(`22\n${CMD_WACOSAS}\n`);
});

test("si el pidfile no se puede escribir, se arranca igual pero avisando", () => {
  // Un directorio sin permiso de escritura: no se puede dejar marca. Negarse a
  // abrir por eso sería cambiar un riesgo chico (dos instancias) por uno seguro
  // (no hay app).
  const dir = join(tmp, "sin-permiso");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o500);
  try {
    const r = acquireLock(join(dir, "wacosas.lock"), { pid: 31, cmdline: CMD_WACOSAS });
    expect(r.ok).toBe(true);
    expect(typeof r.aviso).toBe("string");
    expect(() => r.lock.release()).not.toThrow();
  } finally {
    chmodSync(dir, 0o700);
  }
});

test("cmdlineDelProceso() lee el /proc real y no confunde dos procesos distintos", () => {
  const propio = cmdlineDelProceso(process.pid);
  expect(typeof propio).toBe("string");
  expect(propio).toContain("bun");
  // Un PID que no existe (el máximo de Linux es 2^22) no devuelve texto.
  expect(cmdlineDelProceso(0x7f_ff_ff)).toBe(null);
});
