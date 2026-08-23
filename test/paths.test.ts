// Tests de boot/paths.ts: XDG, creación de dirs y permisos (CA-14.5, CA-14.6, RNF-12).
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolvePaths } from "../src/boot/paths";

const tmp = mkdtempSync(join(tmpdir(), "wacosas-paths-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Los permisos efectivos del archivo/dir, como los muestra `stat -c %a`. */
const mode = (p: string) => (statSync(p).mode & 0o777).toString(8);

const env = (over: Record<string, string | undefined> = {}) => ({
  HOME: join(tmp, "home"),
  XDG_DATA_HOME: undefined,
  XDG_STATE_HOME: undefined,
  ...over,
});

test("respeta XDG_DATA_HOME y XDG_STATE_HOME", () => {
  const data = join(tmp, "xdg-data");
  const state = join(tmp, "xdg-state");
  const p = resolvePaths(env({ XDG_DATA_HOME: data, XDG_STATE_HOME: state }));

  expect(p.dataDir).toBe(join(data, "wacosas"));
  expect(p.stateDir).toBe(join(state, "wacosas"));
  expect(p.dbPath).toBe(join(data, "wacosas", "wacosas.sqlite"));
  expect(p.credsDir).toBe(join(data, "wacosas", "creds"));
  expect(p.configPath).toBe(join(data, "wacosas", "config.json"));
  expect(p.lockPath).toBe(join(data, "wacosas", "wacosas.lock"));
  expect(p.logPath).toBe(join(state, "wacosas", "wacosas.log"));
});

test("sin XDG usa ~/.local/share y ~/.local/state", () => {
  const home = join(tmp, "home-default");
  const p = resolvePaths(env({ HOME: home }));

  expect(p.dataDir).toBe(join(home, ".local", "share", "wacosas"));
  expect(p.stateDir).toBe(join(home, ".local", "state", "wacosas"));
});

test("un XDG relativo se ignora y cae al default (spec XDG)", () => {
  const home = join(tmp, "home-relativo");
  const p = resolvePaths(env({ HOME: home, XDG_DATA_HOME: "datos/relativos" }));

  expect(p.dataDir).toBe(join(home, ".local", "share", "wacosas"));
});

test("crea los dos dirs raíz con 0700 y es idempotente", () => {
  const data = join(tmp, "crea-data");
  const state = join(tmp, "crea-state");

  const p = resolvePaths(env({ XDG_DATA_HOME: data, XDG_STATE_HOME: state }));
  expect(mode(p.dataDir)).toBe("700");
  expect(mode(p.stateDir)).toBe("700");

  // Segunda pasada: no explota y los permisos siguen igual.
  const again = resolvePaths(env({ XDG_DATA_HOME: data, XDG_STATE_HOME: state }));
  expect(again).toEqual(p);
  expect(mode(again.dataDir)).toBe("700");
});

test("endurece un directorio preexistente con permisos laxos", () => {
  const data = join(tmp, "laxo-data");
  const state = join(tmp, "laxo-state");
  mkdirSync(join(data, "wacosas"), { recursive: true });
  chmodSync(join(data, "wacosas"), 0o755);

  const p = resolvePaths(env({ XDG_DATA_HOME: data, XDG_STATE_HOME: state }));
  expect(mode(p.dataDir)).toBe("700");
});

test("los archivos que crea el proceso nacen 0600 (umask 0o077)", () => {
  const data = join(tmp, "umask-data");
  const state = join(tmp, "umask-state");
  const p = resolvePaths(env({ XDG_DATA_HOME: data, XDG_STATE_HOME: state }));

  // Sin pasar `mode`: los permisos salen del umask que setea resolvePaths.
  writeFileSync(p.configPath, "{}\n");
  expect(mode(p.configPath)).toBe("600");
});
