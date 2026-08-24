// La ÚNICA puerta de la interfaz hacia la máquina (design §5.5). Los componentes
// no tocan `repo`, ni el socket, ni el ingest: llaman a un comando y se olvidan.
//
// Las dependencias se INYECTAN una vez desde `index.tsx` (`configureCommands`) en
// vez de importarse acá: si este módulo importara `db/open` o `wa/socket`, montar
// un componente en un test arrastraría la base y Baileys enteros.
//
// Ningún comando lanza: la interfaz no tiene dónde atajar una excepción y una que
// se escape en un handler de teclado se lleva puesto el render.
//
// Hoy están los del esqueleto (tarea 9). Los de vinculación (`chooseLinkMethod`,
// `requestPairing`) los agrega la tarea 10, los de envío (`send`, `retrySend`) la
// 14 y la búsqueda global la 16.
import type { Logger } from "../boot/log";
import type { Repo } from "../db/repo";
import type { WaController } from "../wa/socket";
import type { Store } from "./store";

export type CommandDeps = {
  repo: Repo;
  wa: WaController;
  store: Store;
  log: Logger;
  /**
   * Cierre del proceso. Hoy es el mínimo que deja la terminal usable; la tarea 17
   * lo reemplaza por el apagado ordenado de §6.6 sin tocar a los llamadores.
   */
  shutdown(code?: number): void;
};

let deps: CommandDeps | null = null;

/** Cablea los comandos. Se llama UNA vez, desde el entry, antes de renderizar. */
export function configureCommands(d: CommandDeps): void {
  deps = d;
}

export type Commands = {
  /** Abre el chat y lo marca leído (CA-6.1, CA-11.1). `anchorId` = salto desde la búsqueda. */
  openChat(jid: string, opts?: { anchorId?: number }): void;
  closeChat(): void;
  /** Marca leído SOLO en local; el recibo a WhatsApp lo agrega la tarea 15 (CA-11.3). */
  markRead(jid: string): void;
  /** Conecta en el acto, salteando el backoff (CA-15.5). */
  reconnectNow(): void;
  quit(code?: number): void;
};

export const commands: Commands = {
  openChat(jid, opts) {
    if (!deps || !jid) return;
    deps.store.setOpenChat(jid, { anchorId: opts?.anchorId ?? null });
    commands.markRead(jid);
  },

  closeChat() {
    deps?.store.setOpenChat(null);
  },

  markRead(jid) {
    if (!deps || !jid) return;
    const chat = deps.repo.getChat(jid);
    if (!chat) return;
    // El último mensaje de la ventana es el tope de lectura: de ahí salen las
    // keys del recibo que manda la tarea 15 (CA-11.1).
    const ultimo = deps.repo.lastMessages(jid, 1)[0];
    deps.repo.clearUnread(jid, ultimo ? ultimo.id : chat.lastReadId);
    deps.store.markDirty("inbox");
  },

  reconnectNow() {
    if (!deps) return;
    deps.wa.reconnectNow();
    // CA-19.5: reconectar no se ve solo hasta que el badge cambia.
    deps.store.toast("reconectando…");
  },

  quit(code = 0) {
    if (!deps) {
      process.exit(code);
      return;
    }
    deps.log.info("app.quit", { code });
    deps.shutdown(code);
  },
};
