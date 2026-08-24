// Rescate de nombres a través de la identidad doble de WhatsApp (LID ↔ número).
//
// EL PROBLEMA. WhatsApp está migrando a un identificador que no es el teléfono
// —el LID, `1234567890@lid`— y manda los nombres de la AGENDA pegados a él
// (`lidContactAction`, `Utils/chat-utils.js:833`, que emite un `contacts.upsert`
// con el nombre y SIN número al lado). Los chats, en cambio, vienen muchas veces
// bajo el número. Como `repo.listChats` resuelve el nombre con
// `LEFT JOIN contacts ON contacts.jid = chats.jid`, ese chat nunca encontraba su
// nombre: medido sobre la cuenta real, 463 contactos con número y NINGUNO con
// nombre, contra 32 nombres que estaban todos en filas `@lid`.
//
// EL RESCATE. El ingest ya aprovecha las tres fuentes GRATIS del mapeo (el
// `remoteJidAlt` del sobre, las dos identidades adentro de la ficha del contacto
// y los `lidPnMappings` del history sync). Lo que queda afuera son las
// identidades que YA ESTÁN en la base sin hermana conocida —el nombre llegó en
// otra corrida, o el chat es viejo—: para esas está este módulo, que le pregunta
// al store de baileys.
//
// **La consulta que hace NO toca la red.** `lidMapping.getPNsForLIDs` resuelve
// LID → número contra su caché y los archivos de `creds/` (`Signal/lid-mapping.js`,
// `_getPNsForLIDsImpl`): cero stanzas a WhatsApp, cero riesgo de R8. La vuelta
// contraria (número → LID) SÍ es una consulta USync a WhatsApp, y por eso no se
// hace: además de arriesgada sería inútil, porque los nombres viven del lado del
// LID —si el LID no tiene nombre, su número tampoco—.
//
// Aun así se pregunta en LOTES ESPACIADOS y **una sola vez por identidad**
// (resuelta o no): son cientos de lecturas de disco y no hay ningún apuro por
// hacerlas todas en el mismo tick.
//
// Lo que este módulo NO hace: fusionar los dos chats. Los mensajes siguen
// colgando de su `chat_jid` original (R7); acá sólo se comparte el nombre.
import { isLidUser } from "baileys";
import type { LIDMapping } from "baileys";

import type { Logger } from "../boot/log";
import type { Repo } from "../db/repo";
import type { Cancelar } from "../state/store";

import type { IngestJob } from "./ingest";

/**
 * Identidades por consulta. `getPNsForLIDs` resuelve el lote entero con UNA
 * lectura del store, así que el tamaño manda cuántas consultas salen: 813
 * identidades (el peor caso medido) son 17 consultas locales.
 */
export const LOTE_ALIAS = 50;

/**
 * Espera entre lote y lote. No protege de un ban (no hay red de por medio):
 * protege el event loop, porque cada lote son decenas de lecturas de archivo y
 * la TUI está pintando en el mismo proceso (RNF-5).
 */
export const ESPERA_LOTE_MS = 250;

export type IdentityResolver = {
  /**
   * Pide la hermana de estas identidades. Lo que no sea `@lid` se descarta, y
   * cada identidad se pregunta UNA sola vez por sesión. No bloquea: encola.
   */
  request(lids: string[]): void;
  /**
   * Barre la base: los contactos que tienen nombre y todavía no tienen hermana.
   * Es lo que rescata los chats que ya estaban guardados sin nombre. Idempotente
   * —lo ya preguntado no se vuelve a preguntar—, pensado para correr cuando la
   * conexión abre.
   */
  sweep(): void;
  /** Corta lo agendado. Lo usa el cierre ordenado. */
  stop(): void;
};

export type IdentityDeps = {
  repo: Pick<Repo, "contactsMissingAlias">;
  log: Logger;
  /**
   * El resultado entra por la cola del ingest —un solo camino de escritura, el
   * mismo criterio que el `groupSubject` a demanda—.
   */
  push(job: IngestJob): void;
  /**
   * LID → número contra `sock.signalRepository.lidMapping`. Es LOCAL (caché +
   * archivos de `creds/`), nunca manda una stanza. Puede devolver menos pares de
   * los pedidos: lo que no está, no está.
   */
  pnForLids(lids: string[]): Promise<LIDMapping[]>;
  /** Agendador. Default `setTimeout`; el test le pasa uno manual. */
  schedule?: (fn: () => void, ms: number) => Cancelar;
};

const agendarReal = (fn: () => void, ms: number): Cancelar => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

function motivo(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createIdentityResolver(deps: IdentityDeps): IdentityResolver {
  const { repo, log, push, pnForLids } = deps;
  const agendar = deps.schedule ?? agendarReal;

  /** Identidades esperando lote. */
  const pendientes: string[] = [];
  /** Todo lo que ya se preguntó alguna vez, haya salido bien o mal. */
  const preguntadas = new Set<string>();
  let cancelar: Cancelar | null = null;
  /** Hay un lote en vuelo: el próximo se agenda recién cuando este conteste. */
  let enVuelo = false;
  let detenido = false;

  function agendarLote(ms: number): void {
    if (detenido || cancelar || enVuelo || pendientes.length === 0) return;
    cancelar = agendar(() => {
      cancelar = null;
      correrLote();
    }, ms);
  }

  function correrLote(): void {
    if (detenido) return;
    const lote = pendientes.splice(0, LOTE_ALIAS);
    if (lote.length === 0) return;

    let pedido: Promise<LIDMapping[]>;
    enVuelo = true;
    try {
      // El `try` cubre la función que LANZA en vez de rechazar (un socket que ya
      // no está, por ejemplo): esto cuelga de un timer y no puede tirar nada.
      pedido = Promise.resolve(pnForLids(lote));
    } catch (e) {
      terminarLote(e);
      return;
    }
    pedido.then((pares) => terminarLote(null, pares), terminarLote);
  }

  /** Cierra el lote: publica lo que vino, loguea lo que falló y sigue. */
  function terminarLote(err: unknown, pares?: LIDMapping[]): void {
    enVuelo = false;
    if (err !== null && err !== undefined) {
      log.warn("identity.lote_fallido", { motivo: motivo(err) });
    } else {
      const utiles = (Array.isArray(pares) ? pares : []).filter((p) => !!p?.lid && !!p?.pn);
      if (utiles.length > 0) {
        try {
          push({ kind: "aliases", pairs: utiles });
        } catch (e) {
          log.warn("identity.push_fallido", { motivo: motivo(e) });
        }
      }
    }
    // El próximo lote va espaciado SIEMPRE, también después de un fallo: si el
    // store no está, insistir sin respiro no lo trae de vuelta.
    agendarLote(ESPERA_LOTE_MS);
  }

  function pedir(lids: string[]): void {
    if (detenido) return;
    for (const crudo of Array.isArray(lids) ? lids : []) {
      const jid = typeof crudo === "string" ? crudo : "";
      // Sólo `@lid`: la vuelta contraria es una consulta USync a WhatsApp.
      if (!jid || preguntadas.has(jid) || !isLidUser(jid)) continue;
      preguntadas.add(jid);
      pendientes.push(jid);
    }
    agendarLote(0);
  }

  return {
    request: pedir,

    sweep() {
      if (detenido) return;
      let candidatas: string[];
      try {
        candidatas = repo.contactsMissingAlias();
      } catch (e) {
        // Nunca lanza hacia afuera: esto cuelga de un cambio de estado de la
        // conexión y no puede voltear nada.
        log.warn("identity.barrido_fallido", { motivo: motivo(e) });
        return;
      }
      const antes = preguntadas.size;
      pedir(candidatas);
      const nuevas = preguntadas.size - antes;
      if (nuevas > 0) log.info("identity.barrido", { candidatas: candidatas.length, nuevas });
    },

    stop() {
      detenido = true;
      cancelar?.();
      cancelar = null;
      pendientes.length = 0;
    },
  };
}
