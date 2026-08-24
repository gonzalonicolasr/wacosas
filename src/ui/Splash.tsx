// Splash de arranque (CA-19.2): logo con gradiente que sube de brillo + barra de
// carga. Dura ≤ 1,5 s y cualquier tecla lo saltea; con `--no-splash` no se monta
// nunca (CA-13.7). La línea de tiempo `t` ∈ [0,1] la maneja `App.tsx`.
//
// El logo grande necesita ~63 columnas: abajo de 72 se cae a la marca en texto,
// porque un `<ascii-font>` más ancho que la terminal desborda el layout en vez de
// recortarse.
import { ACCENT, BG, brandGradient, FAINT, GHOST, GOLD, MUT } from "./theme";

const ANCHO_BARRA = 26;
const ANCHO_MIN_LOGO = 72;
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Splash({ t, width }: { t: number; width: number }) {
  const lleno = Math.round(ANCHO_BARRA * t);
  const barra = "█".repeat(lleno) + "░".repeat(Math.max(0, ANCHO_BARRA - lleno));
  const spin = SPIN[Math.floor(t * 24) % SPIN.length] as string;
  const subtitulo = t > 0.35;

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      justifyContent="center"
      alignItems="center"
      backgroundColor={BG}
    >
      {width >= ANCHO_MIN_LOGO ? (
        <ascii-font text="wacosas" font="slick" color={brandGradient(t)} />
      ) : (
        <text fg={GOLD}>{"✦ wacosas"}</text>
      )}
      <text> </text>
      <text fg={subtitulo ? MUT : GHOST}>{"WhatsApp en la terminal  ·  local y tuyo"}</text>
      <text> </text>
      <text fg={GOLD}>
        {`${spin}  `}
        <span fg={ACCENT}>{barra}</span>
      </text>
      <text> </text>
      <text fg={FAINT}>{t > 0.6 ? "cualquier tecla para entrar →" : ""}</text>
    </box>
  );
}
