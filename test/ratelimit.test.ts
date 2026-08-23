// Tests de lib/ratelimit.ts: 1 s de gap y 20 por minuto (RNF-8).
//
// Todo el archivo es SINCRÓNICO y corre en milisegundos: el reloj se le pasa a
// `reserve(now)` a mano. Un test que esperara de verdad el minuto para probar el
// corte a 20 tardaría 60 s y nadie lo correría.
import { expect, test } from "bun:test";

import { MAX_PER_WINDOW, MIN_GAP_MS, WINDOW_MS, createLimiter } from "../src/lib/ratelimit";

/** `n` reservas seguidas en el mismo instante, como cinco `⏎` seguidos. */
const rafaga = (limiter: { reserve(now?: number): number }, n: number, now: number) =>
  Array.from({ length: n }, () => limiter.reserve(now));

test("respeta 1 s de gap entre envíos consecutivos (RNF-8)", () => {
  const limiter = createLimiter();
  expect(rafaga(limiter, 5, 0)).toEqual([0, 1_000, 2_000, 3_000, 4_000]);
});

test("corta a 20 en 60 s: el 21.º espera al minuto (RNF-8)", () => {
  const limiter = createLimiter();
  const primeros20 = rafaga(limiter, MAX_PER_WINDOW, 0);

  // Los 20 del minuto salen espaciados 1 s: el último a los 19 s.
  expect(primeros20[0]).toBe(0);
  expect(primeros20[MAX_PER_WINDOW - 1]).toBe(19_000);

  // El 21.º NO sale a los 20 s: tiene que esperar a que el primero cumpla el
  // minuto. Y el 22.º, un segundo después de ese.
  expect(limiter.reserve(0)).toBe(WINDOW_MS);
  expect(limiter.reserve(0)).toBe(WINDOW_MS + 1_000);
});

test("con la cola vacía y tiempo de sobra, el envío sale ya", () => {
  const limiter = createLimiter();
  expect(limiter.reserve(1_000)).toBe(1_000);
  // Pasó más de un segundo desde la anterior: no hay nada que esperar.
  expect(limiter.reserve(9_000)).toBe(9_000);
  // Al minuto siguiente, con la ventana vacía, tampoco.
  expect(limiter.reserve(200_000)).toBe(200_000);
});

test("la ventana es deslizante: pasado el minuto vuelve a haber 20 turnos", () => {
  const limiter = createLimiter();
  const primeros20 = rafaga(limiter, MAX_PER_WINDOW, 0);
  expect(primeros20[MAX_PER_WINDOW - 1]).toBe(19_000);

  // Un minuto después de la primera reserva, la ventana ya la dejó salir.
  expect(limiter.reserve(WINDOW_MS + 1)).toBe(WINDOW_MS + 1);
});

test("un reloj que retrocede no devuelve un turno en el pasado", () => {
  const limiter = createLimiter();
  expect(limiter.reserve(100_000)).toBe(100_000);
  // NTP corrigió para atrás: el turno sigue siendo posterior al anterior.
  expect(limiter.reserve(50_000)).toBe(101_000);
});

test("los límites son configurables y las constantes son las de RNF-8", () => {
  expect(MIN_GAP_MS).toBe(1_000);
  expect(MAX_PER_WINDOW).toBe(20);
  expect(WINDOW_MS).toBe(60_000);

  const limiter = createLimiter({ minGapMs: 100, maxPerWindow: 3, windowMs: 1_000 });
  expect(rafaga(limiter, 3, 0)).toEqual([0, 100, 200]);
  expect(limiter.reserve(0)).toBe(1_000); // el 4.º espera a que salga el 1.º
});

test("el test entero es sincrónico: no espera el minuto de verdad (RNF-8)", () => {
  const arranque = performance.now();
  const limiter = createLimiter();
  // 200 reservas = diez minutos de tráfico simulado.
  const turnos = rafaga(limiter, 200, 0);

  expect(turnos[199]).toBeGreaterThan(9 * WINDOW_MS);
  expect(performance.now() - arranque).toBeLessThan(50);
});
