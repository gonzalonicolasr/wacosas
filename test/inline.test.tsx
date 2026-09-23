import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { openDb } from "../src/db/open";
import { createRepo } from "../src/db/repo";
import { commands, configureCommands } from "../src/state/commands";
import { store } from "../src/state/store";
import { App } from "../src/ui/App";
import { PixelImage } from "../src/ui/PixelImage";

const data = { width: 1, height: 1, rgba: new Uint8Array([255, 0, 0, 255]) };
const placeholder = String.fromCodePoint(0x10eeee);
const log = { info() {}, warn() {}, error() {}, path: "/tmp/wacosas-fixture.log" };

async function frame(t: { renderOnce(): Promise<void> }, wait = 0) {
  await act(async () => { if (wait) await Bun.sleep(wait); store.flushNow(); await t.renderOnce(); });
}

test("app automatically shows real pixel placeholders for visible messages and avatar rows only", async () => {
  const repo = createRepo(openDb(":memory:"));
  const loaded: number[] = [], avatars: string[][] = [];
  const avatarSizes: number[][] = [];
  let placements = 0, releases = 0;
  for (let i = 0; i < 12; i++) {
    const jid = `fixture-${i}@s.whatsapp.net`;
    repo.upsertChat({ jid, name: `Fixture ${i}`, lastMessageAt: 1700000000 - i });
    for (let j = 0; j < 8; j++) repo.insertMessage({ chatJid: jid, waId: `m${j}`, senderJid: jid, senderName: "Fixture", fromMe: false, ts: 1700000000 + j, kind: "image", body: `caption ${j}`, attachment: { label: "📷 imagen" }, status: "received" });
  }
  store.bootstrap(repo);
  store.setLink({ phase: "linked", qr: null, pairingCode: null, reason: null });
  store.setConn({ state: "open" });
  configureCommands({ repo, store, log, wa: { isOpen: () => false } as never,
    pixels: { ready: async () => true, place() { placements++; return { id: 42, color: "#00002a", release() { releases++; } }; }, stop() {} },
    preparePixels: async (path, cols, rows) => {
      if (path === "/fixture/avatar") avatarSizes.push([cols, rows]);
      return { ok: true, data };
    },
    media: { cached: () => null, ensureImage: async msg => { loaded.push(msg.id); return { ok: true, path: `/fixture/${msg.id}` }; } },
    avatars: { request(jids) { avatars.push(jids); for (const jid of jids) store.setAvatarPhoto(jid, "/fixture/avatar"); }, stop() {}, consultas: () => 0 },
    shutdown() {},
  });
  commands.openChat("fixture-0@s.whatsapp.net");
  store.flushNow();
  const t = await testRender(<App noSplash logPath={log.path} />, { width: 100, height: 24 });
  try {
    for (let n = 0; n < 9; n++) await frame(t, 180);
    expect(avatars.some(jids => jids.length > 0)).toBe(true);
    expect(Math.max(...avatars.map(jids => jids.length))).toBeLessThanOrEqual(10);
    expect(avatarSizes.length).toBeGreaterThan(0);
    expect(avatarSizes.every(([cols, rows]) => cols === 2 && rows === 1)).toBe(true);
    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded.length).toBeLessThan(8);
    expect(loaded.every(id => repo.lastMessages("fixture-0@s.whatsapp.net", 2).some(m => m.id === id))).toBe(true);
    expect(t.captureCharFrame()).toContain(placeholder);
    expect(t.captureCharFrame()).toContain("caption 7");
    expect(placements).toBeGreaterThan(0);
    await act(async () => { commands.openChat("fixture-1@s.whatsapp.net"); store.flushNow(); });
    await frame(t);
    expect(releases).toBeGreaterThan(0);
  } finally { t.renderer.destroy(); repo.close(); }
});

test("avatar failures stay compact instead of wrapping an error through the chat row", async () => {
  const repo = createRepo(openDb(":memory:"));
  configureCommands({ repo, store, log, wa: {} as never,
    pixels: { ready: async () => true, place: () => null, stop() {} },
    preparePixels: async () => ({ ok: false, reason: "no se pudo preparar la foto" }), shutdown() {},
  });
  const t = await testRender(<PixelImage source="/fixture/broken" cols={8} rows={4} visible compact fallback="sin foto" />, { width: 20, height: 8 });
  try {
    await frame(t, 40); await frame(t);
    expect(t.captureCharFrame()).toContain("sin foto");
    expect(t.captureCharFrame()).not.toContain("preparar");
    expect(t.captureCharFrame()).not.toContain("no se");
  } finally { t.renderer.destroy(); repo.close(); }
});

test("PixelImage ignores stale completion after unmount and exposes an error fallback", async () => {
  const repo = createRepo(openDb(":memory:"));
  let finish!: (value: { ok: true; data: typeof data }) => void;
  let placements = 0;
  configureCommands({ repo, store, log, wa: {} as never,
    pixels: { ready: async () => true, place() { placements++; return null; }, stop() {} },
    preparePixels: () => new Promise(r => { finish = r; }), shutdown() {},
  });
  const t = await testRender(<PixelImage source="/fixture/slow" cols={8} rows={4} visible />, { width: 20, height: 8 });
  for (let i = 0; i < 20 && !finish; i++) await frame(t, 25);
  expect(typeof finish).toBe("function");
  await act(async () => { t.renderer.destroy(); });
  finish({ ok: true, data });
  await Bun.sleep(20);
  expect(placements).toBe(0);
  configureCommands({ repo, store, log, wa: {} as never, pixels: { ready: async () => false, place: () => null, stop() {} }, shutdown() {} });
  const e = await testRender(<PixelImage source="/fixture/missing" cols={32} rows={4} visible />, { width: 40, height: 8 });
  try { await frame(e, 20); await frame(e); expect(e.captureCharFrame()).toContain("fotos inline no disponibles"); }
  finally { e.renderer.destroy(); repo.close(); }
});
