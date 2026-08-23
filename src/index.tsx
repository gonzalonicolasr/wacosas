// Entry de wacosas. ORDEN OBLIGATORIO (design §3):
//   umask → paths → stderr(dup2) → args → lock → db → store.bootstrap → renderer → render → wa.start()
//
// Por ahora están el umask, las rutas, el dup2 de stderr y el parseo de flags
// (tareas 1 y 2 del plan SDD): el resto lo cablean las tareas 9 (TUI) y 17 (lock).
//
// Los imports son DINÁMICOS a propósito: los `import` estáticos se hoistean y se
// evaluarían antes del `umask`, que tiene que correr primero sí o sí (CA-14.6), y
// antes del dup2 de stderr, que va antes de tocar baileys / ws / OpenTUI (D9).
// Sin lib de CLI args (D12): alcanza con `argv`.
//
// El `export {}` es puro trámite para TypeScript: sin un import/export ESTÁTICO,
// TS no considera módulo a este archivo y los `await` de arriba de todo dan
// TS1375. No emite nada ni cambia el orden de ejecución.
export {};

process.umask(0o077);

const { resolvePaths } = await import("./boot/paths");
const paths = resolvePaths();

// fd 2 → archivo de log (D9, RNF-4): va ACÁ, antes de cualquier import de
// baileys / ws / OpenTUI, porque los warnings de `ws` los escribe Bun desde
// código nativo y sólo se agarran por el descriptor. Si el dup2 no levanta se
// sigue igual (R1 del §9): el wrapper de ~/.local/bin ya redirige con `2>>`.
const { redirectStderrTo, stderrRedirectError } = await import("./boot/stderr");
const stderrRedirigido = redirectStderrTo(paths.logPath);

// El logger vive desde acá para que el fallo del dup2 quede registrado; a partir
// de la tarea 9 lo consumen la TUI (<Help/> muestra `log.path`) y el resto.
const { createLogger } = await import("./boot/log");
const log = createLogger(paths.logPath);

if (!stderrRedirigido) {
  log.warn("boot.stderr_sin_dup2", {
    path: paths.logPath,
    motivo: stderrRedirectError() ?? "desconocido",
  });
}

const { version } = (await import("../package.json")).default;
const argv = process.argv.slice(2);

if (argv.includes("--version") || argv.includes("-v")) {
  console.log(version);
  process.exit(0);
}

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`wacosas ${version} — cliente de WhatsApp en la terminal

Uso:
  wacosas [opciones]

Opciones:
  --no-splash      saltea la animación de arranque y va directo a la interfaz
  -v, --version    imprime la versión y sale
  -h, --help       muestra esta ayuda y sale

Archivos:
  datos   ${paths.dataDir}
  log     ${paths.logPath}

Aviso: la base local NO se cifra. Queda con permisos 0600 (sólo tu usuario),
pero cualquiera que entre con tu usuario puede leer el historial.`);
  process.exit(0);
}

// CA-13.7 — lo va a consumir <Splash/> cuando la TUI se monte (tarea 9).
const noSplash = argv.includes("--no-splash");

// ── cableado PROVISORIO de la tarea 8 ───────────────────────────────────────
// El orden definitivo (lock → db → store.bootstrap → renderer → render →
// wa.start()) lo arman las tareas 9 y 17. Esto es el mínimo para que el socket
// exista y corra de verdad: base + cola de ingest + controlador. Sin TUI todavía
// —lo único que se ve es el log—, pero ya vincula, sincroniza y reconecta.
const { openDb } = await import("./db/open");
const { createRepo } = await import("./db/repo");
const { store } = await import("./state/store");
const { createIngest } = await import("./wa/ingest");
const { createWaController } = await import("./wa/socket");

const repo = createRepo(openDb(paths.dbPath));
store.bootstrap(repo);

let wa: import("./wa/socket").WaController;
const ingest = createIngest({
  repo,
  store,
  log,
  selfJid: () => wa?.selfJid() ?? "",
  openChatJid: () => store.openChatJid(),
});
wa = createWaController({ ingest, store, log, credsDir: paths.credsDir });
wa.start();

log.info("boot.listo", { version, splash: !noSplash, db: paths.dbPath });
console.log(
  `wacosas ${version} — conectando a WhatsApp (splash: ${noSplash ? "salteado" : "activado"}).\n` +
    `La interfaz se monta en la tarea 9 del plan SDD; por ahora el estado se sigue por el log:\n` +
    `  tail -f ${paths.logPath}`,
);
