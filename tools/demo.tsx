// Arnés de captura de la tarea 13: monta la TUI real con una base SEMBRADA a
// mano (un chat de 900 mensajes, adjuntos, un revoke, un grupo) y la sesión
// marcada como vinculada. NO abre ningún socket ni toca la cuenta real.
//
//   WACOSAS_DEMO_OPEN=<jid>    abre ese chat al arrancar
//   WACOSAS_DEMO_ANCHOR=<id>   lo abre ANCLADO a ese mensaje (como el salto de
//                              la búsqueda global, CA-12.3)
//
//   kill -USR2 <pid>  ⇒ entra un mensaje nuevo al chat abierto (como el ingest)
//   kill -USR1 <pid>  ⇒ reabre el chat abierto anclado a un mensaje viejo
const RAIZ = "/home/gon/projects/wacosas";

const { openDb } = await import(`${RAIZ}/src/db/open.ts`);
const { createRepo } = await import(`${RAIZ}/src/db/repo.ts`);
const { seedDb } = await import(`${RAIZ}/test/fixtures/seed.ts`);
const { store } = await import(`${RAIZ}/src/state/store.ts`);
const { commands, configureCommands } = await import(`${RAIZ}/src/state/commands.ts`);
const { App } = await import(`${RAIZ}/src/ui/App.tsx`);
const { createCliRenderer } = await import("@opentui/core");
const { createRoot } = await import("@opentui/react");

const ruta = process.env.WACOSAS_DEMO_DB ?? "/tmp/wacosas-demo13.sqlite";
const db = openDb(ruta);
const ahora = Math.floor(Date.now() / 1000);

const ANTO = "549115000001@s.whatsapp.net";
const GRUPO = "120000999-1600000000@g.us";

if (process.env.WACOSAS_DEMO_SEED !== "0") {
  seedDb(db, { chats: 12, messages: 300, desde: ahora - 86_400 * 40 });

  const chat = (jid: string, nombre: string, grupo: number, hace: number, prev: string, unread: number) =>
    db.run(
      `INSERT OR REPLACE INTO chats (jid, name, is_group, last_message_at, last_preview, unread_count)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [jid, nombre, grupo, ahora - hace, prev, unread],
    );

  chat(ANTO, "anto 🌻", 0, 60, "dale, nos vemos", 0);
  chat(GRUPO, "Grupo mañana", 1, 900, "quedamos 8am", 3);
  db.run(
    `INSERT OR REPLACE INTO contacts (jid, name, phone) VALUES (?, 'Antonella', '549115000001')`,
    [ANTO],
  );

  const ins = db.query(
    `INSERT INTO messages (chat_jid, wa_id, from_me, sender_jid, sender_name, ts, kind, body, attachment, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(chat_jid, wa_id) DO NOTHING`,
  );

  // 900 mensajes en el chat 1:1 (más de la ventana de 500), alternando propios y
  // ajenos, con el último tramo pegado a "ahora" para que se vea la hora.
  db.transaction(() => {
    for (let i = 0; i < 900; i++) {
      const propio = i % 3 === 0;
      ins.run(
        ANTO,
        `A${i}`,
        propio ? 1 : 0,
        propio ? "self@s.whatsapp.net" : ANTO,
        propio ? "yo" : "anto 🌻",
        ahora - (900 - i) * 60,
        "text",
        propio ? `mensaje propio número ${i}` : `mensaje de ella número ${i}`,
        null,
        propio ? (i % 9 === 0 ? "read" : "delivered") : "received",
      );
    }
    // Los últimos: adjuntos, revoke y tipo desconocido (CA-6.9, CA-7.1/7.2/7.5).
    const extras: Array<[number, string, string, string, string | null, string]> = [
      [0, "image", "mirá lo que encontré en la feria", "📷 imagen", null, "received"],
      [1, "audio", "", "🎤 audio 0:12", null, "received"],
      [2, "document", "", "📎 presupuesto-agosto.pdf", null, "received"],
      [3, "text", "este lo borro en un segundo", "", null, "received"],
      [4, "sticker", "", "🩹 sticker", null, "received"],
      [5, "location", "", "📍 ubicación", null, "received"],
      [6, "unsupported", "", "", null, "received"],
      [7, "video", "el video del sábado", "🎬 video 1:07", null, "received"],
      [8, "text", "dale, nos vemos", "", null, "read"],
    ];
    extras.forEach(([k, kind, body, label, _x, status], n) => {
      ins.run(
        ANTO,
        `X${k}`,
        status === "read" ? 1 : 0,
        status === "read" ? "self@s.whatsapp.net" : ANTO,
        status === "read" ? "yo" : "anto 🌻",
        ahora - 60 * (9 - n),
        kind,
        body,
        label ? JSON.stringify({ label }) : null,
        status,
      );
    });
    // El revoke: se aplica como lo haría el ingest (UPDATE, no INSERT).
    db.run("UPDATE messages SET kind='revoked', body='', attachment=NULL WHERE chat_jid=? AND wa_id='X3'", [
      ANTO,
    ]);

    // Un grupo con tres voces distintas (CA-6.3).
    const voces = ["Meli", "Jorge", "Sofi"];
    for (let i = 0; i < 12; i++) {
      const propio = i % 4 === 3;
      ins.run(
        GRUPO,
        `G${i}`,
        propio ? 1 : 0,
        propio ? "self@s.whatsapp.net" : `54911600000${i % 3}@s.whatsapp.net`,
        propio ? "yo" : voces[i % 3],
        ahora - (12 - i) * 300,
        "text",
        propio ? "yo llevo la camioneta" : "quedamos 8am en la esquina, no lleguen tarde",
        null,
        propio ? "delivered" : "received",
      );
    }
  })();
}

const repo = createRepo(db);
store.bootstrap(repo);
store.setLink({ phase: "linked", qr: null, pairingCode: null, reason: null });
store.setConn({ state: "open" });

const renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [] });
const log = { info() {}, warn() {}, error() {}, path: "/tmp/wacosas-demo13.log" };

// ── envío (tarea 14) ────────────────────────────────────────────────────────
// La cola de envío REAL contra un socket FALSO: ⚠️ la cuenta de Gon está
// vinculada, así que un envío de prueba le llegaría a alguien de verdad. El
// doble anota lo que "manda" y responde como WhatsApp (misma key, mismo id), así
// el camino completo —fila optimista `⏳`, rate limit, `✓`— se ve en pantalla sin
// tocar la red.
//
//   WACOSAS_DEMO_OFFLINE=1  ⇒ la conexión figura cerrada (CA-8.7)
const { createSendQueue } = await import(`${RAIZ}/src/wa/send.ts`);
const offline = process.env.WACOSAS_DEMO_OFFLINE === "1";
if (offline) store.setConn({ state: "reconnecting", attempt: 1 });

const sockFalso = {
  async sendMessage(jid: string, contenido: { text: string }, opts: { messageId: string }) {
    return {
      key: { id: opts.messageId, remoteJid: jid, fromMe: true },
      message: { conversation: contenido.text },
    };
  },
};
const send = createSendQueue({
  repo,
  store,
  log: log as never,
  wa: {
    isOpen: () => !offline,
    socket: () => (offline ? null : (sockFalso as never)),
    selfJid: () => "5491133445566:12@s.whatsapp.net",
  },
});

configureCommands({
  repo,
  wa: { reconnectNow() {}, async requestPairingCode() {} } as never,
  store,
  log: log as never,
  send,
  shutdown(code = 0) {
    try {
      renderer.destroy();
    } catch {}
    process.exit(code);
  },
});

const abrir = process.env.WACOSAS_DEMO_OPEN;
if (abrir) {
  const ancla = process.env.WACOSAS_DEMO_ANCHOR;
  commands.openChat(abrir, ancla ? { anchorId: Number(ancla) } : undefined);
}

// Un mensaje entrante al chat abierto, por el mismo camino que el ingest:
// insertar + touchChatActivity + markDirty (§6.2).
let n = 0;
process.on("SIGUSR2", () => {
  const jid = store.openChatJid();
  if (!jid) return;
  n++;
  const ts = Math.floor(Date.now() / 1000);
  repo.tx(() => {
    repo.insertMessage({
      chatJid: jid,
      waId: `NUEVO${process.pid}-${n}`,
      fromMe: false,
      senderJid: jid,
      senderName: "anto 🌻",
      ts,
      kind: "text",
      body: `mensaje inyectado a mano número ${n}`,
      attachment: null,
      status: "received",
    });
    repo.touchChatActivity(jid, ts, `mensaje inyectado a mano número ${n}`, false);
  });
  store.markDirty("inbox", "convo");
});

// El salto de la búsqueda global: reabre el chat anclado a un mensaje viejo.
process.on("SIGUSR1", () => {
  const jid = store.openChatJid();
  if (!jid) return;
  const id = Number(process.env.WACOSAS_DEMO_ANCHOR ?? 0);
  const fila = id > 0 ? id : (repo.lastMessages(jid, 900)[0]?.id ?? 0);
  if (fila > 0) commands.loadWindow(jid, fila);
});

createRoot(renderer).render(<App noSplash logPath="/tmp/wacosas-demo13.log" />);
