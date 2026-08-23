// Tests de boot/log.ts (formato, campos, permisos, rotación) y del dup2 de
// boot/stderr.ts (CA-16.1, CA-16.4, CA-14.7, RNF-4).
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLogger } from "../src/boot/log";
import { redirectStderrTo, stderrRedirectError } from "../src/boot/stderr";

const tmp = mkdtempSync(join(tmpdir(), "wacosas-log-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Los permisos efectivos, como los muestra `stat -c %a`. */
const mode = (p: string) => (statSync(p).mode & 0o777).toString(8);
const nuevoLog = (nombre: string) => join(tmp, `${nombre}.log`);
const lineas = (p: string) => readFileSync(p, "utf8").split("\n").filter(Boolean);

const MB = 1024 * 1024;

test("cada línea lleva timestamp ISO, nivel y evento (CA-16.1)", () => {
  const p = nuevoLog("formato");
  const log = createLogger(p);

  log.info("wa.open");
  log.warn("wa.version.fallback");
  log.error("db.corrupta");

  const [a, b, c] = lineas(p);
  expect(a).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] INFO {2}wa\.open$/);
  expect(b).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] WARN {2}wa\.version\.fallback$/);
  expect(c).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] ERROR db\.corrupta$/);

  // El timestamp tiene que ser el de ahora, no una constante.
  const ts = Date.parse(a.slice(1, a.indexOf("]")));
  expect(Math.abs(Date.now() - ts)).toBeLessThan(5_000);
});

test("los campos escalares salen como clave=valor en la misma línea", () => {
  const p = nuevoLog("campos");
  const log = createLogger(p);

  log.info("wa.close", { code: 515, reconecta: true, motivo: null, jid: "54911@s.whatsapp.net" });

  const [linea] = lineas(p);
  expect(linea).toEndWith(' wa.close code=515 reconecta=true motivo=null jid=54911@s.whatsapp.net');
  expect(lineas(p)).toHaveLength(1);
});

test("un valor con espacios o saltos no parte la línea en dos", () => {
  const p = nuevoLog("multilinea");
  const log = createLogger(p);

  log.error("send.failed", { motivo: "connection closed\nstack de mentira" });

  expect(lineas(p)).toHaveLength(1);
  expect(lineas(p)[0]).toEndWith(' send.failed motivo="connection closed\\nstack de mentira"');
});

test("un string largo se recorta: red de seguridad de CA-14.7", () => {
  const p = nuevoLog("recorte");
  const log = createLogger(p);

  log.info("algo.raro", { motivo: "x".repeat(5_000) });

  const [linea] = lineas(p);
  expect(linea.length).toBeLessThan(300);
  expect(linea).toContain("…");
});

test("el archivo queda 0600 aunque ya existiera en 0644 (RNF-12)", () => {
  const p = nuevoLog("permisos");
  // Lo que deja el `2>>` del wrapper con el umask de la shell del usuario.
  writeFileSync(p, "ruido previo\n");
  chmodSync(p, 0o644);
  expect(mode(p)).toBe("644");

  const log = createLogger(p);
  expect(mode(p)).toBe("600");

  log.info("boot.ok");
  expect(mode(p)).toBe("600");
});

test("al pasar 5 MB rota a wacosas.log.1 y conserva como máximo un anterior (CA-16.4)", () => {
  const p = nuevoLog("wacosas");
  const previo = `${p}.1`;
  const log = createLogger(p);

  // Primera rotación: el relleno se va al .1 y el log activo queda chico.
  writeFileSync(p, `${"a".repeat(5 * MB)}\n`);
  log.info("rotacion.uno");

  expect(existsSync(previo)).toBe(true);
  expect(statSync(previo).size).toBeGreaterThan(5 * MB);
  expect(readFileSync(previo, "utf8")).toStartWith("aaaa");
  expect(statSync(p).size).toBeLessThan(1024);
  // La línea que disparó la rotación no se pierde: quedó dentro de la copia.
  expect(readFileSync(previo, "utf8")).toContain("rotacion.uno");
  expect(lineas(p)).toHaveLength(0);
  expect(mode(previo)).toBe("600");
  expect(mode(p)).toBe("600");

  // Segunda rotación: pisa el .1 anterior y NO aparece un .2.
  writeFileSync(p, `${"b".repeat(5 * MB)}\n`);
  log.info("rotacion.dos");

  expect(readFileSync(previo, "utf8")).toStartWith("bbbb");
  expect(existsSync(`${p}.2`)).toBe(false);
  expect(existsSync(`${previo}.1`)).toBe(false);
});

test("no rota antes de tiempo", () => {
  const p = nuevoLog("sin-rotar");
  const log = createLogger(p, 4 * 1024);

  for (let i = 0; i < 10; i++) log.info("evento", { i });

  expect(existsSync(`${p}.1`)).toBe(false);
  expect(lineas(p)).toHaveLength(10);
});

test("un log que no se puede escribir no lanza", () => {
  const p = join(tmp, "no", "existe", "este", "dir", "wacosas.log");
  const log = createLogger(p);

  expect(() => log.info("boot.ok", { n: 1 })).not.toThrow();
  expect(log.path).toBe(p);
});

// ── RNF-4: el dup2 de fd 2 se lleva los warnings de `ws` al log ──────────────
// Se corre en un subproceso porque redirigir el fd 2 de este proceso se llevaría
// también la salida de `bun test`. Ojo: `bun` en el PATH puede ser un shim de
// mise, así que se usa `process.execPath` (el binario real) y NO se pisa
// XDG_DATA_HOME, que es donde mise tiene sus installs.
const repo = join(import.meta.dir, "..");
const stderrTs = join(repo, "src/boot/stderr.ts");
const logTs = join(repo, "src/boot/log.ts");

/** Corre `cuerpo` en un Bun aparte y devuelve lo que salió por pantalla. */
async function correr(cuerpo: string, logPath: string) {
  const proc = Bun.spawn([process.execPath, "-e", cuerpo], {
    cwd: repo,
    env: { ...process.env, WACOSAS_LOG: logPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, salidaStdout, salidaStderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, salidaStdout, salidaStderr };
}

/** Registra los dos handlers que hacen que Bun escupa el warning por fd 2. */
const abrirWs = `
  const WebSocket = require("ws");
  const s = new WebSocket("ws://127.0.0.1:9/");
  s.on("upgrade", () => {});
  s.on("unexpected-response", () => {});
  s.on("error", () => {});
  await new Promise((r) => setTimeout(r, 200));
`;

test("si no se puede redirigir, devuelve false con motivo y no lanza (R1 del §9)", () => {
  // Path imposible: falla antes del dup2, así que el fd 2 de este proceso
  // (el de `bun test`) queda intacto.
  const imposible = join(tmp, "no", "existe", "wacosas.log");

  expect(() => redirectStderrTo(imposible)).not.toThrow();
  expect(redirectStderrTo(imposible)).toBe(false);
  expect(stderrRedirectError()).toBeTruthy();
});

test("los warnings de ws terminan en el log y no en la terminal (RNF-4, CA-16.2)", async () => {
  const p = nuevoLog("ws-warning");

  const { code, salidaStdout, salidaStderr } = await correr(
    `
    const { redirectStderrTo } = await import("${stderrTs}");
    if (!redirectStderrTo(process.env.WACOSAS_LOG)) { console.log("SIN_DUP2"); process.exit(3); }
    ${abrirWs}
    process.exit(0);
  `,
    p,
  );

  expect(code).toBe(0);
  // La terminal queda limpia: ni stdout ni stderr traen el warning.
  expect(salidaStdout).toBe("");
  expect(salidaStderr).toBe("");

  const contenido = readFileSync(p, "utf8");
  expect(contenido).toContain("ws.WebSocket 'upgrade'");
  expect(contenido).toContain("ws.WebSocket 'unexpected-response'");
  expect(mode(p)).toBe("600");
});

test("después de rotar, el fd 2 redirigido sigue escribiendo en el log activo", async () => {
  const p = nuevoLog("ws-rotado");

  // Por eso la rotación copia y trunca en vez de renombrar: con un `rename` el
  // fd 2 quedaría pegado al inodo viejo y los warnings caerían en el `.1`.
  const { code, salidaStderr } = await correr(
    `
    const { redirectStderrTo } = await import("${stderrTs}");
    const { createLogger } = await import("${logTs}");
    const p = process.env.WACOSAS_LOG;
    redirectStderrTo(p);
    const log = createLogger(p);
    require("node:fs").appendFileSync(p, "z".repeat(5 * 1024 * 1024) + "\\n");
    log.info("rotacion.forzada");
    ${abrirWs}
    process.exit(0);
  `,
    p,
  );

  expect(code).toBe(0);
  expect(salidaStderr).toBe("");
  expect(existsSync(`${p}.1`)).toBe(true);
  expect(statSync(`${p}.1`).size).toBeGreaterThan(5 * MB);
  // El warning es POSTERIOR a la rotación: tiene que estar en el log activo.
  expect(readFileSync(p, "utf8")).toContain("ws.WebSocket 'upgrade'");
});
