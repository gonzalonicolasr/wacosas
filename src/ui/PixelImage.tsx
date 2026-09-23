import { useEffect, useState } from "react";
import { pixelRows, type PixelPlacement } from "../boot/pixels";
import type { MessageRow } from "../db/types";
import { commands } from "../state/commands";
import { clip } from "../lib/fmt";
import { MUT } from "./theme";

/** Fixed layout slot: loading and image completion never shift the scroll anchor. */
export function PixelImage({ source, cols, rows, visible, compact = false, fallback = "foto no disponible" }: {
  source: MessageRow | string | null; cols: number; rows: number; visible: boolean; compact?: boolean; fallback?: string;
}) {
  const [placement, setPlacement] = useState<PixelPlacement | null>(null);
  const [reason, setReason] = useState("");
  const [resolvedIdentity, setResolvedIdentity] = useState("");
  const identity = typeof source === "string" ? source : source ? `${source.chatJid}:${source.id}:${source.kind}:${source.attachment?.thumbnail ?? ""}` : "";
  useEffect(() => {
    setPlacement(null);
    setReason("");
    if (!visible || !source) return;
    let current = true;
    let image: PixelPlacement | null = null;
    let cancel = () => {};
    let timer: ReturnType<typeof setTimeout>;
    const request = () => {
      // Machine commands finish wiring after the first UI frame.
      if (!commands.pixelTerminal()) { timer = setTimeout(request, 200); return; }
      cancel = commands.requestPixels(source, cols, rows, result => {
        if (!current) return;
        if (!result.ok) { setReason(result.reason); return; }
        image = commands.pixelTerminal()?.place(result.data, cols, rows) ?? null;
        setResolvedIdentity(identity);
        setPlacement(image);
        if (!image) setReason(fallback);
      });
    };
    request();
    return () => { current = false; clearTimeout(timer); cancel(); image?.release(); };
  }, [identity, cols, rows, visible]);

  return <box id={typeof source === "object" && source ? `pixel-${source.id}` : undefined} width={cols} height={rows} flexDirection="column" flexShrink={0} overflow="hidden">
    {placement && visible && resolvedIdentity === identity ? pixelRows(cols, rows).map((text, i) =>
      <text key={i} height={1} width={cols} flexShrink={0} wrapMode="none" fg={placement.color}>{text}</text>
    ) : <text wrapMode={compact ? "none" : "word"} fg={MUT}>{clip(compact && reason ? fallback : reason || (source ? "⋯ foto" : fallback), compact ? cols : cols * rows)}</text>}
  </box>;
}
