// Tests de src/wa/map.ts: mapeo puro de un mensaje de Baileys a la fila que
// persiste el ingest (CA-14.1), placeholders y captions (CA-7.1/7.2/7.5),
// detección de revoke (CA-6.9), preview de la bandeja (CA-4.5), mensajes
// propios de otros dispositivos (CA-9.5) y nombre de un grupo (CA-4.8).
//
// Todos los fixtures viven en `test/fixtures/messages.ts` con la forma real de
// un `WAMessage`; acá sólo se afirma qué sale del mapeo.
import { expect, test } from "bun:test";

import type { MessageKind, MessageStatus } from "../src/db/types";
import { isRevoke, mapMessage, previewFor, resolveChatName } from "../src/wa/map";

import {
  AHORA,
  CTX,
  FIXTURES,
  JID_CONTACTO,
  JID_GRUPO,
  JID_NEWSLETTER,
  JID_PARTICIPANTE,
  JID_STATUS,
  SELF_JID_NORMALIZADO,
  TS_BASE,
  audioConSegundos,
  audioSinSegundos,
  contacto,
  documentoConNombre,
  documentoSinNombre,
  ecoPropio,
  ecoPropioEnvuelto,
  estadoBroadcast,
  imagenConCaption,
  longDe,
  mensajeDeGrupo,
  newsletter,
  protocoloNoRevoke,
  reaccion,
  revoke,
  revokeAplanado,
  sinRemoteJid,
  sinTimestamp,
  sinWaId,
  sticker,
  textoEfimero,
  textoExtendido,
  textoPlano,
  tipoInventado,
  tsBasura,
  tsComoLong,
  ubicacion,
  videoConCaption,
} from "./fixtures/messages";

/** `mapMessage` que además falla el test si devolvió `null`. */
function mapear(m: Parameters<typeof mapMessage>[0]) {
  const fila = mapMessage(m, CTX);
  expect(fila).not.toBeNull();
  return fila!;
}

// ── tipos de contenido ──────────────────────────────────────────────────────

test("texto: conversation → kind text con el cuerpo entero (CA-14.1)", () => {
  const fila = mapear(textoPlano);
  expect(fila).toMatchObject({
    chatJid: JID_CONTACTO,
    waId: "3EB0TEXTO0000000001",
    fromMe: false,
    senderJid: JID_CONTACTO,
    senderName: "Ana Gómez",
    ts: TS_BASE,
    kind: "text",
    body: "hola, ¿cómo va?",
    attachment: null,
    status: "received",
  });
  expect(previewFor(fila)).toBe("hola, ¿cómo va?");
});

test("texto extendido: extendedTextMessage.text también es kind text", () => {
  const fila = mapear(textoExtendido);
  expect(fila.kind).toBe("text");
  expect(fila.body).toBe("mirá esto: https://wacosas.example");
  expect(fila.attachment).toBeNull();
});

test("imagen con caption: placeholder + caption en el body (CA-7.1, CA-7.2)", () => {
  const fila = mapear(imagenConCaption);
  expect(fila.kind).toBe("image");
  expect(fila.body).toBe("el asado de ayer");
  expect(fila.attachment).toEqual({ label: "📷 imagen", mimetype: "image/jpeg" });
  // El caption va DEBAJO del placeholder en la conversación (CA-7.2); en la
  // fila de la bandeja entran los dos en una línea (CA-4.5).
  expect(previewFor(fila)).toBe("📷 imagen · el asado de ayer");
});

test("video con caption: el placeholder lleva la duración (CA-7.1)", () => {
  const fila = mapear(videoConCaption);
  expect(fila.kind).toBe("video");
  expect(fila.body).toBe("salió bien la jugada");
  expect(fila.attachment).toEqual({ label: "🎬 video 1:35", seconds: 95, mimetype: "video/mp4" });
});

test("audio CON seconds: '🎤 audio 0:12' (CA-7.1)", () => {
  const fila = mapear(audioConSegundos);
  expect(fila.kind).toBe("audio");
  expect(fila.body).toBe("");
  expect(fila.attachment).toEqual({
    label: "🎤 audio 0:12",
    seconds: 12,
    mimetype: "audio/ogg; codecs=opus",
  });
  expect(previewFor(fila)).toBe("🎤 audio 0:12");
});

test("audio SIN seconds: placeholder pelado y sin la clave seconds (CA-7.3)", () => {
  const fila = mapear(audioSinSegundos);
  expect(fila.attachment).toEqual({ label: "🎤 audio", mimetype: "audio/ogg; codecs=opus" });
  expect(Object.hasOwn(fila.attachment!, "seconds")).toBe(false);
  expect(previewFor(fila)).toBe("🎤 audio");
});

test("documento CON fileName: el label es el nombre del archivo (CA-7.1)", () => {
  const fila = mapear(documentoConNombre);
  expect(fila.kind).toBe("document");
  expect(fila.attachment).toEqual({
    label: "📎 informe final.pdf",
    filename: "informe final.pdf",
    mimetype: "application/pdf",
  });
});

test("documento SIN fileName: '📎 documento', nunca 'undefined' (CA-7.3)", () => {
  const fila = mapear(documentoSinNombre);
  expect(fila.attachment).toEqual({
    label: "📎 documento",
    mimetype: "application/octet-stream",
  });
  expect(Object.hasOwn(fila.attachment!, "filename")).toBe(false);
});

test("sticker: '🩹 sticker' (CA-7.1)", () => {
  const fila = mapear(sticker);
  expect(fila.kind).toBe("sticker");
  expect(fila.attachment).toEqual({ label: "🩹 sticker", mimetype: "image/webp" });
  expect(previewFor(fila)).toBe("🩹 sticker");
});

test("ubicación: '📍 ubicación' (CA-7.1)", () => {
  const fila = mapear(ubicacion);
  expect(fila.kind).toBe("location");
  expect(fila.body).toBe("");
  expect(fila.attachment).toEqual({ label: "📍 ubicación" });
  expect(previewFor(fila)).toBe("📍 ubicación");
});

test("contacto: '👤 contacto' y ni una línea del vCard en el body (CA-7.1)", () => {
  const fila = mapear(contacto);
  expect(fila.kind).toBe("contact");
  expect(fila.body).toBe("");
  expect(fila.attachment).toEqual({ label: "👤 contacto" });
  expect(previewFor(fila)).toBe("👤 contacto");
});

test("tipo inventado: kind unsupported y SE PERSISTE igual (CA-7.5)", () => {
  const fila = mapear(tipoInventado);
  expect(fila.kind).toBe("unsupported");
  expect(fila.body).toBe("");
  expect(fila.attachment).toBeNull();
  expect(fila.waId).toBe("3EB0FUTURO000000001");
  expect(previewFor(fila)).toBe("❔ mensaje no soportado");
});

test("efímero: se desenvuelve hasta el texto de adentro", () => {
  const fila = mapear(textoEfimero);
  expect(fila.kind).toBe("text");
  expect(fila.body).toBe("esto se borra en 24 h");
});

// ── autoría ─────────────────────────────────────────────────────────────────

test("mensaje de grupo: sender_jid es el participant, no el jid del chat (CA-6.3)", () => {
  const fila = mapear(mensajeDeGrupo);
  expect(fila.chatJid).toBe(JID_GRUPO);
  expect(fila.senderJid).toBe(JID_PARTICIPANTE);
  expect(fila.senderName).toBe("Beto");
  expect(fila.fromMe).toBe(false);
  expect(fila.status).toBe("received");
});

test("mensaje propio del eco (fromMe): se persiste como propio y ya enviado (CA-9.5)", () => {
  const fila = mapear(ecoPropio);
  expect(fila.fromMe).toBe(true);
  expect(fila.status).toBe("sent");
  // El jid propio viene con sufijo de dispositivo (`:12`) y queda normalizado.
  expect(fila.senderJid).toBe(SELF_JID_NORMALIZADO);
  expect(fila.chatJid).toBe(JID_CONTACTO);
});

test("eco envuelto en deviceSentMessage: se desenvuelve, no cae en unsupported (CA-9.5)", () => {
  const fila = mapear(ecoPropioEnvuelto);
  expect(fila.kind).toBe("text");
  expect(fila.body).toBe("esto lo mandé desde el teléfono");
  expect(fila.fromMe).toBe(true);
  expect(fila.senderJid).toBe(SELF_JID_NORMALIZADO);
});

// ── timestamp ───────────────────────────────────────────────────────────────

test("timestamp ausente ⇒ now (§8.4)", () => {
  const fila = mapear(sinTimestamp);
  expect(fila.ts).toBe(AHORA);
});

test("timestamp en 0, negativo, NaN o fuera del rango de Date ⇒ now (§8.4)", () => {
  for (const basura of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 9e12, "", null]) {
    const fila = mapear({ ...textoPlano, messageTimestamp: basura as never });
    expect(fila.ts).toBe(AHORA);
  }
});

test("timestamp como Long del proto: se resuelve a segundos", () => {
  expect(mapear(tsComoLong).ts).toBe(TS_BASE);
  // baileys resuelve el Long por `toNumber()` y, si no lo tiene, por `.low`.
  const sinToNumber = { low: TS_BASE, high: 0, unsigned: true };
  expect(mapear({ ...textoPlano, messageTimestamp: sinToNumber as never }).ts).toBe(TS_BASE);
  expect(mapear({ ...textoPlano, messageTimestamp: longDe(TS_BASE - 60) as never }).ts).toBe(TS_BASE - 60);
});

test("timestamp del futuro (milisegundos) ⇒ now: nadie se clava arriba de la bandeja (CA-4.2)", () => {
  expect(mapear(tsBasura).ts).toBe(AHORA);
  // Un día de tolerancia por reloj desfasado sí se respeta.
  expect(mapear({ ...textoPlano, messageTimestamp: AHORA + 3600 }).ts).toBe(AHORA + 3600);
});

test("el ts siempre es un entero positivo, aunque venga con decimales", () => {
  const fila = mapear({ ...textoPlano, messageTimestamp: (TS_BASE + 0.75) as never });
  expect(fila.ts).toBe(TS_BASE);
  expect(Number.isInteger(fila.ts)).toBe(true);
});

test("un timestamp que hace lanzar a toNumber ⇒ now: mapMessage nunca lanza", () => {
  // `toNumber` de baileys hace `t.toNumber()` sin chequear que sea función
  // (`Utils/generics.js:72`): con esto adentro, un `toNumber` que no lo es
  // propagaba la excepción hasta el handler del socket.
  const explosivo = [{ toNumber: 5 }, { toNumber: null }, { low: 1, toNumber: "no soy función" }];
  for (const ts of explosivo) {
    const fila = mapear({ ...textoPlano, messageTimestamp: ts as never });
    expect(fila.ts).toBe(AHORA);
  }
});

// ── descartes ───────────────────────────────────────────────────────────────

test("revoke: mapMessage no persiste fila e isRevoke apunta al mensaje borrado (CA-6.9)", () => {
  expect(mapMessage(revoke, CTX)).toBeNull();
  expect(isRevoke(revoke)).toEqual({
    chatJid: JID_CONTACTO,
    targetWaId: "3EB0TEXTO0000000001",
  });
});

test("revoke aplanado (messages.update con messageStubType): mismo resultado (CA-6.9)", () => {
  expect(mapMessage(revokeAplanado, CTX)).toBeNull();
  expect(isRevoke(revokeAplanado)).toEqual({
    chatJid: JID_CONTACTO,
    targetWaId: "3EB0TEXTO0000000001",
  });
});

test("isRevoke devuelve null para todo lo que no es un borrado", () => {
  expect(isRevoke(textoPlano)).toBeNull();
  expect(isRevoke(protocoloNoRevoke)).toBeNull();
  expect(isRevoke(reaccion)).toBeNull();
  expect(isRevoke(sinRemoteJid)).toBeNull();
  expect(isRevoke({} as never)).toBeNull();
});

test("status@broadcast, newsletters, protocolo y reacciones se descartan (§5.4)", () => {
  expect(mapMessage(estadoBroadcast, CTX)).toBeNull();
  expect(mapMessage(newsletter, CTX)).toBeNull();
  expect(mapMessage(protocoloNoRevoke, CTX)).toBeNull();
  expect(mapMessage(reaccion, CTX)).toBeNull();
});

test("sin remoteJid o sin key.id no hay fila que insertar (§5.4, CA-14.2)", () => {
  expect(mapMessage(sinRemoteJid, CTX)).toBeNull();
  expect(mapMessage(sinWaId, CTX)).toBeNull();
  expect(mapMessage({} as never, CTX)).toBeNull();
  expect(mapMessage({ key: {} } as never, CTX)).toBeNull();
});

// ── invariantes sobre TODOS los fixtures ────────────────────────────────────

const KINDS: MessageKind[] = [
  "text",
  "image",
  "video",
  "audio",
  "document",
  "sticker",
  "location",
  "contact",
  "revoked",
  "system",
  "unsupported",
];
const STATUS: MessageStatus[] = ["received", "pending", "sent", "delivered", "read", "failed"];

test("ninguna fila mapeada sale con undefined, null ni NaN donde no corresponde", () => {
  for (const [nombre, fixture] of Object.entries(FIXTURES)) {
    const fila = mapMessage(fixture, CTX);
    if (!fila) continue;

    const etiqueta = `fixture ${nombre}`;
    expect(typeof fila.chatJid, etiqueta).toBe("string");
    expect(fila.chatJid.length, etiqueta).toBeGreaterThan(0);
    expect(fila.waId.length, etiqueta).toBeGreaterThan(0);
    expect(typeof fila.fromMe, etiqueta).toBe("boolean");
    expect(typeof fila.senderJid, etiqueta).toBe("string");
    expect(typeof fila.senderName, etiqueta).toBe("string");
    expect(Number.isInteger(fila.ts), etiqueta).toBe(true);
    expect(fila.ts, etiqueta).toBeGreaterThan(0);
    expect(KINDS, etiqueta).toContain(fila.kind);
    expect(STATUS, etiqueta).toContain(fila.status);
    expect(typeof fila.body, etiqueta).toBe("string");

    // El adjunto viaja a la base como JSON (`repo.insertMessage`): ni una clave
    // en `undefined` ni un `NaN` que salga `null` del otro lado.
    if (fila.attachment) {
      const json = JSON.stringify(fila.attachment);
      expect(json, etiqueta).not.toContain("null");
      expect(JSON.parse(json), etiqueta).toEqual(fila.attachment);
      expect(fila.attachment.label.length, etiqueta).toBeGreaterThan(0);
    }

    const preview = previewFor(fila);
    expect(typeof preview, etiqueta).toBe("string");
    expect(preview, etiqueta).not.toContain("\n"); // UNA línea por fila (CA-4.6)
    for (const veneno of ["undefined", "NaN", "[object Object]"]) {
      expect(preview, etiqueta).not.toContain(veneno);
    }
  }
});

test("mapMessage es puro: no toca el mensaje que recibe", () => {
  const antes = JSON.stringify(textoPlano);
  mapMessage(textoPlano, CTX);
  mapMessage(textoPlano, { selfJid: "otro@s.whatsapp.net", nowSec: 1 });
  expect(JSON.stringify(textoPlano)).toBe(antes);
});

// ── preview de la bandeja (CA-4.5) ──────────────────────────────────────────

test("un adjunto NUNCA deja el preview vacío (CA-4.5)", () => {
  for (const fixture of [imagenConCaption, audioSinSegundos, documentoSinNombre, sticker, ubicacion, contacto]) {
    expect(previewFor(mapear(fixture)).length).toBeGreaterThan(0);
  }
});

test("previewFor: un revoke se anuncia como eliminado (CA-6.9)", () => {
  expect(previewFor({ kind: "revoked", body: "", attachment: null })).toBe("🚫 mensaje eliminado");
});

test("previewFor: un mensaje de sistema muestra su texto, no 'no soportado'", () => {
  expect(previewFor({ kind: "system", body: "cambió el código de seguridad", attachment: null })).toBe(
    "cambió el código de seguridad",
  );
});

test("previewFor aplasta los saltos de línea: la fila es UNA línea (CA-4.6)", () => {
  expect(previewFor({ kind: "text", body: "primera\nsegunda\n\ttercera", attachment: null })).toBe(
    "primera segunda tercera",
  );
});

// ── resolveChatName (§5.4) ──────────────────────────────────────────────────

test("resolveChatName: el subject del grupo gana sobre todo (CA-4.8)", () => {
  expect(
    resolveChatName({
      groupSubject: "Los del asado",
      contactName: "Beto",
      pushName: "Beto",
      jid: JID_GRUPO,
    }),
  ).toBe("Los del asado");
});

test("resolveChatName: un grupo sin subject NO se llama como el que escribió (CA-4.8)", () => {
  // Devolver "" es lo correcto: `repo.upsertChat` no pisa el nombre guardado
  // con un vacío, así que el subject que llegue después sigue mandando.
  expect(resolveChatName({ pushName: "Beto", contactName: "Beto Álvarez", jid: JID_GRUPO })).toBe("");
});

test("resolveChatName: en un 1:1 manda el contacto, después el pushName", () => {
  expect(
    resolveChatName({ contactName: "Ana (laburo)", pushName: "Ana", jid: JID_CONTACTO }),
  ).toBe("Ana (laburo)");
  expect(resolveChatName({ pushName: "Ana", jid: JID_CONTACTO })).toBe("Ana");
});

test("resolveChatName: sin ningún nombre queda el número formateado", () => {
  expect(resolveChatName({ jid: JID_CONTACTO })).toBe("+5491133445566");
  expect(resolveChatName({ contactName: "   ", pushName: "", jid: JID_CONTACTO })).toBe("+5491133445566");
  expect(resolveChatName({ jid: "998877665544@lid" })).toBe("+998877665544");
});

test("resolveChatName siempre devuelve un string de una línea", () => {
  const entradas = [
    { jid: JID_CONTACTO },
    { jid: JID_GRUPO },
    { jid: JID_NEWSLETTER },
    { jid: JID_STATUS },
    { jid: "" },
    { jid: "sin-arroba" },
    { jid: JID_CONTACTO, pushName: "Ana\nGómez" },
    { jid: JID_GRUPO, groupSubject: " Los\tdel asado \n" },
  ];
  for (const entrada of entradas) {
    const nombre = resolveChatName(entrada as Parameters<typeof resolveChatName>[0]);
    expect(typeof nombre).toBe("string");
    expect(nombre).not.toContain("\n");
    expect(nombre).not.toContain("undefined");
  }
  expect(resolveChatName({ jid: JID_CONTACTO, pushName: "Ana\nGómez" })).toBe("Ana Gómez");
  expect(resolveChatName({ jid: JID_GRUPO, groupSubject: " Los\tdel asado \n" })).toBe("Los del asado");
});
