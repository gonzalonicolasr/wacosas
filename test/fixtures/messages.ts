// Mensajes de Baileys de mentira, con la forma REAL de un `WAMessage`
// (`proto.IWebMessageInfo`): `key` con `remoteJid`/`fromMe`/`id`, el timestamp
// como `messageTimestamp` y el contenido adentro de `message`, con las mismas
// claves que manda WhatsApp (`imageMessage.caption`, `audioMessage.seconds`,
// `documentMessage.fileName`, …).
//
// Están acá y no dentro de `map.test.ts` porque los reusan las tareas siguientes
// (el ingest de la 7 y la conversación de la 13) para no volver a inventar la
// forma de un mensaje en cada test.
//
// Convenciones: los jids son los de verdad (`@s.whatsapp.net`, `@g.us`,
// `@newsletter`, `status@broadcast`), los `key.id` tienen la pinta de los de
// WhatsApp (`3EB0…` en hex mayúscula) y `SELF_JID` viene CON sufijo de
// dispositivo (`:12`), que es como lo devuelve `sock.user.id` — sirve para
// verificar que el mapeo lo normaliza.
import { proto } from "baileys";
import type { WAMessage } from "baileys";

/** Jid propio tal como lo entrega el socket, con dispositivo. */
export const SELF_JID = "5491155667788:12@s.whatsapp.net";
/** El mismo, ya normalizado: lo que tiene que quedar en `sender_jid`. */
export const SELF_JID_NORMALIZADO = "5491155667788@s.whatsapp.net";

export const JID_CONTACTO = "5491133445566@s.whatsapp.net";
export const JID_GRUPO = "120363041234567890@g.us";
export const JID_PARTICIPANTE = "5491199887766@s.whatsapp.net";
export const JID_NEWSLETTER = "120363099887766554@newsletter";
export const JID_STATUS = "status@broadcast";

/** "Ahora" de los tests: 2025-01-01T00:00:00Z. */
export const AHORA = 1735689600;
/** Una hora antes: el timestamp normal de los fixtures. */
export const TS_BASE = 1735686000;

/** El contexto que recibe `mapMessage` en todos los tests. */
export const CTX = { selfJid: SELF_JID, nowSec: AHORA };

/**
 * Bytes de mentira para los campos binarios del proto (`fileSha256`,
 * `mediaKey`, `waveform`). Van como `Uint8Array` y no como base64 porque eso es
 * lo que devuelve el decodificador de baileys, y el mapeo no los mira: son
 * ruido a propósito, para que el fixture tenga el peso de un mensaje real.
 */
function bytes(largo: number): Uint8Array {
  return Uint8Array.from({ length: largo }, (_, i) => (i * 37) % 256);
}

type OpcionesSobre = {
  jid?: string;
  id?: string;
  fromMe?: boolean;
  participant?: string;
  pushName?: string;
  /** Epoch en segundos. `null` ⇒ el mensaje llega SIN `messageTimestamp`. */
  ts?: number | object | null;
};

/**
 * Arma el sobre (`WebMessageInfo`) alrededor de un contenido. Sólo agrega los
 * campos opcionales que se piden: un `participant: undefined` no existe en un
 * mensaje real de 1:1 y esconder eso haría que los tests mientan.
 */
function sobre(message: WAMessage["message"], o: OpcionesSobre = {}): WAMessage {
  const m: WAMessage = {
    key: {
      remoteJid: o.jid ?? JID_CONTACTO,
      fromMe: o.fromMe ?? false,
      id: o.id ?? "3EB0A1B2C3D4E5F60718",
      ...(o.participant ? { participant: o.participant } : {}),
    },
    message,
  };
  if (o.ts !== null) m.messageTimestamp = (o.ts ?? TS_BASE) as WAMessage["messageTimestamp"];
  if (o.pushName) m.pushName = o.pushName;
  return m;
}

// ── se persisten ────────────────────────────────────────────────────────────

/** Texto pelado: la forma más común de todas. */
export const textoPlano = sobre({ conversation: "hola, ¿cómo va?" }, {
  id: "3EB0TEXTO0000000001",
  pushName: "Ana Gómez",
});

/** Texto "extendido": el que manda WhatsApp cuando hay cita, link o formato. */
export const textoExtendido = sobre(
  {
    extendedTextMessage: {
      text: "mirá esto: https://wacosas.example",
      matchedText: "https://wacosas.example",
      title: "wacosas",
      contextInfo: {
        stanzaId: "3EB0TEXTO0000000001",
        participant: JID_CONTACTO,
        quotedMessage: { conversation: "hola, ¿cómo va?" },
      },
    },
  },
  { id: "3EB0EXTENDIDO000001", pushName: "Ana Gómez" },
);

/** Imagen con caption: el caption va al `body` y se indexa en el FTS (CA-7.2). */
export const imagenConCaption = sobre(
  {
    imageMessage: {
      url: "https://mmg.whatsapp.net/d/f/AbCdEf.enc",
      mimetype: "image/jpeg",
      caption: "el asado de ayer",
      fileSha256: bytes(32),
      fileLength: 184320,
      height: 1600,
      width: 1200,
      mediaKey: bytes(32),
      directPath: "/v/t62.7118-24/12345_678_910_n.enc",
    },
  },
  { id: "3EB0IMAGEN000000001", pushName: "Ana Gómez" },
);

/** Video con caption y duración. */
export const videoConCaption = sobre(
  {
    videoMessage: {
      url: "https://mmg.whatsapp.net/d/f/GhIjKl.enc",
      mimetype: "video/mp4",
      caption: "salió bien la jugada",
      seconds: 95,
      fileLength: 2048000,
      directPath: "/v/t62.7161-24/54321_098_765_n.enc",
    },
  },
  { id: "3EB0VIDEO0000000001", pushName: "Ana Gómez" },
);

/** Nota de voz con duración: `🎤 audio 0:12` (CA-7.1). */
export const audioConSegundos = sobre(
  {
    audioMessage: {
      url: "https://mmg.whatsapp.net/d/f/MnOpQr.enc",
      mimetype: "audio/ogg; codecs=opus",
      seconds: 12,
      ptt: true,
      fileLength: 9216,
      waveform: bytes(64),
    },
  },
  { id: "3EB0AUDIO0000000001", pushName: "Ana Gómez" },
);

/** El mismo audio SIN `seconds`: el label sale pelado, jamás "undefined" (CA-7.3). */
export const audioSinSegundos = sobre(
  {
    audioMessage: {
      url: "https://mmg.whatsapp.net/d/f/StUvWx.enc",
      mimetype: "audio/ogg; codecs=opus",
      ptt: true,
      fileLength: 7168,
    },
  },
  { id: "3EB0AUDIO0000000002", pushName: "Ana Gómez" },
);

/** Documento con nombre: el label ES el nombre del archivo (CA-7.1). */
export const documentoConNombre = sobre(
  {
    documentMessage: {
      url: "https://mmg.whatsapp.net/d/f/YzAbCd.enc",
      mimetype: "application/pdf",
      fileName: "informe final.pdf",
      title: "informe final",
      pageCount: 12,
      fileLength: 512000,
    },
  },
  { id: "3EB0DOC000000000001", pushName: "Ana Gómez" },
);

/** Documento sin `fileName` ni `title`: cae en "📎 documento" (CA-7.3). */
export const documentoSinNombre = sobre(
  {
    documentMessage: {
      url: "https://mmg.whatsapp.net/d/f/EfGhIj.enc",
      mimetype: "application/octet-stream",
      fileLength: 2048,
    },
  },
  { id: "3EB0DOC000000000002", pushName: "Ana Gómez" },
);

export const sticker = sobre(
  {
    stickerMessage: {
      url: "https://mmg.whatsapp.net/d/f/KlMnOp.enc",
      mimetype: "image/webp",
      height: 512,
      width: 512,
      isAnimated: true,
      fileLength: 40960,
    },
  },
  { id: "3EB0STICKER00000001", pushName: "Ana Gómez" },
);

export const ubicacion = sobre(
  {
    locationMessage: {
      degreesLatitude: -34.6037,
      degreesLongitude: -58.3816,
      name: "Obelisco",
      address: "Av. 9 de Julio s/n, CABA",
    },
  },
  { id: "3EB0UBICACION000001", pushName: "Ana Gómez" },
);

export const contacto = sobre(
  {
    contactMessage: {
      displayName: "Carlos Pérez",
      vcard:
        "BEGIN:VCARD\nVERSION:3.0\nN:Pérez;Carlos;;;\nFN:Carlos Pérez\nTEL;type=CELL;waid=5491144556677:+54 9 11 4455-6677\nEND:VCARD",
    },
  },
  { id: "3EB0CONTACTO0000001", pushName: "Ana Gómez" },
);

/**
 * Un tipo que hoy no existe. WhatsApp agrega contenidos nuevos todo el tiempo y
 * `getContentType` los devuelve igual (le alcanza con que la clave termine en
 * `Message`): tiene que caer en `unsupported` y persistirse (CA-7.5).
 */
export const tipoInventado = sobre(
  { mensajeDelFuturoMessage: { payload: "algo que todavía no inventaron" } } as WAMessage["message"],
  { id: "3EB0FUTURO000000001", pushName: "Ana Gómez" },
);

/** Mensaje de grupo: el autor es `key.participant`, no el jid del chat (CA-6.3). */
export const mensajeDeGrupo = sobre(
  { conversation: "che, ¿a qué hora quedamos?" },
  {
    jid: JID_GRUPO,
    id: "3EB0GRUPO0000000001",
    participant: JID_PARTICIPANTE,
    pushName: "Beto",
  },
);

/** Eco de un mensaje mandado desde el teléfono: llega con `fromMe: true` (CA-9.5). */
export const ecoPropio = sobre(
  { conversation: "voy saliendo" },
  { id: "3EB0ECOPROPIO000001", fromMe: true },
);

/** El mismo eco pero envuelto en `deviceSentMessage`, como llega por el sync de historial. */
export const ecoPropioEnvuelto = sobre(
  {
    deviceSentMessage: {
      destinationJid: JID_CONTACTO,
      message: { conversation: "esto lo mandé desde el teléfono" },
    },
  },
  { id: "3EB0ECOENVUELTO0001", fromMe: true },
);

/** Mensaje efímero: `normalizeMessageContent` lo desenvuelve hasta el texto. */
export const textoEfimero = sobre(
  {
    ephemeralMessage: {
      message: { extendedTextMessage: { text: "esto se borra en 24 h" } },
    },
  },
  { id: "3EB0EFIMERO00000001", pushName: "Ana Gómez" },
);

/** Sin `messageTimestamp`: el mapeo tiene que poner `now` (§8.4). */
export const sinTimestamp = sobre(
  { conversation: "¿y la hora?" },
  { id: "3EB0SINTS0000000001", ts: null },
);

/**
 * `Long` de protobufjs de mentira, con el `toNumber()` que usa `baileys.toNumber`.
 * Es función y no constante porque los tests arman varios con distinto valor.
 */
export function longDe(segundos: number): { low: number; high: number; unsigned: boolean; toNumber(): number } {
  return {
    low: segundos | 0,
    high: Math.floor(segundos / 2 ** 32),
    unsigned: true,
    toNumber: () => segundos,
  };
}

/** Timestamp como `Long` del proto (lo normal cuando pasa por protobufjs). */
export const tsComoLong = sobre(
  { conversation: "vengo del proto" },
  { id: "3EB0TSLONG000000001", ts: longDe(TS_BASE) },
);

/**
 * Timestamp en MILISEGUNDOS: finito y positivo, pero es el año 56.000. Pasa
 * cualquier chequeo ingenuo y clava el chat arriba de la bandeja para siempre
 * (`ORDER BY last_message_at DESC`), así que tiene que caer en `now`.
 */
export const tsBasura = sobre(
  { conversation: "reloj roto" },
  { id: "3EB0TSBASURA0000001", ts: TS_BASE * 1000 },
);

// ── se descartan (mapMessage ⇒ null) ────────────────────────────────────────

/** Un estado de WhatsApp: no es un chat (§5.4). */
export const estadoBroadcast = sobre({ conversation: "mi estado del día" }, {
  jid: JID_STATUS,
  id: "3EB0ESTADO000000001",
  participant: JID_CONTACTO,
});

/** Un canal: tampoco es un chat (§5.4). */
export const newsletter = sobre({ conversation: "novedades del canal" }, {
  jid: JID_NEWSLETTER,
  id: "3EB0CANAL0000000001",
});

/** Borrado por su autor, forma cruda: `protocolMessage` con `type: REVOKE` (CA-6.9). */
export const revoke = sobre(
  {
    protocolMessage: {
      key: { remoteJid: JID_CONTACTO, fromMe: false, id: "3EB0TEXTO0000000001" },
      type: proto.Message.ProtocolMessage.Type.REVOKE,
    },
  },
  { id: "3EB0REVOKE0000000001" },
);

/**
 * El mismo borrado como lo reemite baileys por `messages.update`: sin `message`,
 * con `messageStubType: REVOKE` y el id de la víctima ya en `key.id`
 * (`Utils/process-message.js:298`).
 */
export const revokeAplanado: WAMessage = {
  key: { remoteJid: JID_CONTACTO, fromMe: false, id: "3EB0TEXTO0000000001" },
  message: null,
  messageStubType: proto.WebMessageInfo.StubType.REVOKE,
  messageTimestamp: TS_BASE,
};

/** `protocolMessage` que NO es revoke: señal interna, no se muestra (§5.4). */
export const protocoloNoRevoke = sobre(
  {
    protocolMessage: {
      type: proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING,
      ephemeralExpiration: 86400,
    },
  },
  { id: "3EB0PROTO0000000001" },
);

/** Reacción: se descarta sin persistir (§5.4). */
export const reaccion = sobre(
  {
    reactionMessage: {
      key: { remoteJid: JID_CONTACTO, fromMe: false, id: "3EB0TEXTO0000000001" },
      text: "❤️",
      senderTimestampMs: TS_BASE * 1000,
    },
  },
  { id: "3EB0REACCION0000001" },
);

/** Sin `key.remoteJid` no hay chat al que pertenecer (§5.4). */
export const sinRemoteJid: WAMessage = {
  key: { fromMe: false, id: "3EB0SINJID000000001" },
  message: { conversation: "¿de qué chat soy?" },
  messageTimestamp: TS_BASE,
};

/** Sin `key.id` no hay dedupe posible: el índice único es (chat_jid, wa_id). */
export const sinWaId: WAMessage = {
  key: { remoteJid: JID_CONTACTO, fromMe: false },
  message: { conversation: "no tengo id" },
  messageTimestamp: TS_BASE,
};

/**
 * Índice por nombre, para los tests de tabla y para las tareas que vengan.
 * El orden es el del `done when` de la tarea 5.
 */
export const FIXTURES = {
  textoPlano,
  textoExtendido,
  imagenConCaption,
  videoConCaption,
  audioConSegundos,
  audioSinSegundos,
  documentoConNombre,
  documentoSinNombre,
  sticker,
  ubicacion,
  contacto,
  tipoInventado,
  mensajeDeGrupo,
  ecoPropio,
  ecoPropioEnvuelto,
  textoEfimero,
  sinTimestamp,
  tsComoLong,
  tsBasura,
  estadoBroadcast,
  newsletter,
  revoke,
  revokeAplanado,
  protocoloNoRevoke,
  reaccion,
  sinRemoteJid,
  sinWaId,
} satisfies Record<string, WAMessage>;

/** Los que `mapMessage` tiene que descartar devolviendo `null` (§5.4). */
export const DESCARTADOS = [
  "estadoBroadcast",
  "newsletter",
  "revoke",
  "revokeAplanado",
  "protocoloNoRevoke",
  "reaccion",
  "sinRemoteJid",
  "sinWaId",
] as const satisfies ReadonlyArray<keyof typeof FIXTURES>;
