# Diseño — wacosas (cliente de WhatsApp en TUI)

> Documento de diseño técnico para `.sdd/wa-tui/requirements.md` (19 historias, 116 criterios
> `CA-<h>.<n>`, 14 `RNF`). Trazabilidad completa al final. **Esto es diseño, no implementación.**

---

## 0. Resumen

wacosas es **un solo proceso Bun** que corre Baileys y la TUI de OpenTUI juntos. La pieza central
del diseño es el **límite entre los dos mundos**: Baileys y SQLite viven fuera de React, en un
**store externo con notificación coalescida**; React lee ese store con `useSyncExternalStore` por
*slice* y es dueño únicamente del estado que no toca ni la red ni el disco (texto del buscador,
índice seleccionado, scroll). Todo lo que llega de WhatsApp entra por **una cola serializada de
ingest** que escribe a SQLite en transacciones *chunkeadas*, de modo que un sync inicial de cientos
de mensajes se convierte en unos pocos re-renders y nunca bloquea el teclado más de unos ms.

SQLite (`bun:sqlite`, WAL, FTS5) es la **fuente de verdad del historial**: la TUI arranca leyendo la
base y es plenamente navegable sin conexión; WhatsApp es un productor de eventos que actualiza esa
base, no un requisito para que la UI funcione.

El estilo, los atajos, el trato del mouse y los gotchas ya pagados salen de `~/projects/miscosas/tui`;
el ciclo de vida del socket (guards de socket viejo, `loggedOut`/`badSession` ⇒ borrar creds,
`restartRequired` ⇒ reconectar en el acto, reset del backoff al emitir QR) sale de
`~/projects/concesionaria-api/wa-worker/worker.mjs` y `~/projects/atenti/web/worker/session-manager.ts`.

### Hechos verificados durante este diseño (corrigen o precisan el brief)

| # | Hallazgo | Consecuencia de diseño |
|---|---|---|
| V1 | Los warnings `[bun] Warning: ws.WebSocket 'upgrade'…` salen por **stderr (fd 2)**, no por stdout. | La supresión tiene que atacar fd 2. |
| V2 | Parchear `process.stderr.write` **NO los intercepta** (Bun los escribe desde código nativo, salteando JS). Verificado: `CAPTURED=0`. | Descartado el monkey-patch. |
| V3 | `dup2(fd, 2)` vía `bun:ffi` sobre `libc.so.6` **sí los captura** (verificado: terminal limpia, warnings en el archivo). | Mecanismo elegido (§2 D9). |
| V4 | `QRCode.create(payload)` expone la **matriz** (`modules.size`, `modules.get(x,y)`). Para un payload de 277 chars da versión 12 → **65×65 módulos** ⇒ con quiet zone 1: **67 columnas × 34 filas** en half-blocks. Coincide exacto con el spike. | El QR se dibuja **nativo en OpenTUI**, sin ANSI (§2 D10). |
| V5 | `@opentui/core` **no parsea ANSI** dentro del contenido de `<text>` (solo expone `ANSI.*` para escribir escapes). | Confirma V4: pegar la salida de `type:"terminal"` habría pintado bytes crudos. |
| V6 | El `<textarea>` de OpenTUI 0.4.2 trae los bindings **al revés** de lo que pide el requirements: por default `return` = `newline` y `meta+return` = `submit`. | El composer pasa `keyBindings` invirtiéndolos (§5.6, CA-8.2/8.4). |
| V7 | `<scrollbox>` soporta `stickyScroll` + `stickyStart="bottom"` y `scrollChildIntoView(childId)`. | Resuelve CA-6.4 y CA-12.3 sin cuentas a mano. |
| V8 | El DDL completo de §4 fue **ejecutado en bun:sqlite 1.3.14**: idempotente (dos `exec` seguidos), dedupe por índice único, FTS5 `remove_diacritics 2` (buscar `manana` encuentra `Mañana`), `snippet()`, reindexado en `UPDATE`, FK activa. | El DDL de §4 se copia tal cual. |
| V9 | `sendMessage(jid, content, { messageId })` acepta un id propio (`MinimalRelayOptions.messageId`) y existe `generateMessageIDV2(userId)`. | El mensaje optimista se persiste **con su id final** ⇒ el eco se deduplica solo (CA-9.4). |

---

## 1. Alcance del documento

Entra: arquitectura de proceso, esquema de datos, contratos de módulos, máquinas de estado de login y
conexión, árbol de componentes, flujos, casos borde, riesgos y trazabilidad.

No entra: código de implementación, textos finales de UI, y todo lo listado como fuera de alcance en
el requirements (multimedia, llamadas, estados, admin de grupos, multi-cuenta, notificaciones).

---

## 2. Decisiones de arquitectura

### D1 — Un proceso, dos dominios, un límite explícito

**Decisión.** El proceso se parte conceptualmente en dos dominios que se comunican **solo** a través
del store:

```
  ┌───────────────── dominio "máquina" (sin React) ─────────────────┐
  │  wa/socket.ts ──► wa/ingest.ts ──► db/repo.ts (bun:sqlite, WAL) │
  │  wa/send.ts   ──┘                        │                      │
  │                                          ▼                      │
  │                                 state/store.ts  (proyecciones)  │
  └──────────────────────────────────────────┬──────────────────────┘
                                             │ notify coalescido (≤30 fps)
  ┌──────────────────────────────────────────▼──────────────────────┐
  │  dominio "ojo" (React + OpenTUI)                                │
  │  useSlice("inbox"|"convo"|"conn"|"link"|"ui")                   │
  │  useState local: query, selección, scroll, borradores en foco   │
  └─────────────────────────────────────────────────────────────────┘
```

**Regla de oro:** *el store es dueño de todo lo que toca WhatsApp o SQLite; React es dueño de lo que
solo toca el ojo.* Ningún handler de Baileys llama a un `setState` de React, nunca. Ningún componente
llama a `sock.*` directo: llama a un comando del dominio máquina (`send`, `markRead`, `reconnectNow`).

**Por qué.** Los eventos de Baileys llegan en ráfagas impredecibles (el sync inicial mete cientos de
`messages.upsert` en pocos ticks). Con el estado adentro de React cada evento es un render y el
`messages.upsert` inicial degenera en tormenta de renders; además el estado moriría con cualquier
remount o error boundary. Con el store afuera controlamos exactamente cuántas veces se re-renderiza.

**Alternativas descartadas.**

- *React state + Context + reducer.* Es "la forma React", pero obliga a capturar `dispatch` en refs
  desde handlers que viven fuera del árbol, hace un render por evento y ata la vida del estado al
  árbol. Descartada por RNF-5/RNF-6.
- *EventEmitter y `useState` local en cada componente.* Sin fuente única de verdad: cada componente
  reimplementa dedupe y orden, y aparece el clásico UI desgarrado (bandeja actualizada, conversación
  no). Descartada.
- *Zustand / valtio / jotai.* Traen exactamente lo que `useSyncExternalStore` + ~80 líneas ya dan.
  miscosas no usa ninguna lib de estado; meter una acá sería deuda sin beneficio. Descartada.
- *Daemon + TUI separados con IPC.* Descartada por el usuario, no se re-discute.

### D2 — SQLite es la fuente de verdad; el store guarda proyecciones, no una segunda copia

**Decisión.** El store **no** mantiene un modelo paralelo de chats y mensajes. Mantiene
*proyecciones*: el resultado de una consulta, cacheado, invalidado por slice. Cuando el ingest
escribe, marca sucio el slice; en el flush el store **vuelve a consultar** la base y publica un
objeto nuevo.

**Por qué.** Elimina de raíz la clase de bugs "la base dice A y la pantalla dice B" (CA-14.3), hace
que el arranque en frío y el arranque caliente compartan exactamente el mismo camino de datos
(CA-13.1), y deja la búsqueda FTS como una consulta más. El costo es una consulta por flush: con los
índices de §4, la bandeja (≤500 filas) y la ventana de conversación (200 filas) se resuelven en
décimas de ms — muy por debajo de RNF-6.

**Alternativa descartada.** Cache en memoria mutada incrementalmente (más rápida en teoría, pero
duplica la lógica de orden/dedupe/contadores y desincroniza en cuanto un camino de escritura se
olvida de actualizarla).

### D3 — Notificación coalescida: como mucho un render cada 33 ms

**Decisión.** El store expone `markDirty(slice)`. El primer `markDirty` agenda un flush con
`setTimeout(flush, max(0, 33 - (now - lastFlush)))`; los siguientes solo suman slices al set sucio.
El flush reconstruye **solo** los snapshots sucios y notifica **solo** a sus listeners.

**Por qué.** Da un techo duro de ~30 renders/s pase lo que pase, mantiene la latencia de un mensaje
suelto en ≤33 ms (imperceptible) y convierte una ráfaga de 500 upserts en **un** render
(RNF-5, CA-4.3).

### D4 — Cola de ingest serializada + escritura chunkeada en transacciones

**Decisión.** Todo evento de Baileys que implique escritura entra a una cola FIFO en memoria
(`wa/ingest.ts`). Los handlers de Baileys hacen **cero** trabajo async: validan el guard de socket
vigente, empujan el job y vuelven. Un drenador corre con `setTimeout(0)` y en cada vuelta procesa
**hasta `MAX_ROWS_PER_TICK = 400` filas** dentro de **una** `db.transaction()`; si queda cola,
se re-agenda con otro `setTimeout(0)` en lugar de seguir en el mismo tick.

**Por qué.** `bun:sqlite` es **síncrono**: insertar 5.000 mensajes de un saque congela el event loop
y con él el teclado. Chunkeando a 400 filas por transacción cada ventana de bloqueo queda en el orden
del milisegundo y el loop respira entre chunks: el tecleo se atiende (RNF-5). La transacción por
chunk es lo que hace que el sync inicial no tarde minutos (una transacción por INSERT sería ~100x más
lento).

**Serialización.** Una sola cola (hay una sola cuenta). Esto le da al diseño la misma propiedad que
`AccountQueues` en atenti: el `UPDATE` de confirmación de un envío queda **ordenado antes** del
`INSERT` del eco de ese mismo mensaje, así que el eco choca contra el índice único y se descarta en
vez de duplicar (CA-9.4).

### D5 — Un socket por proceso, con guard de identidad en todos los handlers

**Decisión.** `wa/socket.ts` mantiene `let current: WASocket | null`. **Todos** los handlers abren con
`if (s !== current) return;` — `creds.update`, `connection.update`, `messages.upsert`, todos. Al
reemplazar un socket: `removeAllListeners()` + `end()` y recién después crear el nuevo.

**Por qué.** Es la lección literal de `worker.mjs`: un socket viejo que reescribe creds después de
que las borramos resucita una sesión inválida y deja un loop de 401 eterno. Cubre CA-3.3, CA-15.6,
CA-15.7 y RNF-11.

### D6 — Máquina de conexión con backoff que se resetea al emitir QR

**Decisión.** El backoff vive en `wa/socket.ts` (fuera del objeto socket, para que sobreviva a su
muerte): `attempt`, `nextAttemptAt`. `reconnectDelayMs(attempt) = min(60_000, 2_000 * 2^(attempt-1))`
→ 2, 4, 8, 16, 32, 60, 60… (CA-15.2). Se resetea a 0 en `connection === "open"` **y también cuando
llega un `qr`**.

**Por qué el reset en el QR.** Un 408 después de emitir un QR significa "nadie lo escaneó", no un
error de red: si contara como fallo, el segundo QR saldría a los 60 s y la pantalla de vinculación
sería inusable. Lección textual de `worker.mjs`.

### D7 — Un id propio para cada envío: el eco se deduplica solo

**Decisión.** Antes de mandar, se genera `waId = generateMessageIDV2(selfJid)` y se persiste la fila
optimista con **ese** id y `status='pending'`. El envío va con `sendMessage(jid, {text}, { messageId: waId })`.
Al volver, si `sent.key.id !== waId` (no debería, pero se chequea) se hace `UPDATE` del `wa_id`.

**Por qué.** El eco que WhatsApp reenvía como `messages.upsert` trae el mismo id ⇒ `INSERT … ON
CONFLICT DO NOTHING` lo descarta (CA-9.4) sin ninguna heurística de "¿será el mismo mensaje?".
Alternativa descartada: insertar con un id local `local:<uuid>` y reescribirlo al confirmar — abre una
ventana de carrera con el eco justo en el peor momento.

### D8 — Rate limit y reintentos: una cola de envío en memoria, nunca en disco

**Decisión.** `wa/send.ts` es una cola FIFO **en memoria** con un limitador puro (`lib/ratelimit.ts`)
de `minGap = 1000 ms` y `20 / 60 s` (RNF-8). Reintentos automáticos: máximo 3 con backoff 1s/3s/9s
(RNF-9); agotados, la fila queda en `status='failed'` y el reintento pasa a ser una tecla (CA-9.3).
Encolar **requiere conexión abierta**: con la conexión caída el envío se rechaza en el acto y el texto
se conserva en el campo (CA-8.7) — no hay "outbox diferido".

**Qué ve el usuario.** La fila aparece al toque como `⏳ enviando` (CA-9.1, < 100 ms porque solo es un
INSERT + markDirty). Si el limitador la hace esperar más de 2 s, el glifo pasa a `⏳ en cola (Ns)` y un
toast avisa que se está espaciando el ritmo (CA-19.5).

### D9 — Supresión de los warnings de `ws`: `dup2(logFd, 2)` con `bun:ffi`, primera línea del entry

**Decisión.** `src/boot/stderr.ts` abre el archivo de log en modo append (0600) y hace
`dup2(logFd, 2)` llamando a libc por `bun:ffi`. Se ejecuta como **la primera sentencia** de
`src/index.tsx`, **antes** de cualquier `import` de `baileys`, `ws` u OpenTUI.

```ts
// boot/stderr.ts (esquema — verificado funcionando)
import { dlopen, FFIType, suffix } from "bun:ffi";
export function redirectStderrTo(path: string): boolean {
  try {
    const lib = dlopen(`libc.${suffix}.6`, { dup2: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
    const fd = openSync(path, "a", 0o600);
    return lib.symbols.dup2(fd, 2) === 2;
  } catch { return false; }   // sin FFI se sigue: el wrapper ya redirige 2>>
}
```

**Por qué así y no de otra forma.** Verificado (V1/V2/V3): el warning lo escribe Bun desde código
nativo directo a fd 2; ni parchear `process.stderr.write`, ni el capture de consola de OpenTUI, ni un
`try/catch` lo tocan. La única palanca es el descriptor. Beneficio colateral: `console.error`, los
stack traces de Bun y cualquier `warn` de una dep también terminan en el log en vez de encima del
render (CA-16.2).

**Defensa en profundidad.** El wrapper de `~/.local/bin/wacosas` además lanza con
`2>>"$STATE_DIR/wacosas.log"`, así que aun sin FFI (dlopen fallado, otra libc) la pantalla queda
limpia. Los dos caminos apuntan al mismo archivo y ambos son append: no se pisan.

### D10 — El QR se dibuja nativo desde la matriz, con half-blocks

**Decisión.** `wa/qr.ts` (puro) toma el payload y devuelve `{ size, rows: string[], cols, height }`
usando `QRCode.create(payload)` y `modules.get(x, y)`, con quiet zone de **1 módulo** y codificando
cada par vertical de módulos en un carácter: ambos oscuros `█`, arriba oscuro `▀`, abajo oscuro `▄`,
ninguno ` `. Se pinta un `<text>` por fila con `fg` negro sobre `bg` blanco fijos.

**Por qué.** OpenTUI no interpreta ANSI dentro del texto (V5), así que la salida de
`QRCode.toString({type:"terminal"})` se vería como basura de escapes. Además así conocemos el tamaño
**exacto antes de pintar** (67×34 para el payload de 277 chars, idéntico al spike) y podemos decidir
si entra. Colores fijos y no del tema: un QR tiene que ser negro sobre blanco para que el teléfono lo
lea, pase lo que pase con el tema de la terminal.

**Ojo con el umbral (gap del requirements, ver §8.2).** El tamaño del QR **depende del largo del
payload**: 250 chars → 63 cols, 277 → 67, 300 → 71 (medido). El umbral fijo de CA-1.5/CA-2.1
(≥36 filas, ≥69 columnas) es correcto para el payload actual, pero no es una garantía. El diseño usa
el umbral fijo como **política de decisión** (satisface el criterio literal) y además **re-verifica
contra la matriz real** antes de pintar; si no entra, muestra el panel de "no entra" con los números
reales en vez de recortar el QR.

### D11 — El login y la conexión son dos máquinas distintas sobre el mismo socket

**Decisión.** `linkState` (vinculación) y `connState` (conexión) son slices separados. El socket es
uno solo y no se reinicia para cambiar de método de vinculación: `requestPairingCode()` se llama sobre
el socket vigente, y los eventos `qr` siguen llegando y actualizando el payload en memoria aunque se
esté mostrando el código. **Alternar QR ↔ código es un cambio de pintura, no de red** (CA-2.6), y por
lo tanto redimensionar la terminal en el medio no cuesta una reconexión (§6.1).

### D12 — Sin dependencias nuevas

`baileys`, `qrcode`, `@opentui/core`, `@opentui/react`, `react`, `pino` (lo exige Baileys como logger)
y nada más. Sin lib de estado, sin lib de fechas, sin lib de CLI args (`process.argv.includes(...)`
como en miscosas), sin lib de logging propia (30 líneas contra un `appendFileSync`). Cualquier
agregado tiene que justificarse acá.

---

## 3. Estructura de archivos del repo

Todo **NUEVO** (el repo está vacío).

```
wacosas/
├── package.json                 NEW  deps exactas + scripts (start, test)
├── tsconfig.json                NEW  jsx: react-jsx, jsxImportSource: @opentui/react (copia de miscosas)
├── install.sh                   NEW  instalador idempotente sin sudo; genera ~/.local/bin/wacosas y wc
├── README.md                    NEW  uso, teclas, arquitectura, AVISO de que la base NO se cifra (RNF-12)
├── .gitignore                   NEW
├── src/
│   ├── index.tsx                NEW  entry. ORDEN OBLIGATORIO: umask → paths → stderr(dup2) → args →
    │                                 lock → db → store.bootstrap → renderer → root.render(<App/>) → wa.start()
    ├── boot/
    │   ├── paths.ts             NEW  XDG data/state/config, mkdir recursivo, umask 0o077
    │   ├── stderr.ts            NEW  dup2(fd2) vía bun:ffi (D9)
    │   ├── log.ts               NEW  logger append + rotación 5 MB + allowlist de campos
    │   ├── lock.ts              NEW  instancia única (pidfile + kill(pid,0) + /proc/<pid>/cmdline)
    │   └── shutdown.ts          NEW  cierre ordenado idempotente + señales + uncaughtException
    ├── db/
    │   ├── schema.ts            NEW  DDL como string (§4) + PRAGMAs + migrate() idempotente
    │   ├── open.ts              NEW  openDb(): abre, aplica PRAGMAs, migra, valida; throw tipado si corrupta
    │   ├── repo.ts              NEW  TODAS las sentencias preparadas (§5.2)
    │   └── types.ts             NEW  ChatRow, MessageRow, SearchHit, MessageKind, MessageStatus
    ├── wa/
    │   ├── socket.ts            NEW  ciclo de vida, guards, máquina de conexión, backoff, comandos
    │   ├── auth.ts              NEW  useMultiFileAuthState + wipeCreds() + chmod defensivo
    │   ├── map.ts               NEW  PURO: WAMessage → MappedMessage (testeable sin socket)
    │   ├── ingest.ts            NEW  cola serializada + chunking + escritura + markDirty
    │   ├── send.ts              NEW  cola de envío, rate limit, reintentos, sentCache para getMessage
    │   ├── read.ts              NEW  markRead local + recibos de lectura
    │   └── qr.ts                NEW  PURO: payload → matriz half-block + medidas
    ├── state/
    │   ├── store.ts             NEW  slices, snapshots cacheados, markDirty + flush coalescido
    │   ├── hooks.ts             NEW  useSlice(name) sobre useSyncExternalStore
    │   └── commands.ts          NEW  fachada UI→máquina (openChat, send, markRead, reconnectNow, …)
    ├── lib/
    │   ├── fmt.ts               NEW  PURO: fecha relativa, hora, clip, fold, highlightParts
    │   ├── fts.ts               NEW  PURO: buildFtsQuery (sanitiza sintaxis FTS5) + parseSnippet
    │   ├── placeholder.ts       NEW  PURO: placeholders de adjunto + duración
    │   ├── backoff.ts           NEW  PURO: reconnectDelayMs / sendRetryDelayMs
    │   └── ratelimit.ts         NEW  PURO: limitador 1/s + 20/min
    └── ui/
        ├── App.tsx              NEW  modos, teclado global, layout, ruteo de pantallas
        ├── theme.ts             NEW  tokens (paleta propia, misma estructura que miscosas/theme.ts)
        ├── Brand.tsx            NEW  marca animada "✦ wacosas" (shimmer, componente aislado)
        ├── Splash.tsx           NEW  splash ≤1,5 s skippable
        ├── Header.tsx           NEW  marca + buscador + tabs con contadores + badge de conexión
        ├── Footer.tsx           NEW  hints de teclas / toast efímero
        ├── Inbox.tsx            NEW  lista de chats (filas height=1, wrapMode="none")
        ├── Conversation.tsx     NEW  scrollbox sticky-bottom + paginado hacia arriba
        ├── MessageRow.tsx       NEW  una burbuja: hora, autor, cuerpo/placeholder, estado
        ├── Composer.tsx         NEW  textarea con keyBindings invertidos + borradores
        ├── SearchOverlay.tsx    NEW  búsqueda global FTS con debounce
        ├── Login.tsx            NEW  máquina de vinculación (QR ↔ código)
        ├── QrView.tsx           NEW  pinta la matriz de wa/qr.ts
        ├── PairingView.tsx      NEW  input de teléfono + código XXXX-XXXX + timer 120 s
        ├── Help.tsx             NEW  atajos + ruta del log
        ├── TooSmall.tsx         NEW  pantalla "agrandá la terminal" (RNF-2)
        └── ErrorScreen.tsx      NEW  base corrupta / lock tomado (CA-13.6, CA-18.2)
└── test/                        NEW  bun test sobre los módulos PUROS + db
    ├── map.test.ts  placeholder.test.ts  fts.test.ts  fmt.test.ts
    ├── backoff.test.ts  ratelimit.test.ts  qr.test.ts
    ├── db.test.ts        (schema idempotente, dedupe, FTS, contadores)
    └── store.test.ts     (coalescing: 500 upserts ⇒ 1 notify)
```

**`package.json`** (dependencias exactas, sin agregados):

```json
{
  "name": "wacosas", "private": true, "type": "module",
  "scripts": { "start": "bun run src/index.tsx", "test": "bun test" },
  "dependencies": {
    "@opentui/core": "0.4.2", "@opentui/react": "0.4.2", "react": "^19.2.0",
    "baileys": "7.0.0-rc14", "qrcode": "^1.5.4", "pino": "^9.0.0"
  },
  "devDependencies": { "@types/qrcode": "^1.5.5", "@types/react": "^19.0.0" }
}
```

---

## 4. Modelo de datos

Ubicación (CA-14.5): base y creds en `$XDG_DATA_HOME/wacosas` (default `~/.local/share/wacosas`),
log en `$XDG_STATE_HOME/wacosas` (default `~/.local/state/wacosas`).

```
~/.local/share/wacosas/
├── wacosas.sqlite            (+ -wal, -shm)
├── creds/                    useMultiFileAuthState (dir 0700, archivos 0600)
├── config.json               { "readReceipts": true, "splash": true }
└── wacosas.lock              pid de la instancia viva
~/.local/state/wacosas/
├── wacosas.log               destino del dup2 + logger propio
└── wacosas.log.1             rotación (máx 1 anterior)
```

**Permisos (CA-14.6, RNF-12).** `process.umask(0o077)` como una de las primeras sentencias del entry:
todo archivo que cree el proceso nace `0600` y todo directorio `0700`, incluidos los que crea
`useMultiFileAuthState` por dentro. Además `boot/paths.ts` hace `chmod 0700` explícito sobre los dos
directorios raíz (por si ya existían con permisos laxos de una instalación previa).

### 4.1 DDL completo (verificado en bun:sqlite 1.3.14, ver V8)

```sql
-- PRAGMAs (se aplican en db/open.ts, en este orden, antes del DDL)
PRAGMA journal_mode = WAL;      -- lector (UI) y escritor (ingest) conviven
PRAGMA busy_timeout = 3000;     -- gotcha heredado de miscosas
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;    -- WAL + NORMAL: durable ante crash del proceso, rápido

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);  -- schema_version, self_jid, self_phone, last_open_chat

CREATE TABLE IF NOT EXISTS chats (
  jid              TEXT PRIMARY KEY,                    -- normalizado (jidNormalizedUser)
  name             TEXT    NOT NULL DEFAULT '',         -- nombre resuelto (§5.4)
  is_group         INTEGER NOT NULL DEFAULT 0,
  last_message_at  INTEGER NOT NULL DEFAULT 0,          -- epoch SEGUNDOS
  last_preview     TEXT    NOT NULL DEFAULT '',         -- una línea, ya con placeholder si es adjunto
  last_from_me     INTEGER NOT NULL DEFAULT 0,
  unread_count     INTEGER NOT NULL DEFAULT 0,
  last_read_id     INTEGER NOT NULL DEFAULT 0,          -- messages.id del último leído (para recibos)
  created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at       INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_chats_activity ON chats(last_message_at DESC, jid);

CREATE TABLE IF NOT EXISTS contacts (
  jid        TEXT PRIMARY KEY,
  name       TEXT    NOT NULL DEFAULT '',               -- name || notify || verifiedName
  phone      TEXT    NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,        -- rowid: orden de llegada y ancla del FTS
  chat_jid    TEXT    NOT NULL REFERENCES chats(jid) ON DELETE CASCADE,
  wa_id       TEXT    NOT NULL,                         -- key.id de WhatsApp (o el nuestro, D7)
  from_me     INTEGER NOT NULL DEFAULT 0,
  sender_jid  TEXT    NOT NULL DEFAULT '',              -- grupos: key.participant; 1:1: chat_jid o self
  sender_name TEXT    NOT NULL DEFAULT '',              -- pushName congelado al momento
  ts          INTEGER NOT NULL,                         -- epoch SEGUNDOS (messageTimestamp)
  kind        TEXT    NOT NULL,                         -- ver MessageKind (§5.1)
  body        TEXT    NOT NULL DEFAULT '',              -- texto o caption. ÚNICO campo indexado en FTS
  attachment  TEXT,                                     -- JSON o NULL: {label,filename,seconds,mimetype}
  status      TEXT    NOT NULL DEFAULT 'received',      -- received|pending|sent|delivered|read|failed
  error       TEXT,                                     -- motivo del fallo de envío (CA-9.3)
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
-- Dedupe (CA-14.2/CA-14.4/CA-9.4): toda inserción es INSERT ... ON CONFLICT DO NOTHING contra esto.
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_waid   ON messages(chat_jid, wa_id);
-- Ventana de conversación y paginado (CA-6.1/CA-6.8).
CREATE INDEX        IF NOT EXISTS idx_messages_chatts ON messages(chat_jid, ts, id);
-- Envíos en vuelo o fallados al arrancar (CA-17.7).
CREATE INDEX        IF NOT EXISTS idx_messages_open   ON messages(status) WHERE status IN ('pending','failed');

-- ── FTS5: cuerpo de mensajes ──────────────────────────────────────────────
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  body, content='messages', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'                -- CA-12.6: "manana" encuentra "Mañana"
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.id, old.body);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF body ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.id, old.body);
  INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body);
END;

-- ── FTS5: nombres de chat (CA-12.1 exige buscar también por nombre) ───────
CREATE VIRTUAL TABLE IF NOT EXISTS chats_fts USING fts5(
  name, content='chats', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS chats_ai AFTER INSERT ON chats BEGIN
  INSERT INTO chats_fts(rowid, name) VALUES (new.rowid, new.name);
END;
CREATE TRIGGER IF NOT EXISTS chats_ad AFTER DELETE ON chats BEGIN
  INSERT INTO chats_fts(chats_fts, rowid, name) VALUES ('delete', old.rowid, old.name);
END;
CREATE TRIGGER IF NOT EXISTS chats_au AFTER UPDATE OF name ON chats BEGIN
  INSERT INTO chats_fts(chats_fts, rowid, name) VALUES ('delete', old.rowid, old.name);
  INSERT INTO chats_fts(rowid, name) VALUES (new.rowid, new.name);
END;
```

**Nota sobre los triggers de UPDATE.** Son `AFTER UPDATE OF body` / `OF name` a propósito: un
`UPDATE` de `status` (que ocurre en cada confirmación de envío) **no** debe reindexar nada.

### 4.2 Creación y migración idempotente (CA-13.4, CA-13.5)

`db/schema.ts` expone `SCHEMA_SQL` (el bloque de arriba) y `migrate(db)`:

1. `db.exec(SCHEMA_SQL)` — todo es `IF NOT EXISTS`, correr dos veces es un no-op (verificado).
2. Leer `meta.schema_version` (ausente ⇒ 0). Aplicar en orden las migraciones `> version` de un array
   `MIGRATIONS: { v: number; sql: string }[]` (vacío en v1; existe para que la v2 no tenga que
   inventar el mecanismo). Cada migración corre dentro de una transacción.
3. Escribir `meta.schema_version = CURRENT_VERSION`.
4. `PRAGMA quick_check` — si falla, se lanza `DbCorruptError { path, reason }` que `index.tsx`
   convierte en `<ErrorScreen>` + `exit(2)` (CA-13.6). **Nunca** un stack trace crudo sobre la
   terminal (imposible además, con fd 2 redirigido).

### 4.3 Mapeo de un mensaje de Baileys a fila

| Columna | Origen (`WAMessage`) | Notas |
|---|---|---|
| `chat_jid` | `jidNormalizedUser(key.remoteJid)` | se descartan `status@broadcast` y newsletters |
| `wa_id` | `key.id` | dedupe |
| `from_me` | `key.fromMe ? 1 : 0` | CA-9.5: un envío desde el teléfono llega con `fromMe: true` y se persiste como propio, sin caso especial |
| `sender_jid` | grupo: `key.participant`; 1:1: `fromMe ? selfJid : chat_jid` | |
| `sender_name` | `pushName` \|\| nombre del contacto \|\| `''` | congelado (CA-6.3) |
| `ts` | `Number(messageTimestamp)` (segundos) | si falta o es 0 ⇒ `now` |
| `kind` | `getContentType(normalizeMessageContent(message))` mapeado a `MessageKind` | ver tabla §5.1 |
| `body` | `conversation` \|\| `extendedTextMessage.text` \|\| `<media>.caption` \|\| `''` | único campo en FTS |
| `attachment` | `JSON.stringify({label, filename?, seconds?, mimetype?})` o `NULL` | de `imageMessage`, `audioMessage.seconds`, `documentMessage.fileName`, … |
| `status` | entrante: `'received'`; propio del eco: `'sent'`; propio nuestro: `'pending'` | |

---

## 5. Contratos internos (tipos TypeScript)

### 5.1 `db/types.ts`

```ts
export type MessageKind =
  | "text" | "image" | "video" | "audio" | "document" | "sticker"
  | "location" | "contact" | "revoked" | "system" | "unsupported";

export type MessageStatus = "received" | "pending" | "sent" | "delivered" | "read" | "failed";

export type ChatRow = {
  jid: string; name: string; isGroup: boolean;
  lastMessageAt: number; lastPreview: string; lastFromMe: boolean;
  unreadCount: number; lastReadId: number;
};

export type MessageRow = {
  id: number; chatJid: string; waId: string; fromMe: boolean;
  senderJid: string; senderName: string; ts: number;
  kind: MessageKind; body: string;
  attachment: AttachmentInfo | null;         // ya parseado
  status: MessageStatus; error: string | null;
};

export type AttachmentInfo = {
  label: string;                              // "📷 imagen", "🎤 audio 0:12", "📎 informe.pdf"
  filename?: string; seconds?: number; mimetype?: string;
};

export type SearchHit = {
  messageId: number; chatJid: string; chatName: string; isGroup: boolean;
  ts: number; fromMe: boolean;
  parts: Array<{ text: string; hit: boolean }>;   // fragmento ya partido (CA-12.2)
};
```

### 5.2 `db/repo.ts` — todas las sentencias preparadas viven acá

```ts
export type Repo = {
  // lectura (proyecciones del store)
  listChats(limit?: number): ChatRow[];                       // ORDER BY last_message_at DESC (CA-4.2)
  countsByFilter(): { all: number; unread: number; groups: number };
  getChat(jid: string): ChatRow | null;
  lastMessages(jid: string, limit: number): MessageRow[];      // asc por (ts,id); los N últimos (CA-6.1/6.8)
  messagesBefore(jid: string, beforeId: number, limit: number): MessageRow[];   // paginado (CA-6.8)
  messagesAround(jid: string, anchorId: number, span: number): MessageRow[];    // salto desde búsqueda (CA-12.3)
  searchMessages(match: string, limit: number): SearchHit[];   // FTS5 + bm25 + snippet
  searchChats(match: string, limit: number): ChatRow[];
  openSends(): MessageRow[];                                   // status pending/failed al arrancar

  // escritura (SOLO desde wa/ingest.ts y wa/send.ts, siempre dentro de una txn del caller)
  upsertChat(c: Partial<ChatRow> & { jid: string }): void;     // no pisa name/unread con vacíos
  upsertContact(jid: string, name: string, phone: string): void;
  insertMessage(m: MappedMessage): { inserted: boolean; id: number };  // ON CONFLICT DO NOTHING
  touchChatActivity(jid: string, ts: number, preview: string, fromMe: boolean): void;
  bumpUnread(jid: string, delta: number): void;
  clearUnread(jid: string, lastReadId: number): void;          // CA-11.1
  setUnread(jid: string, n: number): void;                     // CA-11.6 (otro dispositivo)
  setMessageStatus(chatJid: string, waId: string, status: MessageStatus, error?: string | null): void;
  setMessageWaId(chatJid: string, oldWaId: string, newWaId: string): void;
  revokeMessage(chatJid: string, waId: string): void;          // kind='revoked', body='' (CA-6.9)

  tx<T>(fn: () => T): T;                                       // db.transaction envuelta
  close(): void;
};
export function createRepo(db: Database): Repo;
```

`searchMessages` usa marcadores de control que no pueden aparecer en texto real y se parten en JS:

```sql
SELECT m.id, m.chat_jid, c.name AS chat_name, c.is_group, m.ts, m.from_me,
       snippet(messages_fts, 0, char(1), char(2), '…', 10) AS frag
FROM messages_fts
JOIN messages m ON m.id = messages_fts.rowid
JOIN chats   c ON c.jid = m.chat_jid
WHERE messages_fts MATCH ?
ORDER BY bm25(messages_fts), m.ts DESC
LIMIT ?;
```

### 5.3 `lib/fts.ts` — sanitización (CA-12.5)

```ts
/** Convierte texto libre en una expresión MATCH segura: parte por no-alfanumérico,
 *  descarta AND/OR/NOT/NEAR, entrecomilla cada término y le agrega `*` (prefijo).
 *  `hola "mundo" -x*: (a)` → `"hola"* "mundo"* "x"* "a"*`. Devuelve '' si no queda nada. */
export function buildFtsQuery(raw: string): string;
export function parseSnippet(frag: string): Array<{ text: string; hit: boolean }>;
```
Mismo patrón que `miscosas/src/repo.js#buildFtsQuery`, ya probado en producción: al entrecomillar
cada token, comillas, `*`, `-`, `:` y paréntesis quedan neutralizados y jamás llegan como sintaxis.

### 5.4 `wa/map.ts` — puro

```ts
export type MappedMessage = { /* = MessageRow sin id, con attachment ya armado */ };

export function mapMessage(m: WAMessage, ctx: { selfJid: string; nowSec: number }): MappedMessage | null;
export function isRevoke(m: WAMessage): { chatJid: string; targetWaId: string } | null;
export function previewFor(m: Pick<MappedMessage,"kind"|"body"|"attachment">): string;   // CA-4.5
export function resolveChatName(input: {
  groupSubject?: string; contactName?: string; pushName?: string; jid: string;
}): string;   // precedencia: subject > contact.name > contact.notify > pushName > número formateado
```

`mapMessage` devuelve `null` (se descarta sin persistir) para: `status@broadcast`, newsletters,
`protocolMessage` que no sea revoke, `reactionMessage`, y mensajes sin `key.remoteJid`.
Cualquier `getContentType` desconocido cae en `kind: "unsupported"` y **se persiste igual** (CA-7.5).

### 5.5 `state/store.ts`

```ts
export type Slice = "link" | "conn" | "inbox" | "convo" | "search" | "ui";

export type ConnSnapshot = {
  state: "offline" | "connecting" | "open" | "reconnecting" | "unlinked";
  attempt: number; nextAttemptAt: number | null; lastCode: number | null; selfPhone: string | null;
};
export type LinkSnapshot = {
  phase: "checking" | "need-link" | "qr-waiting" | "qr-shown" | "pairing-phone"
       | "pairing-requesting" | "pairing-shown" | "restarting" | "linked" | "failed";
  method: "qr" | "code"; methodForced: boolean;
  qr: string | null; pairingCode: string | null; pairingRequestedAt: number | null;
  reason: string | null;                                  // texto para pantalla (CA-1.4/CA-3.1/CA-2.4)
};
export type InboxSnapshot = { chats: ChatRow[]; counts: { all: number; unread: number; groups: number } };
export type ConvoSnapshot = {
  jid: string | null; messages: MessageRow[]; hasMoreAbove: boolean; anchorId: number | null;
};
export type UiSnapshot = { toast: { text: string; at: number } | null; connBanner: string | null };

export function subscribe(slice: Slice, cb: () => void): () => void;
export function getSnapshot<S extends Slice>(s: S): SnapshotOf<S>;   // CACHEADO: misma identidad hasta el flush
export function markDirty(...slices: Slice[]): void;                 // agenda el flush coalescido (D3)
export function toast(text: string): void;                           // CA-19.5
export function bootstrap(repo: Repo): void;                         // primer llenado sincrónico (CA-13.1)
```

`state/hooks.ts`:

```ts
export function useSlice<S extends Slice>(s: S): SnapshotOf<S>;   // useSyncExternalStore(subscribe(s), () => getSnapshot(s))
```

`state/commands.ts` — **la única puerta de la UI hacia la máquina**:

```ts
export const commands: {
  openChat(jid: string, opts?: { anchorId?: number }): void;   // carga ventana + markRead (CA-11.1)
  closeChat(): void;
  loadOlder(): void;                                            // CA-6.8
  send(jid: string, text: string): { ok: true } | { ok: false; reason: string };  // CA-8.7
  retrySend(chatJid: string, waId: string): void;               // CA-9.3
  markRead(jid: string): void;                                  // CA-11.5
  reconnectNow(): void;                                         // CA-15.5
  search(query: string): void;                                  // debounced afuera (RNF-7)
  chooseLinkMethod(m: "qr" | "code"): void;                     // CA-2.6
  requestPairing(phoneDigits: string): void;                    // CA-2.2/2.3
  quit(code?: number): void;                                    // CA-17.1
};
```

### 5.6 `wa/socket.ts`

```ts
export type WaController = {
  start(): void;                                   // arranca el ciclo (no bloquea el render)
  reconnectNow(): void;                            // saltea el backoff (CA-15.5)
  requestPairingCode(phoneDigits: string): Promise<void>;
  isOpen(): boolean;
  socket(): WASocket | null;                       // SOLO para send.ts/read.ts, siempre re-chequeando
  stop(opts: { timeoutMs: number }): Promise<void>; // end() SIN logout (CA-17.1)
};
export function createWaController(deps: {
  repo: Repo; ingest: Ingest; log: Logger; credsDir: string; config: Config;
}): WaController;
```

Opciones del socket — **no negociables**, salen del prior art:

```ts
makeWASocket({
  ...(version ? { version } : {}),                 // fetchLatestBaileysVersion (CA-1.2/RNF-10)
  auth: state,
  browser: Browsers.ubuntu("Chrome"),              // WA rechaza clientes sin browser
  logger: pino({ level: "silent" }),               // CA-16.2
  markOnlineOnConnect: false,                      // CA-15.8
  syncFullHistory: false,
  shouldSyncHistoryMessage: () => false,
  generateHighQualityLinkPreview: false,
  getMessage: async (key) => sentCache.get(key.id ?? "") ?? undefined,   // §8.6
});
```

### 5.7 `wa/ingest.ts`

```ts
export type IngestJob =
  | { kind: "messages"; msgs: WAMessage[]; source: "notify" | "append" | "history" }
  | { kind: "chats";    chats: Chat[] }
  | { kind: "contacts"; contacts: Contact[] }
  | { kind: "chat-updates"; updates: ChatUpdate[] }     // unreadCount de otro dispositivo (CA-11.6)
  | { kind: "msg-updates";  updates: WAMessageUpdate[] } // status + revoke (CA-6.9)
  | { kind: "receipts";     receipts: MessageUserReceiptUpdate[] };

export type Ingest = {
  push(job: IngestJob): void;      // O(1), nunca async, nunca throw
  drainNow(): void;                // usado por el cierre ordenado (CA-17.1)
  pendingRows(): number;           // métrica para la UI ("sincronizando… N")
};
export function createIngest(deps: { repo: Repo; store: Store; log: Logger; selfJid(): string;
                                     openChatJid(): string | null }): Ingest;
```

Constantes: `MAX_ROWS_PER_TICK = 400`, `MAX_QUEUE_JOBS = 10_000` (si se supera, se loguea y se
descartan los `history` más viejos — nunca los `notify`).

### 5.8 `wa/send.ts`

```ts
export type SendJob = { chatJid: string; waId: string; text: string; attempt: number };
export type SendQueue = {
  enqueue(chatJid: string, text: string): { ok: true; waId: string } | { ok: false; reason: string };
  retry(chatJid: string, waId: string): void;
  inFlight(): Promise<void> | null;      // para el tope de 2 s del cierre (CA-17.7)
  size(): number;
};
```

### 5.9 `boot/*`

```ts
// paths.ts
export type Paths = { dataDir: string; stateDir: string; dbPath: string; credsDir: string;
                      logPath: string; lockPath: string; configPath: string };
export function resolvePaths(env = process.env): Paths;     // XDG + mkdir + chmod 0700 + umask 0o077

// log.ts — CA-16.1/16.4/14.7
export type Logger = { info(ev: string, f?: Fields): void; warn(...): void; error(...): void; path: string };
type Fields = Record<string, string | number | boolean | null>;   // NUNCA cuerpos ni creds
export function createLogger(path: string, maxBytes = 5 * 1024 * 1024): Logger;

// lock.ts — CA-18.*
export type LockResult = { ok: true; release(): void } | { ok: false; pid: number };
export function acquireLock(lockPath: string): LockResult;

// shutdown.ts — CA-17.*
export function installShutdown(deps: { renderer: CliRenderer; wa: WaController; ingest: Ingest;
                                        send: SendQueue; repo: Repo; lock: LockResult; log: Logger }): (code?: number) => void;
```

---

## 6. Flujos clave

### 6.1 Vinculación (CA-1.*, CA-2.*, CA-3.*)

Máquina (`linkState.phase`):

```
 checking ──sin creds──► need-link ──┬─(auto: entra el QR)──► qr-waiting ──qr──► qr-shown ─┐
    │ con creds                      └─(auto: no entra)─────► pairing-phone ──⏎──► pairing-requesting
    ▼                                                                │                 │
 (va directo a conn: connecting)                                     │            ok   ▼
                                                                     │      pairing-shown ──120s──► (tecla) pairing-requesting
                                                                     │ error
                                                                     ▼
                                                                  failed (motivo + reintentar)

 qr-shown / pairing-shown ──connection close 515 (restartRequired)──► restarting ──open──► linked
 cualquier estado ──close 401/500──► need-link (creds borradas, motivo en pantalla)
 qr-shown ──close 405 && nunca hubo qr──► failed("versión de WhatsApp Web desactualizada")
```

Detalles que el implementador **no** tiene que decidir:

1. **Elección del método (CA-2.1/RNF-3).** `fitsQr(w, h, qr)` = `h >= 36 && w >= 69` **y**
   `w >= qr.cols && h >= qr.rows + 1` cuando ya tenemos la matriz. Si `methodForced === false`, el
   método se recalcula en cada resize; si el usuario apretó `Tab` (CA-2.6), `methodForced = true` y no
   se toca más hasta que vuelva a apretar.
2. **Redimensionar en el medio.** Cambiar de vista **no toca el socket** (D11): el payload del QR
   sigue rotando en memoria. Achicar mientras se muestra el QR ⇒ se pinta el panel "no entra"
   (tamaño actual vs requerido, CA-2.1); agrandar ⇒ vuelve a aparecer el QR vigente, sin esperar la
   próxima rotación.
3. **Rotación del QR (CA-1.6).** El payload es un `useSlice("link").qr`: React reemplaza el
   `<QrView key={qr}>` entero. No hay apilado posible porque no se "imprime" nada — se re-renderiza.
4. **Código de emparejamiento (CA-2.2/2.3).** El input acepta solo dígitos; valida 8..15 (mensaje
   explicando el formato si no). `requestPairingCode(digits)` devuelve 8 caracteres que se muestran
   como `XXXX-XXXX`. `pairingRequestedAt` arranca el contador de 120 s; al vencer, el pie ofrece
   `Ctrl-R = generar código nuevo` (CA-2.5). Un throw ⇒ `phase: "failed"` con el motivo y el input
   vuelve a estar disponible sin reiniciar nada (CA-2.4).
5. **405 sin QR (CA-1.4).** El socket lleva `sawQr: boolean`. En `close` con `statusCode === 405 &&
   !sawQr` ⇒ `failed` con el texto de versión desactualizada. Sin este flag el usuario se queda en
   "conectando…" para siempre.
6. **`restartRequired` (515) (CA-1.8).** Reconexión inmediata con las creds recién guardadas, **sin**
   sumar al backoff y sin volver a pedir QR. Es el cierre normal después de escanear.
7. **`loggedOut` (401) / `badSession` (500) (CA-3.1).** `removeAllListeners()` + `end()` + `sleep(1500)`
   + borrar **solo** `creds/` (jamás la base, CA-3.2) + `phase: "need-link"` con el motivo. El sleep es
   el cooldown del prior art para que el socket moribundo no reescriba creds.
8. **Reconexión que pide QR (CA-3.4).** Si llega un evento `qr` mientras había creds en disco
   (`flow === "reconnect"`), las creds son inservibles: borrarlas y pasar a vinculación. Nunca
   reintentar en loop. (Patrón textual de `session-manager.ts#handleQrEvent`.)
9. **Post-vinculación (CA-3.5).** No se toca la base: el historial viejo sigue ahí y el sync nuevo se
   mergea por el índice único.

### 6.2 Mensaje entrante (CA-4.3, CA-10.1, CA-11.7, CA-14.1/14.2/14.4)

```
sock.ev "messages.upsert"
  └─ guard s !== current ⇒ return                                     (CA-15.6)
  └─ ingest.push({kind:"messages", msgs, source: type})               ← O(1), vuelve YA
       ...
     drenador (setTimeout 0, ≤400 filas por vuelta, 1 transacción):
       para cada msg:
         map = mapMessage(msg, ctx);  if (!map) continue              (CA-7.5 persiste "unsupported")
         upsertChat(chatJid, {name resuelto, is_group})               ← FK exige el chat primero
         { inserted } = insertMessage(map)                            ← ON CONFLICT DO NOTHING (CA-14.2)
         if (!inserted) continue                                       ← re-sync: NO reabre contadores (CA-14.4)
         touchChatActivity(jid, ts, previewFor(map), fromMe)          (CA-4.1/4.5)
         if (!fromMe) {
           if (jid === openChatJid) { clearUnread(jid, id); pushReadReceipt(map) }   (CA-11.7)
           else bumpUnread(jid, +1)                                                  (CA-10.1)
         }
       markDirty("inbox", jid === openChatJid ? "convo" : null)
```

La bandeja se reordena sola porque la proyección re-consulta `ORDER BY last_message_at DESC`
(CA-4.2/4.3); el cursor se mantiene sobre el mismo chat porque `Inbox.tsx` guarda el **jid**
seleccionado, no el índice (CA-4.4, patrón `prevItemsRef` de miscosas/App.tsx:89).

**Sync inicial.** `messaging-history.set` entra por la misma cola con `source: "history"`. Con
`syncFullHistory: false` llega el bloque reciente que WhatsApp entrega igual (respuesta a la pregunta
abierta 1 del requirements). Mientras `ingest.pendingRows() > 0` el encabezado muestra
`⟳ sincronizando…` y la bandeja se va poblando de a chunks — nunca queda congelada (CA-4.7 cubre el
caso "todavía no llegó nada").

### 6.3 Envío (CA-8.*, CA-9.*, RNF-8, RNF-9)

```
Composer ⏎ (submit)
  └─ text = textarea.plainText.trim(); if (!text) return              (CA-8.3)
  └─ commands.send(jid, text)
       ├─ if (!wa.isOpen()) → { ok:false, reason:"sin conexión" }     (CA-8.7: NO encola, no limpia el campo)
       └─ sendQueue.enqueue:
            waId = generateMessageIDV2(selfJid)                        (D7)
            repo.tx(insertMessage({...,status:"pending"}) + touchChatActivity)
            markDirty("inbox","convo")                                 → visible < 100 ms (CA-9.1)
            push job
  worker (un job por vez):
       await sleep(limiter.reserve(now) - now)                         (RNF-8: 1/s y 20/min)
       if (!isOpen()) → cuenta como intento fallido y reprograma
       sent = await sock.sendMessage(jid, { text }, { messageId: waId })
       sentCache.set(waId, protoDelMensaje)                            (§8.6)
       ok    → setMessageStatus(waId,"sent") [+ setMessageWaId si difiere]   (CA-9.2)
       error → attempt<3 ? backoff(1s,3s,9s) : setMessageStatus("failed", motivo)  (RNF-9, CA-9.3)
       markDirty("convo","inbox")
```

`Ctrl-Y` sobre la conversación reencola el último `failed` del chat abierto (CA-9.3). El eco que
llega después por `messages.upsert` choca contra el índice único y no duplica (CA-9.4). Un mensaje
enviado desde el teléfono llega con `fromMe: true`, no existe en la base y se inserta como propio
(CA-9.5) — sin código especial.

### 6.4 Búsqueda global (CA-12.*, RNF-7)

```
Ctrl-G ⇒ mode="search"; se guarda { selectedJid, filter, query } para el Esc      (CA-12.8)
tipear ⇒ setState local; useEffect con debounce 120 ms                            (RNF-7)
       ⇒ match = buildFtsQuery(text)                                              (CA-12.5)
       ⇒ repo.searchMessages(match, 200) + repo.searchChats(match, 20)            (CA-12.1)
       ⇒ markDirty("search")
render ⇒ grupo "Chats" (si hay) + resultados: chat · fecha · fragmento con hits    (CA-12.2)
       ⇒ 0 resultados ⇒ "sin coincidencias" (NO la lista anterior)                (CA-12.4)
⏎      ⇒ commands.openChat(jid, { anchorId: messageId })
          repo.messagesAround(jid, id, 100) + scrollbox.scrollChildIntoView("msg-"+id)
          la fila queda marcada (borde de acento) hasta el próximo cambio de chat  (CA-12.3)
```

Los mensajes nuevos aparecen en búsquedas posteriores sin reiniciar porque los triggers indexan en el
`INSERT` (CA-12.7).

### 6.5 Reconexión (CA-15.*)

```
close(code) donde code ∉ {401,500,515}
  └─ attempt++, nextAttemptAt = now + reconnectDelayMs(attempt)      2,4,8,16,32,60… (CA-15.2)
  └─ connState = "reconnecting"; markDirty("conn")
  └─ setTimeout(connect, delay)      ← UN solo timer, y connect() aborta si ya hay socket (CA-15.7)
header muestra: "⟳ reconectando · intento 3 · en 7s"                              (CA-15.3)
Ctrl-R ⇒ clearTimeout + connect() ya                                              (CA-15.5)
open   ⇒ attempt=0, connState="open", envío habilitado                            (CA-15.4)
```

Mientras tanto **la TUI sigue viva**: la bandeja, la conversación y la búsqueda leen de SQLite
(CA-13.2/15.3). Lo único deshabilitado es el envío (CA-13.3). Los mensajes del corte los reentrega
WhatsApp al reconectar como `messages.upsert` normales y entran por el flujo 6.2 (CA-15.4).

### 6.6 Cierre ordenado (CA-17.*)

`shutdown(code)` — idempotente, con **un solo** tope global de 2 s:

1. Marcar `shuttingDown` (segundo `Ctrl-C` ⇒ `process.exit(1)` inmediato).
2. Parar el drenador de ingest y el worker de envío (no aceptan trabajo nuevo).
3. `await Promise.race([sendQueue.inFlight(), sleep(2000)])`; lo que no resolvió ⇒
   `setMessageStatus(..., "failed", "cierre")` (CA-17.7, CA-17.4).
4. `ingest.drainNow()` — el resto de la cola se escribe sincrónicamente (son inserts, es rápido).
5. `sock.end(undefined)` dentro de try/catch. **Nunca `logout()`** (CA-17.1/17.6).
6. `repo.close()` (checkpoint de WAL).
7. `renderer.destroy()` → sale de la pantalla alternativa, apaga el tracking de mouse, muestra el
   cursor (CA-17.2).
8. `lock.release()` (CA-18.4).
9. `process.exit(code ?? 0)` (CA-17.3).

Se engancha a: `Ctrl-C`/`Ctrl-Q` desde `useKeyboard`, `process.on("SIGINT"|"SIGTERM"|"SIGHUP")`
(CA-17.5) y `uncaughtException`/`unhandledRejection` (log + `exit(1)`). El renderer se crea con
`exitOnCtrlC: false` y `exitSignals: []` para que **este** sea el único camino de salida.

---

## 7. Interfaz: árbol de componentes y layout

### 7.1 Árbol

```
<App>                                    modo: browse | compose | search | help | login | too-small
 ├ <Splash t/>                           mientras booting (CA-19.2, saltea con cualquier tecla)
 ├ <TooSmall w h/>                       si w<60 || h<15 (RNF-2), se recupera solo
 ├ <ErrorScreen/>                        base corrupta (CA-13.6) / instancia tomada (CA-18.2)
 ├ <Login>                               si link.phase ∉ {linked}
 │   ├ <QrView payload/>                 matriz half-block (D10)
 │   └ <PairingView/>                    input de teléfono + XXXX-XXXX + timer
 └ vista principal                                                                   (CA-19.1)
    ├ <Header>  <Brand/> <SearchBar/> <tabs Todos|No leídos|Grupos + contadores> <ConnBadge/>
    ├ <box row flexGrow>
    │   ├ <Inbox>          filas height=1, wrapMode="none", onMouseScroll, onMouseDown
    │   └ <box column>
    │       ├ <Conversation>   <scrollbox stickyScroll stickyStart="bottom">
    │       │                     <MessageRow id={"msg-"+id}/> …
    │       │                  + badge "↓ N mensajes nuevos" si hay scroll manual arriba
    │       └ <Composer/>       <textarea keyBindings=[invertidos]/>  (oculto si no hay chat abierto)
    ├ <SearchOverlay/>          reemplaza el cuerpo cuando mode==="search"
    ├ <Help/>                   reemplaza el cuerpo cuando mode==="help" (incluye ruta del log, CA-16.3)
    └ <Footer/>                 hints de teclas o toast efímero ≤3 s (CA-19.5)
```

### 7.2 Layout por ancho (RNF-1, CA-19.4)

| Modo | Ancho | Disposición |
|---|---|---|
| `wide` | ≥ 100 | header 3 · bandeja 40% / conversación 60% · footer 1 |
| `compact` | 72–99 | header 3 · bandeja 34 cols fijas / conversación resto · footer 1. Los tabs se mudan al `title` del panel de la bandeja para no romper el header a 80 cols. |
| `mini` | 60–71 | **un panel por vez**: bandeja, `⏎` entra a la conversación, `Esc` vuelve. Header 3 · cuerpo · footer 1 |
| — | < 60 cols o < 15 filas | `<TooSmall/>` (RNF-2) |

A 80×24 (el caso de RNF-1) el modo es `compact`: 3 + 20 + 1 = 24 filas, bandeja 34 / conversación 44.
Verificable a ojo con `grim` + Read.

### 7.3 Teclado

Un solo `useKeyboard` en `App.tsx` que rutea por `mode` (patrón de miscosas). **Orden importante:**
las combinaciones con `Shift` se evalúan **antes** que las teclas peladas.

| Tecla | Modo | Acción | CA |
|---|---|---|---|
| *(escribir)* | browse | filtra la bandeja (buscador siempre activo) | 5.1, 5.2 |
| `↑`/`↓`, `Ctrl-K`/`Ctrl-J` | browse | mover selección | 5.3 |
| `PgUp`/`PgDn`, `Home`/`End` | browse | saltos en la lista | 5.3 |
| `Shift-↑`/`Shift-↓` | browse | scroll fino de la conversación | 6.5, 6.6 |
| `Shift-PgUp`/`Shift-PgDn` | browse | media página de la conversación | 6.5 |
| `Esc` | browse | limpiar búsqueda | 5.4 |
| `Tab` | browse | ciclar Todos / No leídos / Grupos | 5.5 |
| `⏎` | browse | abrir chat (y marcarlo leído) | 6.1, 11.1 |
| `Ctrl-E` | browse | enfocar el campo de redacción | 8.1 |
| `Ctrl-L` | browse | marcar leído sin abrir | 11.5 |
| `Ctrl-G` | browse | búsqueda global | 12.1 |
| `Ctrl-R` | browse | reconectar ya | 15.5 |
| `Ctrl-Y` | browse | reintentar el último envío fallado | 9.3 |
| `?` (buscador vacío) | browse | ayuda | 16.3, 19.3 |
| `⏎` | compose | **enviar** (binding invertido, V6) | 8.2 |
| `Alt-⏎` | compose | salto de línea | 8.4 |
| `Esc` | compose | volver a la bandeja conservando el borrador | 8.5 |
| `↑`/`↓`, `⏎`, `Esc` | search | mover / abrir en el mensaje / volver al estado previo | 12.3, 12.8 |
| `Tab` | login | alternar QR ↔ código | 2.6 |
| `Ctrl-R` | login | pedir código nuevo | 2.5 |
| `Esc` / `?` | help | cerrar | 19.3 |
| `Ctrl-C` / `Ctrl-Q` | todos | salida ordenada | 17.1 |

**Por qué esas teclas y no otras.** El `<input>`/`<textarea>` de OpenTUI consume para edición
`Ctrl-A/E/W/K/U/D/F/B`, `Ctrl-←/→`, `Ctrl-Backspace/Delete`, `Ctrl--`, `Ctrl-.`. Los comandos elegidos
(`Ctrl-E`, `Ctrl-L`, `Ctrl-G`, `Ctrl-R`, `Ctrl-Y`) o no colisionan o colisionan de forma inocua (mover
el cursor del buscador). **Prohibido** `Ctrl-M` (= `⏎`), `Ctrl-I` (= `Tab`), `Ctrl-[` (= `Esc`) y
`Ctrl-H` (= backspace): son el mismo byte y romperían la navegación. `Ctrl-K`/`Ctrl-J` funcionan
gracias al protocolo de teclado kitty (Ghostty lo soporta); las flechas son el camino portable y
siempre están.

### 7.4 Gotchas de OpenTUI que se heredan (no volver a descubrirlos)

1. **Filas de lista con `wrapMode="none"`** y `height={1}`: un evento de mouse re-mide el `<text>` y
   el wrap rompe el clip (miscosas/README §Mouse). Aplica a `Inbox.tsx` y a las filas de
   `SearchOverlay.tsx` (CA-4.6, CA-19.7). **No** aplica a `MessageRow.tsx`, donde el wrap por palabra
   es lo correcto.
2. **Nada de `Ctrl-<letra>` para scrollear**: el `<input>` también recibe la tecla. Por eso el scroll
   de la conversación va con `Shift` (CA-6.6).
3. **`PRAGMA busy_timeout`** en la SQLite, siempre.
4. **Animaciones en su propio componente** (`Brand.tsx`): su `setInterval` re-renderiza solo la marca,
   no la lista.
5. **El detalle/conversación es un `<scrollbox>` nativo**, que además responde a la rueda.
6. **Borradores y `initialValue`**: el `<textarea>` toma `initialValue` una sola vez. Para restaurar el
   borrador al volver a un chat hay que remontarlo con `key={chatJid}` (CA-8.6).

---

## 8. Casos borde y manejo de fallas

### 8.1 Terminal

- **Redimensionar** (CA-19.4): todo el layout es Yoga (flex) + `useTerminalDimensions`; no hay medidas
  cacheadas fuera de `listHeight`, que se recalcula por render. El chat seleccionado se guarda por
  **jid**, así que sobrevive a cualquier re-maquetado.
- **Muy chica** (RNF-2): `<TooSmall/>` a pantalla completa, con el tamaño actual y el mínimo. Se
  recupera sola porque es un render condicional, no un estado.

### 8.2 QR que no entra — gap del requirements (⚠️ leerlo)

El umbral de CA-1.5/CA-2.1 (36×69) está calculado para el payload actual de WhatsApp (277 chars →
QR versión 12 → 67×34 en half-blocks). **Si WhatsApp alarga el payload, el umbral queda corto**:
medido, 300 chars → 71 columnas. El diseño lo cubre chequeando la matriz real además del umbral
(D10), pero conviene saber que el "36×69" del requirements es un valor de hoy, no una invariante.

### 8.3 Concurrencia y orden

- **Socket viejo emitiendo**: guard `s !== current` en los cuatro handlers (CA-15.6, CA-3.3).
- **Dos sockets a la vez**: `connect()` aborta si `current !== null || connecting` (CA-15.7, RNF-11).
- **Eco vs. confirmación de envío**: ambos pasan por la misma cola serializada, y el índice único
  cierra la carrera aunque el orden se invirtiera (CA-9.4).
- **Marcar leído mientras entra un mensaje al mismo chat**: `clearUnread` y `bumpUnread` ocurren dentro
  de la misma transacción del chunk; con el chat abierto, el ingest **nunca** hace `bumpUnread`
  (CA-11.7).
- **Dos instancias**: pidfile + `kill(pid, 0)` + verificación de `/proc/<pid>/cmdline` (evita falsos
  positivos por reuso de PID). Marca huérfana ⇒ se borra y se arranca normal (CA-18.3).

### 8.4 Datos

- **Mensaje sin chat** (llega un upsert de un jid nuevo): el `upsertChat` va **antes** del
  `insertMessage` en la misma transacción; si no, la FK aborta (verificado en V8).
- **Timestamp ausente o 0**: se usa `now`, así el chat no se va al fondo de la bandeja.
- **Metadato de adjunto faltante** (CA-7.3): `fmtDuration(undefined) === ""` y el label se arma por
  concatenación condicional. Nunca puede salir `undefined`/`NaN` porque el label se construye en
  `lib/placeholder.ts` (puro, con tests que cubren exactamente ese caso).
- **Tipo desconocido** (CA-7.5): `kind: "unsupported"`, `body: ""`, se persiste igual.
- **Revoke** (CA-6.9): llega como `messages.update` con `protocolMessage.type === REVOKE`;
  `revokeMessage()` pone `kind='revoked'` y `body=''` — el trigger `AFTER UPDATE OF body` lo saca del
  índice FTS, que es lo correcto (un mensaje borrado no debería seguir apareciendo en búsquedas).
- **Base corrupta** (CA-13.6): `quick_check` en el arranque ⇒ `<ErrorScreen>` con ruta y motivo,
  `exit(2)`.

### 8.5 Recibos de lectura

- Habilitados por config (`readReceipts: true` por default, CA-11.2). Deshabilitados ⇒ solo local,
  cero llamadas a WhatsApp (CA-11.3).
- El envío del recibo es **best effort**: `sock.readMessages(keys)` en un `catch` que loguea y sigue.
  El chat queda leído localmente pase lo que pase (CA-11.4).
- Sin conexión no se manda nada y tampoco se encola: el `last_read_id` local ya refleja la verdad.
- Otro dispositivo marca leído ⇒ `chats.update` con `unreadCount` ⇒ `setUnread(jid, n)` (CA-11.6).

### 8.6 `getMessage` y los reenvíos

Baileys pide `getMessage(key)` para poder re-cifrar un mensaje propio cuando un peer manda un retry
receipt. No guardamos el proto en la base (inflaría la base y no aporta a la UI). Solución: `sentCache`,
un `Map` acotado a los últimos **200** mensajes propios, en memoria. Cubre el caso real (el retry llega
segundos después del envío). Fuera de esa ventana, `getMessage` devuelve `undefined` y ese mensaje
puntual no se re-entrega — riesgo aceptado y documentado.

### 8.7 Validaciones de entrada

- Teléfono para el pairing: solo dígitos, 8–15 (CA-2.2).
- Texto a enviar: `trim()` no vacío (CA-8.3); sin tope de largo propio (lo pone WhatsApp).
- Query de búsqueda: `buildFtsQuery` sanitiza y acota a 200 chars / 8 términos (CA-12.5).

---

## 9. Riesgos y mitigaciones

| # | Riesgo | Impacto | Mitigación |
|---|---|---|---|
| R1 | `dlopen("libc.so.6")` falla (otra libc, FFI deshabilitado) y los warnings de `ws` aparecen sobre el render | Alto (RNF-4) | El wrapper de `~/.local/bin` redirige `2>>` al mismo log: la pantalla queda limpia igual. `redirectStderrTo` devuelve `false` y se loguea, nunca lanza |
| R2 | Alternar de código a QR podría dejar de emitir `qr` sobre el mismo socket (no verificado con rc14) | Medio (CA-2.6) | Al volver a QR, si en 10 s no llegó ningún `qr`, se recicla el socket (`end()` + `connect()`), que es el mismo camino ya probado del backoff. Verificarlo es la **primera** prueba manual de la tarea de login |
| R3 | `bun:sqlite` es síncrono: una escritura grande congela el render y el teclado | Alto (RNF-5/6) | Chunking a 400 filas por transacción + `setTimeout(0)` entre chunks (D4). Test de carga: 5.000 mensajes sintéticos midiendo la latencia máxima de un tick |
| R4 | Ráfaga de `messages.upsert` en el sync inicial ⇒ tormenta de renders | Alto (RNF-5) | Notificación coalescida a ≤30 fps (D3) + test `store.test.ts`: 500 upserts ⇒ 1 notify |
| R5 | `Shift-PgUp` lo intercepta tmux (copy-mode) antes que la app | Medio (CA-6.5) | Documentado en el README con el `unbind -n S-PPage`; `Shift-↑/↓` cubre el caso a mano y siempre llega |
| R6 | `Ctrl-J`/`Ctrl-K` dependen del protocolo de teclado kitty; en una terminal legacy `Ctrl-J` == `⏎` | Bajo | Las flechas son el camino principal y portable; el README lo aclara |
| R7 | Identidades LID (`@lid`) vs PN (`@s.whatsapp.net`): el mismo humano podría aparecer como dos chats | Medio | v1 normaliza con `jidNormalizedUser` y **no** fusiona identidades. Documentado como limitación conocida; si aparece en la práctica, la fusión es una historia nueva (hay `lid-mapping.update` para hacerlo bien) |
| R8 | Ban / rate limit de WhatsApp por ritmo de envío | Alto (cuenta real de Gon) | Techo conservador de RNF-8 (1/s, 20/min), serializado, sin ráfagas. `markOnlineOnConnect:false` y sin presencia para parecer lo menos "bot" posible |
| R9 | El eco/re-sync duplica mensajes o reabre no leídos | Medio (CA-14.4) | Índice único + "solo cuenta si `inserted`" (§6.2). Cubierto por `db.test.ts` |
| R10 | Base sin cifrar con todo el historial en claro | Medio (RNF-12) | `umask 0o077`, dir 0700, archivos 0600, **y aviso explícito en el README** (lo pide RNF-12) |
| R11 | Baileys 7.0.0-rc14 es un release candidate: puede romper entre versiones | Medio | Versión **pineada exacta** en `package.json` (sin `^`), igual que en el spike |
| R12 | `messagesAround` + `scrollChildIntoView` es la parte más frágil de la UI (anclaje del scroll al prepender) | Medio (CA-6.8/12.3) | Una sola implementación (`loadWindow`) para los dos casos; ajuste de `scrollTop += Δ scrollHeight` en un `useLayoutEffect`; si pelea, ver §10 recorte 2 |
| R13 | Migración futura del esquema sin mecanismo | Bajo (CA-13.5) | `meta.schema_version` + array `MIGRATIONS` ya existen en v1, aunque vacío |

**Rollback.** No hay servicio ni datos compartidos: revertir es volver a un commit anterior. La base es
compatible hacia adelante por diseño (todo `IF NOT EXISTS` + `schema_version`); una versión vieja
corriendo sobre una base nueva ignora columnas que no conoce. Sin feature flags: el único flag real es
`--no-splash` (CA-13.7).

---

## 10. Recomendaciones de recorte

Cosas del requirements que, a mi juicio, **cuestan más de lo que aportan**. No las saco por mi cuenta;
las dejo señaladas para que el usuario decida antes de que el planner las convierta en tareas.

1. **`chats_fts` (parte de CA-12.1: "y sobre los nombres de chat").** Es casi redundante con el filtro
   de la bandeja (CA-5.2), que ya busca por nombre y número sin acentos. Cuesta una tabla virtual y
   tres triggers. *Recomendación:* si hay que recortar algo, esto primero — el resultado para el
   usuario es idéntico (escribe el nombre en la bandeja y lo encuentra).
2. **Paginado infinito hacia arriba (CA-6.8).** El anclaje del scroll al prepender es el punto más
   frágil de toda la UI (R12) y en v1 **no hay sync de historial viejo**: lo que hay es lo que WhatsApp
   entregó. *Recomendación:* arrancar con una ventana fija más grande (500 mensajes) y sin carga
   incremental; si un chat supera eso y molesta, agregar el paginado después con el `loadWindow` ya
   escrito para CA-12.3.
3. **Pantalla de configuración.** El requirements pide que los recibos de lectura sean configurables
   (CA-11.3) pero no pide UI para eso. *Recomendación:* `config.json` a mano, sin pantalla de settings
   (a diferencia de miscosas y su `Ctrl-T`). Ahorra una pantalla entera.
4. **Búsqueda por nombre de archivo de adjunto.** Hoy el FTS indexa **solo** `body`, así que buscar
   `presupuesto.pdf` no encuentra el documento (el nombre vive en `attachment`). No lo pide ningún CA;
   lo anoto para que no sorprenda. Agregarlo después es una columna generada + un `rebuild` del índice.
5. **Filtro `Grupos` (CA-5.5).** Es la única de las tres pestañas que no responde a una necesidad
   concreta (`Todos` y `No leídos` sí). Cuesta poco, pero si el header aprieta a 80 columnas, es la
   primera que sacaría.

---

## 11. Preguntas abiertas

1. **Recibos de lectura por default.** El diseño asume `readReceipts: true` (comportamiento de un
   cliente real). Si Gon prefiere leer invisible, se invierte el default en `config.json` — cero
   cambios de código. (Es la pregunta abierta 2 del requirements; el diseño la deja como un flag,
   no como una decisión de arquitectura.)
2. **Ventana inicial de conversación.** 200 mensajes (CA-6.8) vs. la propuesta de recorte 2
   (500 sin paginado). Afecta directamente cuántas tareas salen de la conversación.
3. **Chats LID.** Si al probar aparecen contactos duplicados (`@lid` y `@s.whatsapp.net`), hay que
   decidir si v1 los fusiona. Hoy el diseño dice que no (R7).
4. **`--no-splash` y CA-13.1.** El "≤1 s hasta la bandeja" se mide con `--no-splash`; con splash, la
   base se carga **detrás** de la animación (la bandeja ya está lista cuando termina). Si se quiere
   medir el número con splash, hay que bajar la animación de 1,5 s a ~0,8 s.

---

## 12. Trazabilidad — criterio → dónde vive

### Área A — Vinculación y sesión

| CA | Dónde se resuelve |
|---|---|
| 1.1 | `index.tsx` (creds en disco) → `link.phase="need-link"` → `ui/Login.tsx` |
| 1.2 | `wa/socket.ts` `fetchLatestBaileysVersion()` antes de `makeWASocket` |
| 1.3 | `wa/socket.ts` try/catch → `log.warn("wa.version.fallback")` + sigue con la bundleada |
| 1.4 | `wa/socket.ts` flag `sawQr` + close 405 ⇒ `link.phase="failed"` con motivo |
| 1.5 | `wa/qr.ts` (matriz) + `ui/QrView.tsx` + `fitsQr()` (D10) |
| 1.6 | `<QrView key={qr}>` sobre `link.qr` (re-render, no impresión) |
| 1.7 | `creds.update`→`saveCreds` + `open` ⇒ `phase="linked"` |
| 1.8 | `wa/socket.ts` close 515 ⇒ respawn inmediato, sin sumar backoff |
| 1.9 | `link.phase` pintado en `ui/Login.tsx` |
| 2.1 | `fitsQr(w,h,qr)` + panel "no entra" con tamaño actual vs requerido |
| 2.2 | `ui/PairingView.tsx` validación 8–15 dígitos |
| 2.3 | `commands.requestPairing` → `sock.requestPairingCode` → `XXXX-XXXX` |
| 2.4 | catch ⇒ `phase="failed"` + input reutilizable |
| 2.5 | `pairingRequestedAt` + 120 s ⇒ hint `Ctrl-R` |
| 2.6 | `Tab` ⇒ `chooseLinkMethod` + `methodForced=true` (sin tocar el socket, D11) |
| 2.7 | Mismo camino de `open` que 1.7 |
| 3.1 | close 401/500 ⇒ `wipeCreds()` + `phase="need-link"` + motivo |
| 3.2 | `wipeCreds()` borra **solo** `credsDir` |
| 3.3 | Guard `s !== current` en `creds.update` (D5) |
| 3.4 | Evento `qr` con `flow==="reconnect"` ⇒ wipe + relink |
| 3.5 | La base no se toca en el relink; el sync mergea por índice único |

### Área B — Bandeja

| CA | Dónde |
|---|---|
| 4.1 | `repo.listChats` + `ui/Inbox.tsx` (nombre, preview, fecha relativa, badge) |
| 4.2 | `ORDER BY last_message_at DESC` (`idx_chats_activity`) |
| 4.3 | `markDirty("inbox")` en el ingest ⇒ flush coalescido |
| 4.4 | Selección guardada por **jid**, re-buscada por índice tras cada cambio |
| 4.5 | `previewFor()` guardado en `chats.last_preview` |
| 4.6 | Fila `height={1}` + `wrapMode="none"` + `clipText` |
| 4.7 | Estado vacío en `Inbox.tsx` ("esperando sincronización inicial") |
| 4.8 | `chats.is_group` ⇒ glifo + color distinto |
| 5.1 | `<SearchBar focused={mode==="browse"}/>` siempre enfocado |
| 5.2 | Filtro local sobre `inbox.chats` con `fold()` (`lib/fmt.ts`) |
| 5.3 | `useKeyboard` browse + efecto de viewport (patrón miscosas) |
| 5.4 | `Esc` ⇒ `setQuery("")` |
| 5.5 | `Tab` ⇒ filtro + contadores de `repo.countsByFilter()` |
| 5.6 | `onMouseDown` con detector de doble click < 350 ms |
| 5.7 | `onMouseScroll` en la bandeja (mueve selección) y en el scrollbox (scrollea) |
| 5.8 | `onMouseDown` en cada tab |

### Área C — Conversación

| CA | Dónde |
|---|---|
| 6.1 | `repo.lastMessages(jid,200)` asc + `stickyStart="bottom"` |
| 6.2 | `ui/MessageRow.tsx` (hora, autor, cuerpo; alineación/color por `fromMe`) |
| 6.3 | `sender_name` mostrado si `chat.isGroup && !fromMe` |
| 6.4 | `stickyScroll` (se despega solo si el usuario scrolleó) + badge "↓ N nuevos" |
| 6.5 | `Shift-↑/↓` `scrollBy(±2)`; `Shift-PgUp/PgDn` media página |
| 6.6 | Regla explícita en §7.3: ningún `Ctrl-<letra>` para scroll |
| 6.7 | `useEffect` sobre `convo.jid` ⇒ `scrollTop = scrollHeight` |
| 6.8 | `repo.messagesBefore` disparado al llegar arriba (ver recorte 2) |
| 6.9 | `repo.revokeMessage` + label `🚫 mensaje eliminado` |
| 7.1 | `lib/placeholder.ts` (tabla de labels por `kind`) |
| 7.2 | `body` (caption) renderizado debajo del label |
| 7.3 | `fmtDuration`/`safeName` devuelven `""`; tests dedicados |
| 7.4 | En ningún lado se llama `downloadMediaMessage` ni se escribe binario (regla + revisión) |
| 7.5 | `kind:"unsupported"` persistido, label `❔ mensaje no soportado` |

### Área D — Envío

| CA | Dónde |
|---|---|
| 8.1 | `Ctrl-E` enfoca `<Composer/>` (distinta de la del buscador) |
| 8.2 | `keyBindings` invertidos: `return → submit` (V6) |
| 8.3 | `trim()` vacío ⇒ no-op |
| 8.4 | `keyBindings`: `return+meta → newline`; el `\n` viaja en el texto |
| 8.5 | `Esc` en compose ⇒ `mode="browse"` y el borrador queda en `drafts.get(jid)` |
| 8.6 | `drafts: Map<jid,string>` en el slice `ui` (solo memoria) + `key={chatJid}` en el textarea |
| 8.7 | `commands.send` chequea `wa.isOpen()`: rechaza, avisa, **no** encola |
| 8.8 | `sendMessage` con jid de grupo funciona igual; sin ramas |
| 9.1 | INSERT `pending` + `markDirty` antes de tocar la red |
| 9.2 | `setMessageStatus("sent")` (+ `setMessageWaId` si difiere) |
| 9.3 | 3 intentos ⇒ `failed` + `error` + `Ctrl-Y` |
| 9.4 | Índice único `(chat_jid, wa_id)` + id pre-generado (D7) |
| 9.5 | `fromMe: true` desconocido ⇒ INSERT normal como propio |

### Área E — No leídos

| CA | Dónde |
|---|---|
| 10.1 | `bumpUnread(+1)` solo si `inserted && !fromMe && jid !== openChat` |
| 10.2 | Badge + resaltado en `ui/Inbox.tsx` |
| 10.3 | `counts.unread` en `<Header/>` |
| 10.4 | Filtro `No leídos` sobre `unreadCount > 0` |
| 10.5 | `unread_count` persistido; `bootstrap()` lo lee antes de conectar |
| 11.1 | `commands.openChat` ⇒ `clearUnread(jid, maxId)` |
| 11.2 | `wa/read.ts` `sock.readMessages(keys)` desde `last_read_id` |
| 11.3 | `config.readReceipts === false` ⇒ solo local |
| 11.4 | `catch` que loguea y sigue |
| 11.5 | `Ctrl-L` ⇒ `commands.markRead(jid)` (mismo camino) |
| 11.6 | `chats.update.unreadCount` ⇒ `setUnread` |
| 11.7 | El ingest no incrementa si el chat está abierto; marca leído al vuelo |

### Área F — Búsqueda

| CA | Dónde |
|---|---|
| 12.1 | `repo.searchMessages` + `repo.searchChats` (FTS5) |
| 12.2 | `snippet()` con `char(1)/char(2)` + `parseSnippet` ⇒ spans resaltados |
| 12.3 | `openChat(jid,{anchorId})` + `messagesAround` + `scrollChildIntoView` + marca visual |
| 12.4 | Estado explícito "sin coincidencias"; la lista previa se descarta |
| 12.5 | `buildFtsQuery` (entrecomillado por token) |
| 12.6 | `tokenize='unicode61 remove_diacritics 2'` (verificado, V8) |
| 12.7 | Triggers `messages_ai` (indexa en el INSERT) |
| 12.8 | Snapshot `{selectedJid, filter, query}` guardado al abrir el overlay |

### Área G — Persistencia y arranque

| CA | Dónde |
|---|---|
| 13.1 | `bootstrap(repo)` sincrónico antes del primer render; la red arranca después |
| 13.2 | Todas las lecturas salen del repo, no del socket |
| 13.3 | `<ConnBadge/>` + `commands.send` deshabilitado |
| 13.4 | `db/schema.ts` `SCHEMA_SQL` con todo `IF NOT EXISTS` |
| 13.5 | `meta.schema_version` + `MIGRATIONS[]` idempotentes |
| 13.6 | `quick_check` ⇒ `DbCorruptError` ⇒ `<ErrorScreen/>` + `exit(2)` |
| 13.7 | `process.argv.includes("--no-splash")` |
| 14.1 | `insertMessage` con las 8 columnas del contrato |
| 14.2 | `ON CONFLICT(chat_jid, wa_id) DO NOTHING` |
| 14.3 | Todo se lee de la misma base al arrancar |
| 14.4 | "solo cuenta si `inserted`" (§6.2) |
| 14.5 | `boot/paths.ts` (XDG + mkdir recursivo) |
| 14.6 | `process.umask(0o077)` + `chmod 0700` de los dirs raíz |
| 14.7 | `Logger` con `Fields` acotado a escalares + regla: jamás `body`/`creds` |

### Área H — Conexión

| CA | Dónde |
|---|---|
| 15.1 | `conn.state` con 5 valores (⊃ los 3 pedidos) en `<ConnBadge/>` |
| 15.2 | `lib/backoff.ts` `reconnectDelayMs` (2 s → 60 s) |
| 15.3 | `attempt` + `nextAttemptAt` en el header; la TUI nunca se bloquea |
| 15.4 | `open` ⇒ `attempt=0` + envío habilitado; los mensajes del corte entran por 6.2 |
| 15.5 | `Ctrl-R` ⇒ `commands.reconnectNow()` |
| 15.6 | Guard `s !== current` (D5) |
| 15.7 | `connect()` aborta si ya hay socket o hay uno arrancando |
| 15.8 | `markOnlineOnConnect: false` |
| 16.1 | `boot/log.ts` con timestamp por línea |
| 16.2 | `pino({level:"silent"})` + `dup2(fd2)` + toasts como único canal en pantalla |
| 16.3 | `<Help/>` muestra `logger.path` |
| 16.4 | Rotación a `.log.1` al superar 5 MB |

### Área I — Ciclo de vida

| CA | Dónde |
|---|---|
| 17.1 | `boot/shutdown.ts` (pasos 1–9 de §6.6); `end()`, nunca `logout()` |
| 17.2 | `renderer.destroy()` |
| 17.3 | `exit(0)` |
| 17.4 | `Promise.race` con `sleep(2000)` |
| 17.5 | Handlers de `SIGINT`/`SIGTERM`/`SIGHUP` al mismo `shutdown` |
| 17.6 | El cierre no toca `credsDir` ni el `.sqlite` |
| 17.7 | Envío en vuelo pasa a `failed` al vencer los 2 s |
| 18.1 | `acquireLock(lockPath)` en el arranque |
| 18.2 | `<ErrorScreen/>` de una línea + `exit(3)` antes de abrir socket |
| 18.3 | `kill(pid,0)` ESRCH o `/proc/<pid>/cmdline` que no matchea ⇒ marca huérfana |
| 18.4 | `lock.release()` en el paso 8 del shutdown + `process.on("exit")` |

### Área J — UX

| CA | Dónde |
|---|---|
| 19.1 | `ui/App.tsx` layout de dos paneles + `<Header/>` + `<Footer/>` |
| 19.2 | `ui/Splash.tsx` ≤1,5 s, cualquier tecla saltea |
| 19.3 | `ui/Help.tsx`, cierra con `Esc` |
| 19.4 | Flex + `useTerminalDimensions`; selección por jid |
| 19.5 | `store.toast()` + auto-limpieza a los 2,6 s |
| 19.6 | `install.sh` genera `~/.local/bin/wacosas` (+ alias corto `wc`) |
| 19.7 | `wrapMode="none"` en todas las filas de lista |

### Restricciones no funcionales

| RNF | Dónde |
|---|---|
| 1 | Layout `compact` (§7.2), verificado a 80×24 |
| 2 | `<TooSmall/>` bajo 60×15, recuperación automática |
| 3 | El pairing es una pantalla de primera clase, elegida automáticamente por tamaño (D11) |
| 4 | `dup2(fd2)` (D9) + `2>>` en el wrapper |
| 5 | Handlers O(1) + cola + chunking de 400 filas + flush coalescido (D3/D4) |
| 6 | Índices `idx_chats_activity` / `idx_messages_chatts`; la selección es estado React puro |
| 7 | Debounce 120 ms + FTS5 con bm25 y `LIMIT 200` |
| 8 | `lib/ratelimit.ts` (1/s, 20/min) + cola serializada (D8) |
| 9 | `lib/backoff.ts` `sendRetryDelayMs`, tope 3 intentos |
| 10 | `fetchLatestBaileysVersion()` en cada arranque |
| 11 | Guard de socket único (D5) + lock de instancia (`boot/lock.ts`) |
| 12 | `umask 0o077` + 0700/0600 + aviso en el README |
| 13 | `bun run`; `bun:sqlite` y `bun:ffi` hacen imposible correrlo en Node (y está bien) |
| 14 | `src/index.tsx` levanta TUI y WhatsApp en el mismo proceso |

---

## 13. Plan de tareas sugerido (17 tareas, verificables una por una)

Pensado para que el planner lo corte sin re-decidir arquitectura. Cada tarea tiene su criterio de
verificación.

| # | Tarea | Verificación |
|---|---|---|
| 1 | Andamio: `package.json`, `tsconfig.json`, `.gitignore`, `README` inicial, `install.sh` + wrapper | `bun run src/index.tsx --version` imprime la versión y sale 0; `wacosas` existe en `~/.local/bin` |
| 2 | `boot/paths.ts` + `umask` + creación de dirs con permisos | test: dirs 0700, archivos 0600; respeta `XDG_*` |
| 3 | `boot/stderr.ts` (dup2) + `boot/log.ts` (rotación) | script que crea un `ws` y verifica que el warning **no** sale por terminal y **sí** está en el log; log > 5 MB rota a `.1` |
| 4 | `boot/lock.ts` | dos procesos ⇒ el segundo sale ≠0 con una línea; matar el primero con `-9` y arrancar ⇒ funciona |
| 5 | `db/schema.ts` + `db/open.ts` + `db/repo.ts` | `db.test.ts`: DDL x2, dedupe, FK, FTS con acentos, contadores, `quick_check` |
| 6 | `lib/` puros (`fmt`, `fts`, `placeholder`, `backoff`, `ratelimit`) | `bun test` verde, incluidos los casos de CA-7.3 y CA-12.5 |
| 7 | `wa/map.ts` + fixtures de cada tipo de mensaje | `map.test.ts`: texto, caption, cada adjunto, revoke, desconocido, grupo |
| 8 | `state/store.ts` + `hooks.ts` | `store.test.ts`: 500 `markDirty` ⇒ 1 notify; snapshots estables entre flushes |
| 9 | `wa/ingest.ts` | test de carga: 5.000 mensajes, ningún tick bloquea > 20 ms, todo persistido una sola vez |
| 10 | `wa/socket.ts` (ciclo, guards, backoff, versión) | smoke real: arranca, emite QR, resetea backoff; con creds borradas a mano ⇒ vuelve a vinculación |
| 11 | UI base: `index.tsx`, `App.tsx`, `theme`, `Brand`, `Splash`, `Header`, `Footer`, `TooSmall`, `ErrorScreen`, `Help` | arranca a 80×24 sin layout roto; achicar a 50 cols ⇒ `<TooSmall/>`; agrandar ⇒ vuelve |
| 12 | `ui/Login.tsx` + `wa/qr.ts` + `QrView` + `PairingView` | `qr.test.ts` (67×34 para 277 chars); vinculación real por QR y por código |
| 13 | `ui/Inbox.tsx` + filtros + buscador + mouse | bandeja con datos reales; `Tab` cicla; doble click abre; cursor estable al entrar un mensaje |
| 14 | `ui/Conversation.tsx` + `MessageRow` + scroll | abre al final; `Shift-↑↓` scrollea; mensaje entrante no roba la posición si estabas arriba |
| 15 | `ui/Composer.tsx` + `wa/send.ts` (cola, rate limit, reintentos) | `⏎` envía y `Alt-⏎` salta línea (V6); 5 mensajes seguidos salen espaciados 1 s; sin conexión rechaza y conserva el texto |
| 16 | `wa/read.ts` (leídos + recibos) + contadores | abrir un chat pone el contador en 0 y persiste; con `readReceipts:false` no sale ninguna llamada |
| 17 | `ui/SearchOverlay.tsx` + `boot/shutdown.ts` + README final + trazabilidad | buscar sobre 50k mensajes < 200 ms; `Ctrl-C` deja la terminal usable sin `reset` |
