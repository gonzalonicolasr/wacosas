// Isolated fixture-only Kitty virtual-placement feasibility test. Never connects to WhatsApp.
import { createCliRenderer, type ScrollBoxRenderable } from "@opentui/core";
import { createRoot, useKeyboard } from "@opentui/react";
import { readFileSync, writeFileSync } from "node:fs";
import { useEffect, useRef, useState } from "react";

const photo = process.argv[2];
if (!photo) throw Error("Pass a fixture PNG path");
const id = 0x123456;
const marks = [0x305, 0x30d, 0x30e, 0x310, 0x312, 0x33d, 0x33e, 0x33f, 0x346, 0x34a, 0x34b, 0x34c, 0x350, 0x351, 0x352, 0x357, 0x35b, 0x363, 0x364, 0x365, 0x366, 0x367, 0x368, 0x369, 0x36a, 0x36b, 0x36c, 0x36d, 0x36e, 0x36f, 0x483, 0x484];
const renderer = await createCliRenderer({ exitOnCtrlC: true, useThread: false });
const out = (s: string) => renderer.nextRenderBuffer.lib.writeOut(renderer.rendererPtr, s);
const base64 = readFileSync(photo).toString("base64");
for (let n = 0; n < base64.length; n += 4096) {
  out(`\x1b_G${n === 0 ? `a=t,f=100,i=${id},q=2,` : ""}m=${n + 4096 < base64.length ? 1 : 0};${base64.slice(n, n + 4096)}\x1b\\`);
}
out(`\x1b_Ga=p,U=1,i=${id},c=24,r=12,q=2\x1b\\`);
function App() {
  const scroll = useRef<ScrollBoxRenderable>(null);
  const [shown, show] = useState(true);
  useKeyboard(key => {
    if (key.name === "up") scroll.current?.scrollBy(-1);
    if (key.name === "down") scroll.current?.scrollBy(1);
    if (key.name === "h") show(s => !s);
    if (key.name === "q") { out(`\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`); renderer.destroy(); }
  });
  useEffect(() => {
    const t = setTimeout(() => {
      renderer.addPostProcessFn(buffer => {
        writeFileSync("/tmp/wacosas-pixel-evidence/buffer.json", JSON.stringify(buffer.getSpanLines(), null, 2));
      });
      scroll.current?.scrollBy(2);
    }, 1200);
    const hide = setTimeout(() => show(false), 6000);
    return () => { clearTimeout(t); clearTimeout(hide); };
  }, []);
  return <box flexDirection="column" backgroundColor="#112233">
    <text>PIXEL FIXTURE · arrows scroll · h hide · q quit</text>
    <scrollbox ref={scroll} height={10} width={32} scrollX={false} border>
      <text>CLIPPED PHOTO BELOW</text>
      {shown ? <box flexDirection="column" width={24} height={12} flexShrink={0}>
        {Array.from({ length: 12 }, (_, row) => <text key={row} height={1} wrapMode="none" fg="#123456">{Array.from({ length: 24 }, (_, col) => String.fromCodePoint(0x10eeee, marks[row]!, marks[col]!)).join("")}</text>)}
      </box> : <text>HIDDEN PHOTO</text>}
      <text>AFTER PHOTO</text>
    </scrollbox>
    <text>FOOTER MUST NEVER BE COVERED</text>
  </box>;
}
createRoot(renderer).render(<App />);
