// Kitty virtual placements: OpenTUI owns every visible cell (including clipping).
// No physical placements, cursor escapes or out-of-band drawing are used.
// https://sw.kovidgoyal.net/kitty/graphics-protocol/#unicode-placeholders
import type { CliRenderer } from "@opentui/core";
import { correrReal } from "./clipboard";

export type PixelData = { width: number; height: number; rgba: Uint8Array };
export type PixelResult = { ok: true; data: PixelData; reason?: undefined } | { ok: false; reason: string; data?: undefined };
export const PIXELS_UNSUPPORTED = "fotos inline: requiere Ghostty con Kitty (sin tmux)";
// First 64 entries of Kitty's rowcolumn-diacritics.txt; explicit row AND column
// on every cell are necessary when the scrollbox clips either edge.
const MARKS = [0x305,0x30d,0x30e,0x310,0x312,0x33d,0x33e,0x33f,0x346,0x34a,0x34b,0x34c,0x350,0x351,0x352,0x357,0x35b,0x363,0x364,0x365,0x366,0x367,0x368,0x369,0x36a,0x36b,0x36c,0x36d,0x36e,0x36f,0x483,0x484];
export function pixelRows(cols: number, rows: number): string[] {
  return Array.from({ length: Math.min(32, rows) }, (_, y) =>
    Array.from({ length: Math.min(32, cols) }, (_, x) => String.fromCodePoint(0x10eeee, MARKS[y]!, MARKS[x]!)).join(""));
}

/** Parse ONLY raw RGBA data from chafa, never forward its terminal commands. */
export function parsePixelData(output: string): PixelResult {
  let width = 0, height = 0, payload = "";
  for (const m of output.matchAll(/\x1b_G([^;\x1b]*)(?:;([^\x1b]*))?\x1b\\/g)) {
    const fields = Object.fromEntries(m[1]!.split(",").map(p => p.split("=")));
    if (fields.f) {
      if (fields.f !== "32" || width) return { ok: false, reason: "formato de miniatura no soportado" };
      width = Number(fields.s); height = Number(fields.v);
    }
    payload += m[2] ?? "";
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > 1024 || height > 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) {
    return { ok: false, reason: "miniatura inválida" };
  }
  const rgba = new Uint8Array(Buffer.from(payload, "base64"));
  if (rgba.length !== width * height * 4) return { ok: false, reason: "miniatura incompleta" };
  return { ok: true, data: { width, height, rgba } };
}

export async function preparePixels(path: string, cols: number, rows: number): Promise<PixelResult> {
  const bin = Bun.which("chafa");
  if (!bin) return { ok: false, reason: "instalá chafa para ver las fotos inline" };
  // Chafa decodes/downsamples real pixels, NOT symbol/cell art. Kitty output
  // defaults to 10x20 pixel cells when stdout isn't a terminal.
  // OpenTUI owns terminal input. Chafa otherwise probes /dev/tty even with
  // piped stdio, racing our 5s timeout and consuming the renderer's replies.
  const out = await correrReal([bin, "--probe=off", "--format=kitty", "--passthrough=none", "--animate=off", "--threads=1",
    `--size=${Math.max(1, Math.min(32, cols))}x${Math.max(1, Math.min(32, rows))}`, "--", path], 5000, 6 * 1024 * 1024);
  return out.ok ? parsePixelData(new TextDecoder().decode(out.bytes)) : { ok: false, reason: out.reason || "no se pudo preparar la foto" };
}

export type PixelPlacement = { id: number; color: string; release(): void };
export type PixelTerminal = {
  ready(): Promise<boolean>;
  place(data: PixelData, cols: number, rows: number): PixelPlacement | null;
  stop(): void;
};

/** All transport crosses one exported native boundary, ordered with frame output. */
export function createPixelTerminal(renderer: CliRenderer, env = process.env): PixelTerminal {
  const write = (s: string) => {
    if (!renderer.isDestroyed) renderer.nextRenderBuffer.lib.writeOut(renderer.rendererPtr, s);
  };
  let stopped = false;
  let nextId = 0x610000;
  const active = new Set<number>();
  let probe: Promise<boolean> | undefined;
  let finishProbe: ((ok: boolean) => void) | undefined;
  const remove = (id: number) => {
    if (!active.delete(id)) return;
    write(`\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`);
  };
  return {
    ready() {
      if (stopped || env.TMUX || env.TERM_PROGRAM !== "ghostty") return Promise.resolve(false);
      return probe ??= new Promise<boolean>(resolve => {
        const queryId = 0x60ffff;
        let response = "";
        const done = (ok: boolean) => {
          clearTimeout(timer);
          renderer.removeInputHandler(handler);
          finishProbe = undefined;
          resolve(ok);
        };
        const handler = (sequence: string) => {
          response = (response + sequence).slice(-4096);
          if (response.includes(`\x1b_Gi=${queryId};OK\x1b\\`)) done(true);
          return sequence.includes("\x1b_G");
        };
        const timer = setTimeout(() => done(false), 800);
        finishProbe = done;
        renderer.prependInputHandler(handler);
        write(`\x1b_Ga=q,i=${queryId},s=1,v=1,f=24;AAAA\x1b\\`);
      });
    },
    place(data, cols, rows) {
      if (stopped || active.size >= 64) return null;
      const id = nextId++;
      // IDs never get reused while old cells might still be in a frame.
      if (id > 0xffffff) return null;
      const payload = Buffer.from(data.rgba).toString("base64");
      active.add(id);
      for (let n = 0; n < payload.length; n += 4096) {
        write(`\x1b_G${n === 0 ? `a=t,f=32,s=${data.width},v=${data.height},i=${id},q=2,` : ""}m=${n + 4096 < payload.length ? 1 : 0};${payload.slice(n, n + 4096)}\x1b\\`);
      }
      write(`\x1b_Ga=p,U=1,i=${id},c=${cols},r=${rows},q=2\x1b\\`);
      return { id, color: `#${id.toString(16).padStart(6, "0")}`, release: () => remove(id) };
    },
    stop() {
      stopped = true;
      finishProbe?.(false);
      for (const id of active) remove(id);
    },
  };
}
