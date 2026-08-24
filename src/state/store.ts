// Store externo: el límite entre el dominio "máquina" (Baileys + SQLite) y el
// dominio "ojo" (React + OpenTUI). Es el corazón de D1, D2 y D3 del diseño.
//
// Las tres reglas que lo definen:
//
//  1. NO hay una segunda copia de los datos (D2). Los slices `inbox`, `convo` y
//     `search` son PROYECCIONES: cuando el ingest escribe, marca sucio el slice y
//     en el flush se vuelve a consultar la base. Así nunca puede pasar que la
//     base diga A y la pantalla diga B (CA-14.3).
//  2. La notificación es COALESCIDA (D3): el primer `markDirty` agenda el flush
//     con `max(0, 33 - (ahora - últimoFlush))` y los que vienen después sólo
//     suman slices. Una ráfaga de 500 mensajes del sync inicial se convierte en
//     UN render, no en 500 (RNF-5, CA-4.3).
//  3. `getSnapshot` está CACHEADO: devuelve exactamente el mismo objeto hasta el
//     próximo flush que toque ese slice. No es cosmético: si le devolviera un
//     objeto nuevo en cada llamada, `useSyncExternalStore` entraría en loop
//     infinito de renders ("getSnapshot should be cached").
//
// El reloj y el agendado se INYECTAN (mismo criterio que `lib/ratelimit.ts`, que
// recibe el `now`): así el test mide la tasa de notify de diez segundos de
// tráfico en microsegundos, sin esperar diez segundos de verdad.
import { VENTANA_DEFAULT, type Counts, type Repo } from "../db/repo";
import type { ChatRow, MessageRow, SearchHit } from "../db/types";
import { buildFtsQuery } from "../lib/fts";

/** Techo de renders: como mucho uno cada 33 ms ≈ 30 fps (D3). */
export const FRAME_MS = 33;
/** Vida de un aviso efímero. CA-19.5 pide ≤ 3 s; el diseño fijó 2,6 s. */
export const TOAST_MS = 2_600;
/** Tope de resultados de la búsqueda global (design §6.4). */
export const LIMITE_HITS = 200;
/** Tope de chats que la búsqueda global muestra arriba de los mensajes (§6.4). */
export const LIMITE_CHATS_HIT = 20;

// ── snapshots (design §5.5) ─────────────────────────────────────────────────

export type ConnSnapshot = {
  state: "offline" | "connecting" | "open" | "reconnecting" | "unlinked";
  attempt: number;
  nextAttemptAt: number | null;
  lastCode: number | null;
  selfPhone: string | null;
};

export type LinkPhase =
  | "checking"
  | "need-link"
  | "qr-waiting"
  | "qr-shown"
  | "pairing-phone"
  | "pairing-requesting"
  | "pairing-shown"
  | "restarting"
  | "linked"
  | "failed";

export type LinkSnapshot = {
  phase: LinkPhase;
  method: "qr" | "code";
  /** `true` cuando el usuario eligió el método con `Tab`: deja de recalcularse solo (CA-2.6). */
  methodForced: boolean;
  qr: string | null;
  pairingCode: string | null;
  pairingRequestedAt: number | null;
  /** Texto para la pantalla: por qué se pide vincular, por qué falló (CA-1.4/3.1/2.4). */
  reason: string | null;
};

export type InboxSnapshot = { chats: ChatRow[]; counts: Counts };

export type ConvoSnapshot = {
  jid: string | null;
  messages: MessageRow[];
  hasMoreAbove: boolean;
  anchorId: number | null;
};

/**
 * Búsqueda global (Ctrl-G). `query` es el texto crudo del usuario; los mensajes
 * salen por FTS5 y los chats por `fold`+`includes` (R1: no existe `chats_fts`).
 */
export type SearchSnapshot = { query: string; hits: SearchHit[]; chats: ChatRow[] };

/** Los tres filtros de la bandeja (CA-5.5). El orden es el que cicla `Tab`. */
export type InboxFilter = "all" | "unread" | "groups";

export type UiSnapshot = {
  toast: { text: string; at: number } | null;
  connBanner: string | null;
  /** Filtro activo de la bandeja (CA-5.5). */
  inboxFilter: InboxFilter;
  /** Texto del buscador de la bandeja. Filtra en memoria, no en SQL (CA-5.2). */
  inboxQuery: string;
  /**
   * Chat seleccionado en la bandeja, SIEMPRE por jid y NUNCA por índice
   * (CA-4.4): un mensaje entrante reordena la lista y un índice guardado dejaría
   * el cursor sobre otro chat.
   */
  selectedJid: string | null;
  /**
   * Borradores sin enviar, por jid (CA-8.6). ⚠️ El diseño no los definía: son de
   * la tarea 14 y van acá, en el slice `ui`, porque son estado del OJO —lo que
   * el usuario dejó escrito— y no de la máquina.
   *
   * **Sólo en memoria, a propósito**: mueren con el proceso, que es exactamente
   * lo que pide CA-8.6 ("dentro de la misma sesión del proceso"). Persistirlos
   * significaría escribir en disco, sin cifrar, texto que el usuario decidió no
   * mandar.
   *
   * Un borrador vacío NO deja entrada: el mapa tiene tantas claves como chats con
   * algo escrito, casi siempre una.
   */
  drafts: Record<string, string>;
  /**
   * Los chats con CANDADO (Chat Lock) están a la vista porque el usuario escribió
   * su código en el buscador de la bandeja (`state/commands.ts`).
   *
   * **Sólo en memoria y a propósito**: nace en `false` en cada arranque. Que
   * sobreviviera al proceso convertiría el candado en un interruptor de una sola
   * vez, que es exactamente lo contrario de lo que el usuario escondió detrás de
   * un código.
   *
   * Los BLOQUEADOS no entran acá: siguen ocultos siempre (ver `VISIBLE` en
   * `db/repo.ts`).
   */
  lockedRevealed: boolean;
};

/** El mapa slice → snapshot. De acá salen `Slice` y `SnapshotOf`. */
export type Snapshots = {
  link: LinkSnapshot;
  conn: ConnSnapshot;
  inbox: InboxSnapshot;
  convo: ConvoSnapshot;
  search: SearchSnapshot;
  ui: UiSnapshot;
};

export type Slice = keyof Snapshots;
export type SnapshotOf<S extends Slice> = Snapshots[S];

export const SLICES: Slice[] = ["link", "conn", "inbox", "convo", "search", "ui"];

// ── inyección de tiempo ─────────────────────────────────────────────────────

/** Lo que devuelve `schedule`: cancela el timer que acaba de agendar. */
export type Cancelar = () => void;

export type StoreOpts = {
  /** Reloj en ms. Default `Date.now`. */
  now?: () => number;
  /** Agendador. Default `setTimeout`. El test le pasa uno virtual. */
  schedule?: (fn: () => void, ms: number) => Cancelar;
};

const agendarReal = (fn: () => void, ms: number): Cancelar => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

// ── contrato ────────────────────────────────────────────────────────────────

export type Store = {
  /** Suscribe al slice. Devuelve la baja. Es el `subscribe` de `useSyncExternalStore`. */
  subscribe(slice: Slice, cb: () => void): () => void;
  /** Snapshot vigente. MISMA identidad hasta el próximo flush de ese slice. */
  getSnapshot<S extends Slice>(s: S): Snapshots[S];
  /** Marca slices sucios y agenda el flush coalescido (D3). Los `null` se ignoran. */
  markDirty(...slices: Array<Slice | null | undefined>): void;
  /** Primer llenado, SINCRÓNICO y antes del primer frame (CA-13.1). */
  bootstrap(repo: Repo): void;
  /** Aviso efímero que se limpia solo (CA-19.5). */
  toast(text: string): void;
  setConn(patch: Partial<ConnSnapshot>): void;
  setLink(patch: Partial<LinkSnapshot>): void;
  setBanner(text: string | null): void;
  /**
   * Estado de navegación de la bandeja (filtro, buscador, selección). Va aparte
   * de `setBanner`/`toast` para que un movimiento del cursor no pueda pisar un
   * aviso efímero por descuido.
   */
  setInboxUi(patch: Partial<Pick<UiSnapshot, "inboxFilter" | "inboxQuery" | "selectedJid">>): void;
  /**
   * El estado de la bandeja EN VIVO, sin pasar por el snapshot cacheado. Mismo
   * motivo que `openChatJid()`: quien va a ESCRIBIR necesita leer lo último, no
   * lo último publicado. Dos teclas dentro del mismo frame de 33 ms (mantener
   * apretada la flecha, o el `?` que abre la ayuda mientras el campo escribe)
   * leerían las dos el mismo valor viejo y la segunda se perdería.
   */
  inboxUi(): Pick<UiSnapshot, "inboxFilter" | "inboxQuery" | "selectedJid">;
  /**
   * Muestra o esconde los chats con candado (CANDADO, no bloqueados). Marca
   * sucias las TRES proyecciones que los filtran —bandeja, conversación y
   * búsqueda global—: son consultas distintas sobre la misma base y si una se
   * quedara con el snapshot viejo habría un chat a la vista en un panel y
   * escondido en el otro.
   */
  setLockedRevealed(on: boolean): void;
  /**
   * El estado del candado EN VIVO, sin pasar por el snapshot cacheado. Mismo
   * motivo que `inboxUi()`: quien decide qué hace una tecla (`Esc`) no puede
   * leer un valor de hasta 33 ms de atraso, y el revelado llega por un camino
   * ASINCRÓNICO (la derivación scrypt tarda ~30 ms).
   */
  lockedRevealed(): boolean;
  /** Guarda (o borra, con `""`) el borrador de un chat (CA-8.6). */
  setDraft(jid: string | null, text: string): void;
  /**
   * El borrador EN VIVO, sin pasar por el snapshot cacheado. Mismo motivo que
   * `inboxUi()`/`openChatJid()`: el composer lo lee al MONTARSE —justo después
   * de un cambio de chat— y el snapshot todavía puede ser el del chat anterior
   * (hasta 33 ms de atraso, D3).
   */
  draft(jid: string | null): string;
  /** Chat abierto: define la ventana del slice `convo` y a quién no sumarle no leídos. */
  setOpenChat(jid: string | null, opts?: { anchorId?: number | null }): void;
  openChatJid(): string | null;
  /** Texto de la búsqueda global; el flush la resuelve contra la base. */
  setSearchQuery(query: string): void;
  /** Publica ya lo que esté sucio, sin esperar el frame (cierre ordenado y tests). */
  flushNow(): void;
  /** Cancela los timers pendientes. Lo llama el cierre ordenado (CA-17.*). */
  stop(): void;
};

// ── implementación ──────────────────────────────────────────────────────────

export function createStore(opts: StoreOpts = {}): Store {
  const ahora = opts.now ?? Date.now;
  const agendar = opts.schedule ?? agendarReal;

  /** Null hasta el `bootstrap`: antes de abrir la base los slices van vacíos. */
  let repo: Repo | null = null;

  // Estado mutable del dominio máquina. NO se publica nunca tal cual: lo que se
  // publica es la copia que arma `construir`, para que la identidad del snapshot
  // sólo cambie en el flush.
  const conn: ConnSnapshot = {
    state: "offline",
    attempt: 0,
    nextAttemptAt: null,
    lastCode: null,
    selfPhone: null,
  };
  const link: LinkSnapshot = {
    phase: "checking",
    method: "qr",
    methodForced: false,
    qr: null,
    pairingCode: null,
    pairingRequestedAt: null,
    reason: null,
  };
  const ui: UiSnapshot = {
    toast: null,
    connBanner: null,
    inboxFilter: "all",
    inboxQuery: "",
    selectedJid: null,
    drafts: {},
    lockedRevealed: false,
  };
  let abierto: string | null = null;
  let ancla: number | null = null;
  let consulta = "";

  const cache = new Map<Slice, Snapshots[Slice]>();
  const sucios = new Set<Slice>();
  const oyentes: Record<Slice, Set<() => void>> = {
    link: new Set(),
    conn: new Set(),
    inbox: new Set(),
    convo: new Set(),
    search: new Set(),
    ui: new Set(),
  };

  let cancelarFlush: Cancelar | null = null;
  let cancelarToast: Cancelar | null = null;
  /** `-Infinity` ⇒ el primer `markDirty` agenda el flush con 0 ms de espera. */
  let ultimoFlush = -Infinity;

  // ── proyecciones ──────────────────────────────────────────────────────────

  function construirInbox(): InboxSnapshot {
    if (!repo) return { chats: [], counts: { all: 0, unread: 0, groups: 0 } };
    // Sin límite: `chats` es una tabla chica por naturaleza (cientos de filas) y
    // recortarla escondería chats viejos que la bandeja tiene que poder listar.
    return {
      chats: repo.listChats(undefined, ui.lockedRevealed),
      counts: repo.countsByFilter(ui.lockedRevealed),
    };
  }

  function construirConvo(): ConvoSnapshot {
    if (!repo || abierto === null) {
      return { jid: abierto, messages: [], hasMoreAbove: false, anchorId: ancla };
    }
    // El chat que ya estaba ABIERTO cuando llegó el candado (o el bloqueo): de la
    // bandeja desaparece solo —es otra proyección de la misma base— pero la
    // ventana de mensajes seguía pintándose hasta salir con `Esc`. Era la última
    // puerta abierta del filtro de §4.1.
    //
    // La guarda NO es ciega al estado de revelado: si el usuario escribió el
    // código, un chat con candado se abre y se lee como cualquier otro. Con un
    // BLOQUEADO no hay revelado que valga (`isHidden` no lo mira).
    if (repo.isHidden(abierto, ui.lockedRevealed)) {
      return { jid: abierto, messages: [], hasMoreAbove: false, anchorId: ancla };
    }
    const messages =
      ancla === null
        ? repo.lastMessages(abierto, VENTANA_DEFAULT)
        : repo.messagesAround(abierto, ancla, VENTANA_DEFAULT);
    // Con R2 (ventana fija de 500, sin carga incremental) nadie va a pedir más:
    // es sólo el dato para avisar en pantalla que el historial sigue más arriba.
    return {
      jid: abierto,
      messages,
      hasMoreAbove: messages.length >= VENTANA_DEFAULT,
      anchorId: ancla,
    };
  }

  function construirSearch(): SearchSnapshot {
    if (!repo || consulta.trim() === "") return { query: consulta, hits: [], chats: [] };
    // ⚠️ Los CHATS se buscan aunque no quede ningún término FTS-able (tarea 16).
    // `buildFtsQuery` parte por "todo lo que no sea letra ni número", así que una
    // query de puros símbolos —un emoji, `+549`— se queda en `''` y ahí NO hay
    // mensajes que buscar. Pero el chat sí se puede encontrar: buscar `🌻` en la
    // bandeja encuentra "anto 🌻" y acá decía "sin coincidencias", la misma query
    // con dos respuestas distintas según dónde se escribiera.
    const match = buildFtsQuery(consulta);
    // Con el candado revelado la búsqueda global tiene que encontrar lo mismo que
    // la bandeja muestra: si no, el chat estaría a la vista y sus mensajes no
    // (o al revés, que sería la fuga).
    return {
      query: consulta,
      hits: match === "" ? [] : repo.searchMessages(match, LIMITE_HITS, ui.lockedRevealed),
      chats: repo.searchChats(consulta, LIMITE_CHATS_HIT, ui.lockedRevealed),
    };
  }

  function construir(s: Slice): Snapshots[Slice] {
    switch (s) {
      case "inbox":
        return construirInbox();
      case "convo":
        return construirConvo();
      case "search":
        return construirSearch();
      case "conn":
        return { ...conn };
      case "link":
        return { ...link };
      case "ui":
        return { ...ui };
    }
  }

  // ── flush coalescido (D3) ─────────────────────────────────────────────────

  function flush(): void {
    cancelarFlush = null;
    ultimoFlush = ahora();
    if (sucios.size === 0) return;

    const lote = [...sucios];
    sucios.clear();

    // Primero se reconstruyen TODOS los sucios y recién después se notifica: un
    // listener que lea otro slice tiene que ver el mundo ya publicado, no medio.
    for (const s of lote) cache.set(s, construir(s));
    for (const s of lote) {
      // Copia: un listener puede darse de baja adentro del propio callback.
      for (const cb of [...oyentes[s]]) cb();
    }
  }

  function markDirty(...slices: Array<Slice | null | undefined>): void {
    let hay = false;
    for (const s of slices) {
      if (!s) continue; // el flujo §6.2 pasa `null` cuando el chat no está abierto
      sucios.add(s);
      hay = true;
    }
    if (!hay || cancelarFlush) return;
    cancelarFlush = agendar(flush, Math.max(0, FRAME_MS - (ahora() - ultimoFlush)));
  }

  // ── API ───────────────────────────────────────────────────────────────────

  return {
    subscribe(slice, cb) {
      oyentes[slice].add(cb);
      return () => {
        oyentes[slice].delete(cb);
      };
    },

    getSnapshot<S extends Slice>(s: S): Snapshots[S] {
      let v = cache.get(s);
      if (v === undefined) {
        v = construir(s);
        cache.set(s, v);
      }
      return v as Snapshots[S];
    },

    markDirty,

    // Sincrónico a propósito: corre antes del primer frame, así la bandeja se
    // pinta con datos reales de entrada y no aparece vacía y después llena.
    bootstrap(r) {
      repo = r;
      sucios.clear();
      cache.clear();
      for (const s of SLICES) cache.set(s, construir(s));
      ultimoFlush = ahora();
    },

    toast(text) {
      const t = { text, at: ahora() };
      ui.toast = t;
      markDirty("ui");
      cancelarToast?.();
      cancelarToast = agendar(() => {
        cancelarToast = null;
        if (ui.toast !== t) return; // ya lo pisó un toast más nuevo
        ui.toast = null;
        markDirty("ui");
      }, TOAST_MS);
    },

    setConn(patch) {
      Object.assign(conn, patch);
      markDirty("conn");
    },

    setLink(patch) {
      Object.assign(link, patch);
      markDirty("link");
    },

    setBanner(text) {
      ui.connBanner = text;
      markDirty("ui");
    },

    setInboxUi(patch) {
      Object.assign(ui, patch);
      markDirty("ui");
    },

    inboxUi() {
      const { inboxFilter, inboxQuery, selectedJid } = ui;
      return { inboxFilter, inboxQuery, selectedJid };
    },

    setLockedRevealed(on) {
      const valor = on === true;
      if (ui.lockedRevealed === valor) return;
      ui.lockedRevealed = valor;
      markDirty("ui", "inbox", "convo", "search");
    },

    lockedRevealed() {
      return ui.lockedRevealed;
    },

    setDraft(jid, text) {
      if (!jid) return;
      const valor = typeof text === "string" ? text : "";
      if ((ui.drafts[jid] ?? "") === valor) return;
      // Objeto NUEVO y no mutación: `construir("ui")` publica una copia
      // SUPERFICIAL, así que mutando el mapa el snapshot ya publicado cambiaría
      // por debajo y quien compare por identidad no vería nada (regla 3 del
      // encabezado). Es un objeto de una o dos claves: copiarlo no cuesta nada.
      const drafts = { ...ui.drafts };
      if (valor === "") delete drafts[jid];
      else drafts[jid] = valor;
      ui.drafts = drafts;
      markDirty("ui");
    },

    draft(jid) {
      return jid ? (ui.drafts[jid] ?? "") : "";
    },

    setOpenChat(jid, o = {}) {
      abierto = jid;
      ancla = jid === null ? null : (o.anchorId ?? null);
      markDirty("convo");
    },

    openChatJid() {
      return abierto;
    },

    setSearchQuery(query) {
      consulta = query;
      markDirty("search");
    },

    flushNow() {
      cancelarFlush?.();
      cancelarFlush = null;
      flush();
    },

    stop() {
      cancelarFlush?.();
      cancelarFlush = null;
      cancelarToast?.();
      cancelarToast = null;
      sucios.clear();
    },
  };
}

/**
 * El store del proceso. Hay uno solo (una cuenta, un socket, una base): lo usan
 * `state/hooks.ts`, `state/commands.ts` y el ingest. Los tests se arman el suyo
 * con `createStore()` para poder inyectarle un reloj falso.
 */
export const store: Store = createStore();

// Las funciones sueltas de design §5.5. Son closures del `store` de arriba (no
// usan `this`), así que desestructurarlas es seguro.
export const subscribe = store.subscribe;
export const getSnapshot = store.getSnapshot;
export const markDirty = store.markDirty;
export const bootstrap = store.bootstrap;
export const toast = store.toast;
