// Entry de wacosas. ORDEN OBLIGATORIO (design §3):
//   umask → paths → stderr(dup2) → args → lock → db → store.bootstrap →
//   renderer → root.render(<App/>) → wa.start()
//
// El orden no es cosmético:
//   · el `umask` va primero para que TODO archivo que cree el proceso nazca 0600
//     (CA-14.6), incluidos los de `useMultiFileAuthState`;
//   · el dup2 de stderr va antes de tocar baileys/ws/OpenTUI, porque los warnings
//     de `ws` los escribe Bun desde código nativo y sólo se agarran por el
//     descriptor (D9, RNF-4);
//   · `store.bootstrap(repo)` es SINCRÓNICO y va antes del render, así el primer
//     frame ya sale con los chats de la base y no vacío (CA-13.1);
//   · `wa.start()` va ÚLTIMO: la interfaz tiene que estar pintada y navegable
//     aunque la red no conteste nunca (CA-13.2, RNF-5).
// El `lock` (instancia única) lo inserta la tarea 17 entre los args y la base.
//
// Los imports son DINÁMICOS a propósito: los `import` estáticos se hoistean y se
// evaluarían antes del `umask` y del dup2. Además, cargar `wa/socket` (o sea,
// baileys entero) DESPUÉS del `render` es lo que mantiene el primer frame lejos
// del segundo. Sin lib de CLI args (D12): alcanza con `argv`.
import type { Database } from "bun:sqlite";

process.umask(0o077);

const { resolvePaths } = await import("./boot/paths");
const paths = resolvePaths();

// fd 2 → archivo de log (D9, RNF-4). Si el dup2 no levanta se sigue igual (R1 del
// §9): el wrapper de ~/.local/bin ya redirige con `2>>`.
const { redirectStderrTo, stderrRedirectError } = await import("./boot/stderr");
const stderrRedirigido = redirectStderrTo(paths.logPath);

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

const noSplash = argv.includes("--no-splash"); // CA-13.7

// ── renderer ────────────────────────────────────────────────────────────────
// `exitOnCtrlC:false` + `exitSignals:[]`: la salida la maneja la app (CA-17.1),
// no el renderer. Sin esto, `Ctrl-C` mataría el proceso salteándose el cierre
// ordenado (drenar el ingest, cerrar la base) que arma la tarea 17.
const { createCliRenderer } = await import("@opentui/core");
const { createRoot } = await import("@opentui/react");

async function montarRenderer() {
  return createCliRenderer({ exitOnCtrlC: false, exitSignals: [] });
}

// ── base ────────────────────────────────────────────────────────────────────
const { DbCorruptError, openDb } = await import("./db/open");

let db: Database;
try {
  db = openDb(paths.dbPath);
} catch (e) {
  // CA-13.6: pantalla con ruta y motivo, y salida con 2. Nada de stack trace
  // crudo —que además sería invisible, con el fd 2 apuntando al log—.
  const motivo = e instanceof DbCorruptError ? e.reason : String(e);
  log.error("db.no_abre", { path: paths.dbPath, motivo });

  const rendererError = await montarRenderer();
  const { ErrorScreen } = await import("./ui/ErrorScreen");
  createRoot(rendererError).render(
    <ErrorScreen
      path={paths.dbPath}
      reason={motivo}
      onQuit={() => {
        try {
          rendererError.destroy();
        } catch {
          /* si el renderer ya se cayó, salir igual */
        }
        process.exit(2);
      }}
    />,
  );
  // El módulo NO sigue: la pantalla vive hasta que el usuario aprieta una tecla.
  await new Promise<never>(() => {});
}

const { createRepo } = await import("./db/repo");
const { store } = await import("./state/store");

const repo = createRepo(db!);
// Sincrónico: llena inbox+conn antes del primer frame (CA-13.1).
store.bootstrap(repo);

// ── interfaz ────────────────────────────────────────────────────────────────
const renderer = await montarRenderer();

/**
 * Cierre mínimo: deja la terminal usable (fuera de la pantalla alternativa, sin
 * mouse tracking, con el cursor visible) y sale. La tarea 17 lo reemplaza por el
 * apagado ordenado de §6.6 sin tocar a los llamadores.
 */
const shutdown = (code = 0): void => {
  try {
    renderer.destroy();
  } catch {
    /* si el renderer ya se cayó, la salida sigue siendo la prioridad */
  }
  process.exit(code);
};

const { configureCommands } = await import("./state/commands");
const { App } = await import("./ui/App");

createRoot(renderer).render(<App noSplash={noSplash} logPath={paths.logPath} />);
log.info("boot.render", { splash: !noSplash, ms: Math.round(performance.now()) });

// ── máquina (después del render: baileys tarda en cargar) ────────────────────
const { createIngest } = await import("./wa/ingest");
const { createWaController } = await import("./wa/socket");

let wa: import("./wa/socket").WaController;
const ingest = createIngest({
  repo,
  store,
  log,
  selfJid: () => wa?.selfJid() ?? "",
  openChatJid: () => store.openChatJid(),
});
wa = createWaController({ ingest, store, log, credsDir: paths.credsDir });

configureCommands({ repo, wa, store, log, shutdown });

log.info("boot.listo", { version, db: paths.dbPath, ms: Math.round(performance.now()) });
wa.start();
