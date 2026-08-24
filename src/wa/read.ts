// Recibos de lectura: el único lugar del proyecto que le dice a WhatsApp "esto
// ya lo leí" (design §6.2 `pushReadReceipt`, §8.5, CA-11.2/11.3/11.4).
//
// ⚠️ **Un recibo de lectura lo VE la otra persona.** Es la única acción de este
// proyecto —además de enviar— que se nota del otro lado, así que las reglas son
// más estrictas que en el resto:
//
//  1. **`readReceipts: false` ⇒ CERO llamadas** (CA-11.3). No se llama y se
//     descarta el resultado: no se llega ni a armar las claves. Si esta bandera
//     está apagada, este archivo no toca la red ni una vez.
//  2. **El recibo es best effort y NUNCA bloquea** (CA-11.4). Nada de `await`
//     hacia afuera, nada de excepciones que suban: el chat ya quedó leído en
//     local antes de llegar acá (`commands.markRead`), y lo que pase con la red
//     no puede volver atrás esa decisión ni frenar la navegación.
//  3. **Sin conexión no se manda NI SE ENCOLA** (§8.5). El `last_read_id` local
//     ya refleja la verdad; un recibo diferido que sale tres horas después no le
//     sirve a nadie y sí le miente al otro sobre CUÁNDO lo leíste.
//
// Lo que este archivo **no** hace es marcar leído en local: eso vive en
// `commands.markRead` (repo + store), que es quien tiene esas dos cosas a mano.
// Es un desvío chico de §5.4 —que describe este módulo como "markRead local +
// recibos"— y evita la única alternativa, que era duplicar el `clearUnread` acá
// y en el comando para que los tests de interfaz sigan andando sin socket.
import { isJidGroup } from "baileys";
import type { WAMessageKey } from "baileys";

import type { Logger } from "../boot/log";
import type { Repo } from "../db/repo";

import type { WaController } from "./socket";

/**
 * Tope de claves por recibo.
 *
 * `readMessages` agrupa las claves por `(chat, participante)` y manda **una**
 * stanza por grupo (`aggregateMessageKeysNotFromMe`), así que el costo de red es
 * chico. El tope es contra el otro riesgo: un chat que nunca se leyó puede tener
 * miles de mensajes sin leer del sync inicial, y anunciarlos todos de golpe es
 * exactamente el ritmo de bot que evita R8. Con las últimas 200 el otro lado ve
 * el doble tilde azul igual —lo que mira es el mensaje más nuevo—.
 */
export const MAX_CLAVES_RECIBO = 200;

/** Lo mínimo de un mensaje entrante para armarle la clave del recibo. */
export type ReadTarget = { waId: string; senderJid: string };

export type ReadReceipts = {
  /**
   * Recibo por todo lo ENTRANTE posterior a `sinceId` (el `last_read_id` que
   * tenía el chat ANTES de marcarlo leído). Es el camino de abrir un chat
   * (CA-11.1/11.2) y el de `Ctrl-L` sin abrirlo (CA-11.5): los dos pasan por
   * `commands.markRead`.
   */
  markRead(chatJid: string, sinceId: number): void;
  /**
   * El `pushReadReceipt` de §6.2: los mensajes que acaban de entrar al chat
   * ABIERTO. Nunca hubo un no leído que mostrar (CA-11.7), así que el recibo no
   * puede salir de `markRead` —no quedó rastro en `last_read_id` de que estaban
   * sin leer— y el ingest los pasa a mano.
   */
  pushReadReceipt(chatJid: string, msgs: ReadTarget[]): void;
};

export type ReadDeps = {
  repo: Repo;
  log: Logger;
  /** Sólo lo que hace falta del controlador: así el test no arma un socket entero. */
  wa: Pick<WaController, "isOpen" | "socket">;
  /**
   * `config.readReceipts` (CA-11.3). Es un valor y no una función a propósito:
   * `config.json` se lee una vez en el arranque y no hay pantalla de ajustes
   * (R3), así que no puede cambiar mientras el proceso corre.
   */
  enabled: boolean;
};

function motivo(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * La clave que espera `readMessages`. `fromMe: false` no es adorno: baileys
 * DESCARTA las claves propias al agrupar (`aggregateMessageKeysNotFromMe`), así
 * que sin esto el recibo saldría vacío. `participant` va **sólo en grupos**: en
 * un 1:1 `sender_jid` es el chat mismo (`wa/map.ts`) y mandarlo agregaría un
 * atributo que WhatsApp no espera ahí.
 */
function clave(chatJid: string, waId: string, participant: string): WAMessageKey {
  return {
    remoteJid: chatJid,
    id: waId,
    fromMe: false,
    ...(participant ? { participant } : {}),
  };
}

export function createReadReceipts(deps: ReadDeps): ReadReceipts {
  const { repo, log, wa, enabled } = deps;

  /**
   * Manda el recibo. Sin `await` y sin propagar nada: el llamador ya dio el chat
   * por leído (CA-11.4).
   */
  function enviar(chatJid: string, keys: WAMessageKey[]): void {
    if (keys.length === 0) return;
    const sock = wa.socket();
    if (!wa.isOpen() || !sock) {
      // §8.5: no se manda y tampoco se encola. Queda la línea porque es la
      // explicación de por qué el otro no ve el tilde azul de estos mensajes.
      log.info("read.sin_conexion", { claves: keys.length });
      return;
    }

    const grupo = !!isJidGroup(chatJid);
    let pendiente: Promise<void>;
    try {
      // El `try` cubre la función que LANZA en vez de rechazar (un socket a
      // medio morir): esto cuelga de un comando de teclado y del drenador del
      // ingest, y ninguno de los dos tiene dónde atajar una excepción.
      pendiente = Promise.resolve(sock.readMessages(keys));
    } catch (e) {
      log.warn("read.recibo_fallido", { motivo: motivo(e) });
      return;
    }
    pendiente.then(
      // El jid NO se loguea entero (mismo criterio que `send.ok`): alcanza con
      // saber cuántas claves salieron y si era un grupo.
      () => log.info("read.recibo", { claves: keys.length, chat_grupo: grupo }),
      (e: unknown) => log.warn("read.recibo_fallido", { motivo: motivo(e) }),
    );
  }

  return {
    markRead(chatJid, sinceId) {
      // CA-11.3: apagado ⇒ ni siquiera se consulta la base. La salida temprana
      // va ANTES de todo lo demás en los dos métodos, a propósito.
      if (!enabled || !chatJid) return;

      const grupo = !!isJidGroup(chatJid);
      const desde = Number.isFinite(sinceId) ? sinceId : 0;
      const keys: WAMessageKey[] = [];
      // La ventana es la MISMA que se lee del chat, así que el recibo cubre lo
      // que el usuario tiene delante. Los ids son crecientes, así que "posterior
      // al último leído" es un `>` sobre `id` (el mismo campo que ancla el
      // paginado en `db/repo.ts`).
      for (const m of repo.lastMessages(chatJid, MAX_CLAVES_RECIBO)) {
        if (m.fromMe || m.id <= desde || !m.waId) continue;
        keys.push(clave(chatJid, m.waId, grupo ? m.senderJid : ""));
      }
      enviar(chatJid, keys);
    },

    pushReadReceipt(chatJid, msgs) {
      if (!enabled || !chatJid) return;
      const grupo = !!isJidGroup(chatJid);
      const keys: WAMessageKey[] = [];
      for (const m of msgs ?? []) {
        if (!m?.waId) continue;
        keys.push(clave(chatJid, m.waId, grupo ? m.senderJid : ""));
      }
      enviar(chatJid, keys);
    },
  };
}
