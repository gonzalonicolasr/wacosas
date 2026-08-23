// Placeholders de adjunto (CA-7.1) y duración (CA-7.3). Puro y sin deps.
//
// Este archivo existe por UN bug clásico: el "🎤 audio undefined" que aparece
// cuando WhatsApp manda una nota de voz sin `seconds` o un documento sin
// `fileName`. Acá NUNCA puede salir `undefined`, `null` ni `NaN` en pantalla:
// los metadatos entran como opcionales, se validan de una y el label se arma por
// concatenación condicional (design §8.4).
//
// wacosas no descarga ni un byte de los adjuntos (CA-7.4): esto es todo lo que
// el usuario va a ver de ellos.
import { oneLine } from "./fmt";

/** Lo que sobrevive del adjunto en la fila: nada binario (CA-7.4). */
export type AttachmentMeta = {
  filename?: string | null;
  /** Segundos de audio/video. Puede venir `undefined`, `0` o basura (CA-7.3). */
  seconds?: number | string | null;
  mimetype?: string | null;
};

/** Lo que se muestra cuando el tipo no se sabe representar (CA-7.5). */
const NO_SOPORTADO = "❔ mensaje no soportado";

/**
 * Etiqueta base por `MessageKind` (design §5.1). El tipo se recibe como `string`
 * y no importando `db/types.ts` a propósito: `lib/` es puro y no depende de la
 * capa de datos.
 *
 * `text` va vacío porque un mensaje de texto no tiene placeholder: se muestra el
 * cuerpo. Los tipos que no están en la tabla caen en `NO_SOPORTADO`.
 */
const ETIQUETAS: Record<string, string> = {
  text: "",
  image: "📷 imagen",
  video: "🎬 video",
  audio: "🎤 audio",
  document: "📎 documento",
  sticker: "🩹 sticker",
  location: "📍 ubicación",
  contact: "👤 contacto",
  revoked: "🚫 mensaje eliminado",
  unsupported: NO_SOPORTADO,
};

/** Los únicos que llevan duración pegada al label (CA-7.1). */
const CON_DURACION = new Set(["audio", "video"]);

/**
 * Duración como `m:ss` (CA-7.1). Devuelve `""` —no `"NaN:aN"`— ante cualquier
 * dato que no sirva: ausente, `null`, no numérico, infinito o ≤ 0 (un adjunto de
 * cero segundos es, en los hechos, metadato faltante).
 *
 * Los minutos no se cortan en 60: una nota de voz de 63 minutos se ve `63:20`,
 * que es lo que pide el criterio (`<m:ss>`) y no miente sobre el largo.
 */
export function fmtDuration(seconds?: number | string | null): string {
  const n = typeof seconds === "string" ? Number(seconds.trim() || Number.NaN) : seconds;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return "";
  const total = Math.floor(n);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Placeholder de una línea para un adjunto (CA-7.1). Si falta el metadato, el
 * label sale igual pero sin ese dato (CA-7.3):
 *
 *   placeholderFor("audio", { seconds: 12 })        → "🎤 audio 0:12"
 *   placeholderFor("audio")                          → "🎤 audio"
 *   placeholderFor("document", { filename: "a.pdf" })→ "📎 a.pdf"
 *   placeholderFor("document")                       → "📎 documento"
 *   placeholderFor("cualquier-cosa")                 → "❔ mensaje no soportado"
 */
export function placeholderFor(kind: string, meta?: AttachmentMeta | null): string {
  // El acceso va con `hasOwn` a propósito: `ETIQUETAS[k]` a secas resuelve
  // contra `Object.prototype`, así que `"__proto__"` devolvería un objeto y
  // `"toString"` la función nativa —multilínea— en vez del fallback. Volcado en
  // una fila eso da `[object Object]` o rompe el invariante de una sola línea
  // (CA-4.6), y el `: string` del retorno pasaría a ser mentira.
  const k = String(kind ?? "");
  const base = Object.hasOwn(ETIQUETAS, k) ? ETIQUETAS[k] : NO_SOPORTADO;
  if (base === "") return "";

  if (kind === "document") {
    const nombre = oneLine(meta?.filename ?? "");
    return nombre ? `📎 ${nombre}` : base;
  }

  if (CON_DURACION.has(kind)) {
    const dur = fmtDuration(meta?.seconds);
    return dur ? `${base} ${dur}` : base;
  }

  return base;
}
