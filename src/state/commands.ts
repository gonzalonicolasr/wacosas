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
import { preparePixels, type PixelResult, type PixelTerminal } from "../boot/pixels";
import { createPreviewQueue } from "./previews";
import { type ResultadoImagen, renderizarImagen } from "../boot/chafa";
import { type ClipboardResult, readClipboard } from "../boot/clipboard";
import { type ResultadoVista, verEnGrande } from "../boot/grafica";
import type { Logger } from "../boot/log";
import type { LockCode } from "../boot/lockcode";
import type { Repo } from "../db/repo";
import type { ChatRow, MessageRow } from "../db/types";
import type { Avatars } from "../wa/avatars";
import type { MediaStore } from "../wa/media";
import { clip, fold } from "../lib/fmt";
import type { AppStateSync } from "../wa/appstate";
import type { ReadReceipts } from "../wa/read";
import type { ImagenSaliente, SendQueue } from "../wa/send";
import type { WaController } from "../wa/socket";
import { TOAST_MS, type InboxFilter, type LinkSnapshot, type Store } from "./store";

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
   * Reparación de app-state (los nombres de la agenda). Opcional por el mismo
   * motivo que `send` y `read`: un test de interfaz no tiene socket, y sin ella
   * `resyncContacts` avisa en vez de romper.
   */
  appstate?: AppStateSync;
  /**
   * El código que revela los chats con candado. Opcional por el mismo motivo que
   * `send` y `read`: un test de interfaz no tiene dónde guardar un hash, y sin
   * ella el buscador de la bandeja es un buscador y nada más.
   */
  lockCode?: LockCode;
  /**
   * Lectura del portapapeles del sistema (`^V`). A diferencia de `send`/`read`,
   * **acá el default es el de verdad** (`readClipboard`): el módulo no arrastra
   * ninguna dependencia pesada, así que no hay motivo para degradarlo. La
   * inyección existe para que el test pueda decidir qué había en el portapapeles
   * sin spawnear nada.
   */
  clipboard?: () => Promise<ClipboardResult>;
  /**
   * Descarga a demanda de las imágenes recibidas (`^O`, `wa/media.ts`). Opcional
   * por el mismo motivo que `send`/`read`: un test de interfaz no baja nada, y
   * sin ella `showImage` avisa en vez de romper.
   *
   * ⚠️ Se inyecta y no se importa, igual que `read`: `wa/media.ts` arrastra
   * baileys (~260 ms) y este módulo lo carga la interfaz, que tiene que estar en
   * pantalla en menos de 1 s (CA-13.1). El `import type` de arriba se borra al
   * compilar.
   */
  media?: MediaStore;
  pixels?: PixelTerminal;
  preparePixels?: typeof preparePixels;
  /**
   * Colores de las fotos de perfil de la bandeja (`wa/avatars.ts`). Opcional:
   * sin ella la bandeja pinta los glifos como siempre y no se pierde nada —es un
   * adorno, no un dato—. Se inyecta por lo mismo que `media`: cuelga del socket.
   */
  avatars?: Avatars;
  /**
   * Imagen → celdas de texto (`boot/chafa.ts`). A diferencia de `media`, **acá el
   * default es el de verdad**: el módulo no arrastra nada pesado (mismo criterio
   * que `clipboard`). La inyección existe para que el test no spawnee `chafa`.
   */
  chafa?: (ruta: string, cols: number, filas: number) => Promise<ResultadoImagen>;
  /**
   * Abrir un archivo con el visor del sistema (`xdg-open`). Se inyecta para que
   * el test no le abra una ventana a nadie.
   */
  abrirArchivo?: (ruta: string) => void;
  /**
   * El renderer de OpenTUI, SÓLO para suspenderlo mientras se ve una imagen a
   * calidad real (`boot/grafica.ts`). Es la única pieza de la interfaz que
   * necesita algo del renderer, y por eso entra por acá y no por un import: los
   * comandos no saben nada de OpenTUI.
   *
   * Opcional por lo mismo que `send`/`read`: un test de interfaz no tiene una
   * terminal de verdad que suspender, y sin esto la tecla avisa en vez de romper.
   */
  renderer?: { suspend(): void; resume(): void };
  /**
   * La vista a calidad real. **Acá el default es el de verdad** (mismo criterio
   * que `chafa` y `clipboard`: el módulo no arrastra nada pesado). Se inyecta
   * para que el test no le suspenda la terminal a `bun test`.
   */
  visor?: typeof verEnGrande;
  /**
   * Cierre ordenado del proceso (`boot/shutdown.ts`, §6.6). El `motivo` no cambia
   * nada de lo que hace: va al log para que una salida quede explicada —después
   * de una que nadie pidió, la primera pregunta es "¿quién la disparó?"—.
   */
  shutdown(code?: number, motivo?: string): void;
};

let deps: CommandDeps | null = null;
let previews = createPreviewQueue<PixelResult>({ limit: 32, error: { ok: false, reason: "no se pudo cargar la foto" } });

/** Cablea los comandos. Se llama UNA vez, desde el entry, antes de renderizar. */
export function configureCommands(d: CommandDeps): void {
  previews.stop();
  previews = createPreviewQueue<PixelResult>({ limit: 32, error: { ok: false, reason: "no se pudo cargar la foto" } });
  deps = d;
  // Otro mundo (otro repo, otro store): una confirmación a medias del anterior no
  // puede esconder un chat del nuevo.
  confirmarOculto = null;
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

// ── el candado: revelar escribiendo el código en el buscador ─────────────────
//
// El gesto es el de WhatsApp: los dígitos van en el MISMO campo con el que se
// filtra la bandeja (CA-5.1, que está siempre enfocado) y si coinciden con el
// código guardado, los chats con candado aparecen. `Esc` los vuelve a esconder.
//
// Tres detalles que no son cosméticos:
//
//  1. **El buscador de la bandeja NO consulta la base**: filtra en memoria sobre
//     la lista que ya está en RAM (ver `filtrarChats`). O sea que el código
//     tipeado no llega nunca a SQLite ni al índice FTS — nada de una búsqueda
//     full-text con el código de término. La búsqueda global (`Ctrl-G`) es otro
//     campo, otro modo, y ahí no hay revelado que valga.
//  2. **Al acertar, el campo se VACÍA en el acto**: los dígitos dejan de estar en
//     pantalla apenas dejan de hacer falta, y de paso la bandeja vuelve a la
//     lista completa (filtrando por el código no se vería ningún chat).
//  3. **Un código que no coincide no se distingue de una búsqueda cualquiera**:
//     no hay aviso, ni sonido, ni un "código incorrecto". El texto queda ahí
//     filtrando, como cualquier otra cosa que se escriba. Que exista un código
//     es algo que sabe el que lo puso.
const AVISO_REVELADO = "chats con candado a la vista · Esc para esconderlos";

/**
 * ¿Lo que se acaba de tipear es el código? Si sí, revela; si no, no pasa nada.
 *
 * La derivación es ASINCRÓNICA (~30 ms fuera del hilo del event loop) para no
 * comerse un frame por tecla, así que cuando vuelve hay que volver a preguntar
 * qué hay escrito AHORA: entre medio pudo haber otra tecla, y revelar por un
 * texto que ya no está sería revelar solo.
 */
function intentarRevelar(d: CommandDeps, texto: string): void {
  if (!d.lockCode || d.store.lockedRevealed()) return;
  d.lockCode
    .verify(texto)
    .then((ok) => {
      if (!ok || d.store.inboxUi().inboxQuery !== texto) return;
      // El orden importa poco (los dos `markDirty` caen en el mismo flush, D3),
      // pero limpiar primero deja el código fuera de pantalla cuanto antes.
      commands.setInboxQuery("");
      d.store.setLockedRevealed(true);
      d.store.toast(AVISO_REVELADO);
      // Sin el código, sin su largo y sin el jid de ningún chat.
      d.log.info("candado.revelado");
    })
    .catch(() => {
      // `verify` no lanza; el catch es para que un rechazo inesperado no termine
      // en un unhandled rejection que se lleve puesto el proceso.
    });
}

// ── esconder un chat A MANO (`Ctrl-X`) ──────────────────────────────────────
//
// La vía automática puede no llegar nunca: el `chats.lock` de WhatsApp viaja por
// app-state y en la cuenta real dos colecciones quedaron ESTACIONADAS por una
// clave que sólo puede mandar el teléfono (ver `wa/appstate.ts`). O sea que un
// chat con candado en el teléfono puede verse igual en la TUI. Esto es la salida
// manual: el usuario esconde el chat él mismo.
//
// Tres decisiones:
//
//  1. **Se comporta EXACTAMENTE como un candado de WhatsApp**: no se lista en
//     ninguna de las cuatro puertas y vuelve escribiendo el MISMO código en el
//     buscador (el filtro vive en `db/repo.ts`, no acá). Lo que NO comparte es la
//     fila: va a `jid_hides` y no a `jid_flags`, así ninguno de los dos orígenes
//     puede pisar al otro (§4.1).
//  2. **Pide confirmación**: la primera pulsación pregunta y la segunda esconde.
//     Es una acción que hace DESAPARECER un chat de la vista, y `^X` no puede ser
//     una tecla que se apriete sola. La ventana de confirmación dura lo que dura
//     el aviso en el pie (`TOAST_MS`): mientras la pregunta está en pantalla, la
//     tecla confirma; cuando se fue, vuelve a preguntar. Un `^X` de hace un
//     minuto no puede esconder nada.
//  3. **Sin código fijado no se puede esconder.** Sin `^P` no hay forma de
//     revelar, así que esconder sería tirar el chat a un pozo. Se avisa y se
//     manda a fijarlo. Desmarcar, en cambio, no pide nada: hace APARECER un chat.
export const SIN_CODIGO_PARA_OCULTAR = "fijá antes el código con ^P: sin código no habría cómo volver a ver el chat";

/** Cuánto vale la primera pulsación de `^X`. Es la vida del aviso del pie. */
export const ESPERA_CONFIRMACION_MS = TOAST_MS;

/** Tope del nombre en los avisos: el pie es UNA línea de 80 columnas (RNF-1). */
const LARGO_NOMBRE_AVISO = 22;

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
   * Lee el portapapeles del sistema (`^V`). **No manda nada**: sólo dice qué
   * había, y el que decide qué hacer con eso es el campo de redacción
   * (`ui/Composer.tsx`), que es el único que sabe si el usuario sigue parado en
   * el mismo chat cuando la lectura vuelve.
   *
   * Los casos que no dan nada usable —sin backend, vencido, basura, vacío— se
   * AVISAN por el pie acá y vuelven igual en el resultado: una tecla que a veces
   * no hace nada visible parece rota (mismo criterio que `retrySend`).
   */
  paste(): Promise<ClipboardResult>;
  /**
   * Manda una imagen al chat con el texto del campo como caption (CA-8.2 con
   * `^V`). Devuelve el motivo cuando NO se mandó, igual que `send`.
   */
  sendImage(jid: string, image: ImagenSaliente, caption?: string): Resultado;
  /**
   * Las imágenes del chat, de la más NUEVA a la más vieja (`^O`). Sin chat, sin
   * base o sin imágenes devuelve una lista vacía: la pantalla lo explica.
   */
  chatImages(jid: string | null): MessageRow[];
  /**
   * Pide el color de la foto de perfil de esos chats (los que se VEN en la
   * bandeja, `ui/Inbox.tsx`). Es idempotente y no consulta nada que ya sepa, así
   * que se la puede llamar en cada render.
   */
  requestAvatars(jids: string[]): void;
  /**
   * Baja (si hace falta) y convierte a celdas la imagen de ese mensaje, para
   * pintarla en `cols`×`filas` (`ui/ImageView.tsx`).
   *
   * Los dos pasos van juntos en UN comando porque son la misma pregunta del
   * usuario —"mostrámela"— y porque el segundo no tiene sentido sin el primero.
   * Lo que NO hace es decidir cuándo: eso es de la vista, que es la única que
   * sabe si el usuario sigue parado en la misma imagen cuando la descarga vuelve.
   */
  showImage(msg: MessageRow, cols: number, filas: number): Promise<ResultadoImagen>;
  pixelTerminal(): PixelTerminal | undefined;
  requestPixels(source: MessageRow | string, cols: number, rows: number, listener: (r: PixelResult) => void): () => void;
  /**
   * La misma imagen, a CALIDAD REAL y a pantalla completa (`⏎`): suspende la
   * TUI, dibuja con el protocolo gráfico de la terminal y vuelve con la
   * siguiente tecla (`boot/grafica.ts`).
   *
   * Es lo que hace legible una captura de pantalla: con los medios bloques del
   * panel, el texto de una captura es una mancha. No reemplaza a `showImage` —el
   * panel sigue siendo el que se navega con `←`/`→`—, es el "mirala de verdad".
   */
  showImageFullQuality(msg: MessageRow): Promise<ResultadoVista>;
  /**
   * Abre la imagen ya bajada en el visor del sistema (`xdg-open`). Es la salida
   * para cuando la vista en la terminal no alcanza; si todavía no está bajada, lo
   * dice en vez de abrir un visor con nada.
   */
  openImageExternally(msg: MessageRow): Resultado;
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
  /** ¿Ya hay un código del candado fijado? Lo pregunta la pantalla de `Ctrl-P`. */
  hasLockCode(): boolean;
  /**
   * Fija (o reemplaza) el código del candado. Devuelve el motivo cuando no se
   * pudo, para poder mostrarlo al lado del campo sin dar una vuelta por el store.
   */
  setLockCode(digits: string): Resultado;
  /**
   * Vuelve a esconder los chats con candado (`Esc`). Limpia el buscador y, si el
   * chat abierto era justamente uno de los escondidos, lo cierra: dejarlo abierto
   * sería dejar el campo de redacción apuntando a un chat que ya no se ve.
   */
  hideLocked(): void;
  /**
   * `Ctrl-X`: esconde el chat SELECCIONADO de la bandeja, o lo devuelve si ya
   * estaba escondido a mano (que es lo que se puede hacer con el candado
   * revelado). Ver la sección "esconder un chat A MANO" de más arriba: pide
   * confirmación para esconder, no para mostrar, y no esconde nada si todavía no
   * hay código fijado.
   *
   * Todos los caminos AVISAN por el pie: una tecla que a veces no hace nada
   * visible parece rota (mismo criterio que `retrySend`).
   */
  toggleSelectedHidden(): void;
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
  /**
   * `Ctrl-N`: vuelve a pedirle a WhatsApp las colecciones de app-state, que es de
   * donde salen los NOMBRES de la agenda. Es la única forma de destrabar una
   * colección que quedó estacionada por una clave que faltaba (ver
   * `wa/appstate.ts`). Manda stanzas: por eso es una tecla y no algo automático.
   */
  resyncContacts(): void;
  /** Alterna QR ↔ código a mano (`Tab`, CA-2.6). NO toca el socket (D11). */
  chooseLinkMethod(m: "qr" | "code"): void;
  /**
   * Pide el código de emparejamiento (CA-2.3). Sin número reusa el último válido:
   * es el camino de `Ctrl-R` cuando el código venció (CA-2.5).
   * Devuelve el motivo cuando el número no pasa el formato, para poder mostrarlo
   * al lado del input sin dar una vuelta por el store (CA-2.2).
   */
  requestPairing(phoneDigits?: string): Resultado;
  /**
   * Cierre ordenado (CA-17.1). `motivo` describe QUIÉN lo pidió (`"tecla ^C"`,
   * `"SIGTERM"`, …) y termina en el log: es lo único que permite distinguir una
   * salida que pidió el usuario de una que no pidió nadie.
   */
  quit(code?: number, motivo?: string): void;
};

/**
 * Abre un archivo con el visor del sistema.
 *
 * Se desprende del proceso a propósito (`stdio` a `ignore`, sin esperar la
 * salida): un visor de imágenes vive minutos y wacosas no puede quedarse
 * esperándolo, ni dejar que le escriba en la terminal —que está en la pantalla
 * alternativa y con el layout de OpenTUI—.
 */
function abrirConElSistema(ruta: string): void {
  Bun.spawn({ cmd: ["xdg-open", ruta], stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
}

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

/**
 * El `^X` que ya preguntó "¿ocultar X?" y espera el segundo. Vive acá y no en un
 * `useRef` de la vista por lo mismo que `bandejaGuardada`: es estado de la
 * MÁQUINA (qué va a hacer el próximo comando), y así se puede probar sin montar
 * la interfaz. Se ata al jid: cambiar de chat entre las dos pulsaciones no
 * confirma nada.
 */
let confirmarOculto: { jid: string; at: number } | null = null;

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
    // ¿Y si eso que se tipeó era el código del candado? (ver `intentarRevelar`).
    // Va DESPUÉS de escribir la búsqueda: mientras la derivación corre, el
    // buscador se comporta como siempre.
    if (texto !== "") intentarRevelar(deps, texto);
  },

  hasLockCode() {
    return deps?.lockCode?.exists() ?? false;
  },

  setLockCode(digits) {
    const d = deps;
    if (!d) return { ok: false, reason: "todavía no arrancó la aplicación" };
    if (!d.lockCode) return { ok: false, reason: "el candado todavía no está disponible" };
    const r = d.lockCode.set(digits);
    if (!r.ok) return r;
    return { ok: true };
  },

  hideLocked() {
    const d = deps;
    // El estado se lee EN VIVO (D3): el revelado llega por un camino asincrónico
    // y el snapshot puede tener hasta 33 ms de atraso.
    if (!d || !d.store.lockedRevealed()) return;
    d.store.setLockedRevealed(false);
    commands.setInboxQuery("");
    const jid = d.store.openChatJid();
    // `isHidden` con `false`: la pregunta es "¿este chat se esconde ahora que ya
    // no está revelado?".
    if (jid && d.repo.isHidden(jid, false)) commands.closeChat();
    d.log.info("candado.escondido");
  },

  toggleSelectedHidden() {
    const d = deps;
    if (!d) return;
    const { visibles, actual } = vistaBandeja(d);
    if (!actual) {
      d.store.toast("no hay ningún chat seleccionado");
      return;
    }
    const i = visibles.findIndex((c) => c.jid === actual);
    // `seleccionVigente` garantiza que `actual` está en `visibles` (o es `null`,
    // que ya salió arriba), así que la fila existe.
    const nombre = clip(etiquetaChat(visibles[i] as ChatRow), LARGO_NOMBRE_AVISO);

    // ── devolverlo a la bandeja ───────────────────────────────────────────
    // Sin confirmación a propósito: hace APARECER un chat, no desaparecer.
    if (d.repo.isManuallyHidden(actual)) {
      confirmarOculto = null;
      d.repo.setHidden(actual, false);
      d.store.markDirty("inbox", "convo", "search");
      d.store.toast(`«${nombre}» vuelve a la bandeja`);
      // Sin el jid: es un número de teléfono (mismo criterio que el resto del
      // módulo del candado, donde no se loguea ni el código ni su largo).
      d.log.info("candado.manual", { accion: "mostrar" });
      return;
    }

    // ── esconderlo ────────────────────────────────────────────────────────
    if (!commands.hasLockCode()) {
      d.store.toast(SIN_CODIGO_PARA_OCULTAR);
      d.log.info("candado.manual", { accion: "sin_codigo" });
      return;
    }
    // Vale la confirmación del MISMO chat y sólo mientras la pregunta sigue en el
    // pie. El `< 0` no es paranoia: un salto de reloj hacia atrás (NTP) dejaría
    // una confirmación "del futuro" viva para siempre, y esa es exactamente la
    // que escondería un chat de una sola pulsación.
    const ahora = Date.now();
    const desde = confirmarOculto ? ahora - confirmarOculto.at : Infinity;
    if (!confirmarOculto || confirmarOculto.jid !== actual || desde < 0 || desde > ESPERA_CONFIRMACION_MS) {
      confirmarOculto = { jid: actual, at: ahora };
      d.store.toast(`¿ocultar «${nombre}»? ^X de nuevo para confirmar`);
      return;
    }
    confirmarOculto = null;
    d.repo.setHidden(actual, true);
    // ¿Desaparece AHORA? Con el candado revelado el chat sigue a la vista, y ahí
    // no hay ni cursor que mover ni chat que cerrar. El estado se lee EN VIVO
    // (D3): el revelado llega por un camino asincrónico.
    const seEsconde = d.repo.isHidden(actual, d.store.lockedRevealed());
    if (seEsconde) {
      // El cursor no puede quedar sobre un chat que ya no está. Se elige el
      // vecino ANTES de que la lista cambie: `seleccionVigente` lo mandaría al
      // primero de la bandeja, que está en cualquier otro lado de la pantalla.
      const vecino = visibles[i + 1] ?? visibles[i - 1] ?? null;
      d.store.setInboxUi({ selectedJid: vecino ? vecino.jid : null });
      // Y si el que se escondió era el chat ABIERTO, se cierra: dejarlo sería
      // dejar el campo de redacción apuntando a algo que ya no se ve (mismo
      // criterio que `hideLocked`).
      const abierto = d.store.openChatJid();
      if (abierto && d.repo.isHidden(abierto, d.store.lockedRevealed())) commands.closeChat();
    }
    d.store.markDirty("inbox", "convo", "search");
    d.store.toast(
      seEsconde
        ? `«${nombre}» oculto · escribí el código para verlo`
        : `«${nombre}» oculto · desaparece al esconder el candado`,
    );
    d.log.info("candado.manual", { accion: "ocultar" });
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
    //
    // ⚠️ Lo que esta guarda POSPONE: el sync de historial con el chat abierto.
    // `ingest.aplicarChat` fuerza el contador a 0 en el chat que se está mirando
    // (CA-11.7) con un `upsertChat({unreadCount: 0})` que NO mueve
    // `last_read_id`, así que este `markRead` ve 0, no manda recibo, y esos
    // mensajes se quedan sin acusar hasta que entre uno nuevo en vivo (ese sí
    // sale por `pushReadReceipt`). Es el mal menor: la alternativa —mandarlo
    // igual— es la ráfaga de arriba. El arreglo de fondo es que `aplicarChat`
    // use `clearUnread(jid, ultimoId)` en vez de `upsertChat`, así `unread_count`
    // y `last_read_id` dejan de contradecirse; queda anotado para la tarea 18.
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

  async paste() {
    const d = deps;
    if (!d) return { kind: "error", reason: "todavía no arrancó la aplicación" };
    let r: ClipboardResult;
    try {
      r = await (d.clipboard ?? readClipboard)();
    } catch (e) {
      // `readClipboard` no lanza; esto es para que un backend inyectado que sí lo
      // haga no termine en un unhandled rejection que se lleve el proceso.
      r = { kind: "error", reason: e instanceof Error ? e.message : String(e) };
    }
    if (r.kind === "error") {
      d.store.toast(r.reason);
      d.log.warn("pegar.fallo", { motivo: r.reason });
    } else if (r.kind === "empty") {
      d.store.toast("el portapapeles está vacío");
    } else {
      // NUNCA el contenido: ni el texto pegado ni un byte de la imagen (CA-14.7).
      d.log.info("pegar.ok", {
        tipo: r.kind,
        bytes: r.kind === "image" ? r.bytes.length : r.text.length,
      });
    }
    return r;
  },

  sendImage(jid, image, caption) {
    const d = deps;
    if (!d) return { ok: false, reason: "todavía no arrancó la aplicación" };
    if (!d.send) return { ok: false, reason: "el envío todavía no está disponible" };
    const r = d.send.enqueueImage(jid, image, caption);
    if (r.ok) {
      // El caption viajó con la imagen: el campo queda limpio, igual que con un
      // mensaje de texto que sí entró en la cola.
      d.store.setDraft(jid, "");
      return { ok: true };
    }
    // Mismo criterio que `send` (CA-8.7): el rechazo se AVISA. Acá encima es
    // obligatorio — el usuario no tiene forma de adivinar que su captura pesaba
    // de más.
    d.store.toast(r.reason);
    d.log.warn("send.imagen_rechazada", { motivo: r.reason });
    return { ok: false, reason: r.reason };
  },

  chatImages(jid) {
    const d = deps;
    if (!d || !jid) return [];
    try {
      return d.repo.imagesOf(jid);
    } catch (e) {
      // Ningún comando lanza: una consulta que falla es una lista vacía y una
      // línea en el log, no una pantalla rota.
      d.log.warn("media.listado_fallido", { motivo: e instanceof Error ? e.message : String(e) });
      return [];
    }
  },

  requestAvatars(jids) {
    // Sin `avatars` cableado no pasa nada: la bandeja se pinta igual.
    deps?.avatars?.request(jids ?? []);
  },

  pixelTerminal() { return deps?.pixels; },

  requestPixels(source, cols, rows, listener) {
    const d = deps;
    const key = `${typeof source === "string" ? source : `${source.chatJid}:${source.id}:${source.kind}:${source.attachment?.thumbnail ?? ""}`}:${cols}:${rows}`;
    return previews.request(key, async wanted => {
      if (!d?.pixels || !await d.pixels.ready()) return { ok: false, reason: "fotos inline no disponibles en esta terminal" };
      if (!wanted()) return { ok: false, reason: "foto fuera de pantalla" };
      let path: string;
      if (typeof source === "string") path = source;
      else {
        if (!d.media) return { ok: false, reason: "descarga no disponible" };
        const r = await (d.media.ensurePreview?.(source) ?? d.media.ensureImage(source));
        if (!r.ok) return { ok: false, reason: r.reason };
        path = r.path;
      }
      if (!wanted()) return { ok: false, reason: "foto fuera de pantalla" };
      return (d.preparePixels ?? preparePixels)(path, cols, rows);
    }, listener);
  },

  async showImage(msg, cols, filas) {
    const d = deps;
    if (!d) return { ok: false, reason: "todavía no arrancó la aplicación" };
    if (!d.media) return { ok: false, reason: "la descarga de imágenes todavía no está disponible" };
    if (!msg || msg.kind !== "image") return { ok: false, reason: "ese mensaje no es una imagen" };

    const bajada = await d.media.ensureImage(msg);
    if (!bajada.ok) return { ok: false, reason: bajada.reason };
    return (d.chafa ?? renderizarImagen)(bajada.path, cols, filas);
  },

  async showImageFullQuality(msg) {
    const d = deps;
    if (!d) return { ok: false, reason: "todavía no arrancó la aplicación" };
    // TODOS los caminos que no dibujan AVISAN por el pie: acá la pantalla se va
    // a negro y vuelve, así que una tecla que "no hizo nada" es peor que en
    // cualquier otro lado —parece que se colgó—.
    const avisar = (motivo: string): ResultadoVista => {
      d.store.toast(motivo);
      return { ok: false, reason: motivo };
    };
    if (!d.media) return avisar("la descarga de imágenes todavía no está disponible");
    if (!msg || msg.kind !== "image") return avisar("ese mensaje no es una imagen");
    if (!d.renderer) return avisar("la vista a calidad real todavía no está disponible");

    // Se baja igual que en `showImage` —normalmente ya está en el caché de disco,
    // porque para llegar acá la imagen se estaba MIRANDO—.
    const bajada = await d.media.ensureImage(msg);
    if (!bajada.ok) return avisar(bajada.reason);

    const r = await (d.visor ?? verEnGrande)({
      ruta: bajada.path,
      renderer: d.renderer,
      // `^C` con la imagen en pantalla cierra wacosas, igual que en cualquier
      // otra pantalla (CA-17.1): la suspensión no puede volver la salida
      // inalcanzable.
      alSalir: () => d.shutdown(0, "tecla ^C sobre la imagen"),
    });
    if (!r.ok) {
      d.log.warn("media.grande_fallida", { motivo: r.reason });
      return avisar(r.reason);
    }
    d.log.info("media.grande", { calidad: r.calidad });
    return r;
  },

  openImageExternally(msg) {
    const d = deps;
    if (!d) return { ok: false, reason: "todavía no arrancó la aplicación" };
    if (!d.media) return { ok: false, reason: "la descarga de imágenes todavía no está disponible" };
    // Sólo lo que YA está en disco: `xdg-open` sobre una ruta que no existe abre
    // un visor con un error adentro, que es peor que decirlo acá.
    const ruta = d.media.cached(msg);
    if (!ruta) {
      const motivo = "todavía no está bajada: mirala primero con ^O";
      d.store.toast(motivo);
      return { ok: false, reason: motivo };
    }
    try {
      (d.abrirArchivo ?? abrirConElSistema)(ruta);
    } catch (e) {
      const motivo = e instanceof Error ? e.message : String(e);
      d.store.toast(`no se pudo abrir el visor: ${motivo}`);
      d.log.warn("media.visor_fallido", { motivo });
      return { ok: false, reason: motivo };
    }
    d.store.toast("abriendo la imagen en el visor del sistema…");
    d.log.info("media.visor", {});
    return { ok: true };
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

  resyncContacts() {
    if (!deps) return;
    // Sin conexión no sale ni una stanza: el resync es una consulta a WhatsApp y
    // pedirla offline sólo dejaría un error en el log. El aviso lo pone acá porque
    // `appstate` ni se entera de que la tecla se apretó.
    if (!deps.wa.isOpen()) {
      deps.store.toast("sin conexión: no se puede resincronizar la agenda");
      return;
    }
    if (!deps.appstate) {
      deps.store.toast("la sincronización de la agenda todavía no está disponible");
      return;
    }
    deps.log.info("appstate.pedido_manual");
    // El aviso al usuario lo pone `appstate` (sabe si arrancó, si ya había uno en
    // curso y cómo terminó): duplicarlo acá dejaría dos toasts por una tecla.
    deps.appstate.force();
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

  quit(code = 0, motivo = "?") {
    if (!deps) {
      process.exit(code);
      return;
    }
    deps.log.info("app.quit", { code, motivo, pid: process.pid });
    deps.shutdown(code, motivo);
  },
};
