#!/usr/bin/env bash
# wacosas — instalador local. Idempotente y sin sudo: se puede correr las veces
# que haga falta. Deja el comando `wacosas` (+ alias corto `wa`) en ~/.local/bin
# apuntando a este repo (CA-19.6, RNF-14).
#
# Uso:  git clone … && cd wacosas && ./install.sh
set -euo pipefail

c() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }   # helper de color
WA='1;38;5;42'; OK='0;32'; WARN='1;33'; ERR='1;31'; INFO='1;36'

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="${HOME}/.local/bin"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/wacosas"

c "$WA" "▶ wacosas — instalación local"
echo "  repo: $REPO"

# ── Bun (RNF-13: no se soporta Node como runtime) ─────────────────────────
BUN="$(command -v bun 2>/dev/null || true)"
[ -z "$BUN" ] && BUN="$(mise which bun 2>/dev/null || true)"
if [ -z "$BUN" ] && command -v mise >/dev/null 2>&1; then
  c "$INFO" "→ Instalando Bun con mise…"
  mise use -g bun@latest >/dev/null 2>&1 || true
  BUN="$(mise which bun 2>/dev/null || true)"
fi
if [ -z "$BUN" ]; then
  c "$ERR" "✗ Bun no encontrado. wacosas corre SOLO con Bun (OpenTUI usa FFI nativo)."
  echo "   Instalalo: https://bun.sh   (o: mise use -g bun@latest)"
  exit 1
fi
c "$OK" "  ✓ bun $("$BUN" --version)"

# ── Dependencias ──────────────────────────────────────────────────────────
c "$INFO" "→ Instalando dependencias…"
if ( cd "$REPO" && "$BUN" install >/dev/null 2>&1 ); then
  c "$OK" "  ✓ deps instaladas"
else
  c "$ERR" "  ✗ bun install falló — corrélo a mano para ver el error:  cd $REPO && bun install"
  exit 1
fi

# ── Directorios de datos y de estado (CA-14.5, CA-14.6) ───────────────────
# El proceso igual los crea/endurece al arrancar (boot/paths.ts); acá se
# adelantan para que el wrapper pueda escribir el log desde el vamos.
mkdir -p "$STATE_DIR" && chmod 700 "$STATE_DIR"
mkdir -p "${XDG_DATA_HOME:-$HOME/.local/share}/wacosas" \
  && chmod 700 "${XDG_DATA_HOME:-$HOME/.local/share}/wacosas"
c "$OK" "  ✓ datos: ${XDG_DATA_HOME:-$HOME/.local/share}/wacosas   log: $STATE_DIR/wacosas.log"

# ── Comando `wacosas` (+ alias corto `wa`) ────────────────────────────────
# El wrapper redirige fd 2 al log (2>>): defensa en profundidad de RNF-4, por si
# el dup2 por FFI del entry no levanta (otra libc, dlopen fallado). Los dos
# caminos escriben al mismo archivo en modo append, así que no se pisan.
mkdir -p "$BIN"
WRAP="$BIN/wacosas"
cat > "$WRAP" <<EOF
#!/usr/bin/env bash
# wacosas launcher (generado por install.sh) — repo: $REPO
set -euo pipefail
REPO="$REPO"
STATE_DIR="\${XDG_STATE_HOME:-\$HOME/.local/state}/wacosas"
mkdir -p "\$STATE_DIR" && chmod 700 "\$STATE_DIR" 2>/dev/null || true
BUN="\$(command -v bun 2>/dev/null || true)"
[ -z "\$BUN" ] && BUN="\$(mise which bun 2>/dev/null || true)"
if [ -z "\$BUN" ]; then for x in "\$HOME"/.local/share/mise/installs/bun/*/bin/bun; do [ -x "\$x" ] && BUN="\$x"; done; fi
[ -z "\$BUN" ] && { echo "bun no encontrado — instalá: https://bun.sh"; exit 1; }
exec "\$BUN" run "\$REPO/src/index.tsx" "\$@" 2>>"\$STATE_DIR/wacosas.log"
EOF
chmod +x "$WRAP"

# Alias corto: el plan decía `wc`, pero `wc` es el word count de coreutils y
# pisarlo en el PATH rompe scripts ajenos. Va `wa`, que está libre.
ALIAS="$BIN/wa"
if [ -e "$ALIAS" ] && [ ! -L "$ALIAS" ]; then
  c "$WARN" "  ⚠ $ALIAS ya existe y no es un symlink: dejo el alias sin tocar."
else
  ln -sf "$WRAP" "$ALIAS"
  c "$OK" "  ✓ comando: wacosas  (alias: wa)  → $WRAP"
fi

# ── PATH ──────────────────────────────────────────────────────────────────
case ":$PATH:" in
  *":$BIN:"*) : ;;
  *) c "$WARN" "  ⚠ $BIN no está en tu PATH. Agregalo a tu shell rc:"
     echo '       export PATH="$HOME/.local/bin:$PATH"'
     echo '       (fish:  fish_add_path ~/.local/bin)' ;;
esac

echo
c "$WA" "✔ Listo. Abrilo con:  wacosas    (o  wa)"
echo "   Aviso: la base local NO se cifra — ver el README."
