// Tests de `^V` de punta a punta: la tecla, el portapapeles, la cola de envío y
// lo que queda PINTADO en la pantalla.
//
// Por qué existe este archivo aparte de `send.test.ts` y `clipboard.test.ts`:
// esos dos prueban las dos mitades por separado. Lo que se rompe en el medio —la
// tecla que no llega porque el `<textarea>` se la come, la fila que se pinta
// como texto en vez de como imagen, el aviso que nadie muestra— sólo se ve en el
// frame de caracteres, que es lo que el usuario mira.
//
// Cómo está armado:
//
//   · **La base y la cola de envío son REALES** (`:memory:` + `createSendQueue`),
//     con un socket falso que anota qué se le pidió mandar. Así "aparece la fila
//     📷 imagen" significa que de verdad pasó por la cola y se persistió.
//   · **El portapapeles se INYECTA** (`CommandDeps.clipboard`): acá no se spawnea
//     nada — de que `wl-paste` no cuelgue se encarga `clipboard.test.ts`.
//   · **NADA toca la cuenta real de WhatsApp**: no hay socket de verdad en todo
//     el archivo, y la única imagen que existe son 12 bytes con firma de PNG.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";

import type { ClipboardResult } from "../src/boot/clipboard";
import { MOTIVO_SIN_BACKEND, MOTIVO_TIMEOUT } from "../src/boot/clipboard";
import { openDb } from "../src/db/open";
import { createRepo, type Repo } from "../src/db/repo";
import { commands, configureCommands, type CommandDeps } from "../src/state/commands";
import { store } from "../src/state/store";
import { App } from "../src/ui/App";
import { createSendQueue, LIMITE_IMAGEN_BYTES, type SendQueue } from "../src/wa/send";

const LOG = "/tmp/wacosas-test.log";
const ANTO = "549115000001@s.whatsapp.net";
const SELF = "5491133445566:12@s.whatsapp.net";

/** Doce bytes con firma de PNG de verdad: alcanza y sobra. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

type Enviado = { jid: string; contenido: { text?: string; image?: Buffer; caption?: string } };

type Arnes = {
  repo: Repo;
  cola: SendQueue;
  enviados: Enviado[];
  /** Lo que va a devolver el próximo `^V`. */
  portapapeles: { valor: ClipboardResult };
};

let arnes: Arnes;

function armar(): Arnes {
  const repo = createRepo(openDb(":memory:"));
  repo.upsertChat({ jid: ANTO, name: "anto 🌻" });
  repo.touchChatActivity(ANTO, 1_700_000_000, "hola", false);

  const enviados: Enviado[] = [];
  const sock = {
    async sendMessage(jid: string, contenido: Enviado["contenido"], opts: { messageId: string }) {
      enviados.push({ jid, contenido });
      return {
        key: { id: opts.messageId, remoteJid: jid, fromMe: true },
        message: contenido.image ? { imageMessage: {} } : { conversation: contenido.text },
      };
    },
  };

  const cola = createSendQueue({
    repo,
    store,
    log: { info() {}, warn() {}, error() {}, path: LOG },
    wa: { isOpen: () => true, socket: () => sock as never, selfJid: () => SELF },
  });

  const portapapeles = { valor: { kind: "empty" } as ClipboardResult };

  configureCommands({
    repo,
    wa: { isOpen: () => true } as CommandDeps["wa"],
    store,
    log: { info() {}, warn() {}, error() {}, path: LOG },
    send: cola,
    clipboard: async () => portapapeles.valor,
    shutdown() {},
  });

  store.bootstrap(repo);
  return { repo, cola, enviados, portapapeles };
}

beforeEach(() => {
  arnes = armar();
  // Sin sesión vinculada la pantalla es `<Login/>` (CA-1.1) y no habría campo de
  // redacción que enfocar.
  store.setLink({ phase: "linked", qr: null, pairingCode: null, reason: null });
  store.setConn({ state: "open" });
  store.flushNow();
});

afterEach(() => {
  store.setOpenChat(null);
  store.setDraft(ANTO, "");
  store.flushNow();
});

async function pintar(t: { renderOnce: () => Promise<void> }, veces = 2) {
  for (let i = 0; i < veces; i++) {
    await act(async () => {
      await t.renderOnce();
    });
  }
}

/** Monta la app con el chat abierto y el campo de redacción ENFOCADO (`^E`). */
async function montarEnCompose() {
  const t = await testRender(<App noSplash logPath={LOG} />, { width: 80, height: 24 });
  await pintar(t);
  act(() => {
    commands.openChat(ANTO);
    // ⚠️ El `flushNow` NO es adorno: el flush está coalescido a 33 ms (D3) y el
    // `useKeyboard` de `App` captura `convo` de la closure del render. Sin
    // forzarlo, el `^E` de abajo corre con `convo.jid === null` y se va por su
    // guarda, dejando la app en `browse` — con la conversación YA pintada, que es
    // lo que lo hacía parecer un bug de la tecla.
    store.flushNow();
  });
  await pintar(t);
  act(() => {
    t.mockInput.pressKey("e", { ctrl: true });
  });
  await pintar(t);
  // Sin esto, todo lo demás mediría otra cosa: `^V` sólo vale en modo compose.
  //
  // Se mira el PLACEHOLDER del campo y no los hints del pie a propósito: un aviso
  // vivo (`store.toast`) REEMPLAZA los hints, y el store es un singleton entre
  // tests — el pie diría "la imagen pesa 16 MB…" del caso anterior.
  expect(t.captureCharFrame()).toContain("^V pega");
  return t;
}

/** Aprieta `^V` y deja que la lectura (asincrónica) y el envío se asienten. */
async function pegar(t: Awaited<ReturnType<typeof montarEnCompose>>) {
  act(() => {
    t.mockInput.pressKey("v", { ctrl: true });
  });
  await act(async () => {
    // La lectura del portapapeles es una promesa y el envío otra: hay que dejar
    // correr los microtasks ANTES de mirar la pantalla.
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    // ⚠️ Y después FORZAR el flush: el store coalesce a 33 ms (D3), así que sin
    // esto la fila nueva y el aviso aparecen recién en el test siguiente —que es
    // exactamente lo que pasaba: el pie del caso N mostraba el aviso del N−1.
    store.flushNow();
  });
  await pintar(t, 2);
}

// ── con una imagen en el portapapeles ───────────────────────────────────────

describe("^V con una imagen", () => {
  test("aparece la fila 📷 imagen con su caption debajo, y la imagen se mandó", async () => {
    arnes.portapapeles.valor = { kind: "image", bytes: PNG, mime: "image/png" };
    const t = await montarEnCompose();

    // El texto que había escrito viaja como CAPTION (es lo que hace WhatsApp).
    await act(async () => {
      await t.mockInput.typeText("mirá la terminal");
    });
    await pintar(t);

    await pegar(t);

    const frame = t.captureCharFrame();
    // 1) La fila se ve como una imagen, no como un texto (CA-7.1).
    expect(frame).toContain("📷 imagen");
    // 2) Y el caption, debajo (CA-7.2).
    expect(frame).toContain("mirá la terminal");
    // 3) La imagen SALIÓ por la cola, con sus bytes y su caption.
    expect(arnes.enviados.length).toBe(1);
    expect(arnes.enviados[0]?.jid).toBe(ANTO);
    expect(Array.from(arnes.enviados[0]?.contenido.image as Buffer)).toEqual(Array.from(PNG));
    expect(arnes.enviados[0]?.contenido.caption).toBe("mirá la terminal");
    // 4) El campo quedó limpio: el caption ya viajó (CA-8.2).
    expect(store.draft(ANTO)).toBe("");

    const fila = arnes.repo.lastMessages(ANTO)[0];
    expect(fila?.kind).toBe("image");
    expect(fila?.body).toBe("mirá la terminal");
    t.renderer.destroy();
  });

  test("sin nada escrito, la imagen sale sola", async () => {
    arnes.portapapeles.valor = { kind: "image", bytes: PNG, mime: "image/png" };
    const t = await montarEnCompose();
    await pegar(t);

    expect(t.captureCharFrame()).toContain("📷 imagen");
    expect(arnes.enviados.length).toBe(1);
    expect(arnes.enviados[0]?.contenido.caption).toBeUndefined();
    t.renderer.destroy();
  });

  test("una imagen que se pasa del tope se rechaza y NO se manda", async () => {
    const gorda = new Uint8Array(LIMITE_IMAGEN_BYTES + 1);
    gorda.set(PNG, 0);
    arnes.portapapeles.valor = { kind: "image", bytes: gorda, mime: "image/png" };
    const t = await montarEnCompose();
    await pegar(t);

    const frame = t.captureCharFrame();
    // El aviso explica qué pasó, en el pie y en castellano.
    expect(frame).toContain("16 MB");
    // Nada salió a la red y no quedó ninguna fila.
    expect(arnes.enviados.length).toBe(0);
    expect(arnes.repo.lastMessages(ANTO)).toEqual([]);
    expect(frame).not.toContain("📷 imagen");
    t.renderer.destroy();
  });
});

// ── con TEXTO en el portapapeles ────────────────────────────────────────────

describe("^V con texto", () => {
  test("el texto se PEGA en el campo y NO se manda", async () => {
    arnes.portapapeles.valor = { kind: "text", text: "esto estaba copiado" };
    const t = await montarEnCompose();
    await pegar(t);

    // Aparece en el campo…
    expect(t.captureCharFrame()).toContain("esto estaba copiado");
    expect(store.draft(ANTO)).toBe("esto estaba copiado");
    // …y NADA salió: la única acción irreversible sigue detrás del `⏎` de
    // siempre. Un `^V` no puede, por sí solo, mandarle un texto a nadie.
    expect(arnes.enviados.length).toBe(0);
    expect(arnes.repo.lastMessages(ANTO)).toEqual([]);
    t.renderer.destroy();
  });

  test("se pega DONDE estaba el cursor, sin pisar lo que había escrito", async () => {
    arnes.portapapeles.valor = { kind: "text", text: "PEGADO" };
    const t = await montarEnCompose();
    await act(async () => {
      await t.mockInput.typeText("antes ");
    });
    await pintar(t);
    await pegar(t);

    expect(store.draft(ANTO)).toBe("antes PEGADO");
    expect(arnes.enviados.length).toBe(0);
    t.renderer.destroy();
  });
});

// ── los caminos que no dan nada ─────────────────────────────────────────────

describe("^V sin nada que pegar", () => {
  test("portapapeles vacío: lo dice y no pasa nada más", async () => {
    arnes.portapapeles.valor = { kind: "empty" };
    const t = await montarEnCompose();
    await pegar(t);

    expect(t.captureCharFrame()).toContain("el portapapeles está vacío");
    expect(arnes.enviados.length).toBe(0);
    expect(store.draft(ANTO)).toBe("");
    t.renderer.destroy();
  });

  for (const [caso, motivo] of [
    ["no hay wl-paste ni ninguno de sus reemplazos", MOTIVO_SIN_BACKEND],
    ["el backend se colgó y lo mató el timeout", MOTIVO_TIMEOUT],
  ] as Array<[string, string]>) {
    test(`${caso}: se explica y la aplicación sigue en pie`, async () => {
      arnes.portapapeles.valor = { kind: "error", reason: motivo };
      const t = await montarEnCompose();
      await pegar(t);

      const frame = t.captureCharFrame();
      // El motivo se lee (recortado al ancho del pie, así que se compara el arranque).
      expect(frame).toContain(motivo.slice(0, 30));
      // Y lo más importante: la pantalla sigue viva y el campo sigue usable.
      expect(frame).toContain("anto 🌻");
      expect(frame).toContain("^V pega");
      expect(arnes.enviados.length).toBe(0);
      t.renderer.destroy();
    });
  }
});

// ── la tecla en sí ──────────────────────────────────────────────────────────

describe("la tecla", () => {
  test("^V NO escribe una `v` en el campo (está libre en el <textarea>)", async () => {
    // El precedente es `^K`, que en la tarea 12 estaba mapeado a
    // `delete-to-line-end` y le borraba media búsqueda al usuario. Acá se
    // verificó primero en el fuente de OpenTUI y esto lo deja clavado.
    arnes.portapapeles.valor = { kind: "empty" };
    const t = await montarEnCompose();
    await act(async () => {
      await t.mockInput.typeText("hola");
    });
    await pintar(t);
    await pegar(t);

    expect(store.draft(ANTO)).toBe("hola");
    t.renderer.destroy();
  });

  test("^V en la BANDEJA no lee el portapapeles ni manda nada", async () => {
    // Es una tecla que puede terminar mandando una imagen: sólo vale con el
    // campo enfocado a propósito (`^E`), nunca desde la lista de chats.
    let lecturas = 0;
    arnes.portapapeles.valor = { kind: "image", bytes: PNG, mime: "image/png" };
    configureCommands({
      repo: arnes.repo,
      wa: { isOpen: () => true } as CommandDeps["wa"],
      store,
      log: { info() {}, warn() {}, error() {}, path: LOG },
      send: arnes.cola,
      clipboard: async () => {
        lecturas++;
        return arnes.portapapeles.valor;
      },
      shutdown() {},
    });

    const t = await testRender(<App noSplash logPath={LOG} />, { width: 80, height: 24 });
    await pintar(t);
    act(() => {
      t.mockInput.pressKey("v", { ctrl: true });
    });
    await act(async () => {
      for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
    });
    await pintar(t);

    expect(lecturas).toBe(0);
    expect(arnes.enviados.length).toBe(0);
    t.renderer.destroy();
  });
});
