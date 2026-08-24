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
// Hoy están los del esqueleto (tarea 9) y los de vinculación (tarea 10). Los de
// envío (`send`, `retrySend`) los agrega la tarea 14 y la búsqueda global la 16.
import type { Logger } from "../boot/log";
import type { Repo } from "../db/repo";
import type { WaController } from "../wa/socket";
import type { LinkSnapshot, Store } from "./store";

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

export type Commands = {
  /** Abre el chat y lo marca leído (CA-6.1, CA-11.1). `anchorId` = salto desde la búsqueda. */
  openChat(jid: string, opts?: { anchorId?: number }): void;
  closeChat(): void;
  /** Marca leído SOLO en local; el recibo a WhatsApp lo agrega la tarea 15 (CA-11.3). */
  markRead(jid: string): void;
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

/** Fases que la elección manual de método puede reescribir sin pisar nada. */
const FASES_EN_CURSO = new Set(["checking", "need-link", "qr-waiting", "qr-shown", "pairing-phone", "pairing-shown"]);

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
