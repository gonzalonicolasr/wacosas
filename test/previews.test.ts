import { expect, test } from "bun:test";
import { createPreviewQueue } from "../src/state/previews";

const ok = { ok: true as const, filas: [[{ texto: "▄▄", fg: "#ff0000", bg: "#0000ff" }]] };

test("inline previews serialize, deduplicate, cache and cancel invisible queued work", async () => {
  const started: string[] = [];
  let finish!: (r: typeof ok) => void;
  const q = createPreviewQueue({ gapMs: 0, limit: 2 });
  const seen: string[] = [];
  q.request("a", () => { started.push("a"); return new Promise(r => { finish = r; }); }, () => seen.push("a"));
  q.request("a", async () => { throw Error("duplicate"); }, () => seen.push("a2"));
  const cancel = q.request("hidden", async () => { started.push("hidden"); return ok; }, () => seen.push("hidden"));
  cancel();
  await Bun.sleep(5);
  expect(started).toEqual(["a"]);
  finish(ok);
  await Bun.sleep(10);
  expect(seen).toEqual(["a", "a2"]);
  q.request("a", async () => { throw Error("cache miss"); }, () => seen.push("cached"));
  expect(seen).toContain("cached");
  expect(started).toEqual(["a"]);
});

test("stale completion after leaving a chat never publishes; errors are cached; LRU is bounded", async () => {
  const q = createPreviewQueue({ gapMs: 0, limit: 2 });
  let finish!: (r: typeof ok) => void;
  let published = 0;
  const cancel = q.request("old-chat", () => new Promise(r => { finish = r; }), () => published++);
  await Bun.sleep(5);
  cancel();
  finish(ok);
  await Bun.sleep(5);
  expect(published).toBe(0);
  let attempts = 0;
  const bad = () => { attempts++; return Promise.reject(Error("missing image")); };
  q.request("bad", bad, r => expect(r.ok).toBe(false));
  await Bun.sleep(5);
  q.request("bad", bad, r => expect(r.ok).toBe(false));
  expect(attempts).toBe(1);
  q.request("new", async () => ok, () => {});
  await Bun.sleep(5);
  q.request("old-chat", async () => { attempts++; return ok; }, () => {});
  await Bun.sleep(5);
  expect(attempts).toBe(2);
});
