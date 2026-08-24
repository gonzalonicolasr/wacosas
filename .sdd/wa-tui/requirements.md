# Requisitos — wacosas (cliente de WhatsApp en TUI)

## Resumen

**wacosas** es un cliente de WhatsApp para la terminal —pensado para vivir en una pane de tmux—
que deja leer la bandeja de chats, leer conversaciones, responder texto y buscar en todo el
historial guardado localmente, con la misma UX que la TUI de miscosas.

## Premisas (decisiones ya tomadas, no se re-discuten acá)

- Un **único proceso Bun** (1.3.14) corre WhatsApp (Baileys 7.0.0-rc14) y la TUI
  (`@opentui/react` + `@opentui/core` 0.4.2, React 19) juntos. Un solo comando arranca todo.
  No hay daemon separado.
- El historial se persiste en una **SQLite propia con FTS5** vía `bun:sqlite`.
- El QR se renderiza con `qrcode` (`{type:"terminal"}`).
- Alcance funcional v1: **leer + responder texto + extras**. Los adjuntos se muestran como
  placeholder descriptivo, no se descargan ni se renderizan.
- Node no se usa como runtime del producto.

## Glosario mínimo

- **Chat**: conversación con un contacto o un grupo, identificada por su JID.
- **Bandeja**: lista de chats ordenada por actividad, panel izquierdo.
- **Placeholder de adjunto**: línea de texto que describe un adjunto sin descargarlo
  (ej. `📷 imagen`, `🎤 audio 0:12`, `📎 presupuesto.pdf`).
- **Vinculación**: proceso de asociar la cuenta de WhatsApp del teléfono a wacosas
  (QR o código de 8 caracteres).
- **Re-vinculación**: repetir la vinculación porque las credenciales dejaron de servir.

## Fuera de alcance en v1

- **Enviar** multimedia (imagen, audio, video, documento, sticker, ubicación, contacto).
- **Descargar / abrir / previsualizar** multimedia entrante (solo placeholder).
- Llamadas de voz y video (ni atender, ni iniciar, ni notificar más allá de una línea en el chat).
- Estados / stories (ver, publicar o responder).
- Administración de grupos (crear, agregar/quitar participantes, cambiar asunto, roles de admin).
  Leer y escribir texto en grupos **sí** está en alcance.
- Multi-cuenta: v1 maneja **una sola** cuenta de WhatsApp por instalación.
- Cifrado de la base local (se protege con permisos de archivo, no con criptografía).
- Reacciones, editar mensajes, borrar para todos, citar/responder-a (reply), reenviar, fijar chats,
  archivar, silenciar, bloquear contactos.
- Notificaciones del sistema (libnotify/mako), sonidos, badges fuera de la TUI.
- Sincronización de historial antiguo bajo demanda ("cargar más" contra los servidores de WhatsApp):
  solo se ve lo que WhatsApp entregó en el sync inicial más lo que llegó desde entonces.
- Presencia enriquecida: mostrar/enviar "escribiendo…", "en línea", "última vez".
- Backup, export o import del historial.
- Empaquetado/distribución (AUR, npm, binario standalone). Alcanza con el repo + un wrapper local.

---

## Historias de usuario y criterios de aceptación

Los criterios están en formato EARS y numerados `CA-<historia>.<n>` para poder trazarlos desde el
diseño y los tests.

---

### Área A — Vinculación y sesión

#### 1. Vincular la cuenta escaneando un QR

**Como** usuario nuevo de wacosas, **quiero** escanear un QR desde el teléfono, **para** que la TUI
quede autenticada contra mi WhatsApp sin usar el navegador.

- **CA-1.1** — CUANDO wacosas arranca y no hay credenciales guardadas, EL SISTEMA DEBERÁ mostrar la
  pantalla de vinculación en lugar de la bandeja.
- **CA-1.2** — CUANDO el sistema va a abrir el socket de WhatsApp, EL SISTEMA DEBERÁ obtener la
  versión vigente de WhatsApp Web (`fetchLatestBaileysVersion()`) y usarla en la conexión.
- **CA-1.3** — SI no se puede obtener la versión vigente, ENTONCES EL SISTEMA DEBERÁ continuar con la
  versión que trae la librería y dejar registrado el fallo en el archivo de log.
- **CA-1.4** — SI WhatsApp cierra la conexión con código **405** y no llegó a emitirse ningún QR,
  ENTONCES EL SISTEMA DEBERÁ mostrar en pantalla el mensaje de que la versión de WhatsApp Web quedó
  desactualizada, y NO DEBERÁ quedarse en un "conectando…" indefinido.
- **CA-1.5** — CUANDO Baileys emite un QR y la terminal tiene **≥ 36 filas y ≥ 69 columnas**, EL
  SISTEMA DEBERÁ renderizar el QR en modo compacto (`small: true`, 34 filas × 67 columnas) completo
  y sin recortes.
- **CA-1.6** — CUANDO Baileys emite un QR nuevo (rotación), EL SISTEMA DEBERÁ reemplazar el anterior
  en pantalla, sin apilar QRs ni dejar restos del render previo.
- **CA-1.7** — CUANDO el teléfono escanea el QR y la conexión llega a estado abierto, EL SISTEMA
  DEBERÁ guardar las credenciales en disco y pasar a la bandeja de chats sin pedir reinicio manual.
- **CA-1.8** — CUANDO WhatsApp cierra con `restartRequired` (cierre normal justo después del
  escaneo), EL SISTEMA DEBERÁ reconectar en el acto con las credenciales recién guardadas y NO
  DEBERÁ contarlo como un fallo de conexión ni volver a pedir QR.
- **CA-1.9** — MIENTRAS la pantalla de vinculación esté visible, EL SISTEMA DEBERÁ mostrar el estado
  actual del proceso (esperando QR / esperando escaneo / conectando / vinculado).

#### 2. Vincular con código de 8 caracteres cuando la terminal es chica

**Como** usuario con una pane de tmux de 80×24, **quiero** vincular con un código que escribo en el
teléfono, **para** no depender de un QR que no entra en pantalla.

- **CA-2.1** — SI en el momento de vincular la terminal tiene **menos de 36 filas o menos de 69
  columnas**, ENTONCES EL SISTEMA DEBERÁ ofrecer la vinculación por código en vez de intentar dibujar
  el QR, e indicar en pantalla cuál es el tamaño mínimo para el QR y cuál es el actual.
- **CA-2.2** — CUANDO el usuario elige la vinculación por código, EL SISTEMA DEBERÁ pedirle el número
  de teléfono en formato internacional sin `+` ni separadores, y DEBERÁ rechazar entradas que no sean
  entre 8 y 15 dígitos, explicando el formato esperado.
- **CA-2.3** — CUANDO el sistema recibe un número válido, EL SISTEMA DEBERÁ solicitar el código de
  emparejamiento a WhatsApp y mostrar los **8 caracteres** en pantalla agrupados como `XXXX-XXXX`,
  junto con la instrucción de dónde ingresarlo en el teléfono.
- **CA-2.4** — SI la solicitud del código falla, ENTONCES EL SISTEMA DEBERÁ mostrar el motivo en
  pantalla y permitir reintentar con otro número sin reiniciar el proceso.
- **CA-2.5** — SI pasaron **120 segundos** desde que se mostró el código sin que la conexión se abra,
  ENTONCES EL SISTEMA DEBERÁ ofrecer generar un código nuevo con una sola tecla.
- **CA-2.6** — MIENTRAS la pantalla de vinculación esté visible, EL SISTEMA DEBERÁ permitir alternar
  entre método QR y método código con una tecla, independientemente del tamaño de la terminal
  (el usuario puede forzar el QR si agranda la ventana, o el código aunque el QR entre).
- **CA-2.7** — CUANDO la vinculación por código se completa, EL SISTEMA DEBERÁ guardar las
  credenciales y entrar a la bandeja con el mismo comportamiento que la vinculación por QR (CA-1.7).

#### 3. Re-vincular cuando la sesión deja de servir

**Como** usuario que desvinculó wacosas desde el teléfono, **quiero** que la TUI se dé cuenta y me
ofrezca vincular de nuevo, **para** no quedar en un loop de errores sin explicación.

- **CA-3.1** — SI WhatsApp cierra la conexión con `loggedOut` o `badSession`, ENTONCES EL SISTEMA
  DEBERÁ borrar las credenciales locales, volver a la pantalla de vinculación y explicar el motivo
  ("la sesión fue desvinculada desde el teléfono" / "credenciales inválidas").
- **CA-3.2** — CUANDO el sistema borra credenciales por `loggedOut`/`badSession`, EL SISTEMA NO
  DEBERÁ borrar el historial ya persistido en la base local.
- **CA-3.3** — MIENTRAS haya un socket anterior todavía emitiendo eventos, EL SISTEMA NO DEBERÁ
  permitir que ese socket reescriba las credenciales (solo el socket vigente puede persistirlas).
- **CA-3.4** — SI un intento de reconexión con credenciales existentes termina pidiendo un QR,
  ENTONCES EL SISTEMA DEBERÁ tratar las credenciales como inutilizables: borrarlas y pasar al flujo de
  vinculación, en vez de reintentar en loop.
- **CA-3.5** — CUANDO la re-vinculación se completa, EL SISTEMA DEBERÁ reusar la base local existente
  y mostrar el historial anterior junto con lo que llegue del nuevo sync.

---

### Área B — Bandeja de chats

#### 4. Ver la lista de chats con lo último de cada uno

**Como** usuario, **quiero** ver mis chats ordenados por actividad con un preview del último mensaje,
**para** saber de un vistazo qué hay nuevo.

- **CA-4.1** — CUANDO se muestra la bandeja, EL SISTEMA DEBERÁ listar los chats con: nombre del
  contacto o grupo (o el número si no hay nombre), preview de una línea del último mensaje, fecha
  relativa de ese mensaje y contador de no leídos si es > 0.
- **CA-4.2** — MIENTRAS no haya búsqueda activa, EL SISTEMA DEBERÁ ordenar la bandeja por fecha del
  último mensaje, del más reciente al más viejo.
- **CA-4.3** — CUANDO llega un mensaje nuevo de cualquier chat, EL SISTEMA DEBERÁ actualizar la
  bandeja (posición, preview, contador) sin que el usuario tenga que refrescar a mano.
- **CA-4.4** — CUANDO la bandeja se reordena por un mensaje entrante, EL SISTEMA DEBERÁ mantener el
  cursor sobre el **mismo chat** que estaba seleccionado, aunque haya cambiado de índice.
- **CA-4.5** — CUANDO el último mensaje de un chat es un adjunto, EL SISTEMA DEBERÁ mostrar como
  preview el placeholder descriptivo correspondiente (CA-7.1), no una línea vacía.
- **CA-4.6** — CUANDO el preview no entra en el ancho de la fila, EL SISTEMA DEBERÁ recortarlo en una
  sola línea sin romper el layout (ninguna fila de la lista puede ocupar más de una línea).
- **CA-4.7** — SI todavía no hay ningún chat en la base, ENTONCES EL SISTEMA DEBERÁ mostrar un estado
  vacío explicando que está esperando la sincronización inicial, en vez de una lista en blanco.
- **CA-4.8** — CUANDO un chat es un grupo, EL SISTEMA DEBERÁ mostrar el nombre del grupo en la fila y
  distinguirlo visualmente de un chat individual.

#### 5. Filtrar y navegar la bandeja estilo miscosas

**Como** usuario acostumbrado a miscosas, **quiero** escribir para filtrar y moverme con teclado o
mouse, **para** llegar a un chat sin pensar.

- **CA-5.1** — CUANDO wacosas abre la bandeja, EL SISTEMA DEBERÁ dejar el buscador activo por
  defecto: escribir filtra al instante, sin apretar ninguna tecla previa.
- **CA-5.2** — CUANDO el usuario escribe en el buscador de la bandeja, EL SISTEMA DEBERÁ filtrar por
  nombre de chat y número, sin distinguir mayúsculas ni acentos.
- **CA-5.3** — CUANDO el usuario presiona `↑`/`↓` o `Ctrl-K`/`Ctrl-J`, EL SISTEMA DEBERÁ mover la
  selección un ítem, y el viewport DEBERÁ seguir a la selección.
- **CA-5.4** — CUANDO el usuario presiona `Esc` con texto en el buscador, EL SISTEMA DEBERÁ limpiar la
  búsqueda y volver a la lista completa.
- **CA-5.5** — CUANDO el usuario presiona `Tab`, EL SISTEMA DEBERÁ ciclar el filtro de la bandeja
  entre `Todos` / `No leídos` / `Grupos`, y el encabezado DEBERÁ mostrar el contador de cada filtro.
- **CA-5.6** — CUANDO el usuario hace click sobre una fila, EL SISTEMA DEBERÁ seleccionarla; CUANDO
  hace doble click (mismo ítem, < 350 ms), EL SISTEMA DEBERÁ abrir la conversación (equivalente a `⏎`).
- **CA-5.7** — CUANDO el usuario mueve la rueda del mouse sobre la bandeja, EL SISTEMA DEBERÁ mover la
  selección; CUANDO la mueve sobre el panel de conversación, EL SISTEMA DEBERÁ scrollear ese panel.
- **CA-5.8** — CUANDO el usuario hace click sobre un tab de filtro, EL SISTEMA DEBERÁ aplicar ese
  filtro.

---

### Área C — Lectura de la conversación

#### 6. Leer la conversación de un chat

**Como** usuario, **quiero** ver los mensajes del chat seleccionado, **para** leer la charla completa
sin salir de la terminal.

- **CA-6.1** — CUANDO el usuario selecciona un chat, EL SISTEMA DEBERÁ mostrar en el panel derecho sus
  mensajes en orden cronológico ascendente, con el más reciente abajo, y DEBERÁ posicionar el scroll
  al final.
- **CA-6.2** — CUANDO se renderiza un mensaje, EL SISTEMA DEBERÁ mostrar hora, autor y cuerpo, y
  DEBERÁ distinguir visualmente los propios (enviados) de los ajenos (recibidos).
- **CA-6.3** — CUANDO el chat es un grupo, EL SISTEMA DEBERÁ mostrar además quién escribió cada
  mensaje recibido.
- **CA-6.4** — CUANDO llega un mensaje al chat que está abierto, EL SISTEMA DEBERÁ agregarlo al final;
  SI el panel estaba scrolleado al final, ENTONCES EL SISTEMA DEBERÁ seguir mostrando el final; SI el
  usuario había scrolleado hacia arriba, ENTONCES EL SISTEMA DEBERÁ conservar su posición de lectura e
  indicar que hay mensajes nuevos abajo.
- **CA-6.5** — CUANDO el usuario presiona `Shift-↑`/`Shift-↓`, EL SISTEMA DEBERÁ scrollear el panel de
  conversación línea por línea; CUANDO presiona `Shift-PgUp`/`Shift-PgDn`, DEBERÁ scrollear media
  página.
- **CA-6.6** — EL SISTEMA NO DEBERÁ asignar atajos `Ctrl-<letra>` al scroll del panel de conversación
  (esa tecla la consume el campo de texto).
- **CA-6.7** — CUANDO el usuario cambia de chat, EL SISTEMA DEBERÁ resetear el scroll del panel al
  final del chat nuevo.
- **CA-6.8** — CUANDO un chat tiene más de 200 mensajes persistidos, EL SISTEMA DEBERÁ cargar los
  últimos 200 al abrirlo y DEBERÁ cargar los anteriores desde la base local al scrollear hacia arriba,
  sin pedirle nada a la red.
- **CA-6.9** — CUANDO un mensaje fue borrado por su autor (revoke), EL SISTEMA DEBERÁ mostrarlo como
  `🚫 mensaje eliminado` en lugar del cuerpo original.

#### 7. Ver adjuntos como placeholder descriptivo

**Como** usuario, **quiero** que los adjuntos se vean como una descripción corta, **para** entender
que llegó algo sin que la TUI intente descargarlo.

- **CA-7.1** — CUANDO un mensaje contiene un adjunto, EL SISTEMA DEBERÁ mostrar un placeholder de una
  línea según el tipo: imagen → `📷 imagen`, audio/nota de voz → `🎤 audio <m:ss>`, video →
  `🎬 video <m:ss>`, documento → `📎 <nombre de archivo>`, sticker → `🩹 sticker`, ubicación →
  `📍 ubicación`, contacto → `👤 contacto`.
- **CA-7.2** — SI el adjunto trae `caption`, ENTONCES EL SISTEMA DEBERÁ mostrar el texto del caption
  debajo del placeholder.
- **CA-7.3** — SI falta el metadato usado en el placeholder (duración, nombre de archivo), ENTONCES EL
  SISTEMA DEBERÁ mostrar el placeholder sin ese dato, y NUNCA `undefined`, `null` ni `NaN`.
- **CA-7.4** — MIENTRAS wacosas esté corriendo, EL SISTEMA NO DEBERÁ descargar el contenido binario de
  ningún adjunto, ni escribir archivos multimedia en disco.
- **CA-7.5** — SI llega un tipo de mensaje que el sistema no sabe representar, ENTONCES EL SISTEMA
  DEBERÁ mostrarlo como `❔ mensaje no soportado` y persistirlo igual como parte del historial del
  chat.

---

### Área D — Envío de mensajes

#### 8. Escribir y enviar un mensaje de texto

**Como** usuario, **quiero** responder desde la TUI, **para** no tener que agarrar el teléfono.

- **CA-8.1** — CUANDO hay un chat abierto, EL SISTEMA DEBERÁ ofrecer un campo de redacción y una tecla
  explícita para enfocarlo, distinta de la del buscador de la bandeja.
- **CA-8.2** — CUANDO el usuario presiona `⏎` con texto no vacío en el campo de redacción, EL SISTEMA
  DEBERÁ enviar ese texto al chat abierto y limpiar el campo.
- **CA-8.3** — SI el campo de redacción está vacío o solo tiene espacios, ENTONCES EL SISTEMA NO
  DEBERÁ enviar nada.
- **CA-8.4** — CUANDO el usuario presiona la combinación de salto de línea (`Alt-⏎`), EL SISTEMA
  DEBERÁ insertar un salto en el mensaje sin enviarlo, y el mensaje DEBERÁ llegar con ese salto.
- **CA-8.5** — CUANDO el usuario presiona `Esc` con el campo de redacción enfocado, EL SISTEMA DEBERÁ
  devolver el foco a la bandeja conservando el borrador escrito.
- **CA-8.6** — CUANDO el usuario cambia de chat con un borrador sin enviar, EL SISTEMA DEBERÁ guardar
  ese borrador asociado al chat y restaurarlo al volver, dentro de la misma sesión del proceso.
- **CA-8.7** — SI el usuario intenta enviar mientras la conexión no está abierta, ENTONCES EL SISTEMA
  DEBERÁ rechazar el envío con un aviso visible y conservar el texto en el campo, sin encolarlo para
  después.
- **CA-8.8** — EL SISTEMA DEBERÁ soportar el envío de texto tanto en chats individuales como en grupos.

#### 9. Ver el estado de lo que mandé

**Como** usuario, **quiero** saber si mi mensaje salió, **para** no quedarme con la duda de si se
mandó.

- **CA-9.1** — CUANDO el usuario confirma un envío, EL SISTEMA DEBERÁ mostrar el mensaje al final de
  la conversación de forma inmediata (< 100 ms) con estado `⏳ enviando`, sin esperar la respuesta de
  la red.
- **CA-9.2** — CUANDO WhatsApp confirma la recepción del mensaje, EL SISTEMA DEBERÁ cambiar su estado
  a `✓ enviado` y persistirlo con el id que devolvió WhatsApp.
- **CA-9.3** — SI el envío falla, ENTONCES EL SISTEMA DEBERÁ marcar el mensaje como `⚠ falló`, mostrar
  el motivo y ofrecer reintentar con una tecla.
- **CA-9.4** — CUANDO WhatsApp reenvía como evento entrante el eco de un mensaje propio, EL SISTEMA
  DEBERÁ deduplicarlo por id y NO DEBERÁ mostrarlo dos veces en la conversación.
- **CA-9.5** — CUANDO se envía un mensaje desde otro dispositivo de la misma cuenta (el teléfono u
  otro cliente), EL SISTEMA DEBERÁ mostrarlo en la conversación como mensaje propio.

---

### Área E — No leídos y marcar como leído

#### 10. Ver qué tengo sin leer

**Como** usuario, **quiero** un contador de no leídos por chat y un total, **para** saber qué me falta
atender.

- **CA-10.1** — CUANDO llega un mensaje entrante de un chat que no está abierto, EL SISTEMA DEBERÁ
  incrementar en 1 el contador de no leídos de ese chat.
- **CA-10.2** — CUANDO un chat tiene no leídos, EL SISTEMA DEBERÁ mostrar el número en su fila de la
  bandeja y resaltar la fila; CUANDO tiene 0, NO DEBERÁ mostrar contador.
- **CA-10.3** — CUANDO hay al menos un chat con no leídos, EL SISTEMA DEBERÁ mostrar el total de chats
  no leídos en el encabezado.
- **CA-10.4** — MIENTRAS el filtro `No leídos` esté activo, EL SISTEMA DEBERÁ listar únicamente los
  chats con contador > 0.
- **CA-10.5** — CUANDO wacosas arranca, EL SISTEMA DEBERÁ mostrar los contadores de no leídos tal como
  quedaron persistidos en la sesión anterior, antes de conectarse.

#### 11. Marcar como leído

**Como** usuario, **quiero** que abrir un chat lo marque como leído, **para** que el contador refleje
lo que ya vi.

- **CA-11.1** — CUANDO el usuario abre un chat con no leídos, EL SISTEMA DEBERÁ poner su contador en 0
  y persistirlo.
- **CA-11.2** — CUANDO el sistema marca un chat como leído y los recibos de lectura están habilitados,
  EL SISTEMA DEBERÁ enviar el recibo de lectura a WhatsApp para esos mensajes.
- **CA-11.3** — SI los recibos de lectura están deshabilitados por configuración, ENTONCES EL SISTEMA
  DEBERÁ marcar el chat como leído solo localmente y NO DEBERÁ enviar ningún recibo a WhatsApp.
- **CA-11.4** — CUANDO el envío del recibo de lectura falla, EL SISTEMA DEBERÁ mantener el chat como
  leído localmente y registrar el fallo en el log, sin interrumpir la navegación.
- **CA-11.5** — CUANDO el usuario presiona la tecla de marcar leído sobre un chat de la bandeja sin
  abrirlo, EL SISTEMA DEBERÁ aplicar el mismo comportamiento que CA-11.1 y CA-11.2.
- **CA-11.6** — CUANDO otro dispositivo de la cuenta marca un chat como leído, EL SISTEMA DEBERÁ poner
  su contador local en 0 al recibir esa actualización.
- **CA-11.7** — MIENTRAS un chat esté abierto, EL SISTEMA DEBERÁ mantener su contador en 0 aunque
  lleguen mensajes nuevos a ese chat.

---

### Área F — Búsqueda full-text del historial

#### 12. Buscar texto en todo el historial

**Como** usuario, **quiero** buscar una frase entre todos mis mensajes guardados, **para** encontrar
algo que me dijeron hace meses.

- **CA-12.1** — CUANDO el usuario activa el modo búsqueda global y escribe, EL SISTEMA DEBERÁ buscar
  full-text (FTS5) sobre el cuerpo de todos los mensajes persistidos y sobre los nombres de chat.
- **CA-12.2** — CUANDO hay resultados, EL SISTEMA DEBERÁ listarlos mostrando chat, fecha y un fragmento
  del mensaje con los términos buscados resaltados.
- **CA-12.3** — CUANDO el usuario presiona `⏎` sobre un resultado, EL SISTEMA DEBERÁ abrir ese chat con
  la conversación posicionada en el mensaje encontrado y ese mensaje señalado visualmente.
- **CA-12.4** — SI la búsqueda no devuelve resultados, ENTONCES EL SISTEMA DEBERÁ mostrar
  explícitamente que no hubo coincidencias, y NO DEBERÁ mostrar la lista anterior.
- **CA-12.5** — SI el texto ingresado tiene caracteres que romperían la sintaxis de FTS5 (comillas,
  `*`, `-`, `:`, paréntesis), ENTONCES EL SISTEMA DEBERÁ tratarlos como texto literal y NO DEBERÁ
  arrojar un error de sintaxis ni cortar el proceso.
- **CA-12.6** — CUANDO la búsqueda es sin acentos o sin mayúsculas, EL SISTEMA DEBERÁ igualmente
  encontrar los mensajes que sí los tienen.
- **CA-12.7** — CUANDO llegan mensajes nuevos, EL SISTEMA DEBERÁ indexarlos de modo que aparezcan en
  búsquedas posteriores sin reiniciar el proceso.
- **CA-12.8** — CUANDO el usuario presiona `Esc` en el modo búsqueda global, EL SISTEMA DEBERÁ volver
  a la bandeja con el estado previo (chat seleccionado y filtro).

---

### Área G — Persistencia y arranque en frío

#### 13. Arrancar y tener la bandeja al instante

**Como** usuario que abre la TUI en una pane, **quiero** ver mis chats enseguida, **para** no esperar
a que WhatsApp conecte.

- **CA-13.1** — CUANDO wacosas arranca con credenciales válidas, EL SISTEMA DEBERÁ renderizar la
  bandeja con los datos de la base local en **≤ 1 segundo**, sin esperar a que la conexión con
  WhatsApp esté abierta.
- **CA-13.2** — MIENTRAS la conexión no esté abierta, EL SISTEMA DEBERÁ permitir navegar la bandeja,
  leer conversaciones y buscar en el historial.
- **CA-13.3** — MIENTRAS la conexión no esté abierta, EL SISTEMA DEBERÁ mostrar el estado de conexión
  en el encabezado y DEBERÁ deshabilitar el envío (CA-8.7).
- **CA-13.4** — CUANDO wacosas arranca por primera vez y la base no existe, EL SISTEMA DEBERÁ crear el
  esquema (incluido el índice FTS5) y arrancar sin error.
- **CA-13.5** — CUANDO wacosas arranca sobre una base creada por una versión anterior, EL SISTEMA
  DEBERÁ migrarla o crear lo que falte de forma idempotente, sin perder mensajes.
- **CA-13.6** — SI la base local está corrupta o no se puede abrir, ENTONCES EL SISTEMA DEBERÁ mostrar
  una pantalla de error con la ruta del archivo y el motivo, y salir con código distinto de 0, en vez
  de crashear con un stack trace crudo.
- **CA-13.7** — CUANDO wacosas se ejecuta con `--no-splash`, EL SISTEMA DEBERÁ saltear la animación de
  arranque e ir directo a la interfaz.

#### 14. Que el historial sobreviva reinicios

**Como** usuario, **quiero** que lo que leí y lo que mandé quede guardado, **para** no perder la
conversación cuando cierro la TUI o se reinicia la máquina.

- **CA-14.1** — CUANDO se recibe o se envía un mensaje, EL SISTEMA DEBERÁ persistirlo en la base local
  con: id de WhatsApp, chat, autor, dirección (entrante/saliente), timestamp, tipo y cuerpo o
  descripción del adjunto.
- **CA-14.2** — CUANDO llega un mensaje cuyo id ya está persistido, EL SISTEMA NO DEBERÁ insertarlo de
  nuevo (deduplicación por id de WhatsApp).
- **CA-14.3** — CUANDO wacosas se reinicia, EL SISTEMA DEBERÁ mostrar los mismos chats, mensajes y
  contadores de no leídos que había al cerrarse.
- **CA-14.4** — CUANDO WhatsApp reenvía mensajes ya vistos (re-sync tras reconexión), EL SISTEMA NO
  DEBERÁ duplicarlos ni reabrir contadores de no leídos ya saldados.
- **CA-14.5** — EL SISTEMA DEBERÁ guardar la base y las credenciales bajo el directorio de datos del
  usuario (`$XDG_DATA_HOME/wacosas`, por defecto `~/.local/share/wacosas`), creando los directorios
  si no existen.
- **CA-14.6** — CUANDO se crean los archivos de credenciales, EL SISTEMA DEBERÁ dejarlos con permisos
  que solo permitan acceso al usuario dueño (dir `0700`, archivos `0600`).
- **CA-14.7** — EL SISTEMA NUNCA DEBERÁ escribir credenciales, claves ni el cuerpo de los mensajes en
  el archivo de log.

---

### Área H — Conexión, desconexión y reconexión

#### 15. Ver el estado de conexión y que reconecte solo

**Como** usuario con WiFi que se cae, **quiero** que wacosas se reconecte sin que yo haga nada,
**para** seguir usándolo sin reiniciar.

- **CA-15.1** — MIENTRAS wacosas esté corriendo, EL SISTEMA DEBERÁ mostrar en el encabezado el estado
  de la conexión con al menos tres valores distinguibles: conectado, reconectando y desvinculado.
- **CA-15.2** — CUANDO la conexión se cierra con un código distinto de `loggedOut`, `badSession`,
  `restartRequired`, `connectionReplaced` y `forbidden`, EL SISTEMA DEBERÁ reintentar la conexión con
  backoff exponencial arrancando en 2 s y con un tope de 60 s entre intentos.

  > ⚠️ **Enmienda (tarea 8b, escrita en la 18).** La redacción original decía "distinto de
  > `loggedOut`, `badSession` y `restartRequired`", o sea que **todo** el resto iba a backoff.
  > Construyéndolo aparecieron **dos códigos que NO deben reintentarse**, y por eso están ahora en la
  > lista de excepciones:
  >
  > - **440 `connectionReplaced`** — no es un corte, es un **desalojo**: otra sesión de WhatsApp Web
  >   tomó el slot. Reconectar es jugar ping-pong con el otro cliente y, como cada conexión
  >   **exitosa** resetea el contador de intentos, el backoff ni siquiera protege: el loop queda
  >   pegado en 2 s para siempre sin escalar nunca a 60.
  > - **403 `forbidden`** — WhatsApp rechazó la conexión de esta cuenta. Reintentar solo no la
  >   destraba.
  >
  > En los dos casos el sistema **frena en seco sin borrar credenciales** (siguen sirviendo) y la
  > salida es **manual**, con la tecla de reconexión de CA-15.5. Que el usuario se entere de eso es
  > CA-16.5.
- **CA-15.3** — MIENTRAS el sistema esté reintentando, EL SISTEMA DEBERÁ mostrar en el encabezado
  cuántos intentos lleva y cuánto falta para el próximo, y DEBERÁ mantener la TUI navegable.
- **CA-15.4** — CUANDO la conexión se restablece, EL SISTEMA DEBERÁ resetear el contador de intentos,
  volver a habilitar el envío y sincronizar los mensajes que llegaron durante el corte.
- **CA-15.5** — CUANDO el usuario presiona la tecla de reconexión manual, EL SISTEMA DEBERÁ intentar
  conectar en el acto, salteando la espera del backoff.
- **CA-15.6** — SI un socket viejo emite eventos después de haber sido reemplazado, ENTONCES EL
  SISTEMA DEBERÁ ignorarlos (no persistir mensajes, no cambiar el estado de la UI, no tocar
  credenciales).
- **CA-15.7** — MIENTRAS haya reintentos en curso, EL SISTEMA NO DEBERÁ abrir más de un socket de
  WhatsApp a la vez.
- **CA-15.8** — EL SISTEMA NO DEBERÁ marcar la cuenta como "en línea" en WhatsApp por el solo hecho de
  estar corriendo.

#### 16. Enterarme de qué pasó cuando algo falla

**Como** usuario que debuguea, **quiero** un log en archivo, **para** entender un corte sin ensuciar
la pantalla.

- **CA-16.1** — CUANDO ocurre un evento relevante (conexión abierta/cerrada con su código, fallo de
  envío, error de base, re-vinculación), EL SISTEMA DEBERÁ registrarlo con timestamp en un archivo de
  log bajo el directorio de estado del usuario.
- **CA-16.2** — MIENTRAS la TUI esté renderizando, EL SISTEMA NO DEBERÁ escribir logs, warnings ni
  stack traces en la pantalla fuera de los espacios previstos por la interfaz.
- **CA-16.3** — CUANDO el usuario presiona la tecla de ayuda, EL SISTEMA DEBERÁ mostrar la ruta del
  archivo de log junto con la lista de atajos.
- **CA-16.4** — CUANDO el archivo de log supera los 5 MB, EL SISTEMA DEBERÁ rotarlo conservando como
  máximo un archivo anterior.
- **CA-16.5** — CUANDO la conexión se cierra con uno de los códigos que **no** se reintentan
  (`connectionReplaced`, `forbidden`; ver la enmienda de CA-15.2), EL SISTEMA DEBERÁ mostrar en
  pantalla, de forma persistente, el motivo por el que dejó de reconectar y la tecla que lo destraba.

  > ⚠️ **CA nuevo (tarea 18)**, hermano de la enmienda de CA-15.2. Sin esto, un cierre que frena en
  > seco queda **mudo**: la sesión sigue vinculada, la pantalla dice "sin conexión" y no hay nada que
  > le diga al usuario que la salida es apretar la tecla de reconexión. Lo cumple `ui.connBanner`, la
  > línea del encabezado que espeja el motivo y se limpia sola cuando la conexión vuelve a abrir.

---

### Área I — Ciclo de vida del proceso

#### 17. Salir limpio

**Como** usuario, **quiero** cerrar wacosas y que la terminal quede usable, **para** no tener que
hacer `reset`.

- **CA-17.1** — CUANDO el usuario presiona `Ctrl-C` o `Ctrl-Q`, EL SISTEMA DEBERÁ iniciar el cierre
  ordenado: cerrar el socket de WhatsApp **sin** hacer logout, cerrar la base y terminar el proceso.
- **CA-17.2** — CUANDO el proceso termina, EL SISTEMA DEBERÁ restaurar la terminal (salir de la
  pantalla alternativa, desactivar el tracking del mouse y volver a mostrar el cursor), dejando el
  prompt utilizable sin comandos extra.
- **CA-17.3** — CUANDO se completa el cierre ordenado, EL SISTEMA DEBERÁ salir con código 0.
- **CA-17.4** — SI el cierre del socket no responde en **2 segundos**, ENTONCES EL SISTEMA DEBERÁ
  terminar igual, sin colgarse.
- **CA-17.5** — CUANDO el proceso recibe `SIGTERM` o `SIGINT` (por ejemplo al cerrar la pane de tmux),
  EL SISTEMA DEBERÁ aplicar el mismo cierre ordenado que CA-17.1.
- **CA-17.6** — CUANDO el proceso termina por cualquier vía, EL SISTEMA NO DEBERÁ borrar las
  credenciales ni la base local.
- **CA-17.7** — SI hay un envío en vuelo al momento de salir, ENTONCES EL SISTEMA DEBERÁ esperarlo
  hasta el mismo tope de 2 s y, si no resolvió, dejarlo persistido como `⚠ falló`.

#### 18. Evitar dos instancias sobre la misma sesión

**Como** usuario con varias panes de tmux, **quiero** que wacosas no se pise a sí mismo, **para** no
romper la sesión de WhatsApp ni la base.

- **CA-18.1** — CUANDO wacosas arranca, EL SISTEMA DEBERÁ verificar que no haya otra instancia viva
  sobre el mismo directorio de datos.
- **CA-18.2** — SI ya hay otra instancia viva, ENTONCES EL SISTEMA DEBERÁ avisarlo en una línea y salir
  con código distinto de 0, sin abrir socket ni tocar credenciales.
- **CA-18.3** — CUANDO una instancia anterior murió sin limpiar su marca, EL SISTEMA DEBERÁ detectar
  que el proceso ya no existe y arrancar normalmente.
- **CA-18.4** — CUANDO una instancia termina, EL SISTEMA DEBERÁ liberar la marca de instancia única.

---

### Área J — UX general (estilo miscosas)

#### 19. Sentir la misma TUI que miscosas

**Como** usuario de miscosas, **quiero** el mismo layout, atajos y trato del mouse, **para** no tener
que aprender nada nuevo.

- **CA-19.1** — CUANDO wacosas está en su vista principal, EL SISTEMA DEBERÁ mostrar dos paneles:
  bandeja de chats a la izquierda y conversación a la derecha, con encabezado (marca, filtros con
  contadores, estado de conexión) y pie con las teclas.
- **CA-19.2** — CUANDO wacosas arranca sin `--no-splash`, EL SISTEMA DEBERÁ mostrar una animación de
  arranque de duración acotada (≤ 1,5 s), que DEBERÁ poder saltearse con cualquier tecla.
- **CA-19.3** — CUANDO el usuario presiona la tecla de ayuda, EL SISTEMA DEBERÁ mostrar todos los
  atajos vigentes, y DEBERÁ cerrarse con `Esc`.
- **CA-19.4** — CUANDO el usuario redimensiona la terminal, EL SISTEMA DEBERÁ re-maquetar sin dejar
  restos de render ni perder el chat seleccionado.
- **CA-19.5** — CUANDO una acción produce un resultado que no es visible por sí solo (marcado como
  leído, reconexión manual, envío fallado), EL SISTEMA DEBERÁ mostrar un aviso efímero que desaparece
  solo en ≤ 3 s.
- **CA-19.6** — CUANDO se instala wacosas, EL SISTEMA DEBERÁ poder lanzarse con un comando corto desde
  `~/.local/bin`, sin tener que `cd` al repo.
- **CA-19.7** — CUANDO el mouse pasa o hace click sobre una fila, EL SISTEMA NO DEBERÁ permitir que el
  texto se envuelva y rompa la altura de la fila.

---

## Restricciones no funcionales

Derivadas del spike de compatibilidad y del entorno real de uso (pane de tmux, terminal chica).
También son verificables.

- **RNF-1 (tamaño mínimo)** — EL SISTEMA DEBERÁ ser usable en una terminal de **80 columnas × 24
  filas**: bandeja, conversación, envío y búsqueda funcionan a ese tamaño.
- **RNF-2 (tamaño insuficiente)** — SI la terminal tiene menos de **60 columnas o menos de 15 filas**,
  ENTONCES EL SISTEMA DEBERÁ mostrar un mensaje pidiendo agrandarla en vez de renderizar un layout
  roto, y DEBERÁ recuperarse solo al agrandarla.
- **RNF-3 (QR y terminal chica)** — EL SISTEMA DEBERÁ tratar el código de emparejamiento de 8
  caracteres como camino de vinculación de primera clase, no como fallback escondido: el QR
  compacto ocupa 34 × 67 y no entra en la terminal habitual del usuario (24 × 80).
- **RNF-4 (ruido de stdout)** — EL SISTEMA DEBERÁ suprimir o redirigir al log los warnings de Bun
  `ws.WebSocket 'upgrade' event is not implemented in bun` y `'unexpected-response'`, de modo que
  jamás aparezcan sobre el render de la TUI.
- **RNF-5 (render no bloqueante)** — MIENTRAS haya I/O de red en curso (conexión, envío, sync), EL
  SISTEMA DEBERÁ seguir respondiendo al teclado: ninguna interacción puede quedar bloqueada más de
  **100 ms** esperando la red.
- **RNF-6 (I/O de base no bloqueante para el usuario)** — CUANDO se persiste o se busca en la base, EL
  SISTEMA DEBERÁ mantener la navegación fluida: mover la selección debe responder en **≤ 50 ms** con
  50.000 mensajes persistidos.
- **RNF-7 (búsqueda)** — CUANDO el usuario tipea en la búsqueda global, EL SISTEMA DEBERÁ aplicar un
  debounce de ~120 ms y devolver resultados en **≤ 200 ms** sobre 50.000 mensajes.
- **RNF-8 (rate limiting de envíos)** — EL SISTEMA DEBERÁ serializar los envíos y respetar un mínimo de
  **1 segundo** entre mensajes y un tope de **20 mensajes por minuto**; SI el usuario supera ese
  ritmo, ENTONCES EL SISTEMA DEBERÁ encolar los mensajes mostrándolos como `⏳ enviando` en vez de
  dispararlos todos juntos.
- **RNF-9 (reintentos acotados)** — EL SISTEMA NO DEBERÁ reintentar automáticamente un envío fallido
  más de **3 veces** con backoff; agotados los reintentos, el mensaje queda en `⚠ falló` y el
  reintento pasa a ser una acción del usuario.
- **RNF-10 (versión de WhatsApp Web)** — EL SISTEMA DEBERÁ resolver la versión vigente de WhatsApp Web
  en cada arranque antes de abrir el socket (evita el corte 405 sin QR).
- **RNF-11 (una sola conexión)** — EL SISTEMA NO DEBERÁ mantener más de un socket de WhatsApp abierto
  por proceso ni más de un proceso por directorio de datos.
- **RNF-12 (privacidad local)** — EL SISTEMA DEBERÁ dejar la base y las credenciales solo accesibles al
  usuario dueño; la base **no** se cifra en v1 y eso DEBERÁ estar dicho en el README.
- **RNF-13 (runtime)** — EL SISTEMA DEBERÁ correr con **Bun** (`bun run`); no se soporta Node como
  runtime (OpenTUI usa FFI nativo que en Node no levanta).
- **RNF-14 (arranque)** — CUANDO se ejecuta el comando, EL SISTEMA DEBERÁ levantar TUI y WhatsApp en un
  único proceso; no debe requerirse arrancar un servicio aparte.

---

## Preguntas abiertas

1. **Historial inicial al vincular.** Se asumió que la bandeja se puebla con lo que WhatsApp entregue
   en el sync inicial (sin pedir el historial completo) — si no, la bandeja arrancaría vacía y sería
   inusable. Falta confirmar si querés además el sync de historial completo, que es más pesado y
   demora el primer arranque.
2. **Recibos de lectura.** Se asumió que marcar como leído **sí** envía el recibo a WhatsApp
   (comportamiento de un cliente real, el otro ve el doble tilde azul), con opción de desactivarlo por
   configuración (CA-11.3). Si preferís leer "invisible" por defecto, se invierte el default.
3. **Ritmo de envío.** El 1 mensaje/segundo y 20/minuto de RNF-8 son un techo conservador elegido acá
   para no arriesgar un ban; no salen de un límite documentado de WhatsApp.
4. **Tamaño de página de la conversación.** Los 200 mensajes iniciales de CA-6.8 son una elección
   propia; se puede ajustar si querés más contexto al abrir un chat.
5. **Notificaciones.** Quedaron fuera de alcance (sin `notify-send` ni campanita), asumiendo que la
   TUI vive a la vista en una pane. Si querés aviso cuando está tapada, es una historia nueva.
