// Arnés de captura del candado: monta la TUI real con una base SEMBRADA a mano
// —dos chats normales, uno CON CANDADO y un bloqueado— y la sesión marcada como
// vinculada. NO abre ningún socket ni toca la cuenta real.
//
// ⚠️ Nada de acá escribe en `~/.local/share/wacosas/`: la base y el archivo del
// código van a `/tmp` (o a lo que digan las variables de abajo).
//
//   WACOSAS_CANDADO_DB=<ruta>    base de la demo (default /tmp/wacosas-candado.sqlite)
//   WACOSAS_CANDADO_FILE=<ruta>  archivo del código (default /tmp/wacosas-candado.json)
//   WACOSAS_CANDADO_CODE=<dig>   fija ese código de entrada (para saltear el ^P)
//   WACOSAS_CANDADO_OPEN=<jid>   abre ese chat al arrancar
//
//   kill -USR1 <pid>  ⇒ le PONE el candado al chat abierto (como el `chats.lock`
//                       que llega por app-state mientras lo estás leyendo)
//   kill -USR2 <pid>  ⇒ se lo saca
//
// Sirve igual para el ocultamiento A MANO (`^X`): con `WACOSAS_CANDADO_CODE` ya
// hay código fijado y la tecla anda; sin la variable, la demo arranca SIN código
// y `^X` contesta que hay que fijarlo con `^P` primero.
const RAIZ = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const { openDb } = await import(`${RAIZ}/src/db/open.ts`);
const { createRepo } = await import(`${RAIZ}/src/db/repo.ts`);
const { createLockCode } = await import(`${RAIZ}/src/boot/lockcode.ts`);
const { store } = await import(`${RAIZ}/src/state/store.ts`);
const { commands, configureCommands } = await import(`${RAIZ}/src/state/commands.ts`);
const { App } = await import(`${RAIZ}/src/ui/App.tsx`);
const { createCliRenderer } = await import("@opentui/core");
const { createRoot } = await import("@opentui/react");
const { rmSync } = await import("node:fs");

const ruta = process.env.WACOSAS_CANDADO_DB ?? "/tmp/wacosas-candado.sqlite";
const rutaCodigo = process.env.WACOSAS_CANDADO_FILE ?? "/tmp/wacosas-candado.json";
// Base de cero en cada corrida: la demo tiene que verse siempre igual.
for (const f of [ruta, `${ruta}-wal`, `${ruta}-shm`]) rmSync(f, { force: true });

const db = openDb(ruta);
const ahora = Math.floor(Date.now() / 1000);

const ANTO = "549115000001@s.whatsapp.net";
const GRUPO = "120000999-1600000000@g.us";
const CONTADOR = "549115000777@s.whatsapp.net";
const EX = "549115000888@s.whatsapp.net";

const chat = (jid: string, nombre: string, grupo: number, hace: number, prev: string, unread: number) =>
  db.run(
    `INSERT OR REPLACE INTO chats (jid, name, is_group, last_message_at, last_preview, unread_count)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [jid, nombre, grupo, ahora - hace, prev, unread],
  );

chat(ANTO, "anto 🌻", 0, 60, "dale, nos vemos", 0);
chat(GRUPO, "Grupo mañana", 1, 900, "quedamos 8am", 3);
chat(CONTADOR, "Cont. Marisa", 0, 300, "te paso el detalle del monotributo", 2);
chat(EX, "Alguien bloqueado", 0, 4_000, "…", 0);

const ins = db.query(
  `INSERT INTO messages (chat_jid, wa_id, from_me, sender_jid, sender_name, ts, kind, body, attachment, status)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(chat_jid, wa_id) DO NOTHING`,
);
db.transaction(() => {
  const guion: Array<[string, boolean, string, number]> = [
    [CONTADOR, false, "hola! te paso el detalle del monotributo", 600],
    [CONTADOR, true, "buenísimo, gracias", 540],
    [CONTADOR, false, "la categoría te queda igual que el año pasado", 480],
    [CONTADOR, true, "perfecto, ¿te transfiero hoy?", 420],
    [CONTADOR, false, "sí, cuando puedas. te paso el CBU por acá", 360],
    [CONTADOR, false, "0000003100010000000001", 300],
    [ANTO, false, "mirá lo que encontré en la feria", 180],
    [ANTO, true, "dale, nos vemos", 60],
    [GRUPO, false, "quedamos 8am", 900],
  ];
  guion.forEach(([jid, propio, texto, hace], i) => {
    ins.run(
      jid,
      `D${i}`,
      propio ? 1 : 0,
      propio ? "self@s.whatsapp.net" : jid,
      propio ? "yo" : "ella",
      ahora - hace,
      "text",
      texto,
      null,
      propio ? "read" : "received",
    );
  });
})();

const repo = createRepo(db);
// El estado que en la app real llega por WhatsApp: `chats.lock` (app-state) y la
// lista de bloqueados de la conexión.
repo.setLocked(CONTADOR, true);
repo.setBlocked(EX, true);

const lockCode = createLockCode(rutaCodigo);
if (process.env.WACOSAS_CANDADO_CODE) {
  rmSync(rutaCodigo, { force: true });
  lockCode.set(process.env.WACOSAS_CANDADO_CODE);
} else {
  // Primer uso: sin archivo, para que la demo arranque como arranca de verdad.
  rmSync(rutaCodigo, { force: true });
}

store.bootstrap(repo);
store.setLink({ phase: "linked", qr: null, pairingCode: null, reason: null });
store.setConn({ state: "open" });

const renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [], autoFocus: false });
const log = { info() {}, warn() {}, error() {}, path: "/tmp/wacosas-candado.log" };

configureCommands({
  repo,
  wa: { reconnectNow() {}, isOpen: () => true, async requestPairingCode() {} } as never,
  store,
  log: log as never,
  lockCode: createLockCode(rutaCodigo),
  shutdown(code = 0) {
    try {
      renderer.destroy();
    } catch {}
    process.exit(code);
  },
});

const abrir = process.env.WACOSAS_CANDADO_OPEN;
if (abrir) commands.openChat(abrir);

// El candado llegando MIENTRAS el chat está abierto (y el revés).
const candado = (on: boolean) => () => {
  const jid = store.openChatJid();
  if (!jid) return;
  repo.setLocked(jid, on);
  store.markDirty("inbox", "convo");
};
process.on("SIGUSR1", candado(true));
process.on("SIGUSR2", candado(false));

createRoot(renderer).render(<App noSplash logPath="/tmp/wacosas-candado.log" />);
