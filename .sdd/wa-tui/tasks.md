# Tasks — wacosas (cliente de WhatsApp en TUI)

> Plan de implementación para `.sdd/wa-tui/requirements.md` + `.sdd/wa-tui/design.md`.
> Base: el plan sugerido de **design §13**, ajustado con las decisiones del orquestador (abajo).
> Rutas relativas a la raíz del repo `/home/gon/projects/wacosas` (hoy vacío, solo `git init`).
>
> **Decisiones ya cerradas — no se re-abren en implementación:**
> - **R1 aceptado** — no existe `chats_fts` ni sus triggers. El FTS indexa **solo** `messages.body`.
>   La mitad "y sobre los nombres de chat" de **CA-12.1** la cubre el filtro de bandeja (CA-5.2,
>   `fold()` sobre nombre y número). La trazabilidad de §12 se corrige en la tarea 18.
> - **R2 aceptado** — **sin paginado incremental hacia arriba**. Ventana fija de **500 mensajes** al
>   abrir un chat (reemplaza los 200 de CA-6.8). `loadWindow`/`messagesAround` se implementa igual
>   porque lo necesita CA-12.3. La mitad recortada de CA-6.8 se documenta en el README.
> - **R3 aceptado** — no hay pantalla de configuración: `readReceipts` y compañía se editan a mano en
>   `config.json`.
> - **R4 aceptado** — el FTS no indexa nombres de archivo de adjuntos.
> - **R5 rechazado** — el filtro `Grupos` de la bandeja (CA-5.5) **se queda**.
> - **P1** — `readReceipts: true` es el default.
> - **P3** — v1 **no** fusiona identidades `@lid` / `@s.whatsapp.net`; si aparecen duplicados se
>   documentan como limitación conocida (R7).
> - **P4** — CA-13.1 (≤ 1 s hasta la bandeja) se mide con `--no-splash`; la animación queda en 1,5 s.
>
> **Pruebas manuales con la cuenta real de WhatsApp:** solo las tareas **11** y **17**. Están
> agrupadas a propósito para pedirle el teléfono al usuario dos veces, no cinco.

---

- [x] 1. Armar el andamio del repo, las rutas XDG y el instalador
  - covers: RNF-13, RNF-14 (arranque de un solo comando), CA-13.7 (parseo del flag), CA-14.5,
    CA-14.6, CA-19.6, RNF-12 (permisos + aviso en el README)
  - files: `package.json`, `tsconfig.json`, `.gitignore`, `README.md` (esqueleto), `install.sh`,
    `src/index.tsx` (entry mínimo: `--version` / `--help` / `--no-splash`, todavía sin TUI),
    `src/boot/paths.ts`, `test/paths.test.ts`
  - detalle: deps **exactas** de design §3 (`baileys` pineado sin `^`, D12: cero deps extra);
    `process.umask(0o077)` como primera sentencia útil; `resolvePaths()` con XDG + `mkdir -p` +
    `chmod 0700` de los dos dirs raíz; `install.sh` idempotente sin sudo que genera
    `~/.local/bin/wacosas` (+ alias `wc`) con `2>>"$STATE_DIR/wacosas.log"` (defensa en profundidad
    de RNF-4); el README ya arranca con el aviso de que **la base no se cifra**.
  - done when: `bun install && bun run src/index.tsx --version` imprime la versión y sale **0**;
    `bun test test/paths.test.ts` verde (respeta `XDG_DATA_HOME`/`XDG_STATE_HOME`, crea los dirs,
    `stat -c %a` da `700` en los dirs y `600` en un archivo creado por el proceso); correr
    `./install.sh` dos veces seguidas no rompe nada y `~/.local/bin/wacosas` existe y es ejecutable.

- [x] 2. Redirigir fd 2 con `dup2` y montar el logger con rotación
  - covers: RNF-4, CA-16.1, CA-16.2 (parte de "nada de warnings sobre el render"), CA-16.4, CA-14.7
  - files: `src/boot/stderr.ts`, `src/boot/log.ts`, `src/index.tsx` (llamar a `redirectStderrTo()`
    **antes** de cualquier import de `baileys`/`ws`/OpenTUI), `test/log.test.ts`
  - detalle: `dup2` vía `bun:ffi` sobre `libc.so.6` (D9, verificado V3); si `dlopen` falla devuelve
    `false` y se loguea, **nunca** lanza (R1 del §9). `Fields` acotado a escalares: prohibido pasar
    `body` o creds.
  - done when: un script que abre un WebSocket con `ws` bajo el entry deja la terminal **limpia** y el
    string `ws.WebSocket 'upgrade'` aparece en `$XDG_STATE_HOME/wacosas/wacosas.log`;
    `bun test test/log.test.ts` verde (línea con timestamp; al pasar 5 MB rota a `wacosas.log.1` y
    conserva como máximo un anterior).
  - depends-on: 1

- [x] 2b. Montar el typecheck y cerrar el escape del denylist del logger
  - *(tarea insertada por el orquestador tras las revisiones de 1 y 2 — no venía en el plan original)*
  - covers: CA-14.7 (cierre en runtime, no solo en el tipo) + infraestructura de calidad para 3-18
  - files: `package.json`, `tsconfig.json`, `src/boot/log.ts`, `test/log.test.ts`
  - detalle: **D12 se relee como "cero deps de runtime"** — `typescript` + tipos de Bun entran como
    `devDependencies` y aparece el script `bun run typecheck`. `strict` NO se toca (sigue en `false`
    por decisión del diseño). Además, el denylist de `Fields` hoy solo frena **literales**: un
    `Record<string,string>` con `body` adentro compila y se escribe al log. Se filtra también en
    runtime, case-insensitive, dejando marca de cuántas claves se omitieron.
  - done when: `bun run typecheck` en **verde** (cero errores); `bun test` sigue verde; hay un test
    que reproduce el escape del revisor y verifica que el secreto NO llega al log.
  - depends-on: 2

- [x] 3. Crear la capa de datos: esquema, apertura y repositorio
  - covers: CA-13.4, CA-13.5, CA-13.6, CA-14.1, CA-14.2, CA-14.4, CA-12.6, CA-12.7, CA-4.2, CA-6.1,
    CA-10.5, CA-12.1 (mitad de mensajes), RNF-6 (índices)
  - files: `src/db/schema.ts`, `src/db/open.ts`, `src/db/repo.ts`, `src/db/types.ts`,
    `test/db.test.ts`, `test/fixtures/seed.ts`
  - detalle: DDL de design §4.1 **copiado tal cual salvo el bloque `chats_fts` y sus tres triggers,
    que NO se crean** (R1). PRAGMAs en orden (`WAL`, `busy_timeout=3000`, `foreign_keys=ON`,
    `synchronous=NORMAL`), `migrate()` con `meta.schema_version` + `MIGRATIONS[]` vacío,
    `quick_check` ⇒ `DbCorruptError{path,reason}`. `repo.ts` con **todas** las sentencias preparadas
    del contrato §5.2, con `searchChats` resuelto por `LIKE`/`fold` (no por FTS) y `lastMessages`
    default **500**. `test/fixtures/seed.ts` genera N mensajes sintéticos (se reusa en las tareas 12
    y 16 para RNF-6/RNF-7).
  - done when: `bun test test/db.test.ts` verde cubriendo: `exec(SCHEMA_SQL)` dos veces seguidas es
    no-op; `INSERT` duplicado por `(chat_jid, wa_id)` devuelve `inserted:false`; FK aborta si el chat
    no existe; buscar `manana` encuentra `Mañana`; `UPDATE` de `status` **no** reindexa y `UPDATE` de
    `body` sí; `countsByFilter()` da los tres números; base corrupta a mano ⇒ `DbCorruptError`.
  - depends-on: 1

- [x] 4. Implementar los módulos puros de `lib/` con sus tests
  - covers: CA-7.1, CA-7.3, CA-12.5, CA-5.2 (fold sin acentos ni mayúsculas), CA-4.6 (clip),
    CA-15.2, RNF-8, RNF-9
  - files: `src/lib/fmt.ts`, `src/lib/fts.ts`, `src/lib/placeholder.ts`, `src/lib/backoff.ts`,
    `src/lib/ratelimit.ts`, `test/fmt.test.ts`, `test/fts.test.ts`, `test/placeholder.test.ts`,
    `test/backoff.test.ts`, `test/ratelimit.test.ts`
  - done when: `bun test test/{fmt,fts,placeholder,backoff,ratelimit}.test.ts` verde, con casos
    explícitos para: `buildFtsQuery('hola "mundo" -x*: (a)')` → `"hola"* "mundo"* "x"* "a"*` y query
    vacía → `''`; placeholder sin duración/sin nombre nunca emite `undefined`/`null`/`NaN`;
    `reconnectDelayMs` da 2/4/8/16/32/60/60 s; el limitador respeta 1 s de gap y corta a 20 en 60 s.
  - depends-on: 1

- [x] 5. Implementar `wa/map.ts` (mapeo puro de mensajes) con fixtures de cada tipo
  - covers: CA-14.1, CA-7.1, CA-7.2, CA-7.5, CA-6.9 (detección de revoke), CA-4.5, CA-9.5, CA-4.8
  - files: `src/wa/map.ts`, `test/map.test.ts`, `test/fixtures/messages.ts`
  - detalle: `mapMessage` devuelve `null` (descarta sin persistir) para `status@broadcast`,
    newsletters, `protocolMessage` que no sea revoke, `reactionMessage` y mensajes sin `remoteJid`;
    tipo desconocido ⇒ `kind:"unsupported"` y **se persiste igual**. `resolveChatName` con la
    precedencia de §5.4.
  - ⚠️ **abierto por la revisión de la tarea 4**: `ETIQUETAS` de `src/lib/placeholder.ts` **no tiene
    la clave `system`**, que sí existe en `MessageKind` (design.md:486). Hoy `placeholderFor("system")`
    devuelve `"❔ mensaje no soportado"`, así que un mensaje de sistema se mostraría como "no
    soportado" en vez de su cuerpo. Decidilo acá: lo más probable es `system: ""` (mismo trato que
    `text`, o sea que se muestre el `body`). Además, ahora que `db/types.ts` existe, evaluá angostar
    la firma `placeholderFor(kind: string)` a `MessageKind` — era `string` sólo porque en la tarea 4
    todavía no existía el tipo.
  - done when: `bun test test/map.test.ts` verde con un fixture por caso: texto, texto extendido,
    imagen con caption, audio con y sin `seconds`, documento con y sin `fileName`, sticker,
    ubicación, contacto, revoke, tipo inventado, mensaje de grupo (`sender_jid` = `participant`),
    mensaje propio del eco (`fromMe`), timestamp ausente ⇒ `now`.
  - depends-on: 3, 4

- [x] 6. Implementar el store externo con notificación coalescida
  - covers: RNF-5, CA-4.3 (mecanismo), CA-13.1 (bootstrap sincrónico), CA-19.5 (toast)
  - files: `src/state/store.ts`, `src/state/hooks.ts`, `test/store.test.ts`
  - detalle: slices `link|conn|inbox|convo|search|ui`; `getSnapshot` **cacheado** (misma identidad
    hasta el próximo flush, requisito de `useSyncExternalStore`); flush agendado con
    `setTimeout(flush, max(0, 33 - (now - lastFlush)))` (D3); `bootstrap(repo)` llena inbox+conn de
    forma sincrónica.
  - done when: `bun test test/store.test.ts` verde: 500 `markDirty("inbox")` en el mismo tick ⇒ **1**
    solo `notify`; los listeners de un slice limpio **no** se llaman; dos `getSnapshot` sin flush en
    el medio devuelven la **misma referencia**; con marcado continuo la tasa de notify queda ≤ 31/s.
  - depends-on: 3

- [ ] 7. Implementar la cola de ingest serializada con escritura chunkeada
  - covers: CA-4.3, CA-10.1, CA-11.7, CA-14.2, CA-14.4, CA-12.7, RNF-5, RNF-6
  - files: `src/wa/ingest.ts`, `test/ingest.test.ts`
  - detalle: `push()` es O(1), nunca async, nunca lanza; drenador con `setTimeout(0)`,
    `MAX_ROWS_PER_TICK = 400` dentro de **una** `db.transaction()`, `MAX_QUEUE_JOBS = 10_000`
    (se descartan los `history` más viejos, nunca los `notify`); orden del §6.2: `upsertChat` →
    `insertMessage` → `if (!inserted) continue` → `touchChatActivity` → unread; `drainNow()` para el
    cierre.
  - ⚠️ **abierto por la tarea 5 — el diseño está MAL acá, no lo sigas al pie de la letra**:
    (a) **§5.4 se contradice con §8.4 en el revoke.** Un revoke NO inserta, *actualiza*
    (`repo.revokeMessage`). Si `mapMessage` devolviera fila, el `ON CONFLICT DO NOTHING` se la comería
    y el borrado nunca se aplicaría. Por eso `mapMessage` devuelve `null` para **todo**
    `protocolMessage`, y el ingest tiene que llamar **`isRevoke()`** por separado.
    (b) **El revoke real no tiene la forma de §5.4.** Verificado en el fuente de baileys
    (`lib/Utils/process-message.js:298`): se reemite como **`messages.update`** con `message: null`,
    `messageStubType: REVOKE` y el id de la víctima **ya en `key.id`**. En la rama `msg-updates` hay
    que invocarlo como `isRevoke({ ...u.update, key: u.key })` — **ese orden y no el inverso**: al
    revés, `u.update.key` pisa con el id del *protocolMessage* en vez del de la víctima.
    (b2) **`isRevoke` va en LAS DOS ramas, no sólo en `messages.update`** (lo levantó la revisión de
    la tarea 5). La forma cruda también llega por `messages.upsert` (`Socket/chats.js:918` emite el
    sobre entero, `protocolMessage` incluido) y un revoke del history sync entra como stub por ahí.
    En esa rama `mapMessage` devuelve `null`, así que **si nadie llama `isRevoke` el borrado se
    pierde para siempre** — nadie más produce `kind:'revoked'`.
    (c) **Decidir qué hacer con los sobres sin contenido renderizable** (`messageStubType` de "se unió
    al grupo", `CIPHERTEXT`, `senderKeyDistributionMessage` solo): hoy caen en `unsupported` y **se
    persisten**, así que se quedan con el preview de la bandeja y suman no leídos con un "❔ mensaje
    no soportado". O los filtra el ingest, o `map` pasa a emitir `system`. Hoy `system` no tiene
    productor. (d) Candidato a sumar al descarte: `encReactionMessage`, misma familia que
    `reactionMessage` pero hoy persiste como `unsupported`.
  - done when: `bun test test/ingest.test.ts` verde: 5.000 mensajes sintéticos quedan persistidos una
    sola vez, ningún tick del drenador bloquea más de **20 ms** (medido con `performance.now()`
    alrededor de cada vuelta), re-empujar los mismos 5.000 no inserta nada ni mueve los contadores de
    no leídos, y con `openChatJid` apuntando a un chat sus mensajes entrantes no incrementan unread.
  - depends-on: 3, 5, 6

- [ ] 8. Implementar el ciclo de vida del socket: guards, backoff y máquina de cierre
  - covers: CA-1.2, CA-1.3, CA-1.4, CA-1.8, CA-3.1, CA-3.2, CA-3.3, CA-3.4, CA-15.2, CA-15.3,
    CA-15.4, CA-15.5, CA-15.6, CA-15.7, CA-15.8, RNF-10, RNF-11 (un socket)
  - files: `src/wa/socket.ts`, `src/wa/auth.ts`, `test/socket.test.ts`
  - detalle: opciones **no negociables** de §5.6 (`Browsers.ubuntu("Chrome")`, `pino silent`,
    `markOnlineOnConnect:false`, `syncFullHistory:false`, `getMessage` contra `sentCache`); guard
    `if (s !== current) return;` en **los cuatro** handlers; reemplazo = `removeAllListeners()` +
    `end()` y recién ahí crear el nuevo; backoff fuera del socket, reseteado en `open` **y** al
    llegar un `qr`; flag `sawQr` para el 405; 401/500 ⇒ `end()` + `sleep(1500)` + borrar **solo**
    `creds/`; 515 ⇒ respawn inmediato sin sumar backoff; evento `qr` con `flow==="reconnect"` ⇒ wipe
    + relink. Extraer `decideOnClose(code, ctx)` como función pura para poder testearla.
  - done when: `bun test test/socket.test.ts` verde con un doble de `makeWASocket` inyectado:
    `decideOnClose` mapea 401/500 → wipe+need-link, 515 → respawn sin sumar intento, 405 sin `sawQr`
    → failed, 408 → reconnect con delay 2 s; un socket "viejo" que emite `creds.update` y
    `messages.upsert` después de ser reemplazado no escribe **nada**; nunca hay dos sockets vivos.
    Además, smoke sin teléfono: `bun run src/index.tsx --no-splash` con `creds/` vacío deja en el log
    `wa.version.ok` y al menos un `wa.qr` y el backoff en 0.
  - depends-on: 2, 3, 7

- [ ] 9. Montar el esqueleto de la TUI y el cableado del entry
  - covers: CA-13.1, CA-13.2, CA-13.3, CA-13.6, CA-13.7, CA-15.1, CA-16.2, CA-16.3, CA-19.1,
    CA-19.2, CA-19.3, CA-19.4, CA-19.5, CA-6.6, CA-10.5, RNF-1, RNF-2, RNF-14
  - files: `src/index.tsx` (orden obligatorio: umask → paths → stderr → args → db → `store.bootstrap`
    → renderer → `root.render(<App/>)` → `wa.start()`), `src/ui/App.tsx`, `src/ui/theme.ts`,
    `src/ui/Brand.tsx`, `src/ui/Splash.tsx`, `src/ui/Header.tsx`, `src/ui/Footer.tsx`,
    `src/ui/TooSmall.tsx`, `src/ui/ErrorScreen.tsx`, `src/ui/Help.tsx`, `src/state/commands.ts`
  - detalle: un solo `useKeyboard` en `App.tsx` ruteando por `mode`, con las combinaciones `Shift`
    evaluadas **antes** que las teclas peladas y **ningún** `Ctrl-<letra>` para scroll (§7.3);
    renderer con `exitOnCtrlC:false` y `exitSignals:[]`; layouts `wide`/`compact`/`mini` de §7.2;
    `commands.ts` arranca con `openChat`/`closeChat`/`markRead` local/`reconnectNow`/`quit` (los de
    envío y pairing los agregan las tareas 10 y 14).
  - ⚠️ **abierto por la revisión de la tarea 3 — afecta directo al ≤ 1 s de CA-13.1**: `PRAGMA
    quick_check` corre en **cada** apertura (lo manda design §4.2) y escala lineal: medido en **48 ms
    sobre 50.000 mensajes / 16 MB**, o sea ~0,5 s a 500 k mensajes, que se come medio presupuesto.
    Al medir el arranque, medilo con una base **poblada**, no vacía, o el número miente. Si no entra,
    la salida es correr el `quick_check` en background después del primer frame en vez de bloquear
    el arranque — pero eso cambia §4.2 y hay que actualizar el diseño, no improvisarlo.
  - done when: en una pane de 80×24, `bun run src/index.tsx --no-splash` pinta header + dos paneles +
    footer sin layout roto (`tmux capture-pane -p` como evidencia) y la bandeja aparece en **≤ 1 s**
    (medido con `time` hasta el primer frame); achicar a 50 columnas muestra `<TooSmall/>` con el
    tamaño actual y el mínimo, y agrandar vuelve solo; `?` abre la ayuda con la ruta del log y `Esc`
    la cierra; sin `--no-splash` el splash dura ≤ 1,5 s y cualquier tecla lo saltea; una base
    corrupta a mano muestra `<ErrorScreen>` con ruta y motivo y sale con código **2**.
  - depends-on: 2, 3, 6, 8

- [ ] 10. Construir la pantalla de vinculación: QR nativo y código de emparejamiento
  - covers: CA-1.1, CA-1.5, CA-1.6, CA-1.9, CA-2.1, CA-2.2, CA-2.3, CA-2.4, CA-2.5, CA-2.6, RNF-3
  - files: `src/wa/qr.ts`, `src/ui/Login.tsx`, `src/ui/QrView.tsx`, `src/ui/PairingView.tsx`,
    `src/state/commands.ts` (agrega `chooseLinkMethod` y `requestPairing`), `test/qr.test.ts`
  - detalle: QR dibujado **nativo** desde `QRCode.create().modules` con half-blocks y quiet zone 1,
    `fg` negro sobre `bg` blanco fijos (nunca del tema, D10); `fitsQr(w,h,qr)` = umbral fijo
    `h>=36 && w>=69` **y** además la matriz real; `<QrView key={qr}>` para que la rotación reemplace
    y no apile; input de teléfono solo dígitos 8–15 con mensaje de formato; código mostrado
    `XXXX-XXXX`; `pairingRequestedAt` + 120 s ⇒ hint `Ctrl-R`; error ⇒ `phase:"failed"` con motivo y
    el input queda reusable sin reiniciar el proceso. Alternar método **no toca el socket** (D11).
  - done when: `bun test test/qr.test.ts` verde (payload de 277 chars ⇒ `cols:67`, `rows:34`;
    250 ⇒ 63; 300 ⇒ 71; `fitsQr` rechaza 24×80); con un payload falso inyectado, a 40×80 se ve el QR
    completo sin recortes y a 24×80 se ve el panel "no entra" con tamaño actual vs requerido;
    `Tab` alterna las dos vistas; un teléfono de 5 dígitos es rechazado con el mensaje de formato.
  - depends-on: 9

- [ ] 11. **[PRUEBA MANUAL — cuenta real de WhatsApp]** Vincular de verdad y validar el riesgo R2
  - covers: CA-1.7, CA-1.8, CA-2.6, CA-2.7, CA-3.4, R2 (§9)
  - files: `src/wa/socket.ts`, `src/ui/Login.tsx` (solo ajustes que salgan de la prueba)
  - detalle: **es la primera vez que se le pide el teléfono al usuario.** Guion de la sesión, en este
    orden: (a) vincular por **código** en una pane 80×24; (b) desvincular desde el teléfono, agrandar
    la terminal y vincular por **QR**; (c) **R2**: con la pantalla de vinculación abierta, alternar
    `Tab` código → QR sobre el **mismo socket** y confirmar en el log que sigue llegando un `wa.qr`
    nuevo dentro de los 10 s. **Plan B si no llega:** reciclar el socket al volver a QR
    (`end()` + `connect()`, el mismo camino ya probado del backoff) y dejarlo anotado en el diseño.
  - done when: los dos métodos terminan en la bandeja **sin reiniciar el proceso**, las creds quedan
    en `~/.local/share/wacosas/creds/` con `0600`, el cierre 515 posterior al escaneo reconecta solo
    (log `wa.restart_required` seguido de `wa.open`, sin pedir QR de nuevo), y el resultado de R2
    queda escrito (funciona tal cual / se aplicó el plan B).
  - depends-on: 10

- [ ] 12. Construir la bandeja: filas, filtros, buscador y mouse
  - covers: CA-4.1, CA-4.2, CA-4.4, CA-4.6, CA-4.7, CA-4.8, CA-5.1, CA-5.2, CA-5.3, CA-5.4, CA-5.5,
    CA-5.6, CA-5.7, CA-5.8, CA-10.2, CA-10.3, CA-10.4, CA-19.7, RNF-6
  - files: `src/ui/Inbox.tsx`, `src/ui/Header.tsx` (tabs con contadores + clickeables),
    `src/state/commands.ts` (selección/filtro)
  - detalle: filas `height={1}` + `wrapMode="none"` + `clipText` (gotcha §7.4.1); selección guardada
    por **jid**, nunca por índice (CA-4.4); buscador siempre enfocado en modo `browse`; filtro local
    con `fold()` sobre nombre y número (acá vive la mitad de CA-12.1 que perdió `chats_fts`);
    `Tab` cicla `Todos`/`No leídos`/`Grupos`; doble click < 350 ms abre; rueda mueve la selección;
    estado vacío "esperando la sincronización inicial".
  - ⚠️ **abierto por la revisión de la tarea 3 (aplica también a la 16)**: (a) sembrar 50.000 mensajes
    con `test/fixtures/seed.ts` tarda **~3,4 s** (~3,2 s son los triggers del FTS) y el default de
    `bun test` son **5 s por test** → los tests de volumen necesitan su **propio `timeout`**. (b)
    `refrescarChats` en `seed.ts:101-108` hace un `UPDATE` **sin `WHERE`**: recalcula actividad y
    preview de *todos* los chats de la base, no sólo los sembrados. Hoy no molesta porque siempre se
    siembra sobre una base fresca; si acá sembrás encima de una base ya poblada, te va a morder.
  - done when: con la base ya poblada por la tarea 11 y **sin conexión** (modo avión), la bandeja
    lista los chats ordenados por actividad con preview, fecha relativa y badge de no leídos; escribir
    `mañana` y `manana` filtran igual; `Tab` cicla los tres filtros y el header muestra los tres
    contadores; click en un tab lo aplica; doble click abre el chat; con `test/fixtures/seed.ts` de
    50.000 mensajes, mover la selección responde en **≤ 50 ms** (medido con un log de duración);
    ninguna fila ocupa más de una línea al pasar el mouse.
  - depends-on: 9, 11

- [ ] 13. Construir el panel de conversación con ventana fija de 500 y scroll
  - covers: CA-6.1, CA-6.2, CA-6.3, CA-6.4, CA-6.5, CA-6.7, CA-6.9, CA-7.1, CA-7.2, CA-7.3, CA-7.4,
    CA-7.5, CA-6.8 (recortado: ventana de 500 sin carga incremental)
  - files: `src/ui/Conversation.tsx`, `src/ui/MessageRow.tsx`, `src/state/commands.ts`
    (`openChat` con `loadWindow`, usado también por CA-12.3)
  - detalle: `<scrollbox stickyScroll stickyStart="bottom">` con `<MessageRow id={"msg-"+id}/>`;
    ventana = `repo.lastMessages(jid, 500)`, **sin** `loadOlder` ni disparo al llegar arriba (R2);
    `loadWindow(jid, anchorId?)` implementado sobre `messagesAround` porque lo necesita la tarea 16;
    badge "↓ N mensajes nuevos" cuando el usuario está scrolleado arriba; `Shift-↑/↓` línea a línea y
    `Shift-PgUp/PgDn` media página (nunca `Ctrl-<letra>`, CA-6.6); en `MessageRow` **sí** hay wrap por
    palabra (el gotcha de `wrapMode="none"` no aplica acá).
  - done when: abrir un chat con más de 500 mensajes carga los últimos 500 posicionado al final;
    cambiar de chat resetea el scroll al final del nuevo; `Shift-↑/↓` y `Shift-PgUp/PgDn` scrollean;
    un mensaje inyectado a mano en la base mientras el panel está scrolleado arriba **no** roba la
    posición y aparece el badge; un mensaje `revoked` se ve `🚫 mensaje eliminado`; los adjuntos se
    ven con su placeholder + caption debajo; `grep -rn "downloadMediaMessage\|writeFile" src/` no
    devuelve nada en el camino de mensajes (CA-7.4).
  - ⚠️ **abierto por la revisión de la tarea 6 — el ancla es pegajosa y te congela la conversación**:
    `store.ts:337` guarda `ancla` y `construirConvo` la usa en **todos** los flush siguientes, no sólo
    en el salto. Reproducido: chat de 900 mensajes, abrís desde un resultado de búsqueda con
    `anchorId` viejo, llega un mensaje nuevo ⇒ la bandeja se actualiza pero **el mensaje nuevo nunca
    entra en la ventana**. Acá hay que **soltar el ancla** (`setOpenChat(jid)` sin ancla) al volver al
    final o al primer mensaje entrante. El diseño no dice cuándo se suelta — decidilo y anotalo.
    Además: por el camino anclado, `hasMoreAbove` miente (`messagesAround` devolvió 252 filas ⇒
    `false` aunque había ~650 mensajes arriba), así que **no te apoyes en ese flag** para el
    indicador "hay más arriba".
  - depends-on: 12

- [ ] 14. Implementar el composer y la cola de envío con rate limit y reintentos
  - covers: CA-8.1, CA-8.2, CA-8.3, CA-8.4, CA-8.5, CA-8.6, CA-8.7, CA-8.8, CA-9.1, CA-9.2, CA-9.3,
    CA-9.4 (mecanismo), CA-13.3, RNF-8, RNF-9
  - files: `src/ui/Composer.tsx`, `src/wa/send.ts`, `src/state/commands.ts` (`send`, `retrySend`),
    `test/send.test.ts`
  - detalle: `keyBindings` **invertidos** (`return → submit`, `meta+return → newline`, V6);
    `key={chatJid}` en el `<textarea>` para restaurar borradores (gotcha §7.4.6), borradores en el
    slice `ui` (solo memoria); id propio `generateMessageIDV2(selfJid)` persistido con
    `status:'pending'` **antes** de tocar la red (D7 ⇒ el eco se deduplica solo); cola FIFO en memoria
    con `minGap` 1 s y 20/60 s, 3 reintentos 1/3/9 s, después `failed` + `Ctrl-Y`; sin conexión el
    envío se **rechaza** y el texto se conserva (nunca outbox diferido).
  - done when: `bun test test/send.test.ts` verde con un `sock` falso: 5 envíos seguidos salen
    espaciados ≥ 1000 ms, el 21.º del minuto espera, un envío que falla se reintenta exactamente 3
    veces con 1/3/9 s y termina en `failed` con motivo, `enqueue` con conexión cerrada devuelve
    `{ok:false}` sin insertar nada. Y a ojo: `Ctrl-E` enfoca el campo, `⏎` con texto envía y limpia,
    `⏎` con espacios no hace nada, `Alt-⏎` mete un salto de línea, `Esc` vuelve a la bandeja con el
    borrador intacto y volver al chat lo restaura.
  - ⚠️ **abierto por la revisión de la tarea 6**: `UiSnapshot` **no tiene campo de borradores** y el
    diseño tampoco los define. Agregalo acá, en el slice `ui`, que es donde el done-when los pide.
  - depends-on: 13

- [ ] 15. Implementar marcar como leído, recibos de lectura y contadores
  - covers: CA-10.1, CA-11.1, CA-11.2, CA-11.3, CA-11.4, CA-11.5, CA-11.6, CA-11.7, CA-14.3
  - files: `src/wa/read.ts`, `src/state/commands.ts` (`markRead`), `src/wa/ingest.ts` (rama
    `chat-updates` → `setUnread`), `test/read.test.ts`
  - detalle: `readReceipts: true` por default en `config.json` (sin pantalla de settings, R3); el
    recibo es **best effort**: `sock.readMessages(keys)` en un `catch` que loguea y sigue, el chat
    queda leído localmente pase lo que pase; sin conexión no se manda ni se encola; `Ctrl-L` marca
    leído sin abrir; con el chat abierto el ingest nunca hace `bumpUnread`.
  - done when: `bun test test/read.test.ts` verde: con `readReceipts:false` **cero** llamadas a
    `readMessages` y el contador igual queda en 0; con `true` se llama una vez con las keys desde
    `last_read_id`; un `readMessages` que lanza deja el chat leído y una línea en el log; un
    `chats.update` con `unreadCount:0` pone el contador local en 0. Y a ojo: abrir un chat con no
    leídos lo pone en 0, `Ctrl-L` hace lo mismo sin abrirlo, y al reiniciar el proceso los
    contadores quedan como estaban (CA-14.3).
  - depends-on: 14

- [ ] 16. Construir la búsqueda global full-text
  - covers: CA-12.1, CA-12.2, CA-12.3, CA-12.4, CA-12.5, CA-12.7, CA-12.8, RNF-7
  - files: `src/ui/SearchOverlay.tsx`, `src/state/commands.ts` (`search`), `src/ui/App.tsx` (modo
    `search`), `test/search.bench.test.ts`
  - detalle: `Ctrl-G` guarda `{selectedJid, filter, query}` para restaurarlo con `Esc`; debounce
    120 ms; `buildFtsQuery` + `repo.searchMessages(match, 200)`; fragmento con `snippet()` partido por
    `char(1)/char(2)` y resaltado; `⏎` ⇒ `openChat(jid,{anchorId})` + `messagesAround` +
    `scrollChildIntoView("msg-"+id)` + marca visual hasta el próximo cambio de chat. **Los chats por
    nombre no se buscan acá** (R1): eso lo cubre el filtro de la bandeja.
  - done when: `bun test test/search.bench.test.ts` verde: sobre las 50.000 filas de
    `test/fixtures/seed.ts`, `searchMessages` devuelve en **≤ 200 ms**, y las queries
    `"comillas" -guion (paren) *ast :dosp` no lanzan error de sintaxis. Y a ojo: `Ctrl-G` + tipear
    lista chat · fecha · fragmento con los términos resaltados; `⏎` abre el chat posicionado en ese
    mensaje y señalado; una query sin resultados dice "sin coincidencias" y no deja la lista anterior;
    un mensaje recibido recién aparece en la búsqueda siguiente sin reiniciar; `Esc` vuelve a la
    bandeja con el mismo chat seleccionado y el mismo filtro.
  - depends-on: 13

- [ ] 17. Implementar instancia única y cierre ordenado
  - covers: CA-17.1, CA-17.2, CA-17.3, CA-17.4, CA-17.5, CA-17.6, CA-17.7, CA-18.1, CA-18.2,
    CA-18.3, CA-18.4, RNF-11 (un proceso por directorio de datos)
  - files: `src/boot/lock.ts`, `src/boot/shutdown.ts`, `src/index.tsx` (acquire antes de abrir el
    socket, release en el paso 8), `src/ui/ErrorScreen.tsx` (variante "instancia tomada"),
    `test/lock.test.ts`
  - detalle: pidfile + `kill(pid,0)` + verificación de `/proc/<pid>/cmdline` (evita falsos positivos
    por reuso de PID); `shutdown(code)` idempotente con **un solo** tope global de 2 s y los 9 pasos
    de §6.6: parar drenador y worker → `Promise.race(inFlight, 2 s)` → lo no resuelto a `failed` →
    `ingest.drainNow()` → `sock.end()` **sin `logout()`** → `repo.close()` → `renderer.destroy()` →
    `lock.release()` → `exit`. Enganchado a `Ctrl-C`/`Ctrl-Q`, `SIGINT`/`SIGTERM`/`SIGHUP`,
    `uncaughtException` y `unhandledRejection`. Segundo `Ctrl-C` ⇒ `exit(1)` inmediato.
  - done when: `bun test test/lock.test.ts` verde (marca huérfana de un PID muerto ⇒ arranca normal;
    PID vivo con otro `cmdline` ⇒ arranca normal). Y a ojo: con una instancia corriendo, una segunda
    imprime **una línea** y sale con código ≠ 0 sin tocar creds ni abrir socket; `Ctrl-C` sale con
    código 0 y el prompt queda usable **sin `reset`** (cursor visible, sin mouse tracking, fuera de
    la pantalla alternativa); `kill -TERM` hace lo mismo; matar la primera con `-9` y arrancar de
    nuevo funciona; después de salir, `creds/` y el `.sqlite` siguen ahí.
  - ⚠️ **abierto por la revisión de la tarea 6 — orden del apagado**: después de `store.stop()`, un
    `markDirty` **vuelve a armar un timer** (medido: 1 timer, 1 notify). Así que `store.stop()` va
    **al final**, después de parar el drenador de ingest y el worker de envío; al revés te queda un
    timer de 33 ms en vuelo que impide que el proceso muera.
  - depends-on: 9, 14

- [ ] 18. **[PRUEBA MANUAL — cuenta real de WhatsApp]** Recorrido end-to-end y documentación final
  - covers: CA-3.1, CA-3.2, CA-3.5, CA-6.9, CA-8.2, CA-8.4, CA-8.7, CA-8.8, CA-9.1, CA-9.2, CA-9.3,
    CA-9.4, CA-9.5, CA-11.2, CA-11.6, CA-14.3, CA-14.4, CA-15.1, CA-15.3, CA-15.4, CA-15.5,
    CA-19.6, RNF-12 (aviso), R7 (LID)
  - files: `README.md` (versión final), `.sdd/wa-tui/design.md` (§12: corregir la trazabilidad de
    CA-12.1 y CA-6.8 a lo recortado)
  - detalle: **segunda y última vez que se le pide el teléfono al usuario.** Guion, corriendo desde
    `~/.local/bin/wacosas` (no desde el repo, así se valida CA-19.6): enviar a un chat 1:1 y a un
    grupo, con y sin salto de línea; mandarse uno desde el teléfono y ver que entra como propio;
    verificar que el eco no duplica; borrar un mensaje desde el teléfono y ver `🚫 mensaje eliminado`;
    abrir un chat con no leídos y confirmar el doble tilde azul en el teléfono; marcar leído desde el
    teléfono y ver el contador local en 0; cortar el WiFi (header en reconectando con intento y
    cuenta regresiva, envío rechazado conservando el texto), reconectar con `Ctrl-R` y ver que
    entran los mensajes del corte; reiniciar el proceso y confirmar que chats, mensajes y contadores
    quedaron igual; desvincular desde el teléfono ⇒ vuelve a vinculación explicando el motivo, con el
    historial intacto. El README final documenta: teclas, arquitectura, ruta del log, **la base no se
    cifra**, la ventana fija de 500 sin paginado, la búsqueda global solo sobre el cuerpo, el
    `unbind -n S-PPage` de tmux (R5), `Ctrl-J/K` y el protocolo kitty (R6) y los duplicados `@lid` si
    aparecieron (R7).
  - done when: los doce pasos del guion pasan sin que se rompa la UI ni haya que reiniciar a mano;
    `~/.local/state/wacosas/wacosas.log` no contiene ningún cuerpo de mensaje ni credencial
    (`grep` del texto de una de las pruebas ⇒ 0 líneas); `bun test` completo verde; el README y la
    §12 del diseño quedan alineados con lo implementado.
  - depends-on: 15, 16, 17

---

## Cobertura de criterios

Todos los `CA-*` y `RNF-*` del requirements quedan cubiertos por al menos una tarea, con estas dos
salvedades ya decididas por el orquestador:

- **CA-6.8** — se cubre **parcialmente y a propósito**: la ventana al abrir un chat pasa de 200 a 500
  mensajes (tarea 13) y **no** se implementa la carga incremental al scrollear hacia arriba (R2).
  Queda documentado en el README (tarea 18).
- **CA-12.1** — la mitad "sobre los nombres de chat" ya no se resuelve con FTS sino con el filtro de
  la bandeja (CA-5.2, tarea 12). El resultado para el usuario es el mismo; la §12 del diseño se
  corrige en la tarea 18.
