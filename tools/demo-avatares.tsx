// Arnés de comparación: ¿qué conviene mostrar de la foto de perfil en una fila
// de bandeja, donde hay UNA o DOS celdas y ni una fila de alto?
//
// Pinta las mismas doce fotos de perfil de tres formas, una al lado de la otra:
//
//   (a) como está hoy      — el glifo `▪`/`▣` con el color del tema;
//   (b) glifo TEÑIDO       — el mismo glifo, con el color más vivo de la foto;
//   (c) miniatura de 2×1   — dos celdas de `chafa`, o sea la foto reducida.
//
// Se corre con `bun run tools/demo-avatares.tsx <dir-con-avX.jpg>` y se captura
// con `tmux capture-pane`. NO abre ningún socket ni toca la cuenta real: son
// archivos locales.
const RAIZ = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const { colorDominante, renderizarImagen } = await import(`${RAIZ}/src/boot/chafa.ts`);
const { legibleSobrePanel, ACCENT2, BORDER, FAINT, GOLD, MUT, SURFACE, TEXT_DIM } = await import(
  `${RAIZ}/src/ui/theme.ts`
);
const { createCliRenderer } = await import("@opentui/core");
const { createRoot } = await import("@opentui/react");
const { readdirSync } = await import("node:fs");
const { join } = await import("node:path");

const DIR = process.argv[2] ?? "/tmp/wacosas-demo-avatares";
const NOMBRES = [
  "Antonella",
  "Grupo mañana",
  "Marcos Díaz",
  "Sofía Gómez",
  "Papá",
  "Laboratorio",
  "Jorge (obra)",
  "Meli 🌻",
  "Consorcio",
  "Vero",
  "Nico",
  "Tía Susana",
];

const archivos = readdirSync(DIR)
  .filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f))
  .sort((a, b) => (Number(a.replace(/\D/g, "")) || 0) - (Number(b.replace(/\D/g, "")) || 0))
  .slice(0, NOMBRES.length);

type Fila = { nombre: string; grupo: boolean; color: string | null; mini: Array<{ texto: string; fg: string; bg: string }> };

const filas: Fila[] = [];
for (const [i, archivo] of archivos.entries()) {
  const ruta = join(DIR, archivo);
  const color = await colorDominante(ruta);
  const r = await renderizarImagen(ruta, 2, 1);
  filas.push({
    nombre: NOMBRES[i] ?? archivo,
    grupo: (NOMBRES[i] ?? "").toLowerCase().includes("grupo") || (NOMBRES[i] ?? "") === "Consorcio",
    color,
    mini: r.ok ? (r.filas[0] ?? []) : [],
  });
}

function Columna({ titulo, hijos }: { titulo: string; hijos: React.ReactNode }) {
  return (
    <box flexDirection="column" width={26} border borderColor={BORDER} backgroundColor={SURFACE} title={` ${titulo} `}>
      {hijos}
    </box>
  );
}

function App() {
  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor="#0b1512">
      <box height={1} paddingLeft={1}>
        <text fg={GOLD} wrapMode="none">
          {"foto de perfil en la bandeja · tres formas, las mismas 12 fotos"}
        </text>
      </box>
      <box flexDirection="row" flexGrow={1}>
        <Columna
          titulo="a) como está hoy"
          hijos={filas.map((f, i) => (
            <box key={i} height={1} paddingLeft={1}>
              <text wrapMode="none">
                <span fg={f.grupo ? ACCENT2 : FAINT}>{f.grupo ? "▣ " : "▪ "}</span>
                <span fg={TEXT_DIM}>{f.nombre}</span>
              </text>
            </box>
          ))}
        />
        <Columna
          titulo="b) glifo teñido"
          hijos={filas.map((f, i) => (
            <box key={i} height={1} paddingLeft={1}>
              <text wrapMode="none">
                <span fg={f.color ? legibleSobrePanel(f.color) : f.grupo ? ACCENT2 : FAINT}>
                  {f.grupo ? "▣ " : "▪ "}
                </span>
                <span fg={TEXT_DIM}>{f.nombre}</span>
              </text>
            </box>
          ))}
        />
        <Columna
          titulo="c) miniatura 2×1"
          hijos={filas.map((f, i) => (
            <box key={i} height={1} paddingLeft={1}>
              <text wrapMode="none">
                {f.mini.map((t, j) => (
                  <span key={j} fg={t.fg || undefined} bg={t.bg || undefined}>
                    {t.texto}
                  </span>
                ))}
                <span fg={MUT}>{" "}</span>
                <span fg={TEXT_DIM}>{f.nombre}</span>
              </text>
            </box>
          ))}
        />
      </box>
    </box>
  );
}

const renderer = await createCliRenderer({ exitOnCtrlC: true, autoFocus: false });
createRoot(renderer).render(<App />);
