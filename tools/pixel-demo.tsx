// Fixture-only app demo: no socket, no credentials, no live WhatsApp data.
// Pass a local photo file; it is reused as both avatar and message image.
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { createPixelTerminal } from "../src/boot/pixels";
import { openDb } from "../src/db/open";
import { createRepo } from "../src/db/repo";
import { commands, configureCommands } from "../src/state/commands";
import { store } from "../src/state/store";
import { App } from "../src/ui/App";

const photo = process.argv[2];
if (!photo) throw Error("Pass a local fixture photo");
const repo = createRepo(openDb(":memory:"));
for (let i = 0; i < 8; i++) {
  const jid = `fixture-${i}@s.whatsapp.net`;
  repo.upsertChat({ jid, name: `Foto demo ${i + 1}`, lastMessageAt: 1700000000 - i, lastPreview: "foto de prueba" });
  for (let j = 0; j < 6; j++) repo.insertMessage({ chatJid: jid, waId: `img-${j}`, fromMe: false, senderJid: jid, senderName: "Fixture", ts: 1700000000 + j, kind: j % 2 ? "text" : "image", body: j % 2 ? "Texto al lado de fotos reales" : "Foto inline sin Ctrl-O", attachment: j % 2 ? null : { label: "📷 imagen", media: { key: "fixture", directPath: "/fixture" } }, status: "received" });
}
store.bootstrap(repo);
store.setLink({ phase: "linked", qr: null, pairingCode: null, reason: null });
store.setConn({ state: "open" });
const renderer = await createCliRenderer({ exitOnCtrlC: false });
const pixels = createPixelTerminal(renderer);
configureCommands({ repo, store, pixels, wa: { isOpen: () => false } as never,
  log: { info() {}, warn() {}, error() {}, path: "/tmp/wacosas-pixel-demo.log" },
  media: { cached: () => photo, ensureImage: async () => ({ ok: true, path: photo }) },
  avatars: { request(jids) { for (const jid of jids) store.setAvatarPhoto(jid, photo); }, stop() {}, consultas: () => 0 },
  shutdown() { pixels.stop(); renderer.destroy(); process.exit(0); },
});
commands.openChat("fixture-0@s.whatsapp.net");
store.flushNow();
createRoot(renderer).render(<App noSplash logPath="/tmp/wacosas-pixel-demo.log" />);
