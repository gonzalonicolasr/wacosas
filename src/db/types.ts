// Contratos de la capa de datos (design §5.1). Son los tipos que cruzan el
// límite db → store → ui: siempre camelCase y con `attachment` YA parseado, así
// nadie fuera de `db/repo.ts` se entera de que las columnas son snake_case ni de
// que el adjunto viaja como JSON adentro de una celda TEXT.

/** Tipo de contenido de un mensaje (§4.3). `unsupported` se persiste igual. */
export type MessageKind =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "document"
  | "sticker"
  | "location"
  | "contact"
  | "revoked"
  | "system"
  | "unsupported";

/**
 * Estado de un mensaje. `received` es lo que llega de afuera; el resto es el
 * ciclo de vida de un envío propio: `pending` (persistido antes de tocar la red,
 * D7) → `sent` → `delivered` → `read`, o `failed` con motivo (CA-9.3).
 */
export type MessageStatus = "received" | "pending" | "sent" | "delivered" | "read" | "failed";

export type ChatRow = {
  jid: string;
  name: string;
  /**
   * Nombre de la agenda (`contacts.name`), resuelto en la consulta con un
   * `LEFT JOIN`. Es DERIVADO: no se escribe con `upsertChat`.
   *
   * Existe porque `chats.name` de un 1:1 sale del `pushName` —el nombre que
   * eligió el otro— y §5.4 pide que el de la agenda tenga prioridad. Se lee al
   * PINTAR la fila y nunca se copia a `chats`: upsertear un chat por cada
   * contacto de la agenda llenaría la bandeja de gente con la que nunca hablaste.
   */
  contactName: string;
  isGroup: boolean;
  /** Epoch en SEGUNDOS del último mensaje: es el orden de la bandeja (CA-4.2). */
  lastMessageAt: number;
  lastPreview: string;
  lastFromMe: boolean;
  unreadCount: number;
  /** `messages.id` del último leído; de acá salen las keys del recibo (CA-11.1). */
  lastReadId: number;
};

export type AttachmentInfo = {
  /** Lo que se muestra en lugar del archivo: "📷 imagen", "🎤 audio 0:12", … */
  label: string;
  filename?: string;
  seconds?: number;
  mimetype?: string;
};

export type MessageRow = {
  id: number;
  chatJid: string;
  waId: string;
  fromMe: boolean;
  senderJid: string;
  senderName: string;
  /** Epoch en SEGUNDOS. */
  ts: number;
  kind: MessageKind;
  /** Texto o caption. ES EL ÚNICO CAMPO INDEXADO EN FTS (R1, R4). */
  body: string;
  attachment: AttachmentInfo | null;
  status: MessageStatus;
  error: string | null;
};

/**
 * Un mensaje listo para insertar: `MessageRow` sin el `id` (lo pone SQLite) y
 * con el `error` opcional, que casi siempre es `null`.
 *
 * El diseño lo declara en §5.4 como salida de `wa/map.ts`, pero vive acá porque
 * es el parámetro de `repo.insertMessage` y `db/` no puede depender de `wa/`
 * (sería un ciclo). `wa/map.ts` lo reexporta cuando se implemente (tarea 5).
 */
export type MappedMessage = Omit<MessageRow, "id" | "error"> & { error?: string | null };

/** Un resultado de la búsqueda global, con el fragmento ya partido (CA-12.2). */
export type SearchHit = {
  messageId: number;
  chatJid: string;
  chatName: string;
  isGroup: boolean;
  ts: number;
  fromMe: boolean;
  /** Trozos alternados del snippet: `hit: true` son los términos a resaltar. */
  parts: Array<{ text: string; hit: boolean }>;
};
