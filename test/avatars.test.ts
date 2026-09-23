// Tests de `src/wa/avatars.ts`: el color de cada chat en la bandeja.
//
// ⚠️ **Lo que se prueba acá es el RITMO, no el color.** La cuenta real tiene ~890
// chats y este módulo es lo único de la aplicación que le pregunta algo a
// WhatsApp sin que el usuario apriete una tecla. Los cuatro invariantes que no se
// negocian:
//
//   1. una consulta por jid **y nada más** (aunque la bandeja lo pida en cada
//      render, que es lo que pasa de verdad);
//   2. lo que ya está en disco **no vuelve a consultarse** en el arranque
//      siguiente — ni las fotos ni los "no tiene foto";
//   3. las consultas van **de a una y espaciadas**;
//   4. **nada de esto puede lanzar ni romper la bandeja**: sin foto, sin permiso,
//      sin red o sin `chafa`, el chat se queda con el glifo de siempre.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Cancelar } from "../src/state/store";
import { createAvatars, GAP_MS, nombreDeJid, TTL_SIN_FOTO_MS } from "../src/wa/avatars";

const raiz = mkdtempSync(join(tmpdir(), "wacosas-avatars-"));
afterAll(() => rmSync(raiz, { recursive: true, force: true }));

const LOG = { info() {}, warn() {}, error() {}, path: "/tmp/wacosas-test.log" } as never;
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

let n = 0;
const dirNuevo = (): string => join(raiz, `caso-${++n}`);

/**
 * Un agendador MANUAL: encola y dispara a mano (§7.4.17 — un agendador que
 * ejecuta EN EL ACTO rompe las colas). Así se puede medir el espaciado sin
 * esperar un segundo por chat.
 */
function agendadorManual() {
  const pendientes: Array<{ fn: () => void; ms: number }> = [];
  const schedule = (fn: () => void, ms: number): Cancelar => {
    const e = { fn, ms };
    pendientes.push(e);
    return () => {
      const i = pendientes.indexOf(e);
      if (i >= 0) pendientes.splice(i, 1);
    };
  };
  const correrTodo = async (vueltas = 20): Promise<void> => {
    for (let i = 0; i < vueltas; i++) {
      const e = pendientes.shift();
      if (e) e.fn();
      // Un tick para que la cadena de promesas del worker avance.
      await Bun.sleep(0);
    }
  };
  return { schedule, pendientes, correrTodo };
}

type Armado = {
  consultados: string[];
  publicado: Array<[string, string | null]>;
  avatars: ReturnType<typeof createAvatars>;
  esperas: Array<{ fn: () => void; ms: number }>;
  correrTodo: (vueltas?: number) => Promise<void>;
};

function armar(opts: { dir: string; foto?: (jid: string) => string | null; color?: string | null }): Armado {
  const consultados: string[] = [];
  const publicado: Array<[string, string | null]> = [];
  const { schedule, pendientes, correrTodo } = agendadorManual();
  const avatars = createAvatars({
    dir: opts.dir,
    log: LOG,
    schedule,
    urlDe: async (jid) => {
      consultados.push(jid);
      return (opts.foto ?? (() => "https://cdn/foto.jpg"))(jid);
    },
    bajar: async () => JPG,
    color: async () => (opts.color === undefined ? "#c02040" : opts.color),
    publicar: (jid, color) => publicado.push([jid, color]),
  });
  return { consultados, publicado, avatars, esperas: pendientes, correrTodo };
}

/** Espera a que la cola termine, disparando las esperas del agendador manual. */
async function drenar(a: Armado): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await Bun.sleep(0);
    const e = a.esperas.shift();
    if (e) e.fn();
  }
}

test("un jid se consulta UNA sola vez, aunque la bandeja lo pida en cada render", async () => {
  const a = armar({ dir: dirNuevo() });
  for (let i = 0; i < 10; i++) a.avatars.request(["uno@s.whatsapp.net", "dos@s.whatsapp.net"]);
  await drenar(a);
  expect(a.consultados.sort()).toEqual(["dos@s.whatsapp.net", "uno@s.whatsapp.net"]);
  expect(a.avatars.consultas()).toBe(2);
  expect(a.publicado).toEqual([
    ["uno@s.whatsapp.net", "#c02040"],
    ["dos@s.whatsapp.net", "#c02040"],
  ]);
});

test("⚠️ las consultas van ESPACIADAS: una por vez, con el gap en el medio", async () => {
  const a = armar({ dir: dirNuevo() });
  a.avatars.request(["a@s.whatsapp.net", "b@s.whatsapp.net", "c@s.whatsapp.net"]);
  // Sin disparar ninguna espera, sólo se resolvió el PRIMERO: el resto está
  // esperando su turno.
  for (let i = 0; i < 6; i++) await Bun.sleep(0);
  expect(a.consultados).toEqual(["a@s.whatsapp.net"]);
  expect(a.esperas[0]?.ms).toBe(GAP_MS);

  await drenar(a);
  expect(a.consultados).toEqual(["a@s.whatsapp.net", "b@s.whatsapp.net", "c@s.whatsapp.net"]);
});

test("lo que ya está en disco no le pregunta nada a WhatsApp (ni espera)", async () => {
  const dir = dirNuevo();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const jid = "viejo@s.whatsapp.net";
  writeFileSync(join(dir, `${nombreDeJid(jid)}.jpg`), JPG, { mode: 0o600 });

  const a = armar({ dir });
  a.avatars.request([jid]);
  await drenar(a);
  expect(a.consultados).toEqual([]);
  expect(a.avatars.consultas()).toBe(0);
  expect(a.publicado).toEqual([[jid, "#c02040"]]);
  // Y sin red no hay por qué esperar: el gap es para WhatsApp, no para el disco.
  expect(a.esperas).toEqual([]);
});

test("un 'no tiene foto' RECIENTE tampoco se vuelve a preguntar; uno viejo sí", async () => {
  const dir = dirNuevo();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const reciente = "sinfoto@s.whatsapp.net";
  const antiguo = "antiguo@s.whatsapp.net";
  writeFileSync(join(dir, `${nombreDeJid(reciente)}.none`), "", { mode: 0o600 });
  const marca = join(dir, `${nombreDeJid(antiguo)}.none`);
  writeFileSync(marca, "", { mode: 0o600 });
  // Envejecida más allá del TTL: un contacto que se puso foto tiene que poder
  // aparecer alguna vez.
  const viejo = (Date.now() - TTL_SIN_FOTO_MS - 1_000) / 1000;
  utimesSync(marca, viejo, viejo);

  const a = armar({ dir });
  a.avatars.request([reciente, antiguo]);
  await drenar(a);
  expect(a.consultados).toEqual([antiguo]);
  expect(a.publicado).toContainEqual([reciente, null]);
});

test("sin foto se anota la marca y se publica null (el glifo queda como siempre)", async () => {
  const dir = dirNuevo();
  const jid = "nada@s.whatsapp.net";
  const a = armar({ dir, foto: () => null });
  a.avatars.request([jid]);
  await drenar(a);
  expect(a.publicado).toEqual([[jid, null]]);
  expect(existsSync(join(dir, `${nombreDeJid(jid)}.none`))).toBe(true);
  // Y no se guarda ninguna foto que no existe.
  expect(existsSync(join(dir, `${nombreDeJid(jid)}.jpg`))).toBe(false);
});

test("los permisos son los de siempre: 0700 el directorio, 0600 la foto", async () => {
  const dir = dirNuevo();
  const jid = "conperm@s.whatsapp.net";
  const a = armar({ dir });
  a.avatars.request([jid]);
  await drenar(a);
  expect((statSync(dir).mode & 0o777).toString(8)).toBe("700");
  expect((statSync(join(dir, `${nombreDeJid(jid)}.jpg`)).mode & 0o777).toString(8)).toBe("600");
});

test("el nombre del archivo NO es el teléfono: va por hash", () => {
  const jid = "5491133445566@s.whatsapp.net";
  const nombre = nombreDeJid(jid);
  expect(nombre).not.toContain("5491133445566");
  expect(nombre).toMatch(/^[0-9a-f]{24}$/);
  // Estable entre corridas: si cambiara, el caché de disco no serviría de nada.
  expect(nombreDeJid(jid)).toBe(nombre);
});

test("un `urlDe` que LANZA no se lleva puesta la cola: el resto se resuelve igual", async () => {
  const dir = dirNuevo();
  const consultados: string[] = [];
  const publicado: Array<[string, string | null]> = [];
  const { schedule, pendientes } = agendadorManual();
  const avatars = createAvatars({
    dir,
    log: LOG,
    schedule,
    urlDe: async (jid) => {
      consultados.push(jid);
      if (jid.startsWith("malo")) throw new Error("se cayó el socket");
      return "https://cdn/foto.jpg";
    },
    bajar: async () => JPG,
    color: async () => "#123456",
    publicar: (jid, color) => publicado.push([jid, color]),
  });
  avatars.request(["malo@s.whatsapp.net", "bueno@s.whatsapp.net"]);
  for (let i = 0; i < 40; i++) {
    await Bun.sleep(0);
    const e = pendientes.shift();
    if (e) e.fn();
  }
  expect(consultados).toEqual(["malo@s.whatsapp.net", "bueno@s.whatsapp.net"]);
  expect(publicado).toContainEqual(["bueno@s.whatsapp.net", "#123456"]);
  expect(publicado).toContainEqual(["malo@s.whatsapp.net", null]);
});

test("sin chafa (color null) la bandeja no se entera: se publica null y listo", async () => {
  const a = armar({ dir: dirNuevo(), color: null });
  a.avatars.request(["x@s.whatsapp.net"]);
  await drenar(a);
  expect(a.publicado).toEqual([["x@s.whatsapp.net", null]]);
});

test("`stop()` corta la cola: lo que quedaba no se le pregunta a nadie", async () => {
  const a = armar({ dir: dirNuevo() });
  a.avatars.request(["a@s.whatsapp.net", "b@s.whatsapp.net", "c@s.whatsapp.net"]);
  for (let i = 0; i < 4; i++) await Bun.sleep(0);
  a.avatars.stop();
  await drenar(a);
  expect(a.consultados).toEqual(["a@s.whatsapp.net"]);
  // Y después de `stop()` tampoco entra trabajo nuevo.
  a.avatars.request(["d@s.whatsapp.net"]);
  await drenar(a);
  expect(a.consultados).toEqual(["a@s.whatsapp.net"]);
});

test("`request` con basura no lanza (cuelga de un render)", async () => {
  const a = armar({ dir: dirNuevo() });
  expect(() => a.avatars.request(null as never)).not.toThrow();
  expect(() => a.avatars.request(["", null as never, undefined as never])).not.toThrow();
  await drenar(a);
  expect(a.consultados).toEqual([]);
});

test("avatar requests replace viewport queue; late hidden completion publishes no photo", async () => {
  let finish!: (url: string) => void;
  const consulted: string[] = [], photos: string[] = [];
  const { schedule, correrTodo } = agendadorManual();
  const avatars = createAvatars({ dir: dirNuevo(), log: LOG, schedule,
    urlDe: async jid => { consulted.push(jid); if (jid === "a" && consulted.length === 1) return new Promise(r => { finish = r; }); return "fixture"; },
    bajar: async () => JPG, color: async () => "#ff0000", publicar() {},
    publicarFoto: (jid, path) => { if (path) photos.push(jid); },
  });
  avatars.request(["a", "hidden"]);
  await Bun.sleep(0);
  avatars.request(["visible"]);
  finish("fixture");
  await correrTodo();
  expect(consulted).toEqual(["a", "visible"]);
  expect(photos).toEqual(["visible"]);
  avatars.request(["a"]);
  await correrTodo();
  expect(photos).toEqual(["visible", "a"]);
  expect(consulted).toEqual(["a", "visible", "a"]); // cancelled before CDN download, so re-request
  avatars.stop();
});
