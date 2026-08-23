// Tests de lib/backoff.ts: backoff de reconexión (CA-15.2) y de reintentos de
// envío (RNF-9).
import { expect, test } from "bun:test";

import { SEND_MAX_ATTEMPTS, reconnectDelayMs, sendRetryDelayMs } from "../src/lib/backoff";

const s = (ms: number) => ms / 1000;

test("reconnectDelayMs da 2/4/8/16/32/60/60 s (CA-15.2)", () => {
  const secuencia = [1, 2, 3, 4, 5, 6, 7].map((n) => s(reconnectDelayMs(n)));
  expect(secuencia).toEqual([2, 4, 8, 16, 32, 60, 60]);
});

test("el tope de 60 s no se rompe nunca, ni con un attempt disparatado (CA-15.2)", () => {
  for (const n of [8, 20, 100, 5_000, Number.MAX_SAFE_INTEGER]) {
    expect(reconnectDelayMs(n)).toBe(60_000);
  }
});

test("un attempt inválido cuenta como el primero: siempre 2 s, nunca NaN", () => {
  const malos = [0, -7, 1.4, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined, null];
  for (const malo of malos) {
    expect(reconnectDelayMs(malo as number)).toBe(2_000);
  }
});

test("sendRetryDelayMs da 1/3/9 s y corta ahí: 3 reintentos y a failed (RNF-9)", () => {
  expect([1, 2, 3].map((n) => s(sendRetryDelayMs(n)))).toEqual([1, 3, 9]);
  expect(SEND_MAX_ATTEMPTS).toBe(3);
  // Del cuarto en adelante no crece: el caller ya tendría que haber cortado.
  expect(sendRetryDelayMs(4)).toBe(9_000);
  expect(sendRetryDelayMs(99)).toBe(9_000);
  expect(sendRetryDelayMs(0)).toBe(1_000);
  expect(sendRetryDelayMs(Number.NaN)).toBe(1_000);
});

test("los dos backoffs devuelven enteros finitos de milisegundos", () => {
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
    for (const ms of [reconnectDelayMs(n), sendRetryDelayMs(n)]) {
      expect(Number.isInteger(ms)).toBe(true);
      expect(ms).toBeGreaterThan(0);
    }
  }
});
