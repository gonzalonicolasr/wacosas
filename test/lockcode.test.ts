// Tests del candado: el código guardado con scrypt (`boot/lockcode.ts`), el
// revelado desde el buscador de la bandeja (`state/commands.ts`), lo que ve la
// base con los chats revelados (`db/repo.ts`) y la única puerta que quedaba
// abierta del filtro anterior: **el chat que ya estaba abierto** cuando llegó el
// candado (`state/store.ts`).
//
// Lo que se mira acá y no en un render: que el archivo NO tenga los dígitos, que
// un código incorrecto se comporte EXACTAMENTE como una búsqueda cualquiera (o
// sea, que no delate que existe un código) y que revelar no toque a los
// bloqueados.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLockCode, MAX_DIGITOS, MIN_DIGITOS, validarCodigo } from "../src/boot/lockcode";
import { openDb } from "../src/db/open";
import { createRepo, type Repo } from "../src/db/repo";
import type { MappedMessage } from "../src/db/types";
import {
  commands,
  configureCommands,
  ESPERA_CONFIRMACION_MS,
  type CommandDeps,
} from "../src/state/commands";
import { createStore, type Store } from "../src/state/store";

const tmp = mkdtempSync(join(tmpdir(), "wacosas-candado-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const LOG = { info() {}, warn() {}, error() {}, path: join(tmp, "wacosas.log") };

/** Los permisos efectivos, como los muestra `stat -c %a`. */
const modo = (p: string) => (statSync(p).mode & 0o777).toString(8);

/** Un archivo de código nuevo para cada test: nunca se comparten. */
let n = 0;
const rutaNueva = () => join(tmp, `lock-code-${++n}.json`);

const ANA = "5491150000001@s.whatsapp.net";
const BETO = "5491199999999@s.whatsapp.net";
const ANA_LID = "77771111@lid";

function mensaje(over: Partial<MappedMessage> = {}): MappedMessage {
  return {
    chatJid: ANA,
    waId: "WA1",
    fromMe: false,
    senderJid: ANA,
    senderName: "Ana",
    ts: 1_700_000_000,
    kind: "text",
    body: "hola",
    attachment: null,
    status: "received",
    ...over,
  };
}

/** Ana (con dos mensajes) y Beto (con uno). Los dos buscables por `hola`. */
function baseConDosChats(): Repo {
  const repo = createRepo(openDb(":memory:"));
  repo.upsertChat({ jid: ANA, name: "Ana", lastMessageAt: 300, unreadCount: 2 });
  repo.upsertChat({ jid: BETO, name: "Beto", lastMessageAt: 200 });
  repo.insertMessage(mensaje({ waId: "A1", body: "hola dice ana" }));
  repo.insertMessage(mensaje({ waId: "A2", body: "otro mensaje de ana" }));
  repo.insertMessage(mensaje({ chatJid: BETO, waId: "B1", senderJid: BETO, body: "hola dice beto" }));
  return repo;
}

/** Espera a que se cumpla algo (el revelado llega por una derivación scrypt). */
async function esperarA(cond: () => boolean, ms = 3_000): Promise<void> {
  const hasta = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > hasta) throw new Error("timeout esperando la condición");
    await Bun.sleep(5);
  }
}

// ── el archivo del código ───────────────────────────────────────────────────

describe("código del candado en disco", () => {
  test("sin archivo no hay código, y nada verifica", async () => {
    const lock = createLockCode(rutaNueva(), LOG);
    expect(lock.exists()).toBe(false);
    expect(await lock.verify("1234")).toBe(false);
    expect(await lock.verify("")).toBe(false);
  });

  test("se guarda hasheado: 0600, sin los dígitos en ningún lado", () => {
    const ruta = rutaNueva();
    const lock = createLockCode(ruta, LOG);
    expect(lock.set("482913").ok).toBe(true);

    expect(modo(ruta)).toBe("600");
    const crudo = readFileSync(ruta, "utf8");
    // Ni los dígitos, ni al derecho ni en base64 (que es como está el hash).
    expect(crudo).not.toContain("482913");
    expect(crudo).not.toContain(Buffer.from("482913").toString("base64"));

    const o = JSON.parse(crudo);
    expect(o.kdf).toBe("scrypt");
    // Sal de 16 bytes y hash de 32, los dos en base64.
    expect(Buffer.from(o.salt, "base64").length).toBe(16);
    expect(Buffer.from(o.hash, "base64").length).toBe(32);
    // El LARGO del código tampoco se guarda: ya sería media pista.
    expect(JSON.stringify(o)).not.toContain('"6"');
    expect(o.largo).toBeUndefined();
  });

  test("el correcto verifica y el incorrecto no", async () => {
    const lock = createLockCode(rutaNueva(), LOG);
    lock.set("482913");
    expect(await lock.verify("482913")).toBe(true);
    expect(await lock.verify("482914")).toBe(false);
    expect(await lock.verify("48291")).toBe(false);
    expect(await lock.verify("4829130")).toBe(false);
    // Nada que no tenga forma de código: ni siquiera llega a derivar.
    expect(await lock.verify("hola")).toBe(false);
    expect(await lock.verify("48 29 13")).toBe(false);
  });

  test("el código sobrevive al proceso (se lee del archivo, no de la memoria)", async () => {
    const ruta = rutaNueva();
    createLockCode(ruta, LOG).set("112233");
    // Otra instancia: como abrir wacosas de nuevo.
    const otra = createLockCode(ruta, LOG);
    expect(otra.exists()).toBe(true);
    expect(await otra.verify("112233")).toBe(true);
  });

  test("re-fijarlo cambia la sal: el mismo código no da el mismo archivo", async () => {
    const ruta = rutaNueva();
    const lock = createLockCode(ruta, LOG);
    lock.set("112233");
    const primero = JSON.parse(readFileSync(ruta, "utf8"));
    lock.set("112233");
    const segundo = JSON.parse(readFileSync(ruta, "utf8"));
    expect(segundo.salt).not.toBe(primero.salt);
    expect(segundo.hash).not.toBe(primero.hash);
    // Y sigue andando: el que verifica es el nuevo par sal+hash.
    expect(await lock.verify("112233")).toBe(true);

    // Cambiarlo de verdad: el viejo deja de servir en el acto (CA del candado:
    // si cambia en el teléfono, se vuelve a fijar acá).
    lock.set("445566");
    expect(await lock.verify("112233")).toBe(false);
    expect(await lock.verify("445566")).toBe(true);
  });

  test("sólo dígitos y entre 4 y 16: lo demás no se puede fijar", () => {
    const lock = createLockCode(rutaNueva(), LOG);
    expect(lock.set("hola1234")).toMatchObject({ ok: false });
    expect(lock.set("12 34")).toMatchObject({ ok: false });
    expect(lock.set("+541234")).toMatchObject({ ok: false });
    expect(lock.set("")).toMatchObject({ ok: false });
    expect(lock.set("1".repeat(MIN_DIGITOS - 1))).toMatchObject({ ok: false });
    expect(lock.set("1".repeat(MAX_DIGITOS + 1))).toMatchObject({ ok: false });
    // Nada de lo anterior dejó archivo: no hay código a medio fijar.
    expect(lock.exists()).toBe(false);

    expect(lock.set("1".repeat(MIN_DIGITOS)).ok).toBe(true);
    expect(validarCodigo("1234")).toEqual({ ok: true, digits: "1234" });
  });

  test("un archivo roto se comporta como 'no hay código' (el lado seguro)", async () => {
    const ruta = rutaNueva();
    writeFileSync(ruta, "{ esto no es json", { mode: 0o600 });
    const lock = createLockCode(ruta, LOG);
    expect(lock.exists()).toBe(false);
    expect(await lock.verify("1234")).toBe(false);

    // Un JSON válido pero con la sal cambiada de largo tampoco pasa.
    writeFileSync(ruta, JSON.stringify({ kdf: "scrypt", n: 16384, r: 8, p: 1, salt: "AA", hash: "BB" }));
    expect(createLockCode(ruta, LOG).exists()).toBe(false);
  });

  test("un archivo que quedó con permisos laxos se endurece al fijar el código", () => {
    const ruta = rutaNueva();
    writeFileSync(ruta, "{}", { mode: 0o644 });
    chmodSync(ruta, 0o644); // el `mode` del open no corrige lo que ya existía
    expect(modo(ruta)).toBe("644");
    createLockCode(ruta, LOG).set("998877");
    expect(modo(ruta)).toBe("600");
  });
});

// ── lo que ve la base con el candado revelado ───────────────────────────────

describe("repo con el candado revelado", () => {
  const nombres = (repo: Repo, ver?: boolean) => repo.listChats(undefined, ver).map((c) => c.name);
  const enBusqueda = (repo: Repo, ver?: boolean) =>
    repo.searchMessages("hola", 10, ver).map((h) => h.chatName);

  test("con el código, el chat con candado vuelve a las cuatro puertas", () => {
    const repo = baseConDosChats();
    repo.setLocked(ANA, true);

    // Sin revelar: como antes.
    expect(nombres(repo)).toEqual(["Beto"]);
    expect(repo.countsByFilter()).toEqual({ all: 1, unread: 0, groups: 0 });
    expect(repo.searchChats("ana", 10)).toEqual([]);
    expect(enBusqueda(repo)).toEqual(["Beto"]);

    // Revelado: bandeja, contadores, chats de la búsqueda global y mensajes.
    expect(nombres(repo, true)).toEqual(["Ana", "Beto"]);
    expect(repo.countsByFilter(true)).toEqual({ all: 2, unread: 1, groups: 0 });
    expect(repo.searchChats("ana", 10, true).map((c) => c.name)).toEqual(["Ana"]);
    expect(enBusqueda(repo, true).sort()).toEqual(["Ana", "Beto"]);
  });

  test("el código del CANDADO no desbloquea a nadie", () => {
    const repo = baseConDosChats();
    repo.setBlocked(ANA, true);
    // Revelar no lo trae: un bloqueado no es un chat escondido detrás de un
    // código, es alguien con quien el usuario decidió no hablar.
    expect(nombres(repo, true)).toEqual(["Beto"]);
    expect(repo.countsByFilter(true)).toEqual({ all: 1, unread: 0, groups: 0 });
    expect(enBusqueda(repo, true)).toEqual(["Beto"]);
    expect(repo.isHidden(ANA, true)).toBe(true);
  });

  test("isHidden cruza la identidad hermana (la marca puede estar en el @lid)", () => {
    const repo = baseConDosChats();
    repo.linkJids(ANA, ANA_LID);
    repo.setLocked(ANA_LID, true);

    // El chat está bajo el número y el candado pegado al lid: igual está oculto.
    expect(repo.isHidden(ANA)).toBe(true);
    expect(repo.isHidden(ANA, true)).toBe(false);
    expect(repo.isHidden(BETO)).toBe(false);
    expect(nombres(repo)).toEqual(["Beto"]);
    expect(nombres(repo, true)).toEqual(["Ana", "Beto"]);
  });
});

// ── el gesto completo, por los comandos ─────────────────────────────────────

/** Comandos cableados contra un store propio y un código ya fijado. */
function armar(codigo = "482913") {
  const repo = baseConDosChats();
  const s: Store = createStore();
  s.bootstrap(repo);
  const lockCode = createLockCode(rutaNueva(), LOG);
  if (codigo) lockCode.set(codigo);
  configureCommands({
    repo,
    wa: {} as CommandDeps["wa"],
    store: s,
    log: LOG as CommandDeps["log"],
    lockCode,
    shutdown() {},
  });
  return { repo, s, lockCode };
}

const listado = (s: Store): string[] => {
  s.flushNow();
  return s.getSnapshot("inbox").chats.map((c) => c.name);
};

describe("revelar desde el buscador de la bandeja", () => {
  test("el código correcto revela, limpia el campo y avisa", async () => {
    const { repo, s } = armar();
    repo.setLocked(ANA, true);
    s.markDirty("inbox");
    expect(listado(s)).toEqual(["Beto"]);

    commands.setInboxQuery("482913");
    await esperarA(() => s.lockedRevealed());

    expect(listado(s)).toEqual(["Ana", "Beto"]);
    // El código NO se queda en pantalla: el campo vuelve a estar vacío.
    expect(s.inboxUi().inboxQuery).toBe("");
    expect(s.getSnapshot("ui").lockedRevealed).toBe(true);
    expect(s.getSnapshot("ui").toast?.text).toContain("candado");
  });

  test("un código incorrecto no revela y se comporta como una búsqueda normal", async () => {
    const { repo, s } = armar();
    repo.setLocked(ANA, true);
    s.markDirty("inbox");

    commands.setInboxQuery("482914");
    // Se le da tiempo de sobra a la derivación: lo que se afirma es que NO pasó.
    await Bun.sleep(300);

    expect(s.lockedRevealed()).toBe(false);
    expect(listado(s)).toEqual(["Beto"]);
    // El texto sigue en el buscador filtrando, como cualquier otra cosa: nada en
    // pantalla dice "código incorrecto" ni delata que existe un código.
    expect(s.inboxUi().inboxQuery).toBe("482914");
    expect(s.getSnapshot("ui").toast).toBe(null);
  });

  test("sin código fijado, escribir dígitos es sólo escribir dígitos", async () => {
    const { repo, s } = armar("");
    repo.setLocked(ANA, true);
    s.markDirty("inbox");

    commands.setInboxQuery("482913");
    await Bun.sleep(300);

    expect(s.lockedRevealed()).toBe(false);
    expect(s.inboxUi().inboxQuery).toBe("482913");
    expect(listado(s)).toEqual(["Beto"]);
  });

  test("Esc los vuelve a esconder y cierra el chat con candado que estaba abierto", async () => {
    const { repo, s } = armar();
    repo.setLocked(ANA, true);
    s.markDirty("inbox");

    commands.setInboxQuery("482913");
    await esperarA(() => s.lockedRevealed());

    // Con el candado revelado el chat se abre y se LEE como cualquier otro.
    commands.openChat(ANA);
    s.flushNow();
    expect(s.getSnapshot("convo").messages.map((m) => m.body)).toEqual([
      "hola dice ana",
      "otro mensaje de ana",
    ]);

    commands.hideLocked();
    s.flushNow();
    expect(s.lockedRevealed()).toBe(false);
    expect(listado(s)).toEqual(["Beto"]);
    // El chat abierto era uno de los escondidos: se cierra, no queda un panel de
    // conversación (con su campo de redacción) apuntando a algo que ya no se ve.
    expect(s.openChatJid()).toBe(null);
    expect(s.getSnapshot("convo").messages).toEqual([]);
  });

  test("estando ya revelado no se vuelve a derivar por cada tecla", async () => {
    const { repo, s, lockCode } = armar();
    repo.setLocked(ANA, true);
    commands.setInboxQuery("482913");
    await esperarA(() => s.lockedRevealed());

    let derivaciones = 0;
    const espiado = { ...lockCode, verify: (d: string) => (derivaciones++, lockCode.verify(d)) };
    configureCommands({
      repo,
      wa: {} as CommandDeps["wa"],
      store: s,
      log: LOG as CommandDeps["log"],
      lockCode: espiado,
      shutdown() {},
    });
    commands.setInboxQuery("482913");
    commands.setInboxQuery("4829");
    await Bun.sleep(50);
    expect(derivaciones).toBe(0);
  });

  test("el revelado NO sobrevive a un store nuevo (o sea, al proceso)", () => {
    const { s } = armar();
    s.setLockedRevealed(true);
    expect(s.lockedRevealed()).toBe(true);
    expect(createStore().lockedRevealed()).toBe(false);
  });
});

// ── esconder un chat A MANO (`^X`) ──────────────────────────────────────────
//
// La otra mitad del candado: la que NO depende de que WhatsApp mande el
// `chats.lock` (que puede no llegar nunca, ver `wa/appstate.ts`). Lo que se
// prueba acá es que se comporta igual que un candado de verdad, que no se
// esconde de un manotazo y que los dos orígenes no se pisan.

describe("esconder un chat a mano", () => {
  /** Deja el cursor sobre Ana y la lista al día. */
  function conAnaSeleccionada(codigo = "482913") {
    const b = armar(codigo);
    b.s.flushNow();
    commands.selectChat(ANA);
    return b;
  }

  test("sin código fijado NO esconde nada: manda a fijarlo con ^P", () => {
    const { repo, s } = conAnaSeleccionada("");

    // Dos veces, por si acaso: ni con la confirmación se esconde.
    commands.toggleSelectedHidden();
    commands.toggleSelectedHidden();

    expect(repo.isManuallyHidden(ANA)).toBe(false);
    expect(listado(s)).toEqual(["Ana", "Beto"]);
    expect(s.getSnapshot("ui").toast?.text).toContain("^P");
  });

  test("la primera pulsación PREGUNTA; recién la segunda esconde", () => {
    const { repo, s } = conAnaSeleccionada();

    commands.toggleSelectedHidden();
    expect(repo.isManuallyHidden(ANA)).toBe(false);
    expect(listado(s)).toEqual(["Ana", "Beto"]);
    expect(s.getSnapshot("ui").toast?.text).toContain("¿ocultar «Ana»?");

    commands.toggleSelectedHidden();
    expect(repo.isManuallyHidden(ANA)).toBe(true);
    // Desaparece de la bandeja Y de los contadores.
    expect(listado(s)).toEqual(["Beto"]);
    expect(s.getSnapshot("inbox").counts).toEqual({ all: 1, unread: 0, groups: 0 });
    // El cursor pasa al vecino, no se queda sobre un chat que ya no está.
    expect(s.inboxUi().selectedJid).toBe(BETO);
  });

  test("la confirmación VENCE con el aviso del pie: un ^X viejo no esconde nada", () => {
    const { repo, s } = conAnaSeleccionada();
    commands.toggleSelectedHidden();

    // El reloj de verdad, corrido más allá de la vida del aviso.
    const real = Date.now;
    Date.now = () => real() + ESPERA_CONFIRMACION_MS + 1;
    try {
      commands.toggleSelectedHidden();
    } finally {
      Date.now = real;
    }

    // No escondió: volvió a preguntar.
    expect(repo.isManuallyHidden(ANA)).toBe(false);
    expect(listado(s)).toEqual(["Ana", "Beto"]);
    expect(s.getSnapshot("ui").toast?.text).toContain("¿ocultar");
  });

  test("cambiar de chat entre las dos pulsaciones tampoco confirma", () => {
    const { repo, s } = conAnaSeleccionada();
    commands.toggleSelectedHidden();

    commands.selectChat(BETO);
    commands.toggleSelectedHidden();

    expect(repo.isManuallyHidden(ANA)).toBe(false);
    expect(repo.isManuallyHidden(BETO)).toBe(false);
    expect(listado(s)).toEqual(["Ana", "Beto"]);
  });

  test("escondido a mano no se lista en la búsqueda global (ni chats ni mensajes)", () => {
    const { s } = conAnaSeleccionada();
    commands.toggleSelectedHidden();
    commands.toggleSelectedHidden();

    commands.search("hola");
    s.flushNow();
    const busqueda = s.getSnapshot("search");
    expect(busqueda.chats.map((c) => c.name)).toEqual([]);
    expect(busqueda.hits.map((h) => h.chatName)).toEqual(["Beto"]);

    // Con el candado revelado vuelve a estar, igual que uno de WhatsApp.
    s.setLockedRevealed(true);
    s.flushNow();
    expect(s.getSnapshot("search").hits.map((h) => h.chatName).sort()).toEqual(["Ana", "Beto"]);
  });

  test("si el chat escondido era el ABIERTO, se cierra", () => {
    const { s } = conAnaSeleccionada();
    commands.openChat(ANA);
    s.flushNow();
    expect(s.getSnapshot("convo").messages).toHaveLength(2);

    commands.toggleSelectedHidden();
    commands.toggleSelectedHidden();
    s.flushNow();

    expect(s.openChatJid()).toBe(null);
    expect(s.getSnapshot("convo").messages).toEqual([]);
  });

  test("con el código a la vista, la misma tecla lo desmarca (y sin preguntar)", async () => {
    const { repo, s } = conAnaSeleccionada();
    commands.toggleSelectedHidden();
    commands.toggleSelectedHidden();
    expect(listado(s)).toEqual(["Beto"]);

    // El MISMO código del candado: el chat escondido a mano vuelve a la vista.
    commands.setInboxQuery("482913");
    await esperarA(() => s.lockedRevealed());
    expect(listado(s)).toEqual(["Ana", "Beto"]);

    // Y ahí se desmarca de una sola pulsación: hace APARECER un chat, no
    // desaparecer, así que no hay nada que confirmar.
    commands.selectChat(ANA);
    commands.toggleSelectedHidden();
    s.flushNow();
    expect(repo.isManuallyHidden(ANA)).toBe(false);
    expect(s.getSnapshot("ui").toast?.text).toContain("vuelve a la bandeja");

    // Escondido el candado otra vez, Ana sigue en la bandeja: ya no está marcada.
    commands.hideLocked();
    expect(listado(s)).toEqual(["Ana", "Beto"]);
  });

  test("un `chats.lock` de WhatsApp y el ocultamiento a mano no se pisan", () => {
    const { repo, s } = conAnaSeleccionada();
    commands.toggleSelectedHidden();
    commands.toggleSelectedHidden();
    expect(listado(s)).toEqual(["Beto"]);

    // Llega el candado de WhatsApp para el mismo chat y después se levanta:
    // el ocultamiento del usuario sobrevive a las dos cosas.
    repo.setLocked(ANA, true);
    repo.setLocked(ANA, false);
    s.markDirty("inbox");
    expect(listado(s)).toEqual(["Beto"]);
    expect(repo.isManuallyHidden(ANA)).toBe(true);
  });

  test("sin nada seleccionado la tecla avisa en vez de no hacer nada", () => {
    const { s } = armar();
    // Bandeja vacía a fuerza de filtro: no hay chat sobre el que aplicar.
    commands.setInboxQuery("zzzz");
    commands.toggleSelectedHidden();
    s.flushNow();
    expect(s.getSnapshot("ui").toast?.text).toContain("no hay ningún chat seleccionado");
  });
});

// ── la puerta que faltaba: el chat ABIERTO cuando llega el candado ───────────

describe("chat abierto al que le llega el candado", () => {
  function abierto() {
    const repo = baseConDosChats();
    const s: Store = createStore();
    s.bootstrap(repo);
    s.setOpenChat(ANA);
    s.flushNow();
    return { repo, s };
  }

  const cuerpos = (s: Store): string[] => {
    s.flushNow();
    return s.getSnapshot("convo").messages.map((m) => m.body);
  };

  test("la ventana se VACÍA en el flush siguiente (sin revelado)", () => {
    const { repo, s } = abierto();
    expect(cuerpos(s)).toEqual(["hola dice ana", "otro mensaje de ana"]);

    // Como lo escribe el ingest cuando llega `chats.lock`.
    repo.setLocked(ANA, true);
    s.markDirty("inbox", "convo");
    expect(cuerpos(s)).toEqual([]);
    // El chat sigue "abierto" (el jid no se toca): lo que no hay es contenido.
    expect(s.getSnapshot("convo").jid).toBe(ANA);
    expect(s.getSnapshot("convo").hasMoreAbove).toBe(false);

    // Y sacado el candado desde el teléfono, vuelve solo.
    repo.setLocked(ANA, false);
    s.markDirty("convo");
    expect(cuerpos(s)).toEqual(["hola dice ana", "otro mensaje de ana"]);
  });

  test("con el código revelado, el chat con candado se abre y se lee", () => {
    const { repo, s } = abierto();
    repo.setLocked(ANA, true);
    s.markDirty("convo");
    expect(cuerpos(s)).toEqual([]);

    s.setLockedRevealed(true);
    expect(cuerpos(s)).toEqual(["hola dice ana", "otro mensaje de ana"]);

    // Esconderlos otra vez lo vuelve a vaciar.
    s.setLockedRevealed(false);
    expect(cuerpos(s)).toEqual([]);
  });

  test("un BLOQUEADO abierto se vacía aunque el candado esté revelado", () => {
    const { repo, s } = abierto();
    repo.setBlocked(ANA, true);
    s.setLockedRevealed(true);
    expect(cuerpos(s)).toEqual([]);
  });

  test("el candado pegado a la identidad hermana también vacía la ventana", () => {
    const { repo, s } = abierto();
    repo.linkJids(ANA, ANA_LID);
    repo.setLocked(ANA_LID, true);
    s.markDirty("convo");
    expect(cuerpos(s)).toEqual([]);
  });
});
