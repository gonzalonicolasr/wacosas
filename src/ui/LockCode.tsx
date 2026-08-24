// La pantalla de `Ctrl-P`: fijar el código que revela los chats con candado.
//
// POR QUÉ ES UNA PANTALLA Y NO UN CAMPO MÁS: el código tiene que quedar fijado
// EXPLÍCITAMENTE. Si se aprendiera solo de lo que se tipea en el buscador, el
// primer número que alguien busque quedaría convertido en código sin que se
// entere — un candado que no se sabe cuál es no es un candado.
//
// Dos decisiones de esta vista:
//
//  1. **El campo no es un `<input>`**: los dígitos se pintan como `•` y el
//     buffer vive en `App` (memoria, nunca en disco). Un `<input>` de OpenTUI no
//     tiene modo contraseña, así que la única forma de que el código no quede a
//     la vista de quien mire la pantalla es no dibujarlo nunca.
//  2. **Se pide dos veces.** Un código con un dígito de más no se puede
//     descubrir después: no hay "código incorrecto" en ningún lado (a propósito),
//     así que un tipeo mal quedaría como "el candado no anda".
//
// El alto se PRESUPUESTA como en `Help`: OpenTUI no esconde a los hijos que no
// entran en una caja, los dibuja ENCIMADOS. Primero se tiran los renglones en
// blanco y recién después se corta.
import { clip } from "../lib/fmt";
import { MAX_DIGITOS, MIN_DIGITOS, validarCodigo } from "../boot/lockcode";
import { ACCENT, BORDER, FAINT, GOLD, MUT, SURFACE, TEXT_DIM, WARN } from "./theme";

/**
 * Los tres pasos: escribir el código, repetirlo y el cartel que explica el gesto
 * (que es la única parte de todo esto que el usuario tiene que aprender).
 */
export type FaseCandado = "nuevo" | "repetir" | "listo";

export type EstadoCandado = {
  fase: FaseCandado;
  /** Lo que se lleva tipeado en el paso actual. NUNCA sale de la memoria. */
  digitos: string;
  /** Lo que se tipeó en el paso "nuevo", para comparar contra la repetición. */
  primero: string;
  /** Por qué no se pudo avanzar (formato, no coinciden, disco). */
  motivo: string | null;
};

export const CANDADO_INICIAL: EstadoCandado = {
  fase: "nuevo",
  digitos: "",
  primero: "",
  motivo: null,
};

export const MOTIVO_NO_COINCIDEN = "no coinciden: escribilo de nuevo";

/**
 * Qué pasa al apretar `⏎`. Es PURA: devuelve el estado siguiente y, cuando
 * corresponde, los dígitos a guardar. Quien escribe en disco es `App` (por
 * `commands`), que es el único que tiene los comandos cableados.
 */
export function siguientePaso(e: EstadoCandado): { estado: EstadoCandado; guardar?: string } {
  if (e.fase === "nuevo") {
    const v = validarCodigo(e.digitos);
    if (!v.ok) return { estado: { ...e, motivo: v.reason } };
    return { estado: { fase: "repetir", digitos: "", primero: v.digits, motivo: null } };
  }
  if (e.fase === "repetir") {
    // Se vuelve al principio, no se "corrige" la repetición: si los dos no
    // coinciden no se sabe cuál de los dos estaba mal.
    if (e.digitos !== e.primero) {
      return { estado: { ...CANDADO_INICIAL, motivo: MOTIVO_NO_COINCIDEN } };
    }
    return { estado: { ...e, motivo: null }, guardar: e.primero };
  }
  return { estado: e };
}

/** Una tecla de dígito: se acumula hasta el máximo y se ignora lo que sobra. */
export function conDigito(e: EstadoCandado, d: string): EstadoCandado {
  if (e.fase === "listo" || e.digitos.length >= MAX_DIGITOS) return e;
  return { ...e, digitos: e.digitos + d, motivo: null };
}

/** `Backspace`: borra el último dígito. */
export function sinUltimo(e: EstadoCandado): EstadoCandado {
  if (e.fase === "listo" || e.digitos === "") return e;
  return { ...e, digitos: e.digitos.slice(0, -1), motivo: null };
}

type Tono = "texto" | "tenue" | "campo" | "error" | "aviso";

/**
 * El cuerpo de la pantalla como datos, para poder contarlo antes de pintarlo.
 *
 * ⚠️ Sin alineación por espacios repetidos: `clip()` los aplasta (usa `oneLine`),
 * así que `código   ••` saldría `código ••`. Las etiquetas van con `:` y punto.
 */
export function lineasCandado(e: EstadoCandado, yaHay: boolean): Array<[string, Tono]> {
  // El cursor deja ver que el campo está vivo aunque no haya ningún dígito.
  const puntos = `${"•".repeat(e.digitos.length)}▏`;
  const error: Array<[string, Tono]> = e.motivo ? [[`⚠ ${e.motivo}`, "error"]] : [];
  if (e.fase === "listo") {
    return [
      ["listo: el código quedó fijado.", "texto"],
      ["", "tenue"],
      ["Escribí esos dígitos en el buscador de la bandeja y los chats", "texto"],
      ["con candado aparecen. Esc los vuelve a esconder.", "texto"],
      ["", "tenue"],
      ["⚠ Si cambiás el código en el teléfono, wacosas no se entera:", "aviso"],
      ["volvé a fijarlo acá con ^P.", "aviso"],
      ["", "tenue"],
      ["⏎ / Esc cerrar", "tenue"],
    ];
  }
  if (e.fase === "repetir") {
    return [
      ["Repetilo para confirmar.", "texto"],
      ["", "tenue"],
      [`repetir: ${puntos}`, "campo"],
      ["", "tenue"],
      ...error,
      ["⏎ confirmar · Esc cancelar", "tenue"],
    ];
  }
  return [
    [yaHay ? "Cambiá el código de los chats con candado." : "Fijá el código de los chats con candado.", "texto"],
    ["", "tenue"],
    ["Elegí un código DISTINTO del de tu teléfono, y cuanto más largo", "tenue"],
    ["mejor: el hash se guarda en tu disco y se puede crackear offline", "tenue"],
    ["(6 dígitos ≈ 7-9 h en un core). Si reusás el de WhatsApp, quien", "tenue"],
    ["se lleve ese archivo abre también los chats de tu teléfono.", "tenue"],
    ["", "tenue"],
    [`código: ${puntos}`, "campo"],
    ["", "tenue"],
    ...error,
    [`⏎ seguir · Esc cancelar · entre ${MIN_DIGITOS} y ${MAX_DIGITOS} dígitos`, "tenue"],
  ];
}

/** Las que entran: primero se tiran los renglones en blanco, después se corta. */
export function candadoQueEntra(
  lineas: Array<[string, Tono]>,
  filas: number,
): Array<[string, Tono]> {
  if (lineas.length <= filas) return lineas;
  const sinHuecos = lineas.filter(([t]) => t !== "");
  return sinHuecos.slice(0, Math.max(0, filas));
}

const COLOR: Record<Tono, string> = {
  texto: TEXT_DIM,
  tenue: MUT,
  campo: GOLD,
  error: WARN,
  aviso: FAINT,
};

export function LockCode({
  estado,
  yaHay,
  ancho,
  alto,
}: {
  estado: EstadoCandado;
  /** Ya había un código fijado: la pantalla lo dice, en vez de fingir que es el primero. */
  yaHay: boolean;
  ancho: number;
  alto: number;
}) {
  const lineas = candadoQueEntra(lineasCandado(estado, yaHay), Math.max(1, alto - 2));
  return (
    <box
      flexDirection="column"
      flexGrow={1}
      border
      borderColor={BORDER}
      backgroundColor={SURFACE}
      title=" candado "
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={ACCENT} wrapMode="none">
        {clip("chats con candado", Math.max(4, ancho - 4))}
      </text>
      {lineas.map(([texto, tono], i) => (
        // La lista es estática por render: el índice alcanza como `key`.
        <text key={i} fg={COLOR[tono]} wrapMode="none">
          {texto === "" ? " " : clip(texto, Math.max(4, ancho - 4))}
        </text>
      ))}
    </box>
  );
}
