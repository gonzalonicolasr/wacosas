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

/**
 * `--qr-png` / `--qr-png=<ruta>` ⇒ ruta del PNG, o `null` si el flag no está.
 *
 * POR QUÉ EXISTE: el QR de WhatsApp mide 34 filas × 67 columnas y la terminal de
 * todos los días acá es 24 × 80 — no entra (RNF-3). Para eso está el código de
 * emparejamiento, pero el usuario **quiere el QR** y agrandar la terminal no
 * siempre es opción. Con el PNG lo abre en cualquier visor y escanea desde ahí,
 * SIN salirse de la app: eso es lo que importa, porque el 515
 * (`restartRequired`) que llega justo después del escaneo lo tiene que manejar
 * el controlador (CA-1.8, respawn en el acto) y no una herramienta aparte que
 * termina y deja la sesión a medio armar —un `creds/` con un solo archivo, sin
 * pre-keys ni app-state—.
 *
 * Sin valor ⇒ `<dataDir>/qr.png`. Un `--qr-png=` vacío se trata como sin valor:
 * quedarse con `""` sería escribir en el directorio actual.
 */
function rutaQrPng(args: string[], dataDir: string): string | null {
  const PREFIJO = "--qr-png=";
  const arg = args.find((a) => a === "--qr-png" || a.startsWith(PREFIJO));
  if (arg === undefined) return null;
  const valor = arg.startsWith(PREFIJO) ? arg.slice(PREFIJO.length).trim() : "";
  return valor === "" ? `${dataDir}/qr.png` : valor;
}

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
  --qr-png[=RUTA]  además de dibujarlo, escribe cada QR de vinculación como PNG
                   (por defecto ${paths.dataDir}/qr.png, permisos 0600).
                   Sirve cuando el QR no entra en la terminal: lo abrís con un
                   visor de imágenes y escaneás desde ahí, sin salir de wacosas
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
const qrPngPath = rutaQrPng(argv, paths.dataDir);

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

createRoot(renderer).render(<App noSplash={noSplash} logPath={paths.logPath} qrPngPath={qrPngPath} />);
log.info("boot.render", { splash: !noSplash, ms: Math.round(performance.now()) });

// ── `--qr-png`: cada QR también como PNG ────────────────────────────────────
// Se engancha al store y no al socket: el payload ya viaja por el slice `link`
// (lo publica `wa/socket.ts` en cada `wa.qr`), así que esto es un OYENTE más y
// el ciclo de vida de la conexión no se entera. La rotación pisa el archivo:
// hay un solo QR vigente por vez, igual que en pantalla (CA-1.6).
//
// Nunca puede voltear la app (ni la vinculación): si el `toFile` falla —disco
// lleno, permisos, ruta inventada— queda una línea en el log y el QR se sigue
// escaneando de la pantalla. Por eso el `catch` no re-lanza y no hay `await`.
if (qrPngPath) {
  const QRCode = (await import("qrcode")).default;
  const { chmodSync } = await import("node:fs");
  /** El último payload escrito: sin esto cada flush del slice reescribiría el PNG. */
  let ultimo: string | null = null;

  store.subscribe("link", () => {
    const qr = store.getSnapshot("link").qr;
    if (qr === null || qr === ultimo) return;
    ultimo = qr;
    QRCode.toFile(qrPngPath, qr, { width: 512, margin: 2 })
      .then(() => {
        // El `umask(0o077)` ya lo hace nacer 0600; el `chmod` es para el archivo
        // que quedó de una corrida anterior con permisos laxos (mismo criterio
        // que `hardenCreds`). Un QR es la llave para vincular un dispositivo.
        try {
          chmodSync(qrPngPath, 0o600);
        } catch {
          /* el archivo está escrito: no poder endurecerlo no lo invalida */
        }
        // El payload NO se loguea (CA-14.7): sólo dónde quedó y cuánto medía.
        log.info("qr.png", { path: qrPngPath, largo: qr.length });
      })
      .catch((e: unknown) => {
        log.warn("qr.png_fallido", {
          path: qrPngPath,
          motivo: e instanceof Error ? e.message : String(e),
        });
      });
  });
}

// ── máquina (después del render: baileys tarda en cargar) ────────────────────
const { createIngest } = await import("./wa/ingest");
const { createSendQueue } = await import("./wa/send");
const { createWaController } = await import("./wa/socket");

let wa: import("./wa/socket").WaController;
const ingest = createIngest({
  repo,
  store,
  log,
  selfJid: () => wa?.selfJid() ?? "",
  openChatJid: () => store.openChatJid(),
});
// La cola de envío y el controlador se necesitan MUTUAMENTE (la cola le pide el
// socket; el socket le pide el `getMessage` de §8.6), así que la cola lo lee a
// través de funciones —el mismo patrón que ya usa el ingest con `selfJid`— y no
// se queda con una referencia que todavía no existe.
const send = createSendQueue({
  repo,
  store,
  log,
  wa: {
    isOpen: () => wa?.isOpen() ?? false,
    socket: () => wa?.socket() ?? null,
    selfJid: () => wa?.selfJid() ?? "",
  },
});
wa = createWaController({
  ingest,
  store,
  log,
  credsDir: paths.credsDir,
  getMessage: send.getMessage,
});

configureCommands({ repo, wa, store, log, send, shutdown });

log.info("boot.listo", { version, db: paths.dbPath, ms: Math.round(performance.now()) });
wa.start();
