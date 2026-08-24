// Tests de `hasCreds` (src/wa/auth.ts): ¿hay una sesión VINCULADA en disco?
//
// De esta función cuelga el `flujo` del socket (`link` vs `reconnect`) y con él
// CA-3.4 (un QR durante una RECONEXIÓN ⇒ las creds no sirven, hay que borrarlas),
// así que equivocarse acá tiene dos costos: pedirle otro QR a alguien que ya
// vinculó, o no darse cuenta nunca de que las creds murieron.
//
// El caso que manda es el PRIMERO: una sesión vinculada **por QR** queda con
// `registered: false` en disco. Baileys setea `registered` en un solo lugar
// —`Socket/messages-recv.js:940`, `case 'link_code_companion_reg'`, o sea sólo el
// flujo del código de emparejamiento—, mientras que `me` lo escribe
// `configureSuccessfulPairing` (`Utils/validate-connection.js:190`) por los dos
// caminos. Y `me` es lo que mira baileys mismo para decidir entre vincular y
// retomar la sesión (`Socket/socket.js:320`).
//
// Los directorios son REALES (temporales, se borran al final): `hasCreds` lee del
// filesystem y los casos que importan —archivo ausente, vacío, ilegible— sólo
// existen ahí.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hasCreds } from "../src/wa/auth";

const tmp = mkdtempSync(join(tmpdir(), "wacosas-auth-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;

/** Un dir de creds con el contenido crudo que se le pase (o vacío, sin archivo). */
function credsCon(contenido?: string): string {
  const dir = join(tmp, `creds-${n++}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (contenido !== undefined) {
    writeFileSync(join(dir, "creds.json"), contenido, { mode: 0o600 });
  }
  return dir;
}

/**
 * La forma REAL de un `creds.json` recién vinculado por QR: `me.id`, `account` y
 * `platform` puestos… y `registered` en `false`, que es como quedó el de la
 * cuenta de verdad con la que se encontró este bug.
 */
const CREDS_QR = {
  me: { id: "5491133445566:12@s.whatsapp.net", name: "Gon", lid: "998877665544:12@lid" },
  account: { details: "CKn+8sMGEJ==", accountSignature: "T+9r==", accountSignatureKey: "0xQ=" },
  platform: "iphone",
  registered: false,
};

test("una sesión vinculada POR QR cuenta como vinculada, aunque `registered` sea false", () => {
  // El bug real: con el criterio viejo (`registered === true`) esto daba `false`,
  // la app arrancaba en flujo `link` y le volvía a pedir un QR a una sesión sana.
  expect(hasCreds(credsCon(JSON.stringify(CREDS_QR)))).toBe(true);
});

test("una sesión vinculada por CÓDIGO también cuenta (tiene `me` y `registered:true`)", () => {
  const creds = { ...CREDS_QR, registered: true };
  expect(hasCreds(credsCon(JSON.stringify(creds)))).toBe(true);
});

test("sin `me` NO hay sesión: es el `creds.json` del handshake, antes de escanear", () => {
  // Lo que baileys escribe apenas arranca: claves de ruido, identidad, nada más.
  // Es el caso que hace falta distinguir para no confundir "hay archivo" con
  // "hay sesión" — un proceso cortado a mitad de la vinculación deja esto.
  const enHandshake = { noiseKey: { private: "a", public: "b" }, registrationId: 42 };
  expect(hasCreds(credsCon(JSON.stringify(enHandshake)))).toBe(false);
});

test("`registered:true` SIN `me` no alcanza: el criterio es `me.id`, no el flag", () => {
  expect(hasCreds(credsCon(JSON.stringify({ registered: true })))).toBe(false);
});

test("con `me` pero sin `id` NO hay sesión: `generateLoginNode` necesita el id", () => {
  expect(hasCreds(credsCon(JSON.stringify({ me: { name: "Gon" } })))).toBe(false);
});

test("`me: null` NO hay sesión (y no rompe el acceso a `.id`)", () => {
  expect(hasCreds(credsCon(JSON.stringify({ me: null })))).toBe(false);
});

test("`me.id` vacío NO hay sesión", () => {
  expect(hasCreds(credsCon(JSON.stringify({ me: { id: "" } })))).toBe(false);
});

test("sin archivo devuelve false, no lanza", () => {
  expect(() => hasCreds(credsCon())).not.toThrow();
  expect(hasCreds(credsCon())).toBe(false);
});

test("el directorio ni siquiera existe: false, no lanza", () => {
  const fantasma = join(tmp, "no-existe-este-dir");
  expect(() => hasCreds(fantasma)).not.toThrow();
  expect(hasCreds(fantasma)).toBe(false);
});

test("archivo vacío: false, no lanza", () => {
  expect(() => hasCreds(credsCon(""))).not.toThrow();
  expect(hasCreds(credsCon(""))).toBe(false);
});

test("JSON roto (escritura cortada a la mitad): false, no lanza", () => {
  const cortado = JSON.stringify(CREDS_QR).slice(0, 40);
  expect(() => hasCreds(credsCon(cortado))).not.toThrow();
  expect(hasCreds(credsCon(cortado))).toBe(false);
});

test("JSON válido que no es un objeto (`null`, un número): false, no lanza", () => {
  expect(hasCreds(credsCon("null"))).toBe(false);
  expect(hasCreds(credsCon("7"))).toBe(false);
  expect(hasCreds(credsCon('"me"'))).toBe(false);
});
