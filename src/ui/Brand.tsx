// Marca "✦ wacosas" del encabezado, con un shimmer lento por las letras.
//
// Vive en su PROPIO componente por el gotcha §7.4.4: su `setInterval` re-renderiza
// sólo esto. Si la animación viviera en `App.tsx`, cada 180 ms se volvería a
// pintar la bandeja entera (y con 500 chats eso se siente).
import { useEffect, useState } from "react";

import { brand } from "./theme";

const LABEL = "✦ wacosas";

export function Brand() {
  const [fase, setFase] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFase((p) => (p + 0.012) % 1), 180);
    return () => clearInterval(id);
  }, []);
  return (
    <text>
      {LABEL.split("").map((ch, i) => {
        // Onda senoidal por posición, corrida por la fase. El rango 0,35–1 del
        // gradiente evita el verde oscuro del arranque, que sobre SURFACE es
        // ilegible.
        const onda = 0.5 + 0.5 * Math.sin((i / LABEL.length - fase) * Math.PI * 2);
        return (
          <span key={i} fg={brand(0.35 + 0.65 * onda)}>
            {ch}
          </span>
        );
      })}
      <span>{"  "}</span>
    </text>
  );
}
