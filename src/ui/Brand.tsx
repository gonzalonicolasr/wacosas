// Marca "✦ wacosas" del encabezado, con un shimmer lento por las letras.
//
// Vive en su PROPIO componente por el gotcha §7.4.4: su `setInterval` re-renderiza
// sólo esto. Si la animación viviera en `App.tsx`, cada tick se volvería a pintar
// la bandeja entera (y con 500 chats eso se siente).
//
// El intervalo es 1000 ms y NO 180 ms como en miscosas, por costo medido: a 180 ms
// el shimmer se come 5,4 % de un core SOSTENIDO (dos mediciones independientes),
// contra 1,45 % a 1000 ms y 0,30 % sin animación. O sea que a 180 ms nueve
// caracteres animados costaban 18× el consumo en reposo de toda la app. Esto es
// una TUI pensada para vivir abierta todo el día en una pane, y encima esta
// máquina corre con el boost apagado a 3,7 GHz fijos. El paso por tick se subió
// en proporción para que la onda tarde lo mismo en recorrer las letras.
import { useEffect, useState } from "react";

import { brand } from "./theme";

const LABEL = "✦ wacosas";

export function Brand() {
  const [fase, setFase] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFase((p) => (p + 0.0667) % 1), 1000);
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
