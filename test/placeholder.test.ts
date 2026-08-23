// Tests de lib/placeholder.ts: placeholders de adjunto (CA-7.1), metadato
// faltante (CA-7.3) y tipo desconocido (CA-7.5).
import { expect, test } from "bun:test";

import { fmtDuration, placeholderFor } from "../src/lib/placeholder";

/** La basura que llega cuando WhatsApp no manda el metadato (CA-7.3). */
const SIN_DATO = [undefined, null, Number.NaN, 0, -3, Number.POSITIVE_INFINITY, "", "  ", "abc", {}];

/**
 * Las ocho claves que TODO objeto hereda de `Object.prototype`. No son tipos de
 * mensaje, pero con un lookup pelado (`ETIQUETAS[kind]`) se colaban por el
 * prototipo: `"__proto__"` devolvía un objeto (`[object Object]` en la fila) y
 * `"toString"` la función nativa, que es MULTILÍNEA y rompe la fila única
 * (CA-4.6). Tienen que caer en el fallback como cualquier otro desconocido.
 */
const CLAVES_HEREDADAS = [
  "__proto__",
  "constructor",
  "toString",
  "toLocaleString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
];

test("cada tipo de adjunto tiene su placeholder de una línea (CA-7.1)", () => {
  expect(placeholderFor("image")).toBe("📷 imagen");
  expect(placeholderFor("audio", { seconds: 12 })).toBe("🎤 audio 0:12");
  expect(placeholderFor("video", { seconds: 95 })).toBe("🎬 video 1:35");
  expect(placeholderFor("document", { filename: "informe.pdf" })).toBe("📎 informe.pdf");
  expect(placeholderFor("sticker")).toBe("🩹 sticker");
  expect(placeholderFor("location")).toBe("📍 ubicación");
  expect(placeholderFor("contact")).toBe("👤 contacto");
});

test("un audio sin duración muestra el placeholder pelado, nunca 'undefined' (CA-7.3)", () => {
  expect(placeholderFor("audio")).toBe("🎤 audio");
  expect(placeholderFor("audio", {})).toBe("🎤 audio");
  for (const malo of SIN_DATO) {
    const label = placeholderFor("audio", { seconds: malo as number });
    expect(label).toBe("🎤 audio");
  }
});

test("un documento sin nombre de archivo dice 'documento', nunca 'undefined' (CA-7.3)", () => {
  expect(placeholderFor("document")).toBe("📎 documento");
  expect(placeholderFor("document", {})).toBe("📎 documento");
  expect(placeholderFor("document", { filename: null })).toBe("📎 documento");
  expect(placeholderFor("document", { filename: "" })).toBe("📎 documento");
  expect(placeholderFor("document", { filename: "   " })).toBe("📎 documento");
});

test("ningún placeholder puede emitir undefined, null ni NaN (CA-7.3)", () => {
  const kinds = [
    "text",
    "image",
    "video",
    "audio",
    "document",
    "sticker",
    "location",
    "contact",
    "revoked",
    "unsupported",
    "system",
    "tipo-inventado",
    "",
    ...CLAVES_HEREDADAS,
  ];
  const metas = [
    undefined,
    null,
    {},
    { seconds: undefined, filename: undefined },
    { seconds: null, filename: null },
    { seconds: Number.NaN, filename: "" },
  ];

  for (const kind of kinds) {
    for (const meta of metas) {
      const label = placeholderFor(kind, meta as Parameters<typeof placeholderFor>[1]);
      expect(typeof label).toBe("string");
      expect(label).not.toContain("\n"); // una fila de la bandeja es UNA línea (CA-4.6)
      for (const veneno of ["undefined", "null", "NaN"]) {
        expect(label).not.toContain(veneno);
      }
    }
  }
});

test("un tipo desconocido cae en '❔ mensaje no soportado' (CA-7.5)", () => {
  expect(placeholderFor("tipo-que-no-existe")).toBe("❔ mensaje no soportado");
  expect(placeholderFor("unsupported")).toBe("❔ mensaje no soportado");
  expect(placeholderFor(undefined as unknown as string)).toBe("❔ mensaje no soportado");
  for (const heredada of CLAVES_HEREDADAS) {
    expect(placeholderFor(heredada)).toBe("❔ mensaje no soportado");
  }
});

test("un mensaje de texto no tiene placeholder y un revoke tiene el suyo (CA-6.9)", () => {
  expect(placeholderFor("text")).toBe("");
  expect(placeholderFor("text", { filename: "no-va.pdf" })).toBe("");
  expect(placeholderFor("revoked")).toBe("🚫 mensaje eliminado");
  // `system` va sin placeholder, igual que `text`: un aviso de WhatsApp ES su
  // texto y no puede mostrarse como "no soportado" (decidido en la tarea 5).
  expect(placeholderFor("system")).toBe("");
});

test("el nombre de archivo se aplasta a una línea: la fila no puede crecer (CA-4.6)", () => {
  expect(placeholderFor("document", { filename: " informe\nfinal.pdf " })).toBe("📎 informe final.pdf");
});

test("fmtDuration formatea m:ss y devuelve '' ante cualquier dato faltante (CA-7.3)", () => {
  expect(fmtDuration(1)).toBe("0:01");
  expect(fmtDuration(12)).toBe("0:12");
  expect(fmtDuration(60)).toBe("1:00");
  expect(fmtDuration(95)).toBe("1:35");
  expect(fmtDuration(3599)).toBe("59:59");
  expect(fmtDuration(3600)).toBe("60:00"); // no se corta en 60 minutos
  expect(fmtDuration(12.9)).toBe("0:12"); // trunca, no redondea para arriba
  expect(fmtDuration("12")).toBe("0:12"); // baileys a veces manda el número como string

  for (const malo of SIN_DATO) {
    expect(fmtDuration(malo as number)).toBe("");
  }
});
