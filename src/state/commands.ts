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
// Hoy están los del esqueleto (tarea 9), los de vinculación (tarea 10), los de
// la bandeja —selección, filtro y buscador— (tarea 12), los de envío (tarea 14),
// los de leído (tarea 15) y los de la búsqueda global (tarea 16).
import type { Logger } from "../boot/log";
import type { Repo } from "../db/repo";
import type { ChatRow } from "../db/types";
import { fold } from "../lib/fmt";
import type { ReadReceipts } from "../wa/read";
import type { SendQueue } from "../wa/send";
import type { WaController } from "../wa/socket";
import type { InboxFilter, LinkSnapshot, Store } from "./store";

export type CommandDeps = {
  repo: Repo;
  wa: WaController;
  store: Store;
  log: Logger;
  /**
   * Cola de envío (tarea 14). Es opcional para que los tests de interfaz que no
   * mandan nada no tengan que armar una: sin ella, `send` avisa en vez de
   * romper. En producción SIEMPRE viene (la cablea el entry).
   */
  send?: SendQueue;
  /**
   * Recibos de lectura (tarea 15). Opcional por el mismo motivo que `send`: sin
   * ella el chat se marca leído en LOCAL igual —que es todo lo que necesita un
   * test de interfaz— y no sale ninguna llamada a WhatsApp.
   *
   * ⚠️ Se inyecta y no se importa: `wa/read.ts` arrastra baileys (~260 ms de
   * import) y este módulo lo carga la interfaz, que tiene que estar en pantalla
   * en menos de 1 s (CA-13.1). El `import type` de arriba se borra al compilar.
   */
  read?: ReadReceipts;
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

/**
 * Resultado de un comando que la interfaz tiene que poder explicar en pantalla.
 *
 * El `reason?: undefined` de la rama buena no es adorno: el proyecto compila con
 * `strict: false` (decisión del diseño) y **sin `strictNullChecks` TypeScript no
 * angosta una unión por un booleano literal** —verificado—, así que sin declarar
 * la propiedad en las dos ramas, un `r.ok ? … : r.reason` no compila.
 */
export type Resultado = { ok: true; reason?: undefined } | { ok: false; reason: string };

/** Mínimo y máximo de dígitos de un teléfono internacional (CA-2.2). */
export const TEL_MIN = 8;
export const TEL_MAX = 15;

/** El ejemplo va en TODOS los mensajes de formato: explicar sin mostrar no sirve. */
const EJEMPLO_TEL = "ej.: 5491122334455";

export const MOTIVO_TEL_NO_DIGITOS = `sólo dígitos, sin + ni separadores (${EJEMPLO_TEL})`;

/** Los mensajes son cortos a propósito: entran en una línea de 80 columnas. */
export const motivoTelLargo = (n: number): string =>
  `el número tiene ${n} ${n === 1 ? "dígito" : "dígitos"}: van entre ${TEL_MIN} y ${TEL_MAX} (${EJEMPLO_TEL})`;

/**
 * Valida el teléfono del código de emparejamiento (CA-2.2): formato
 * internacional, **sólo dígitos**, entre 8 y 15.
 *
 * Vive acá y no en el componente porque los dos caminos que pueden pedir un
 * código —el `⏎` del input y el `Ctrl-R` de "generá uno nuevo" (CA-2.5)— pasan
 * por `requestPairing`, y una segunda copia de la regla en la vista se
 * desincroniza el día que cambie.
 */
export function validarTelefono(
  raw: string | null | undefined,
): { ok: true; digits: string } | { ok: false; reason: string } {
  const texto = String(raw ?? "").trim();
  if (texto === "" || /\D/.test(texto)) return { ok: false, reason: MOTIVO_TEL_NO_DIGITOS };
  if (texto.length < TEL_MIN || texto.length > TEL_MAX) {
    return { ok: false, reason: motivoTelLargo(texto.length) };
  }
  return { ok: true, digits: texto };
}

// ── bandeja: etiqueta, filtro y selección (CA-4.*, CA-5.*, CA-10.4) ─────────
//
// Estos tres son PUROS y viven acá, no en `ui/Inbox.tsx`, porque los usan los dos
// lados: la vista para pintar y los comandos para mover el cursor. Si el filtro
// viviera en la vista, `moveSelection` no sabría sobre qué lista se está
// moviendo — y la primera vez que alguien tipeara en el buscador, el cursor
// saltaría a un chat que no está en pantalla.
//
// `commands.ts` puede importar de `lib/`, pero JAMÁS de `wa/`: `resolveChatName`
// (§5.4) vive en `wa/map.ts`, que arrastra baileys entero (~260 ms de import) y
// se comería el presupuesto de CA-13.1. De ahí que la precedencia de nombres se
// repita acá, sin baileys.

/** Los tres filtros en el orden en que los cicla `Tab` (CA-5.5). */
export const FILTROS: InboxFilter[] = ["all", "unread", "groups"];

/** Un jid mostrable cuando no hay ningún nombre: `+549…`, `~lid` o el jid crudo. */
function jidLegible(jid: string): string {
  const corte = jid.indexOf("@");
  const user = corte < 0 ? jid : jid.slice(0, corte);
  const server = corte < 0 ? "" : jid.slice(corte + 1);
  if (!user) return jid;
  // Un `@lid` NO es un teléfono: es el identificador opaco que WhatsApp usa para
  // no revelar el número. Pintarlo con `+` sería inventarle un número que no
  // existe y que nadie puede marcar. El `~` es la marca de "identidad sin
  // nombre" que usa el propio WhatsApp.
  if (server === "lid") return `~${user}`;
  return /^\d+$/.test(user) ? `+${user}` : user;
}

/**
 * El nombre que se VE en la fila de la bandeja (CA-4.1, CA-4.8).
 *
 * La precedencia es la de §5.4 —subject > agenda > `pushName` > número—, con
 * `chats.name` haciendo de subject en un grupo y de `pushName` en un 1:1.
 *
 * El fallback al número NO es cosmético: un chat creado por un mensaje SALIENTE
 * queda con `name: ""` a propósito (el `pushName` del eco de uno mismo es uno
 * mismo, y renombraría el chat con el nombre propio), así que sin esto la fila
 * se vería EN BLANCO.
 */
export function etiquetaChat(chat: Pick<ChatRow, "jid" | "name" | "contactName" | "isGroup">): string {
  const nombre = String(chat?.name ?? "").trim();
  // En un grupo la agenda no aplica: `contacts` guarda personas, no grupos.
  if (chat?.isGroup) return nombre || "grupo sin nombre";
  return String(chat?.contactName ?? "").trim() || nombre || jidLegible(String(chat?.jid ?? ""));
}

/**
 * ¿Este chat coincide con lo que se tipeó? `aguja` viene YA plegada (`fold`).
 *
 * ⚠️ **Es el predicado que iguala a los dos buscadores** (decisión de la tarea
 * 16). El de la bandeja miraba sólo la etiqueta VISIBLE + el jid, mientras que
 * `repo.searchChats` mira `chats.name`, `contacts.name` y el jid: un chat cuyo
 * `pushName` quedó tapado por el nombre de la agenda (chat "Pepe", agenda
 * "José") **no era encontrable por `pepe` en la bandeja pero sí en la búsqueda
 * global** — la misma query daba distinto según dónde se escribiera.
 *
 * Se resolvió hacia el LADO AMPLIO —se busca por cualquier nombre que WhatsApp
 * conozca del chat, no sólo por el que se ve—, porque el otro lado (recortar la
 * búsqueda global a la etiqueta visible) esconde un chat que el usuario tiene
 * derecho a encontrar por el nombre que la persona se puso. La etiqueta visible
 * se sigue mirando: es la que cubre los fallbacks que no salen de ninguna
 * columna (`+549…`, `~lid`, `grupo sin nombre`).
 */
export function coincideChat(
  chat: Pick<ChatRow, "jid" | "name" | "contactName" | "isGroup">,
  aguja: string,
): boolean {
  if (!aguja) return true;
  return (
    fold(etiquetaChat(chat)).includes(aguja) ||
    fold(String(chat?.name ?? "")).includes(aguja) ||
    fold(String(chat?.contactName ?? "")).includes(aguja) ||
    fold(String(chat?.jid ?? "")).includes(aguja)
  );
}

/**
 * Los chats que la bandeja muestra AHORA: primero el filtro de tabs (CA-5.5,
 * CA-10.4) y después el texto del buscador (CA-5.2), que compara sin acentos ni
 * mayúsculas (ver `coincideChat`).
 *
 * Se filtra en memoria y no con `repo.searchChats` a propósito: `inbox.chats` ya
 * está en RAM, es la MISMA lista que se está viendo, y una consulta por tecla
 * sobre la base sería I/O regalado (RNF-6).
 */
export function filtrarChats(chats: ChatRow[], filtro: InboxFilter, query: string): ChatRow[] {
  const aguja = fold(String(query ?? "").trim());
  const salida: ChatRow[] = [];
  for (const c of chats) {
    if (filtro === "unread" && c.unreadCount <= 0) continue;
    if (filtro === "groups" && !c.isGroup) continue;
    if (!coincideChat(c, aguja)) continue;
    salida.push(c);
  }
  return salida;
}

/**
 * El jid seleccionado EFECTIVO. El guardado si sigue a la vista; si no, el
 * primero de la lista.
 *
 * Hace falta porque la lista cambia por debajo sin que el usuario toque nada: un
 * mensaje entrante puede sacar un chat del filtro `No leídos`. El jid guardado
 * queda como estaba hasta la próxima acción del usuario —así el cursor no se
 * mueve solo— y todos los que lo leen resuelven igual.
 */
export function seleccionVigente(visibles: ChatRow[], jid: string | null): string | null {
  if (jid && visibles.some((c) => c.jid === jid)) return jid;
  return visibles.length > 0 ? (visibles[0] as ChatRow).jid : null;
}

/** Lo que hace falta para mover el cursor: la lista visible y dónde está parado. */
function vistaBandeja(d: CommandDeps): { visibles: ChatRow[]; actual: string | null } {
  const ui = d.store.inboxUi();
  const visibles = filtrarChats(d.store.getSnapshot("inbox").chats, ui.inboxFilter, ui.inboxQuery);
  return { visibles, actual: seleccionVigente(visibles, ui.selectedJid) };
}

/** `Home`/`End`: un delta que siempre se pasa de largo y queda clavado en la punta. */
export const SALTO_EXTREMO = Number.MAX_SAFE_INTEGER;

export type Commands = {
  /** Abre el chat y lo marca leído (CA-6.1, CA-11.1). `anchorId` = salto desde la búsqueda. */
  openChat(jid: string, opts?: { anchorId?: number }): void;
  /**
   * Carga la ventana de mensajes del chat (CA-6.1): los últimos `VENTANA_DEFAULT`,
   * o los que rodean a `anchorId` cuando se llega desde un resultado de búsqueda
   * (CA-12.3). No marca leído ni mueve el cursor de la bandeja: es sólo la
   * ventana, que es lo que necesita el salto de la tarea 16.
   */
  loadWindow(jid: string, anchorId?: number | null): void;
  /**
   * Suelta el ancla: la ventana vuelve a ser "los últimos 500".
   *
   * El ancla existe para UN salto (CA-12.3) y `construirConvo` la aplica en
   * TODOS los flush siguientes, así que si no se suelta el chat queda congelado:
   * los mensajes que llegan después no entran en `messagesAround` y la
   * conversación deja de crecer aunque la bandeja se actualice. Quién decide
   * cuándo soltarla es `ui/Conversation.tsx`, que es el único que sabe si el
   * usuario todavía está mirando el salto.
   */
  releaseAnchor(): void;
  closeChat(): void;
  /** Abre el chat seleccionado en la bandeja (`⏎`, CA-6.1). Sin selección no hace nada. */
  openSelectedChat(): void;
  /**
   * Marca el chat como leído: contador a 0 en la base (CA-11.1) y recibo de
   * lectura a WhatsApp si están habilitados (CA-11.2/11.3). Lo llama `openChat`.
   */
  markRead(jid: string): void;
  /**
   * `Ctrl-L` (CA-11.5): marca leído el chat SELECCIONADO de la bandeja, sin
   * abrirlo. Resuelve cuál es acá y no en la vista por lo mismo que
   * `openSelectedChat`: la lista visible depende del filtro y del buscador, y de
   * eso sabe este módulo.
   */
  markSelectedRead(): void;
  /**
   * Manda un texto al chat (CA-8.2). Devuelve el motivo cuando NO se mandó, para
   * que el composer sepa que tiene que conservar el texto (CA-8.7).
   */
  send(jid: string, text: string): Resultado;
  /**
   * Reintenta un envío fallado (`Ctrl-Y`, CA-9.3). Sin argumentos toma el ÚLTIMO
   * `failed` del chat abierto, que es lo que hace la tecla: la interfaz no tiene
   * por qué salir a buscar cuál era.
   */
  retrySend(chatJid?: string, waId?: string): Resultado;
  /** Pone el cursor sobre un chat (click, CA-5.6). */
  selectChat(jid: string): void;
  /** Mueve el cursor `delta` filas dentro de la lista VISIBLE, sin dar la vuelta (CA-5.3, CA-5.7). */
  moveSelection(delta: number): void;
  /** Aplica un filtro (click en un tab, CA-5.8). */
  setInboxFilter(filtro: InboxFilter): void;
  /** `Tab`: Todos → No leídos → Grupos → Todos (CA-5.5). */
  cycleInboxFilter(): void;
  /** Texto del buscador de la bandeja (CA-5.2). `""` vuelve a la lista completa (CA-5.4). */
  setInboxQuery(query: string): void;
  /**
   * `Ctrl-G`: entra a la búsqueda global. Guarda el estado de la bandeja
   * —chat seleccionado, filtro y texto del buscador— para poder devolverlo tal
   * cual con `Esc` (CA-12.8), y arranca con la lista vacía.
   */
  openSearch(): void;
  /**
   * Texto de la búsqueda global (CA-12.1). Llega YA debounceado desde la vista
   * (RNF-7): el store resuelve `buildFtsQuery` + FTS en el flush siguiente, así
   * que acá no hay ni una consulta.
   */
  search(query: string): void;
  /**
   * Sale de la búsqueda global. Con `restaurar` (el `Esc` de CA-12.8) la bandeja
   * vuelve exactamente a como estaba; sin él —el `⏎` que saltó a un mensaje
   * (CA-12.3)— se la deja donde la dejó el salto, que es donde el usuario quiso
   * terminar.
   */
  closeSearch(restaurar?: boolean): void;
  /** Conecta en el acto, salteando el backoff (CA-15.5). */
  reconnectNow(): void;
  /** Alterna QR ↔ código a mano (`Tab`, CA-2.6). NO toca el socket (D11). */
  chooseLinkMethod(m: "qr" | "code"): void;
  /**
   * Pide el código de emparejamiento (CA-2.3). Sin número reusa el último válido:
   * es el camino de `Ctrl-R` cuando el código venció (CA-2.5).
   * Devuelve el motivo cuando el número no pasa el formato, para poder mostrarlo
   * al lado del input sin dar una vuelta por el store (CA-2.2).
   */
  requestPairing(phoneDigits?: string): Resultado;
  quit(code?: number): void;
};

/** Último teléfono VÁLIDO usado: lo reusa el `Ctrl-R` de "código nuevo" (CA-2.5). */
let ultimoTelefono = "";

/**
 * Cómo estaba la bandeja al abrir la búsqueda global, para el `Esc` (CA-12.8).
 *
 * Vive acá y no en un `useState` de la vista porque es estado de la MÁQUINA —lo
 * que hay que devolverle al store—, y porque el overlay se desmonta al salir:
 * guardarlo adentro sería guardarlo en algo que muere justo cuando hace falta.
 */
let bandejaGuardada: ReturnType<Store["inboxUi"]> | null = null;

/** Fases que la elección manual de método puede reescribir sin pisar nada. */
const FASES_EN_CURSO = new Set(["checking", "need-link", "qr-waiting", "qr-shown", "pairing-phone", "pairing-shown"]);

export const commands: Commands = {
  openChat(jid, opts) {
    if (!deps || !jid) return;
    commands.loadWindow(jid, opts?.anchorId ?? null);
    // El chat que se abre queda seleccionado: si se llegó por click sobre una
    // fila que no era la del cursor —o por el salto desde la búsqueda global
    // (CA-12.3)—, el cursor tiene que terminar donde terminó el usuario.
    deps.store.setInboxUi({ selectedJid: jid });
    commands.markRead(jid);
  },

  // La ventana en sí la arma el store: el slice `convo` es una PROYECCIÓN (D2),
  // así que decirle cuál es el chat abierto y con qué ancla ya alcanza para que
  // el próximo flush consulte `lastMessages` o `messagesAround` según el caso.
  loadWindow(jid, anchorId) {
    if (!deps || !jid) return;
    deps.store.setOpenChat(jid, { anchorId: anchorId ?? null });
  },

  releaseAnchor() {
    if (!deps) return;
    const jid = deps.store.openChatJid();
    if (jid === null) return;
    deps.store.setOpenChat(jid);
  },

  openSelectedChat() {
    if (!deps) return;
    const { actual } = vistaBandeja(deps);
    if (actual) commands.openChat(actual);
  },

  closeChat() {
    deps?.store.setOpenChat(null);
  },

  selectChat(jid) {
    if (!deps || !jid) return;
    deps.store.setInboxUi({ selectedJid: jid });
  },

  moveSelection(delta) {
    if (!deps || !Number.isFinite(delta) || delta === 0) return;
    const { visibles, actual } = vistaBandeja(deps);
    if (visibles.length === 0) {
      // Lista vacía: el cursor se suelta, no queda apuntando a un fantasma.
      if (actual !== null) deps.store.setInboxUi({ selectedJid: null });
      return;
    }
    // `actual` siempre está en `visibles` (lo garantiza `seleccionVigente`), así
    // que el índice nunca es −1.
    const i = visibles.findIndex((c) => c.jid === actual);
    const j = Math.max(0, Math.min(visibles.length - 1, i + delta));
    deps.store.setInboxUi({ selectedJid: (visibles[j] as ChatRow).jid });
  },

  setInboxFilter(filtro) {
    if (!deps || !FILTROS.includes(filtro)) return;
    const ui = deps.store.inboxUi();
    // El cursor se REANCLA en el mismo movimiento: si el chat que estaba
    // seleccionado no pasa el filtro nuevo, salta al primero de la lista nueva.
    // Un solo `setInboxUi` ⇒ un solo `markDirty` ⇒ un solo render (D3).
    const visibles = filtrarChats(deps.store.getSnapshot("inbox").chats, filtro, ui.inboxQuery);
    deps.store.setInboxUi({
      inboxFilter: filtro,
      selectedJid: seleccionVigente(visibles, ui.selectedJid),
    });
  },

  cycleInboxFilter() {
    if (!deps) return;
    const actual = deps.store.inboxUi().inboxFilter;
    const i = FILTROS.indexOf(actual);
    commands.setInboxFilter(FILTROS[(i + 1) % FILTROS.length] as InboxFilter);
  },

  setInboxQuery(query) {
    if (!deps) return;
    const texto = String(query ?? "");
    const ui = deps.store.inboxUi();
    // Sin corte por "no cambió" a propósito: el snapshot está CACHEADO hasta el
    // próximo flush (D3), así que dos llamadas en el mismo tick comparan las dos
    // contra el valor viejo y la segunda se perdería. Pasa de verdad: al abrir
    // la ayuda con `?`, el campo escribe y `App` limpia, todo en la misma tecla.
    const visibles = filtrarChats(deps.store.getSnapshot("inbox").chats, ui.inboxFilter, texto);
    deps.store.setInboxUi({
      inboxQuery: texto,
      selectedJid: seleccionVigente(visibles, ui.selectedJid),
    });
  },

  openSearch() {
    if (!deps) return;
    // El estado se lee EN VIVO y no del snapshot cacheado (D3): la misma tecla
    // que abre la búsqueda pudo haber sido precedida por otra dentro del mismo
    // frame de 33 ms, y restaurar un filtro viejo sería peor que no restaurar.
    bandejaGuardada = deps.store.inboxUi();
    // La búsqueda arranca EN BLANCO: los resultados de la vez anterior no son
    // "la lista anterior" de nadie (CA-12.4) y además serían 200 filas vivas.
    deps.store.setSearchQuery("");
  },

  search(query) {
    deps?.store.setSearchQuery(String(query ?? ""));
  },

  closeSearch(restaurar = true) {
    if (!deps) return;
    const previo = bandejaGuardada;
    bandejaGuardada = null;
    deps.store.setSearchQuery("");
    if (restaurar && previo) deps.store.setInboxUi(previo);
  },

  markRead(jid) {
    if (!deps || !jid) return;
    const chat = deps.repo.getChat(jid);
    if (!chat) return;
    // El último mensaje del chat es el tope de lectura (CA-11.1).
    const ultimo = deps.repo.lastMessages(jid, 1)[0];
    // LOCAL PRIMERO, y sin depender de nada más: el recibo es best effort y el
    // chat tiene que quedar leído pase lo que pase con la red (CA-11.4).
    deps.repo.clearUnread(jid, ultimo ? ultimo.id : chat.lastReadId);
    deps.store.markDirty("inbox");

    // El recibo cubre lo que estaba SIN leer, o sea desde el `last_read_id`
    // ANTERIOR (por eso se lee `chat` antes del `clearUnread`).
    //
    // Y sólo si de verdad había algo sin leer: con el contador en 0 el chat ya
    // fue acusado —o lo marcó leído otro dispositivo (CA-11.6), que deja el
    // contador en 0 sin tocar `last_read_id`—, y mandar el recibo igual sería
    // una ráfaga de stanzas por mensajes que el otro ya vio en azul (R8).
    if (chat.unreadCount > 0) deps.read?.markRead(jid, chat.lastReadId);
  },

  markSelectedRead() {
    if (!deps) return;
    const { actual } = vistaBandeja(deps);
    if (actual) commands.markRead(actual);
  },

  send(jid, text) {
    const d = deps;
    if (!d) return { ok: false, reason: "todavía no arrancó la aplicación" };
    if (!d.send) return { ok: false, reason: "el envío todavía no está disponible" };
    const r = d.send.enqueue(jid, text);
    if (r.ok) {
      // El borrador se suelta recién cuando el mensaje YA está en la base: si el
      // envío se rechaza (CA-8.7), el texto tiene que seguir en el campo.
      d.store.setDraft(jid, "");
      return { ok: true };
    }
    // CA-8.7: el rechazo se AVISA. Sin esto, apretar `⏎` sin conexión no hace
    // nada visible y parece que la tecla no anduvo.
    d.store.toast(r.reason);
    d.log.warn("send.rechazado", { motivo: r.reason });
    return { ok: false, reason: r.reason };
  },

  retrySend(chatJid, waId) {
    const d = deps;
    if (!d) return { ok: false, reason: "todavía no arrancó la aplicación" };
    // TODOS los caminos avisan por el pie, incluidos los de "no había nada que
    // reintentar": una tecla que a veces no hace NADA visible parece rota.
    const avisar = (motivo: string): Resultado => {
      d.store.toast(motivo);
      return { ok: false, reason: motivo };
    };
    if (!d.send) return avisar("el envío todavía no está disponible");
    const jid = chatJid || d.store.openChatJid();
    if (!jid) return avisar("no hay ningún chat abierto");
    // Sin `waId` explícito: el último fallado de ese chat. `openSends` sale del
    // índice parcial de `status IN ('pending','failed')`, así que es una lista
    // corta aunque la base tenga 50.000 mensajes.
    let id = waId ?? "";
    if (!id) {
      for (const m of d.repo.openSends()) {
        if (m.chatJid === jid && m.status === "failed") id = m.waId;
      }
    }
    if (!id) return avisar("no hay ningún envío fallado en este chat");
    const r = d.send.retry(jid, id);
    if (!r.ok) return avisar(r.reason);
    d.store.toast("reintentando el envío…");
    return { ok: true };
  },

  reconnectNow() {
    if (!deps) return;
    deps.wa.reconnectNow();
    // CA-19.5: reconectar no se ve solo hasta que el badge cambia.
    deps.store.toast("reconectando…");
  },

  chooseLinkMethod(m) {
    if (!deps) return;
    const link = deps.store.getSnapshot("link");
    // D11: el socket NO se toca. Los `qr` siguen llegando y actualizando el
    // payload en memoria aunque se esté mostrando el código, así que alternar es
    // un cambio de pintura y redimensionar en el medio no cuesta una reconexión.
    const patch: Partial<LinkSnapshot> = { method: m, methodForced: true };
    // La fase sigue al método sólo cuando describe una vinculación EN CURSO:
    // `failed` (405, pairing rechazado), `restarting` y `linked` dicen algo que
    // el usuario necesita leer, y pisarlas sería esconderlo.
    //
    // Y al volver al código con uno ya pedido se muestra ESE, no el input: el
    // código sigue siendo válido, hacérselo pedir de nuevo sería gratis pero
    // molesto (y una llamada más a WhatsApp).
    if (FASES_EN_CURSO.has(link.phase)) {
      patch.phase =
        m === "code"
          ? link.pairingCode
            ? "pairing-shown"
            : "pairing-phone"
          : link.qr
            ? "qr-shown"
            : "qr-waiting";
    }
    deps.store.setLink(patch);
    deps.log.info("link.metodo", { metodo: m, fase: patch.phase ?? link.phase });
  },

  requestPairing(phoneDigits) {
    const d = deps;
    if (!d) return { ok: false, reason: "todavía no arrancó la aplicación" };
    const v = validarTelefono(phoneDigits ?? ultimoTelefono);
    // Un número mal escrito NUNCA llega a WhatsApp ni mueve la máquina de
    // vinculación: es un error de tipeo, no un fallo de la sesión. El motivo
    // vuelve por el resultado y la vista lo muestra abajo del input (CA-2.2).
    if (!v.ok) return v;

    ultimoTelefono = v.digits;
    // El código viejo se limpia ANTES de pedir: si la solicitud falla, lo que
    // tiene que quedar en pantalla es el input y el motivo, no un código que ya
    // no vale (CA-2.4).
    d.store.setLink({
      phase: "pairing-requesting",
      method: "code",
      methodForced: true,
      pairingCode: null,
      pairingRequestedAt: null,
      reason: null,
    });
    // El teléfono NO se loguea (CA-14.7): sólo cuántos dígitos tenía.
    d.log.info("link.pairing_pedido", { digitos: v.digits.length });

    d.wa.requestPairingCode(v.digits).catch((e: unknown) => {
      const motivo = e instanceof Error ? e.message : String(e);
      // El socket ya deja `failed` + motivo cuando el que rechaza es WhatsApp;
      // este `setLink` es para el otro caso —todavía no hay socket—, que sube el
      // throw sin haber tocado el store y dejaría la pantalla en "pidiendo…"
      // para siempre.
      d.store.setLink({ phase: "failed", pairingCode: null, reason: motivo });
      d.log.warn("link.pairing_fallido", { motivo });
    });
    return { ok: true };
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
