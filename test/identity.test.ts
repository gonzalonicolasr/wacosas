// Tests de la identidad doble de WhatsApp: el LID (`…@lid`) y el número
// (`…@s.whatsapp.net`) son la MISMA persona, y WhatsApp manda los nombres de la
// agenda pegados a una de las dos —casi siempre al LID, por `lidContactAction`—
// mientras que el chat puede estar bajo la otra.
//
// La forma real del problema, medida sobre la cuenta de verdad (899 chats):
//
//     contactos @lid:            381   ← de estos, 32 CON nombre
//     contactos @s.whatsapp.net: 463   ← de estos,  0 CON nombre
//     chats 1:1 @lid:            351
//     chats 1:1 @s.whatsapp.net: 463
//
// Como `repo.listChats` resuelve el nombre de la agenda con
// `LEFT JOIN contacts ON contacts.jid = chats.jid`, un chat `@s.whatsapp.net`
// NUNCA encuentra su nombre si el nombre está guardado bajo el `@lid` del mismo
// contacto. El resultado es una bandeja llena de números.
//
// Lo que se verifica acá es el contrato de la solución: **un chat cuyo contacto
// tiene nombre bajo cualquiera de las dos identidades muestra ese nombre**, y
// sin mapeo disponible sigue cayendo al número sin romperse. Nada de esto fusiona
// chats: los mensajes siguen colgando de su `chat_jid` original (R7).
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Contact, WAMessage } from "baileys";

import { createLogger, type Fields } from "../src/boot/log";
import { openDb } from "../src/db/open";
import { createRepo, type Repo } from "../src/db/repo";
import { etiquetaChat } from "../src/state/commands";
import { createStore, type Store } from "../src/state/store";
import { createIngest, type Ingest, type IngestJob } from "../src/wa/ingest";
import {
  createIdentityResolver,
  ESPERA_LOTE_MS,
  LOTE_ALIAS,
  type IdentityResolver,
} from "../src/wa/identity";
import { AHORA, SELF_JID, TS_BASE } from "./fixtures/messages";

const tmp = mkdtempSync(join(tmpdir(), "wacosas-identity-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Las dos caras del mismo humano. */
const PN = "5491133445566@s.whatsapp.net";
const LID = "192837465564738@lid";
/** Otro par, para los tests que necesitan dos contactos. */
const PN_2 = "5491199887766@s.whatsapp.net";
const LID_2 = "112233445566778@lid";

/** Presupuesto por vuelta del drenador (el mismo de la tarea 7). */
const TOPE_MS = 20;

// ── agendador manual (mismo criterio que `test/ingest.test.ts`) ──────────────

function agendadorManual() {
  const pendientes: Array<() => void> = [];
  return {
    schedule(fn: () => void, _ms: number) {
      pendientes.push(fn);
      return () => {
        const i = pendientes.indexOf(fn);
        if (i >= 0) pendientes.splice(i, 1);
      };
    },
    hay: () => pendientes.length > 0,
    /** Corre UNA tarea pendiente y devuelve lo que tardó, o `null` si no había. */
    correr(): number | null {
      const fn = pendientes.shift();
      if (!fn) return null;
      const t0 = performance.now();
      fn();
      return performance.now() - t0;
    },
  };
}

// ── banco ───────────────────────────────────────────────────────────────────

let nBase = 0;

type Banco = {
  repo: Repo;
  store: Store;
  ingest: Ingest;
  /** Los avisos que el log recibió, para verificar que nada se comió una excepción. */
  eventos: string[];
  push(job: IngestJob): void;
  /** Corre todas las vueltas pendientes; devuelve los ms de cada una. */
  drenar(): number[];
  /** La etiqueta que la bandeja muestra para ese chat (lo que ve el usuario). */
  etiqueta(jid: string): string;
  cerrar(): void;
};

function banco(opts: { requestAlias?: (lids: string[]) => void } = {}): Banco {
  const db = openDb(join(tmp, `identity-${nBase++}.sqlite`));
  const repo = createRepo(db);
  const eventos: string[] = [];
  const base = createLogger(join(tmp, "identity.log"));
  const log = {
    ...base,
    warn: (evento: string, campos?: Fields) => {
      eventos.push(evento);
      base.warn(evento, campos);
    },
    error: (evento: string, campos?: Fields) => {
      eventos.push(evento);
      base.error(evento, campos);
    },
  };

  const store = createStore({ schedule: () => () => {} });
  store.bootstrap(repo);

  const agenda = agendadorManual();
  const ingest = createIngest({
    repo,
    store,
    log,
    selfJid: () => SELF_JID,
    openChatJid: () => store.openChatJid(),
    now: () => AHORA * 1000,
    schedule: agenda.schedule,
    ...(opts.requestAlias ? { requestAlias: opts.requestAlias } : {}),
  });

  return {
    repo,
    store,
    ingest,
    eventos,
    push: ingest.push,
    drenar() {
      const ms: number[] = [];
      for (let vueltas = 0; agenda.hay(); vueltas++) {
        if (vueltas > 5_000) throw new Error("el drenador no termina");
        ms.push(agenda.correr()!);
      }
      return ms;
    },
    etiqueta(jid) {
      const chat = repo.getChat(jid);
      if (!chat) throw new Error(`no existe el chat ${jid}`);
      return etiquetaChat(chat);
    },
    cerrar() {
      store.stop();
      repo.close();
    },
  };
}

/** Un entrante del chat `jid`, opcionalmente con la identidad hermana al lado. */
function entrante(o: { jid: string; alt?: string; id?: string; pushName?: string }): WAMessage {
  return {
    key: {
      remoteJid: o.jid,
      fromMe: false,
      id: o.id ?? "3EB0IDENTIDAD000001",
      ...(o.alt ? { remoteJidAlt: o.alt } : {}),
    },
    message: { conversation: "hola, ¿cómo va?" },
    messageTimestamp: TS_BASE,
    ...(o.pushName ? { pushName: o.pushName } : {}),
  };
}

/**
 * La ficha que manda `lidContactAction`: el nombre de la agenda pegado al LID y
 * **sin** número al lado (`Utils/chat-utils.js:833`). Es la forma exacta en la
 * que llegan los 32 nombres de la cuenta real.
 */
const contactoSoloLid = (jid: string, nombre: string): Contact => ({
  id: jid,
  name: nombre,
  lid: jid,
});

// ── la forma real del problema ──────────────────────────────────────────────

test("el nombre que llegó bajo @lid aparece en el chat @s.whatsapp.net (mapeo por remoteJidAlt)", () => {
  const b = banco();
  // La agenda: el nombre viene pegado al LID, sin número al lado.
  b.push({ kind: "contacts", contacts: [contactoSoloLid(LID, "Ana Gómez")] });
  // El chat: bajo el NÚMERO, y el sobre trae la identidad hermana al lado.
  b.push({ kind: "messages", msgs: [entrante({ jid: PN, alt: LID })], source: "notify" });
  b.drenar();

  expect(b.etiqueta(PN)).toBe("Ana Gómez");
  b.cerrar();
});

test("y al revés: nombre bajo @s.whatsapp.net, chat bajo @lid", () => {
  const b = banco();
  b.push({ kind: "contacts", contacts: [{ id: PN, name: "Ana Gómez" }] });
  b.push({ kind: "messages", msgs: [entrante({ jid: LID, alt: PN })], source: "notify" });
  b.drenar();

  expect(b.etiqueta(LID)).toBe("Ana Gómez");
  b.cerrar();
});

test("el nombre llega DESPUÉS del mensaje y el chat lo toma igual", () => {
  const b = banco();
  // Primero el chat (con el mapeo), después el `contacts.upsert` del app-state:
  // es el orden real, porque la agenda sincroniza cuando se le canta.
  b.push({ kind: "messages", msgs: [entrante({ jid: PN, alt: LID })], source: "notify" });
  b.drenar();
  expect(b.etiqueta(PN)).not.toBe("Ana Gómez");

  b.push({ kind: "contacts", contacts: [contactoSoloLid(LID, "Ana Gómez")] });
  b.drenar();
  expect(b.etiqueta(PN)).toBe("Ana Gómez");
  b.cerrar();
});

test("la ficha del contacto con las DOS identidades ya alcanza (contactAction)", () => {
  const b = banco();
  // `processContactAction` emite el contacto con `lid` y `phoneNumber` adentro
  // (`Utils/sync-action-utils.js:18`): el mapeo viene gratis en el payload.
  b.push({ kind: "messages", msgs: [entrante({ jid: LID })], source: "notify" });
  b.push({
    kind: "contacts",
    contacts: [{ id: PN, name: "Ana Gómez", lid: LID, phoneNumber: PN }],
  });
  b.drenar();

  expect(b.etiqueta(LID)).toBe("Ana Gómez");
  b.cerrar();
});

test("sin mapeo disponible el chat sigue cayendo al número, sin romperse", () => {
  const b = banco();
  b.push({ kind: "contacts", contacts: [contactoSoloLid(LID, "Ana Gómez")] });
  // El mismo mensaje pero SIN `remoteJidAlt`: nadie puede saber que son la
  // misma persona, así que el chat se queda con el número formateado (§5.4).
  b.push({ kind: "messages", msgs: [entrante({ jid: PN })], source: "notify" });
  b.drenar();

  expect(b.etiqueta(PN)).toBe("+5491133445566");
  expect(b.repo.getChat(PN)!.unreadCount).toBe(1); // el ingest hizo el resto igual
  expect(b.eventos).toEqual([]);
  b.cerrar();
});

test("un nombre propio del chat NO se pisa con el de la otra identidad", () => {
  const b = banco();
  b.push({ kind: "contacts", contacts: [contactoSoloLid(LID, "Ana Gómez")] });
  b.push({ kind: "contacts", contacts: [{ id: PN, name: "Ana del laburo" }] });
  b.push({ kind: "messages", msgs: [entrante({ jid: PN, alt: LID })], source: "notify" });
  b.drenar();

  // Cada identidad conserva el nombre que WhatsApp le dio: el préstamo es sólo
  // para la que no tiene ninguno.
  expect(b.etiqueta(PN)).toBe("Ana del laburo");
  expect(b.repo.getContact(LID)!.name).toBe("Ana Gómez");
  b.cerrar();
});

test("el par `lidPnMappings` del history sync también resuelve el nombre", () => {
  const b = banco();
  b.push({ kind: "contacts", contacts: [contactoSoloLid(LID, "Ana Gómez")] });
  b.push({ kind: "chats", chats: [{ id: PN, conversationTimestamp: TS_BASE }] });
  b.drenar();
  expect(b.etiqueta(PN)).toBe("+5491133445566");

  b.push({ kind: "aliases", pairs: [{ lid: LID, pn: PN }] });
  b.drenar();
  expect(b.etiqueta(PN)).toBe("Ana Gómez");
  b.cerrar();
});

test("el par que devuelve el store de baileys viene con dispositivo y resuelve igual", () => {
  const b = banco();
  b.push({ kind: "contacts", contacts: [contactoSoloLid(LID, "Ana Gómez")] });
  b.push({ kind: "messages", msgs: [entrante({ jid: PN })], source: "notify" });
  b.drenar();

  // `getPNsForLIDs` arma el número CON sufijo de dispositivo (`…:0@…`,
  // `Signal/lid-mapping.js:229`): si el ingest no lo normalizara, el par se
  // guardaría contra un jid que no existe en ninguna tabla.
  b.push({ kind: "aliases", pairs: [{ lid: "192837465564738:0@lid", pn: "5491133445566:0@s.whatsapp.net" }] });
  b.drenar();

  expect(b.etiqueta(PN)).toBe("Ana Gómez");
  expect(b.repo.altJid(PN)).toBe(LID);
  b.cerrar();
});

test("la equivalencia queda escrita en las dos direcciones y no crea chats fantasma", () => {
  const b = banco();
  b.push({ kind: "contacts", contacts: [contactoSoloLid(LID, "Ana Gómez")] });
  b.push({ kind: "messages", msgs: [entrante({ jid: PN, alt: LID })], source: "notify" });
  b.drenar();

  expect(b.repo.altJid(PN)).toBe(LID);
  expect(b.repo.altJid(LID)).toBe(PN);
  // El contacto de la agenda no puede inventar un chat con alguien con quien
  // nunca hablaste: el `@lid` no está en la bandeja.
  expect(b.repo.listChats().map((c) => c.jid)).toEqual([PN]);
  b.cerrar();
});

test("el nombre prestado también llega a `chats.name` (que es lo que muestra la búsqueda global)", () => {
  const b = banco();
  b.push({ kind: "contacts", contacts: [contactoSoloLid(LID, "Ana Gómez")] });
  b.push({ kind: "messages", msgs: [entrante({ jid: PN, alt: LID })], source: "notify" });
  b.drenar();

  // `repo.searchMessages` lee `chats.name` a pelo, sin el JOIN con la agenda.
  const hits = b.repo.searchMessages("hola", 10);
  expect(hits).toHaveLength(1);
  expect(hits[0]!.chatName).toBe("Ana Gómez");
  b.cerrar();
});

test("un grupo nunca entra en el juego de identidades", () => {
  const b = banco();
  const grupo = "120363041234567890@g.us";
  b.push({ kind: "aliases", pairs: [{ lid: LID, pn: grupo }] });
  b.push({ kind: "aliases", pairs: [{ lid: grupo, pn: PN }] });
  // Y un par degenerado (la misma identidad de los dos lados) tampoco.
  b.push({ kind: "aliases", pairs: [{ lid: LID, pn: LID }] });
  b.drenar();

  expect(b.repo.altJid(grupo)).toBeNull();
  expect(b.repo.altJid(LID)).toBeNull();
  expect(b.eventos).toEqual([]);
  b.cerrar();
});

// ── el pedido a demanda (identidades que ya están en la base) ────────────────

test("un contacto con nombre y sin hermana conocida se reporta UNA sola vez", () => {
  const pedidos: string[][] = [];
  const b = banco({ requestAlias: (lids) => pedidos.push(lids) });

  b.push({ kind: "contacts", contacts: [contactoSoloLid(LID, "Ana Gómez")] });
  b.push({ kind: "contacts", contacts: [contactoSoloLid(LID, "Ana Gómez")] });
  b.push({ kind: "contacts", contacts: [contactoSoloLid(LID_2, "Beto")] });
  // Sin nombre no hay nada que prestar: no se pregunta.
  b.push({ kind: "contacts", contacts: [{ id: "998877665544@lid", notify: "" , phoneNumber: "" }] });
  // Un `@s.whatsapp.net` tampoco: la vuelta pn→lid es una consulta de RED.
  b.push({ kind: "contacts", contacts: [{ id: PN_2, name: "Carlos" }] });
  b.drenar();

  expect(pedidos.flat()).toEqual([LID, LID_2]);
  b.cerrar();
});

test("con la hermana ya conocida no se pregunta nada", () => {
  const pedidos: string[][] = [];
  const b = banco({ requestAlias: (lids) => pedidos.push(lids) });

  b.push({ kind: "aliases", pairs: [{ lid: LID, pn: PN }] });
  b.push({ kind: "contacts", contacts: [contactoSoloLid(LID, "Ana Gómez")] });
  b.drenar();

  expect(pedidos.flat()).toEqual([]);
  b.cerrar();
});

// ── el resolver (`wa/identity.ts`) ──────────────────────────────────────────

type BancoResolver = {
  resolver: IdentityResolver;
  /** Los lotes que se le pidieron al store de baileys, en orden. */
  lotes: string[][];
  jobs: IngestJob[];
  eventos: string[];
  correr(): number;
};

function bancoResolver(
  opts: {
    repo?: Partial<Repo>;
    pnForLids?: (lids: string[]) => Promise<Array<{ lid: string; pn: string }>>;
  } = {},
): BancoResolver {
  const lotes: string[][] = [];
  const jobs: IngestJob[] = [];
  const eventos: string[] = [];
  const base = createLogger(join(tmp, "identity-resolver.log"));
  const log = {
    ...base,
    warn: (evento: string, campos?: Fields) => {
      eventos.push(evento);
      base.warn(evento, campos);
    },
  };
  const agenda = agendadorManual();

  const resolver = createIdentityResolver({
    repo: { contactsMissingAlias: () => [], ...opts.repo } as Repo,
    log,
    push: (job) => jobs.push(job),
    pnForLids: async (lids) => {
      lotes.push(lids);
      return opts.pnForLids ? await opts.pnForLids(lids) : lids.map((lid) => ({ lid, pn: PN }));
    },
    schedule: agenda.schedule,
  });

  return {
    resolver,
    lotes,
    jobs,
    eventos,
    /** Corre todo lo agendado (incluidas las microtareas de las promesas). */
    correr() {
      let vueltas = 0;
      while (agenda.hay()) {
        if (vueltas++ > 1_000) throw new Error("el resolver no termina");
        agenda.correr();
      }
      return vueltas;
    },
  };
}

/** Deja correr las promesas ya resueltas (el `then` del lote). */
const microtareas = () => new Promise<void>((r) => setTimeout(r, 0));

test("el resolver pregunta en lotes y devuelve los pares por la cola del ingest", async () => {
  const b = bancoResolver();
  b.resolver.request([LID, LID_2]);
  b.correr();
  await microtareas();
  b.correr();

  expect(b.lotes).toEqual([[LID, LID_2]]);
  expect(b.jobs).toEqual([
    { kind: "aliases", pairs: [{ lid: LID, pn: PN }, { lid: LID_2, pn: PN }] },
  ]);
  b.resolver.stop();
});

test("una identidad se pregunta UNA sola vez, resuelta o no", async () => {
  const b = bancoResolver({ pnForLids: async () => [] });
  b.resolver.request([LID, LID]);
  b.correr();
  await microtareas();
  b.correr();
  // Ni el mismo pedido repetido, ni un barrido posterior, la vuelven a pedir.
  b.resolver.request([LID]);
  b.correr();
  await microtareas();
  b.correr();

  expect(b.lotes).toEqual([[LID]]);
  b.resolver.stop();
});

test("lo que no es `@lid` no se le pregunta al store (esa vuelta es de RED)", async () => {
  const b = bancoResolver();
  b.resolver.request([PN, "120363041234567890@g.us", ""]);
  b.correr();
  await microtareas();

  expect(b.lotes).toEqual([]);
  b.resolver.stop();
});

test("un store que rechaza (o que lanza) no voltea nada y deja el aviso", async () => {
  const b = bancoResolver({
    pnForLids: async () => {
      throw new Error("no hay socket");
    },
  });
  b.resolver.request([LID]);
  b.correr();
  await microtareas();
  b.correr();

  expect(b.jobs).toEqual([]);
  expect(b.eventos).toContain("identity.lote_fallido");
  b.resolver.stop();
});

test("el barrido toma los contactos con nombre que la base ya tiene, en lotes espaciados", async () => {
  // El peor caso del pedido: 813 identidades sin hermana conocida.
  const muchos = Array.from({ length: 813 }, (_, i) => `${100000000000000 + i}@lid`);
  const b = bancoResolver({ repo: { contactsMissingAlias: () => muchos } });

  b.resolver.sweep();
  for (let i = 0; i < 100 && b.lotes.length * LOTE_ALIAS < muchos.length; i++) {
    b.correr();
    await microtareas();
  }
  b.correr();

  // UNA consulta local por lote de 50: nada de 813 llamadas sueltas, y ni una
  // sola stanza a WhatsApp (el store de baileys resuelve lid→pn de disco).
  expect(b.lotes.length).toBe(Math.ceil(813 / LOTE_ALIAS));
  expect(b.lotes.flat()).toHaveLength(813);
  expect(new Set(b.lotes.flat()).size).toBe(813);
  console.log(
    `[identity] peor caso 813 identidades · ${b.lotes.length} consultas LOCALES ` +
      `(lotes de ${LOTE_ALIAS}, ${ESPERA_LOTE_MS} ms entre lote y lote) · 0 stanzas a WhatsApp`,
  );
  b.resolver.stop();
});

// ── presupuesto ─────────────────────────────────────────────────────────────

test(
  "el ingest sigue dentro de presupuesto con la identidad doble en juego (RNF-5)",
  () => {
    const b = banco();
    // 800 contactos con nombre, cada uno con su par de identidades, y 5.000
    // mensajes que traen la hermana en el sobre: el peor caso del sync inicial.
    const contactos: Contact[] = [];
    const msgs: WAMessage[] = [];
    for (let i = 0; i < 800; i++) {
      const lid = `${100000000000000 + i}@lid`;
      const pn = `54911${String(4000000 + i)}@s.whatsapp.net`;
      contactos.push(contactoSoloLid(lid, `Contacto ${i}`));
      for (let m = 0; m < 6; m++) {
        msgs.push(entrante({ jid: pn, alt: lid, id: `3EB0IDENT${i}_${m}` }));
      }
    }
    b.push({ kind: "contacts", contacts: contactos });
    for (let i = 0; i < msgs.length; i += 500) {
      b.push({ kind: "messages", msgs: msgs.slice(i, i + 500), source: "history" });
    }

    const ms = b.drenar();
    const peor = Math.max(...ms);
    console.log(
      `[identity] 800 contactos + ${msgs.length} mensajes con identidad doble en ` +
        `${ms.length} vueltas · peor tick ${peor.toFixed(2)} ms`,
    );

    expect(peor).toBeLessThanOrEqual(TOPE_MS);
    // Y el resultado: los 800 chats bajo el número muestran el nombre del LID.
    const chats = b.repo.listChats();
    expect(chats).toHaveLength(800);
    expect(chats.every((c) => etiquetaChat(c).startsWith("Contacto "))).toBe(true);
    b.cerrar();
  },
  30_000,
);
