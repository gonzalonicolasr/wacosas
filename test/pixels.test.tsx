import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import { createPixelTerminal, parsePixelData, pixelRows, preparePixels } from "../src/boot/pixels";
import type { ScrollBoxRenderable } from "@opentui/core";

const pixel = { width: 1, height: 1, rgba: new Uint8Array([255, 0, 0, 255]) };
test("Kitty parser accepts bounded RGBA, rejects truncated/invalid payload, never relays commands", () => {
  expect(parsePixelData("\x1b[2J\x1b_Ga=T,f=32,s=1,v=1; /wAA/w==\x1b\\").ok).toBe(false);
  expect(parsePixelData("\x1b[2J\x1b_Ga=T,f=32,s=1,v=1;/wAA/w==\x1b\\")).toEqual({ ok: true, data: pixel });
  expect(parsePixelData("\x1b_Gf=32,s=10000,v=1;AAAA\x1b\\").ok).toBe(false);
  expect(parsePixelData("\x1b_Gf=32,s=2,v=1;AAAA\x1b\\").ok).toBe(false);
});

test("virtual placement transport probes actual response, chunks, bounds and deletes owned IDs", async () => {
  const writes: string[] = [];
  let handler: ((s: string) => boolean) | undefined;
  const renderer = { isDestroyed: false, rendererPtr: 1, nextRenderBuffer: { lib: { writeOut(_p: number, s: string) { writes.push(s); } } }, prependInputHandler(h: typeof handler) { handler = h; }, removeInputHandler() { handler = undefined; } } as never;
  const terminal = createPixelTerminal(renderer, { TERM_PROGRAM: "ghostty" });
  const ready = terminal.ready();
  expect(writes[0]).toContain("a=q");
  handler?.("\x1b_Gi=6356991;OK\x1b\\");
  expect(await ready).toBe(true);
  const image = terminal.place(pixel, 8, 4)!;
  expect(image.color).toBe("#610000");
  expect(writes.at(-1)).toContain("U=1,i=6356992,c=8,r=4");
  expect(writes.join("")).not.toContain("a=T");
  image.release();
  expect(writes.at(-1)).toContain("a=d,d=I,i=6356992");
  terminal.stop();
  expect(terminal.place(pixel, 8, 4)).toBeNull();
  expect(await createPixelTerminal(renderer, { TERM_PROGRAM: "ghostty", TMUX: "yes" }).ready()).toBe(false);
});

test("OpenTUI keeps pixel ID truecolor and diacritics; partial scroll clips rows and hide clears cells", async () => {
  let scroll: ScrollBoxRenderable | null = null;
  const content = (show: boolean) => <box flexDirection="column"><text>HEADER</text><scrollbox ref={r => { scroll = r; }} height={3} width={10} scrollX={false}>
    {show ? <box height={6} flexShrink={0} flexDirection="column">{pixelRows(8, 6).map((s, i) => <text key={i} width={8} height={1} fg="#123456" wrapMode="none">{s}</text>)}</box> : <text>hidden</text>}
  </scrollbox><text>FOOTER</text></box>;
  let show!: (value: boolean) => void;
  function Fixture() { const [visible, set] = useState(true); show = set; return content(visible); }
  const t = await testRender(<Fixture />, { width: 30, height: 10 });
  try {
    await act(async () => { await t.renderOnce(); });
    const before = t.captureSpans();
    expect(JSON.stringify(before)).toContain("􎻮̅̅");
    expect(t.captureCharFrame()).toContain("FOOTER");
    await act(async () => { scroll?.scrollBy(2); await t.renderOnce(); });
    expect(JSON.stringify(t.captureSpans())).toContain("􎻮̎̅");
    expect(t.captureCharFrame()).toContain("FOOTER");
    await act(async () => { show(false); });
    await act(async () => { await t.renderOnce(); });
    expect(t.captureCharFrame()).not.toContain(String.fromCodePoint(0x10eeee));
  } finally { t.renderer.destroy(); }
});

test("pixel preparation does not probe the controlling terminal while OpenTUI owns input", () => {
  const dir = mkdtempSync(join(tmpdir(), "wacosas-probe-"));
  try {
    // Tiny real GIF, generated fixture; no user's photos or WhatsApp access.
    const photo = join(dir, "pixel.gif");
    writeFileSync(photo, Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));
    const script = `import {preparePixels} from ${JSON.stringify(resolve("src/boot/pixels.ts"))}; const r=await preparePixels(${JSON.stringify(photo)},8,4); process.exit(r.ok?0:1);`;
    // PTY gives the child a controlling terminal even with stdio piped. No
    // emulator answers chafa's unsolicited query: conversion must not wait.
    const run = spawnSync("python3", ["-c", `import os,pty,sys\npid,fd=pty.fork()\nif pid==0:\n os.execv(sys.argv[1],[sys.argv[1],'-e',sys.argv[2]])\n_,status=os.waitpid(pid,0)\nos.close(fd)\nsys.exit(os.waitstatus_to_exitcode(status))`, process.execPath, script], { timeout: 7000 });
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 10000);

test("missing chafa input returns an honest error, not symbol art", async () => {
  expect((await preparePixels("/not/a/real/fixture.png", 8, 4)).ok).toBe(false);
});
