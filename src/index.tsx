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
//   · el `lock` (instancia única, CA-18.*) va entre los args y la base: una
//     segunda instancia tiene que morir SIN haber abierto la base ni tocado
//     `creds/`, y sin haberle robado la pantalla a la que ya está corriendo.
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

// ── instancia única (CA-18.*) ───────────────────────────────────────────────
// Va acá y no más abajo a propósito: la segunda instancia tiene que salir SIN
// abrir la base, sin tocar `creds/` y sin conectarse a WhatsApp (CA-18.2). Y va
// después de `--version`/`--help`, que son preguntas y no una sesión.
//
// El aviso sale por `console.log` (fd 1) y no por `console.error`: el fd 2 ya
// está apuntando al archivo de log (D9), así que un `error` acá sería invisible.
const { acquireLock } = await import("./boot/lock");
const tomado = acquireLock(paths.lockPath);
if (!tomado.ok) {
  console.log(
    `wacosas ya está corriendo en este directorio (pid ${tomado.ajena.pid}). ` +
      `Cerrá esa instancia, o usá otro XDG_DATA_HOME.`,
  );
  log.warn("boot.instancia_tomada", { pid: tomado.ajena.pid, lock: paths.lockPath });
  // 3 = "hay otra instancia". Distinto de 0 (CA-18.2) y distinto del 2 de la
  // base corrupta, para que un script pueda diferenciarlos.
  process.exit(3);
}
const lock = tomado.lock;
if (tomado.aviso) {
  // No se pudo escribir el pidfile (directorio de sólo lectura, por ejemplo). Se
  // arranca igual —quedarse sin app es peor que el riesgo de dos instancias—,
  // pero queda dicho en el log.
  log.warn("boot.lock_sin_marca", { lock: paths.lockPath, motivo: tomado.aviso });
}

// ── renderer ────────────────────────────────────────────────────────────────
// `exitOnCtrlC:false` + `exitSignals:[]`: la salida la maneja la app (CA-17.1),
// no el renderer. Sin esto, `Ctrl-C` mataría el proceso salteándose el cierre
// ordenado (drenar el ingest, cerrar la base) que arma la tarea 17.
//
// `autoFocus:false`: el foco lo decide la app (la prop `focused` del buscador y
// del campo de redacción), NUNCA el mouse. Con el default `true`, cualquier
// click izquierdo hace que OpenTUI camine hacia arriba buscando el primer
// ancestro focusable y lo enfoque (`dispatchMouseEvent`); el `<scrollbox>` de la
// conversación **es** focusable, así que clickear un mensaje le sacaba el foco al
// buscador de la bandeja y al campo de redacción —el pie seguía diciendo
// `⏎ enviar` con el campo muerto, y recuperarlo era `Esc` y después `Ctrl-E`,
// porque en modo `compose` el handler global no maneja nada más que la salida—.
// Apagarlo no saca nada: `focused` sigue funcionando igual, y el click en la
// bandeja (seleccionar / abrir con doble click, CA-5.6) es un handler propio.
const { createCliRenderer } = await import("@opentui/core");
const { createRoot } = await import("@opentui/react");

async function montarRenderer() {
  return createCliRenderer({ exitOnCtrlC: false, exitSignals: [], autoFocus: false });
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
        // La marca de instancia única se suelta también por este camino (CA-18.4):
        // si no, una base corrupta dejaría el pidfile puesto hasta el próximo
        // arranque —que lo vería huérfano y lo pisaría, pero recién ahí—.
        lock.release();
        process.exit(2);
      }}
    />,
  );
  // El módulo NO sigue: la pantalla vive hasta que el usuario aprieta una tecla.
  await new Promise<never>(() => {});
}

// `config.json` (R3: sin pantalla de ajustes, se edita a mano). Se lee acá —una
// vez, antes de la interfaz— porque lo único que hay adentro es `readReceipts`,
// y de eso depende si el recibo de lectura sale o no (CA-11.3).
const { loadConfig } = await import("./boot/config");
const config = loadConfig(paths.configPath, log);

// El código que revela los chats con candado (`Ctrl-P`). Se arma acá, con el
// resto de los archivos del `dataDir`: adentro no hay nada del socket ni de la
// base, sólo `node:crypto` y un archivo 0600.
const { createLockCode } = await import("./boot/lockcode");
const lockCode = createLockCode(paths.lockCodePath, log);

const { createRepo } = await import("./db/repo");
const { store } = await import("./state/store");

const repo = createRepo(db!);
// Sincrónico: llena inbox+conn antes del primer frame (CA-13.1).
store.bootstrap(repo);

// ── interfaz ────────────────────────────────────────────────────────────────
const renderer = await montarRenderer();

// ── cierre ordenado (§6.6, CA-17.*) ─────────────────────────────────────────
// Se arma ACÁ, antes de la máquina, porque desde este punto ya hay una terminal
// en la pantalla alternativa: si algo explota mientras carga baileys, el camino
// de salida tiene que existir para devolverle el prompt al usuario.
//
// La máquina (ingest, cola de envío, socket, app-state, identidades) viaja en una
// caja que se llena MÁS ABAJO, cuando esas cinco piezas existen: un `Ctrl-C` en
// el medio de la carga de baileys tiene que poder cerrar igual, y cada paso del
// cierre se saltea solo si su pieza todavía no está.
const { createShutdown, cerrarEnviosAbiertos, MOTIVO_CAIDA } = await import("./boot/shutdown");
const maquina: import("./boot/shutdown").Maquina = {};

const shutdown = createShutdown({
  log,
  store,
  repo,
  renderer,
  lock,
  maquina: () => maquina,
});

// Envíos que dejó a medias un proceso que murió de golpe (`kill -9`, un corte de
// luz): la cola es de memoria (D8), así que nadie los va a volver a tomar y sin
// esto se quedarían en `⏳ enviando` para siempre. Pasan a `⚠ falló` con motivo y
// el usuario decide con `Ctrl-Y` (CA-9.3). Corre antes de que se pueda abrir un
// chat, que es la única pantalla donde se ve el estado de un mensaje propio.
cerrarEnviosAbiertos(repo, MOTIVO_CAIDA, log);

// CA-17.5. El renderer se crea con `exitSignals: []`, así que estos son los
// ÚNICOS handlers de señal del proceso: sin ellos, cerrar la pane de tmux mata a
// wacosas sin drenar la cola ni cerrar la base.
for (const senal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(senal, () => shutdown(0, senal));
}

// Un error que nadie atrapó no puede dejar la terminal en la pantalla alternativa
// y sin cursor: se loguea y se cierra por el mismo camino, con código 1.
process.on("uncaughtException", (e: unknown) => {
  log.error("app.excepcion", { motivo: e instanceof Error ? e.message : String(e) });
  shutdown(1, "uncaughtException");
});
process.on("unhandledRejection", (e: unknown) => {
  log.error("app.rechazo", { motivo: e instanceof Error ? e.message : String(e) });
  shutdown(1, "unhandledRejection");
});

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
const { createAppStateSync, META_SYNC_REPARADO } = await import("./wa/appstate");
const { createIdentityResolver } = await import("./wa/identity");
const { createAvatars } = await import("./wa/avatars");
const { createIngest } = await import("./wa/ingest");
const { createMediaStore } = await import("./wa/media");
const { createReadReceipts } = await import("./wa/read");
const { createSendQueue } = await import("./wa/send");
const { createWaController } = await import("./wa/socket");

let wa: import("./wa/socket").WaController;
// El rescate de nombres por identidad doble (LID ↔ número). Se lee por función,
// igual que `wa`: el ingest lo necesita como hook y el resolver necesita la cola
// del ingest, así que uno de los dos tiene que existir después del otro.
let identity: import("./wa/identity").IdentityResolver;
// La reparación de app-state, declarada ACÁ ARRIBA por el mismo motivo: el
// controlador le pasa los avisos de baileys (de ahí sale qué colección quedó
// estacionada) y se arma después, cuando ya existe el socket que consulta.
let appstate: import("./wa/appstate").AppStateSync;
// Los recibos van PRIMERO porque el ingest los necesita como hook (§6.2). Lee el
// socket por función, igual que la cola de envío: acá el controlador todavía no
// existe (se necesitan mutuamente).
const read = createReadReceipts({
  repo,
  log,
  wa: {
    isOpen: () => wa?.isOpen() ?? false,
    socket: () => wa?.socket() ?? null,
  },
  enabled: config.readReceipts,
});
const ingest = createIngest({
  repo,
  store,
  log,
  selfJid: () => wa?.selfJid() ?? "",
  openChatJid: () => store.openChatJid(),
  // Último recurso para el nombre de un grupo que apareció por un mensaje en
  // vivo (el ingest se encarga de pedirlo una sola vez y de no bloquear). Se lee
  // por función, como `selfJid`: cuando esto se define el controlador todavía no
  // existe. Sin socket devuelve "" y el grupo queda como estaba.
  groupSubject: async (jid) => (await wa?.socket()?.groupMetadata(jid))?.subject ?? "",
  // CA-11.7: los mensajes que entran al chat abierto nunca figuran sin leer, así
  // que su recibo no sale de `markRead` — lo manda el ingest (§6.2).
  pushReadReceipt: read.pushReadReceipt,
  // Identidades `@lid` con nombre y sin número conocido: las resuelve
  // `wa/identity.ts` contra el store de baileys (consulta LOCAL) y el par vuelve
  // por la cola del ingest.
  requestAlias: (lids) => identity?.request(lids),
});
identity = createIdentityResolver({
  repo,
  log,
  push: ingest.push,
  // `getPNsForLIDs` lee la caché y los archivos de `creds/`: NO manda ninguna
  // stanza a WhatsApp (`Signal/lid-mapping.js`). Sin socket todavía, devuelve
  // vacío y la identidad se rescata en la próxima corrida.
  pnForLids: async (lids) => (await wa?.socket()?.signalRepository?.lidMapping?.getPNsForLIDs(lids)) ?? [],
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
  // El único camino por el que se sabe que una colección de app-state quedó
  // estacionada: baileys lo dice en un `warn` y no lo publica en ningún lado
  // (ver `wa/appstate.ts`). Se lee por función porque `appstate` se arma abajo;
  // hasta entonces no hay socket, así que tampoco hay avisos.
  onAviso: (texto) => appstate?.onAviso(texto),
  // Se borraron las credenciales ⇒ empieza otra sesión, con su
  // `accountSyncCounter` en 0. La marca de "el sync completo ya se reparó" era
  // de la sesión anterior: si la nueva vuelve a caer en el mismo agujero (el
  // timeout de 20 s con muchos chats), la reparación tiene que poder correr.
  onCredsWiped: () => repo.setMeta(META_SYNC_REPARADO, ""),
});

// La reparación de app-state: las colecciones de las que salen los NOMBRES de la
// agenda. `resyncAppState` y el estado local viven los dos colgados del socket,
// así que se leen por función igual que en `identity`. Sin socket no hay nada que
// reparar: el chequeo corre 30 s DESPUÉS de abrir y ahí el socket está.
appstate = createAppStateSync({
  log,
  localState: async (names) =>
    (await wa?.socket()?.authState?.keys?.get("app-state-sync-version", names as string[])) ?? {},
  resync: async (names, isInitialSync) => {
    const sock = wa?.socket();
    if (!sock) throw new Error("no hay conexión con WhatsApp");
    await sock.resyncAppState(names, isInitialSync);
  },
  // La reparación de fondo: volver a habilitar la sincronización inicial de
  // baileys poniendo `accountSyncCounter` en 0 (ver `wa/appstate.ts`). La marca
  // de "ya se intentó" va en `meta` —en la base, no en `creds/`— para que
  // sobreviva al proceso: si no, cada arranque con la agenda incompleta sería
  // una reconexión más contra WhatsApp. La limpia el borrado de credenciales
  // (ver `onCredsWiped` más abajo), que es cuando empieza otra sesión.
  // Borra el `app-state-sync-version-<colección>.json` de `creds/` (el key store
  // de baileys borra el archivo cuando el valor es `null`,
  // `Utils/use-multi-file-auth-state.js:105`). Es lo que hace que la colección
  // trabada se pida con el SNAPSHOT completo en vez de con los parches que no se
  // pueden descifrar. No toca la base ni el resto de las credenciales.
  resetLocalState: async (names) => {
    const keys = wa?.socket()?.authState?.keys;
    if (!keys) throw new Error("no hay conexión con WhatsApp");
    await keys.set({
      "app-state-sync-version": Object.fromEntries(names.map((n) => [n, null])),
    } as never);
  },
  syncCounter: () => wa?.syncCounter() ?? null,
  resetSyncCounter: async () => (await wa?.resetSyncCounter()) ?? false,
  reconnect: () => wa?.reconnectNow(),
  yaReparado: () => !!repo.getMeta(META_SYNC_REPARADO),
  marcarReparado: () => repo.setMeta(META_SYNC_REPARADO, String(Math.floor(Date.now() / 1000))),
  toast: (texto) => store.toast(texto),
});

// El barrido de identidades arranca cuando la conexión ABRE, no antes: el store
// de baileys vive colgado del socket. Se engancha al store —igual que `--qr-png`—
// para no meterle otra responsabilidad al ciclo de vida de la conexión, y sólo
// dispara en el FLANCO (de cerrado a abierto): el slice se flushea seguido y
// barrer en cada flush sería leer la base de gusto.
let conexionAbierta = false;
store.subscribe("conn", () => {
  const abierta = store.getSnapshot("conn").state === "open";
  if (abierta === conexionAbierta) return;
  conexionAbierta = abierta;
  if (abierta) {
    identity.sweep();
    appstate.onOpen();
  }
});

// Las imágenes recibidas (`^O`). NO cuelga del socket: bajar del CDN de WhatsApp
// es un `fetch` con la clave del mensaje, sin sesión, así que una foto se puede
// mirar aunque la conexión esté caída (ver `wa/media.ts`).
const media = createMediaStore({ dir: paths.mediaDir, log });

// El color de cada chat en la bandeja (el promedio de su foto de perfil). ⚠️ Es
// lo ÚNICO de la aplicación que consulta a WhatsApp sin que el usuario apriete
// nada, así que el cuidado está adentro: sólo las filas que se ven, una consulta
// por chat en toda la vida (queda en `avatars/`) y espaciadas de a una por
// segundo. Ver el encabezado de `wa/avatars.ts`.
const avatars = createAvatars({
  dir: paths.avatarsDir,
  log,
  urlDe: async (jid) => {
    try {
      // `preview` es la miniatura: unos KB, no la foto entera.
      return (await wa?.socket()?.profilePictureUrl(jid, "preview", 10_000)) ?? null;
    } catch {
      // Sin foto, sin permiso para verla o sin conexión: no hay nada que avisar.
      return null;
    }
  },
  publicar: (jid, color) => store.setAvatar(jid, color),
});

// Recién ahora el cierre ordenado tiene a quién pararle la mano (§6.6, paso 2).
// Hasta esta línea `Ctrl-C` cerraba igual, pero sin drenar ni parar nada: no
// había nada corriendo.
Object.assign(maquina, { ingest, send, wa, appstate, identity, avatars });

configureCommands({ repo, wa, store, log, send, read, appstate, lockCode, media, avatars, shutdown });

log.info("boot.listo", {
  version,
  db: paths.dbPath,
  recibos: config.readReceipts,
  ms: Math.round(performance.now()),
});
wa.start();
