// Tests de la pantalla de imágenes (`^O`, `src/ui/ImageView.tsx`) y de los dos
// helpers de color del pie (`src/ui/Footer.tsx`).
//
// Se monta la interfaz REAL con una base de verdad y una descarga inyectada: acá
// no sale nada a internet ni se spawnea `chafa`. Lo que se mira es el frame de
// caracteres, porque los bugs de esta pantalla viven ahí (una imagen que no
// aparece, un contador que no se mueve, un motivo que no se lee).
import { afterAll, beforeEach, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";

import type { FilaImagen } from "../src/boot/chafa";
import { openDb } from "../src/db/open";
import { createRepo, type Repo } from "../src/db/repo";
import type { MessageRow } from "../src/db/types";
import { commands, configureCommands, type CommandDeps } from "../src/state/commands";
import { store, TOAST_MS } from "../src/state/store";
import { App } from "../src/ui/App";
import { esTecla, partirHints } from "../src/ui/Footer";

const LOG = "/tmp/wacosas-test.log";
/** El motivo literal de `wa/media.ts` (copiado para no arrastrar baileys acá). */
const SIN_REFERENCIA =
  "de esta imagen no guardamos la referencia: es de antes de que wacosas supiera mostrarlas";
const ANA = "5491150000001@s.whatsapp.net";

/** Una imagen de juguete: cuatro celdas rojas. */
const CELDAS: FilaImagen[] = [
  [{ texto: "▄▄", fg: "#ff0000", bg: "#880000" }],
  [{ texto: "▄▄", fg: "#ff0000", bg: "#880000" }],
];

let repo: Repo;
let visto: {
  bajadas: number[];
  visor: number[];
  render: Array<[number, number]>;
  fallar: string | null;
};

function baseCon(conReferencia: boolean): Repo {
  const db = openDb(":memory:");
  const r = createRepo(db);
  r.upsertChat({ jid: ANA, name: "Ana" });
  r.tx(() => {
    r.insertMessage({
      chatJid: ANA,
      waId: "T1",
      fromMe: false,
      senderJid: ANA,
      senderName: "Ana",
      ts: 1_700_000_000,
      kind: "text",
      body: "hola",
      attachment: null,
      status: "received",
    });
    for (const [i, caption] of ["la vieja", "el atardecer"].entries()) {
      r.insertMessage({
        chatJid: ANA,
        waId: `IMG${i}`,
        fromMe: false,
        senderJid: ANA,
        senderName: "Ana",
        ts: 1_700_000_100 + i,
        kind: "image",
        body: caption,
        attachment: {
          label: "📷 imagen",
          mimetype: "image/png",
          // La primera (la más VIEJA) va sin referencia a propósito: es el
          // historial anterior a esta versión, y la pantalla tiene que explicarlo.
          ...(conReferencia && i === 1 ? { media: { key: "ZGVtbw==", directPath: "/x.enc" } } : {}),
        },
        status: "received",
      });
    }
  });
  return r;
}

function cablear(r: Repo): void {
  visto = { bajadas: [], visor: [], render: [], fallar: null };
  configureCommands({
    repo: r,
    wa: { isOpen: () => true } as CommandDeps["wa"],
    store,
    log: { info() {}, warn() {}, error() {}, path: LOG } as CommandDeps["log"],
    media: {
      // Imita al `MediaStore` de verdad: sin referencia no hay descarga posible
      // (es el historial anterior a esta versión), y eso la pantalla lo explica.
      async ensureImage(msg: MessageRow) {
        visto.bajadas.push(msg.id);
        if (!msg.attachment?.media) return { ok: false as const, reason: SIN_REFERENCIA };
        if (visto.fallar) return { ok: false as const, reason: visto.fallar };
        return { ok: true as const, path: `/tmp/foto-${msg.id}.png` };
      },
      cached: (msg: MessageRow) => (msg.attachment?.media ? `/tmp/foto-${msg.id}.png` : null),
    },
    chafa: async (_ruta: string, cols: number, filas: number) => {
      visto.render.push([cols, filas]);
      return { ok: true as const, filas: CELDAS };
    },
    abrirArchivo: (ruta: string) => visto.visor.push(Number(ruta.replace(/\D/g, ""))),
    shutdown() {},
  });
}

/**
 * Un frame. El `flushNow()` va adentro porque el snapshot está CACHEADO hasta el
 * próximo flush (D3): sin él, el render leería el estado anterior y el test
 * miraría la pantalla de hace una tecla.
 */
async function pintar(t: { renderOnce: () => Promise<void> }, veces = 3) {
  for (let i = 0; i < veces; i++) {
    await act(async () => {
      store.flushNow();
      await t.renderOnce();
    });
  }
}

async function montar(conReferencia = true, width = 80, height = 24) {
  // ⚠️ `store` es un SINGLETON de todo el proceso de tests, y un aviso efímero
  // dura 2,6 s: uno que haya disparado otro archivo le taparía el pie a éste (el
  // pie muestra el aviso O las teclas, nunca los dos). Casi siempre no hay nada
  // que esperar; cuando lo hay, se espera a que se vaya y listo.
  store.flushNow();
  if (store.getSnapshot("ui").toast) await Bun.sleep(TOAST_MS + 100);
  repo = baseCon(conReferencia);
  cablear(repo);
  store.bootstrap(repo);
  store.setLink({ phase: "linked", qr: null, pairingCode: null, reason: null });
  store.setConn({ state: "open" });
  store.flushNow();
  const t = await testRender(<App noSplash logPath={LOG} />, { width, height });
  await pintar(t);
  return t;
}

async function tecla(
  t: Awaited<ReturnType<typeof montar>>,
  k: string,
  mods?: { ctrl?: boolean; shift?: boolean },
) {
  act(() => {
    t.mockInput.pressKey(k, mods);
  });
  await pintar(t);
}

beforeEach(() => {
  store.setOpenChat(null);
  store.setInboxUi({ inboxQuery: "", inboxFilter: "all", selectedJid: null });
});

afterAll(() => {
  store.setOpenChat(null);
});

// ── entrar y salir ───────────────────────────────────────────────────────────

test("^O abre la pantalla con la imagen MÁS NUEVA y su epígrafe", async () => {
  const t = await montar();
  commands.openChat(ANA);
  await pintar(t);
  await tecla(t, "o", { ctrl: true });

  const frame = t.captureCharFrame();
  // Dos imágenes en el chat, y se arranca por la última que llegó.
  expect(frame).toContain("imagen 1 de 2");
  expect(frame).toContain("el atardecer");
  // El pie cambia a las teclas de ESTA pantalla.
  expect(frame).toContain("← → cambiar");
  expect(frame).toContain("o visor");
  // Y se bajó UNA sola: la que se está mirando, nunca las de al lado.
  expect(visto.bajadas).toHaveLength(1);
});

test("^O cierra y devuelve la conversación", async () => {
  const t = await montar();
  commands.openChat(ANA);
  await pintar(t);
  // ⚠️ Se prueba con `^O` y no con `Esc`: un `\x1B` suelto en el arnés queda
  // esperando a ver si es el principio de una secuencia (el timeout clásico del
  // Esc), así que el frame siguiente todavía no lo vio. `Esc` cierra igual —está
  // verificado a mano contra la demo—; lo que se clava acá es que **la misma
  // tecla que abre, cierra**, que es lo que uno prueba primero.
  await tecla(t, "o", { ctrl: true });
  expect(t.captureCharFrame()).toContain("imagen 1 de 2");
  await tecla(t, "o", { ctrl: true });
  const frame = t.captureCharFrame();
  expect(frame).not.toContain("imagen 1 de 2");
  // Volvió la conversación: el campo de redacción está de nuevo en pantalla.
  expect(frame).toContain("^E para escribir");
});

// ⚠️ Los dos tests que miran EL PIE van primero: `store` es un singleton de todo
// el archivo y un aviso efímero dura 2,6 s, así que un toast disparado antes le
// tapa la línea de teclas al que venga después.

test("^O sin chat abierto avisa por el pie y no cambia de pantalla", async () => {
  const t = await montar();
  await tecla(t, "o", { ctrl: true });
  const frame = t.captureCharFrame();
  expect(frame).toContain("abrí un chat para ver sus imágenes");
  expect(frame).not.toContain("imagen 1 de");
  expect(visto.bajadas).toEqual([]);
});

// ── moverse entre las fotos ──────────────────────────────────────────────────

test("← → caminan las imágenes del chat y el contador las sigue", async () => {
  const t = await montar();
  commands.openChat(ANA);
  await pintar(t);
  await tecla(t, "o", { ctrl: true });
  expect(t.captureCharFrame()).toContain("imagen 1 de 2");

  await tecla(t, "ARROW_RIGHT");
  const frame = t.captureCharFrame();
  expect(frame).toContain("imagen 2 de 2");
  expect(frame).toContain("la vieja");

  // Y en la punta se queda quieta: no da la vuelta.
  await tecla(t, "ARROW_RIGHT");
  expect(t.captureCharFrame()).toContain("imagen 2 de 2");
  await tecla(t, "ARROW_LEFT");
  expect(t.captureCharFrame()).toContain("imagen 1 de 2");
});

test("una imagen SIN referencia explica por qué no se puede ver", async () => {
  const t = await montar();
  commands.openChat(ANA);
  await pintar(t);
  await tecla(t, "o", { ctrl: true });
  // La segunda (la más vieja) es la del historial sin referencia.
  await tecla(t, "ARROW_RIGHT");
  expect(t.captureCharFrame()).toContain("no guardamos la referencia");
});

test("un fallo de descarga se lee en la pantalla, no voltea nada", async () => {
  const t = await montar();
  commands.openChat(ANA);
  await pintar(t);
  visto.fallar = "WhatsApp ya no tiene esta imagen en su servidor";
  await tecla(t, "o", { ctrl: true });
  const frame = t.captureCharFrame();
  expect(frame).toContain("WhatsApp ya no tiene esta imagen");
  expect(frame).toContain("imagen 1 de 2"); // la pantalla sigue en pie
});

// ── el visor del sistema ─────────────────────────────────────────────────────

test("`o` abre la imagen bajada en el visor del sistema", async () => {
  const t = await montar();
  commands.openChat(ANA);
  await pintar(t);
  await tecla(t, "o", { ctrl: true });
  await tecla(t, "o");
  expect(visto.visor).toHaveLength(1);
});

test("`o` sobre una imagen que no está bajada lo dice, y no abre nada", async () => {
  const t = await montar();
  commands.openChat(ANA);
  await pintar(t);
  await tecla(t, "o", { ctrl: true });
  await tecla(t, "ARROW_RIGHT"); // la que no tiene referencia
  await tecla(t, "o");
  expect(visto.visor).toEqual([]);
  expect(t.captureCharFrame()).toContain("mirala primero con ^O");
});

// ── tamaño ───────────────────────────────────────────────────────────────────

test("la imagen se pide del tamaño que de verdad hay (CA-19.4)", async () => {
  const t = await montar(true, 80, 24);
  commands.openChat(ANA);
  await pintar(t);
  await tecla(t, "o", { ctrl: true });
  // 80 columnas − 2 del borde − 2 del padding; 22 filas de cuerpo − 2 del borde
  // − 1 del renglón de datos.
  expect(visto.render[0]).toEqual([76, 19]);
});

// ── el pie de dos pesos ──────────────────────────────────────────────────────

test("esTecla reconoce las cuatro formas en las que se nombra una tecla", () => {
  for (const t of ["⏎", "Esc", "Tab", "?", "^E", "^C", "⇧↑↓", "←", "→", "Alt-⏎", "⇧PgUp/PgDn", "/"]) {
    expect({ t, tecla: esTecla(t) }).toEqual({ t, tecla: true });
  }
  for (const t of ["abrir", "leído", "filtro", "escribí", "scroll", "ayuda", "salir", "·", "imágenes", ""]) {
    expect({ t, tecla: esTecla(t) }).toEqual({ t, tecla: false });
  }
});

test("partirHints separa teclas de palabras sin perder ni un carácter", () => {
  const linea = "^L leído · ^E escribí · ^O imágenes · ⇧↑↓ scroll · ? ayuda · ^C salir";
  const tramos = partirHints(linea);
  // Lo que se pinta tiene que ser EXACTAMENTE lo que entró: el pie ya viene
  // recortado a las columnas que hay, y un carácter de más lo desborda.
  expect(tramos.map((t) => t.texto).join("")).toBe(linea);
  expect(tramos.some((t) => t.tecla)).toBe(true);
  // El `·` es separador, no tecla: pintarlo de acento haría parpadear la línea.
  expect(tramos.find((t) => t.texto.includes("·"))?.tecla).toBe(false);
  expect(partirHints("")).toEqual([]);
});
