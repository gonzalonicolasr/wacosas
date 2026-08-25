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

/** Los tres canales de un `#rrggbb`, 0..255. */
function canales(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(String(hex ?? "").slice(i, i + 2), 16) || 0);
  return [r as number, g as number, b as number];
}

/**
 * Luminancia relativa (WCAG 2.x), 0..1. Se usa para decidir si un color que
 * viene de AFUERA —el promedio de una foto de perfil— se ve o no sobre el fondo
 * del panel.
 */
export function luminancia(hex: string): number {
  const lineal = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = canales(hex);
  return 0.2126 * lineal(r) + 0.7152 * lineal(g) + 0.0722 * lineal(b);
}

/** Piso de luminancia para que un color se despegue del fondo (`SURFACE`). */
const LUM_MINIMA = 0.18;

/**
 * Aclara un color hasta que se lea sobre el panel, conservando su TONO.
 *
 * Hace falta porque los colores de las fotos de perfil no los elegimos nosotros:
 * el promedio de una foto nocturna puede dar `#111` y sobre un fondo `#111f1a`
 * sería un glifo invisible —o sea, un chat que desaparece de la lista—. Se mezcla
 * hacia el blanco de a poco: cambiar el tono lo volvería un color inventado, y la
 * gracia es justamente que sea EL de esa foto.
 */
export function legibleSobrePanel(hex: string): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(String(hex ?? ""))) return TEXT_DIM;
  let color = hex;
  // Doce pasos de 8 %: alcanzan para levantar hasta un negro puro y son un ciclo
  // acotado (nada de `while` sobre una condición que podría no cumplirse nunca).
  for (let i = 0; i < 12 && luminancia(color) < LUM_MINIMA; i++) {
    color = lerpHex(color, "#ffffff", 0.08);
  }
  return color;
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
