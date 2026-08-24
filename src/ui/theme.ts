// ── wacosas · sistema de tokens "verde noche" ───────────────────────────────
// Una sola fuente de verdad para el color (misma estructura que
// `miscosas/tui/src/theme.ts`, paleta propia). Clave de diseño: los grises son
// FRÍOS con un dejo verde, nunca violáceos — así el verde de WhatsApp que usamos
// de acento no queda como un parche sobre una UI de otra temperatura.
//
// Ningún componente escribe un `#rrggbb` a mano: si un color hace falta dos
// veces, se agrega acá.

// Fondos / superficies (de lo más profundo a lo elevado)
export const BG = "#0b1512"; //       canvas base (verde noche)
export const SURFACE = "#111f1a"; //  panel / caja elevada
export const ELEVATED = "#182b24"; // cards / acción secundaria
export const SELBG = "#1f3c31"; //    fila seleccionada

// Escala de texto
export const TEXT = "#e9f6ef"; //     primario   (blanco verdoso)
export const TEXT_DIM = "#bdd8ca"; // secundario
export const MUT = "#8ba79a"; //      apagado
export const FAINT = "#6b8579"; //    metadata / íconos secundarios (contraste ≥3:1)
export const GHOST = "#152420"; //    casi invisible (placeholders apagados)

// Acentos
export const ACCENT = "#25d366"; //  verde WhatsApp (acción primaria / browse)
export const ACCENT2 = "#34e0c0"; // turquesa      (modo alterno / foco)
export const GOLD = "#ffd479"; //    dorado        (títulos / resaltado)

// Semánticos
export const DANGER = "#ff6b5e"; //  error / desvinculado
export const WARN = "#ffb454"; //    reconectando / aviso persistente
export const SEL_FG = "#06120d"; //  texto sobre fondo de acento (tabs activos)
export const INPUT_FG = "#d9ffe9"; // texto que se tipea

// Bordes
export const BORDER = "#31544a"; //     neutro visible (paneles en reposo)
export const BORDER_ACCENT = ACCENT; // panel con foco / acción

// Stops del gradiente de marca (oscuro → brillante).
const STOPS = ["#0f3b2e", "#137a4e", "#25d366", "#7ef0a5", "#ffd479"];

/** Interpola dos colores hex (#rrggbb) por t∈[0,1]. */
export function lerpHex(a: string, b: string, t: number): string {
  const ca = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const cb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  const k = Math.max(0, Math.min(1, t));
  const m = ca.map((v, i) => Math.round(v + ((cb[i] as number) - v) * k));
  return "#" + m.map((v) => v.toString(16).padStart(2, "0")).join("");
}

/** Color a lo largo del gradiente de marca, t∈[0,1] (para animaciones). */
export function brand(t: number): string {
  const x = Math.max(0, Math.min(1, t)) * (STOPS.length - 1);
  const i = Math.floor(x);
  if (i >= STOPS.length - 1) return STOPS[STOPS.length - 1] as string;
  return lerpHex(STOPS[i] as string, STOPS[i + 1] as string, x - i);
}

/**
 * Gradiente horizontal para el `color` del `<ascii-font>` del splash. El brillo
 * sube con `t`: el logo "amanece" desde el fondo en vez de aparecer de golpe.
 */
const GRAD = ["#0f3b2e", "#12634a", "#137a4e", "#1aa85a", "#25d366", "#5ae68a", "#7ef0a5", "#ffd479"];
export function brandGradient(t: number): string[] {
  const k = Math.max(0, Math.min(1, t / 0.7));
  return GRAD.map((c) => lerpHex(BG, c, k));
}
