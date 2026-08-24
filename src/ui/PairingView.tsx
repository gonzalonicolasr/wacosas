// Vinculación por código de 8 caracteres (CA-2.2 a CA-2.5). Es el camino
// PRINCIPAL, no el de respaldo: en la pane de 80×24 de RNF-3 el QR mide 67×34 y
// no entra ni cerca.
//
// Tres estados, en este orden:
//
//   1. **input del teléfono** — sólo dígitos, 8 a 15, con el mensaje de formato
//      abajo cuando no valida (CA-2.2). El motivo lo devuelve
//      `commands.requestPairing`, así una entrada mal escrita ni toca el store
//      ni mueve la máquina de vinculación: es un error de tipeo;
//   2. **pidiendo** — mientras WhatsApp contesta;
//   3. **código** — los 8 caracteres como `XXXX-XXXX` (CA-2.3) y la cuenta
//      regresiva de 120 s; al vencer, el pie ofrece `Ctrl-R` (CA-2.5).
//
// El input queda REUSABLE pase lo que pase: si la solicitud falla, el comando
// limpia el código y la pantalla vuelve sola al paso 1 con el motivo a la vista
// (CA-2.4), sin reiniciar el proceso.
import type { InputRenderable } from "@opentui/core";
import { useEffect, useRef, useState } from "react";

import { clip } from "../lib/fmt";
import { commands } from "../state/commands";
import type { LinkSnapshot } from "../state/store";
import { ELEVATED, GOLD, INPUT_FG, MUT, TEXT, TEXT_DIM, WARN } from "./theme";

/** CA-2.5: a los 120 s el código deja de servir y hay que pedir otro. */
export const VIDA_CODIGO_MS = 120_000;

/** Ancho del campo: 15 dígitos entran de sobra y no rompe a 60 columnas. */
const ANCHO_INPUT = 22;

/** `ABCD1234` → `ABCD-1234` (CA-2.3). Un largo distinto se muestra tal cual. */
export function formatearCodigo(codigo: string): string {
  const c = String(codigo ?? "");
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

/** `95` → `1:35`. */
function reloj(segundos: number): string {
  const m = Math.floor(segundos / 60);
  const s = segundos % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Cuenta regresiva del código. Componente aparte por el gotcha §7.4.4: late una
 * vez por segundo y así re-renderiza este renglón, no la pantalla entera.
 */
function Vencimiento({ desde }: { desde: number }) {
  const [ahora, setAhora] = useState(() => Date.now());
  const vencido = ahora - desde >= VIDA_CODIGO_MS;
  useEffect(() => {
    if (vencido) return; // vencido no hay nada más que contar: el timer se apaga
    const id = setInterval(() => setAhora(Date.now()), 1000);
    return () => clearInterval(id);
  }, [vencido, desde]);

  if (vencido) {
    return (
      <text fg={WARN} wrapMode="none">
        {"el código venció · Ctrl-R para pedir uno nuevo"}
      </text>
    );
  }
  const faltan = Math.max(0, Math.ceil((desde + VIDA_CODIGO_MS - ahora) / 1000));
  return (
    <text fg={MUT} wrapMode="none">
      {`vence en ${reloj(faltan)}`}
    </text>
  );
}

export function PairingView({
  link,
  width,
  espacioso,
}: {
  link: LinkSnapshot;
  width: number;
  espacioso: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const campo = useRef<InputRenderable | null>(null);
  // `wrapMode="none"` NO recorta por sí solo (§7.4.1): una línea más larga que
  // la pantalla desborda y se encima con lo de al lado. Todo texto va clipeado.
  const ancho = Math.max(20, width - 2);

  // ── pidiendo (CA-2.3) ─────────────────────────────────────────────────────
  if (link.phase === "pairing-requesting") {
    return (
      <text fg={WARN} wrapMode="none">
        {"⟳ pidiéndole el código a WhatsApp…"}
      </text>
    );
  }

  // ── código en pantalla (CA-2.3, CA-2.5) ───────────────────────────────────
  if (link.pairingCode) {
    return (
      <box flexDirection="column" alignItems="center">
        <text fg={TEXT} wrapMode="none">
          {"ingresá este código en el teléfono"}
        </text>
        {espacioso ? <text> </text> : null}
        <text fg={GOLD} wrapMode="none">
          {formatearCodigo(link.pairingCode)}
        </text>
        {espacioso ? <text> </text> : null}
        <text fg={MUT} wrapMode="none">
          {clip("WhatsApp › Dispositivos vinculados › Vincular con número", ancho)}
        </text>
        {link.pairingRequestedAt ? <Vencimiento desde={link.pairingRequestedAt} /> : null}
      </box>
    );
  }

  // ── input del teléfono (CA-2.2) ───────────────────────────────────────────
  const pedir = (valor: string): void => {
    const r = commands.requestPairing(valor);
    // Sólo el error de FORMATO se muestra acá; el que rechaza WhatsApp viaja por
    // `link.reason` y lo pinta `Login` (CA-2.4).
    setError(r.ok ? null : r.reason);
  };

  return (
    <box flexDirection="column" alignItems="center">
      <text fg={TEXT} wrapMode="none">
        {clip("escribí tu número con el código de país, sólo dígitos", ancho)}
      </text>
      {espacioso ? <text> </text> : null}
      {/* Sin `border`: el borde son dos filas más y esta pantalla también se
          dibuja en terminales de 15 filas. El campo se distingue por el fondo. */}
      <box width={ANCHO_INPUT} height={1} backgroundColor={ELEVATED} flexShrink={0}>
        <input
          ref={campo}
          focused
          placeholder="5491122334455"
          maxLength={15}
          backgroundColor={ELEVATED}
          focusedBackgroundColor={ELEVATED}
          textColor={INPUT_FG}
          focusedTextColor={INPUT_FG}
          placeholderColor={MUT}
          onInput={(valor: string) => {
            // "sólo dígitos" se hace cumplir mientras se escribe, no recién al
            // apretar `⏎`: es un teléfono, no hay nada válido que empiece con
            // una letra. El `+` que uno teclea por reflejo se cae solo.
            const limpio = valor.replace(/\D/g, "");
            if (limpio !== valor && campo.current) campo.current.value = limpio;
            if (error) setError(null);
          }}
          onSubmit={pedir}
        />
      </box>
      {error ? (
        <text fg={WARN} wrapMode="none">
          {clip(error, ancho)}
        </text>
      ) : (
        <text fg={TEXT_DIM} wrapMode="none">
          {"⏎ para pedir el código"}
        </text>
      )}
    </box>
  );
}
