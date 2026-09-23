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
//
//   WACOSAS_DEMO_RECIBOS=0     recibos de lectura apagados (config.readReceipts)
//   WACOSAS_DEMO_SYNC=<n>      a los 2 s entra un `chats.upsert` del sync de
//                              historial con `unreadCount: n` para el chat
//                              abierto, por el ingest REAL (tarea 15, CA-11.7)
//   WACOSAS_DEMO_ACK=<código>  WhatsApp RECHAZA el primer mensaje que se mande
//                              desde el campo: `messages.update` con
//                              `status: ERROR` y ese código (tarea 15)
const RAIZ = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

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

  chat(ANTO, "caro 🌻", 0, 60, "dale, nos vemos", 0);
  chat(GRUPO, "Grupo mañana", 1, 900, "quedamos 8am", 3);
  db.run(
    `INSERT OR REPLACE INTO contacts (jid, name, phone) VALUES (?, 'Carolina', '549115000001')`,
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
        propio ? "yo" : "caro 🌻",
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
        status === "read" ? "yo" : "caro 🌻",
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

    // ── imágenes con referencia (`^O`) ──────────────────────────────────────
    // Tres fotos: dos con `attachment.media` —o sea bajables, como las que
    // llegan de WhatsApp desde esta versión— y la de arriba (`X0`) SIN
    // referencia, que es como quedó todo el historial anterior. Así la pantalla
    // de imágenes muestra los dos casos, el que anda y el que explica por qué no.
    const fotos: Array<[string, string, string]> = [
      ["IMG1", "mirá el atardecer de ayer", "foto1"],
      ["IMG2", "", "foto2"],
    ];
    fotos.forEach(([waId, caption, archivo], n) => {
      ins.run(
        ANTO,
        waId,
        0,
        ANTO,
        "caro 🌻",
        // Las más NUEVAS del chat: así `^O` abre directo en una que se puede
        // ver, y la que quedó sin referencia (`X0`) está una a la derecha.
        ahora - 20 * (2 - n),
        "image",
        caption,
        JSON.stringify({
          label: "📷 imagen",
          mimetype: "image/png",
          // La referencia REAL tiene la clave en base64; acá el `directPath` es
          // el nombre del archivo de juguete que va a leer el `descargar`
          // inyectado más abajo (nunca sale a internet).
          media: { key: "ZGVtbw==", directPath: `/${archivo}`, bytes: 1024 },
        }),
        "received",
      );
    });

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

// `autoFocus:false` espejado de `src/index.tsx` (tarea 14): con el default, un
// click izquierdo enfoca el primer ancestro focusable —el `<scrollbox>` de la
// conversación—, y el buscador de la bandeja y el campo de redacción se quedan
// mudos. Sin esta línea la demo muestra el bug que la aplicación ya no tiene.
const renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [], autoFocus: false });
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

// ── leído (tarea 15) ────────────────────────────────────────────────────────
// Los recibos REALES contra un socket FALSO: ⚠️ un recibo de lectura lo VE la
// otra persona, así que acá no puede haber socket de verdad ni de casualidad. Lo
// que "sale" se escribe en un archivo para poder mirarlo desde afuera.
const { createReadReceipts } = await import(`${RAIZ}/src/wa/read.ts`);
const RUTA_RECIBOS = process.env.WACOSAS_DEMO_RECIBOS_LOG ?? "/tmp/wacosas-demo15-recibos.log";
const { appendFileSync } = await import("node:fs");

const sockLeido = {
  async readMessages(keys: Array<{ remoteJid: string; id: string; participant?: string }>) {
    appendFileSync(
      RUTA_RECIBOS,
      `readMessages ${keys.length} claves · chat=${keys[0]?.remoteJid} ids=${keys
        .map((k) => k.id)
        .join(",")}\n`,
    );
  },
};
const read = createReadReceipts({
  repo,
  log: log as never,
  wa: { isOpen: () => !offline, socket: () => (offline ? null : (sockLeido as never)) },
  enabled: process.env.WACOSAS_DEMO_RECIBOS !== "0",
});

// ── imágenes recibidas (`^O`) ───────────────────────────────────────────────
// El `MediaStore` REAL —con su caché en disco, sus permisos 0600, su tope de
// tamaño y su timeout— contra un "CDN" falso: ⚠️ acá no puede haber una descarga
// de verdad, porque las claves de la base de juguete no son de nadie. `descargar`
// devuelve el stream de un PNG local, así que el camino completo (bajar →
// guardar → chafa → pintar) se ve en pantalla sin tocar la red.
const { createMediaStore } = await import(`${RAIZ}/src/wa/media.ts`);
const { createReadStream } = await import("node:fs");
const DIR_MEDIA = process.env.WACOSAS_DEMO_MEDIA ?? "/tmp/wacosas-demo-media";
const FOTOS = process.env.WACOSAS_DEMO_FOTOS ?? "/tmp/wacosas-demo-fotos";

const media = createMediaStore({
  dir: DIR_MEDIA,
  log: log as never,
  descargar: async (ref: { directPath?: string; url?: string }) => {
    const nombre = (ref.directPath ?? ref.url ?? "").replace(/^\//, "");
    return createReadStream(`${FOTOS}/${nombre}.png`) as never;
  },
});

// ── fotos de perfil de la bandeja ───────────────────────────────────────────
// La cola REAL —con su caché en disco, su espaciado y su tope— contra un
// WhatsApp falso: ⚠️ acá no se le puede preguntar nada a WhatsApp, así que
// `urlDe` devuelve un `file://` de una foto de juguete (una por chat, rotando).
// Con `WACOSAS_DEMO_AVATARES=0` no hay fotos y la bandeja se ve como antes.
const { createAvatars } = await import(`${RAIZ}/src/wa/avatars.ts`);
const DIR_AVATARES = process.env.WACOSAS_DEMO_AVATARES_CACHE ?? "/tmp/wacosas-demo-avatares-cache";
const FOTOS_PERFIL = process.env.WACOSAS_DEMO_AVATARES_SRC ?? "/tmp/wacosas-demo-avatares";
const conAvatares = process.env.WACOSAS_DEMO_AVATARES !== "0";

const avatares = createAvatars({
  dir: DIR_AVATARES,
  log: log as never,
  // Sin espera entre pedidos: acá no hay a quién cuidarle el ritmo y una demo
  // que tarda 19 segundos en pintarse no se puede capturar.
  schedule: (fn: () => void) => {
    const t = setTimeout(fn, 0);
    return () => clearTimeout(t);
  },
  urlDe: async (jid: string) => {
    if (!conAvatares) return null;
    // Un jid de cada seis se queda SIN foto, para ver los dos casos en la misma
    // captura (el glifo teñido y el de siempre).
    const n = [...jid].reduce((a, c) => a + c.charCodeAt(0), 0);
    if (n % 6 === 0) return null;
    return `${FOTOS_PERFIL}/av${(n % 12) + 1}.jpg`;
  },
  bajar: async (ruta: string) => {
    const { readFileSync, existsSync } = await import("node:fs");
    return existsSync(ruta) ? new Uint8Array(readFileSync(ruta)) : null;
  },
  publicar: (jid: string, color: string | null) => store.setAvatar(jid, color),
});

configureCommands({
  repo,
  wa: { reconnectNow() {}, async requestPairingCode() {} } as never,
  store,
  log: log as never,
  send,
  read,
  media,
  avatars: avatares,
  // El renderer REAL: `⏎` sobre una imagen lo SUSPENDE, dibuja con el protocolo
  // gráfico de la terminal y lo reanuda (`boot/grafica.ts`). Va acá porque es lo
  // único de esta pantalla que no se puede mirar con `testRender` —depende de
  // una terminal de verdad—, así que la demo es el arnés donde se verifica.
  renderer,
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

// ── el ingest REAL, para los dos escenarios de la tarea 15 ──────────────────
const { createIngest } = await import(`${RAIZ}/src/wa/ingest.ts`);
const ingest = createIngest({
  repo,
  store,
  log: log as never,
  selfJid: () => "5491133445566:12@s.whatsapp.net",
  openChatJid: () => store.openChatJid(),
  pushReadReceipt: read.pushReadReceipt,
});

// El sync de historial entrando con el chat ABIERTO (CA-11.7, punto 4 del ⚠️ de
// la tarea 15): el `unreadCount` del `chats.upsert` es el ABSOLUTO del servidor,
// que no sabe que lo estás mirando.
const sync = Number(process.env.WACOSAS_DEMO_SYNC ?? 0);
if (sync > 0) {
  setTimeout(() => {
    const jid = store.openChatJid() ?? ANTO;
    ingest.push({
      kind: "chats",
      chats: [{ id: jid, unreadCount: sync, conversationTimestamp: ahora }] as never,
    });
  }, 2_000);
}

// El ERROR ack: WhatsApp acusa la stanza y la RECHAZA. Llega siempre DESPUÉS del
// `sent` (`relayMessage` vuelve apenas manda), así que se espera a que aparezca
// un mensaje propio en `sent` en vez de dispararlo por reloj.
const ack = process.env.WACOSAS_DEMO_ACK;
if (ack) {
  const { proto } = await import("baileys");
  const buscar = setInterval(() => {
    const jid = store.openChatJid();
    if (!jid) return;
    const fila = repo.lastMessages(jid, 20).find((m) => m.fromMe && m.status === "sent");
    if (!fila) return;
    clearInterval(buscar);
    ingest.push({
      kind: "msg-updates",
      updates: [
        {
          key: { remoteJid: jid, id: fila.waId, fromMe: true },
          update: {
            status: proto.WebMessageInfo.Status.ERROR,
            messageStubParameters: [ack],
          },
        },
      ] as never,
    });
  }, 300);
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
      senderName: "caro 🌻",
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
