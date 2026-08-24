# wacosas

Cliente de WhatsApp en la terminal (TUI), en un solo proceso: interfaz y conexión juntas, sin
servicio aparte. Corre con **Bun**.

> ## ⚠️ Aviso: la base local **NO se cifra**
>
> Todo el historial (chats, mensajes, contadores) vive en un SQLite en claro y las credenciales de
> sesión de WhatsApp quedan en archivos en tu disco. wacosas los deja con permisos privados
> —directorios `0700`, archivos `0600`, sólo tu usuario— pero **cualquiera que entre con tu usuario,
> o que se lleve el disco, puede leer todo**. En la v1 no hay cifrado en reposo. Si eso no te sirve,
> no lo instales en una máquina compartida.

**Estado: en construcción.** Hoy está el andamio (rutas, permisos, instalador y el entry con sus
flags). La interfaz, la base y la conexión con WhatsApp se van sumando en las tareas siguientes del
plan que vive en `.sdd/wa-tui/`.

## Requisitos

- **Bun ≥ 1.3** — es el único runtime soportado. Con Node no arranca: OpenTUI usa FFI nativo que en
  Node no levanta.
- Linux con una terminal de al menos **80 × 24** (abajo de 60 × 15 te va a pedir que la agrandes).

## Instalación

```bash
git clone <repo> wacosas && cd wacosas
./install.sh
```

El instalador es idempotente y **no usa sudo**: podés correrlo las veces que quieras. Instala las
dependencias y deja en `~/.local/bin` el comando `wacosas` y el alias corto `wa`, así lo abrís desde
cualquier lado sin `cd` al repo.

> **¿Por qué `wa` y no `wc`?** El plan original pedía `wc` como alias, pero `wc` es el *word count* de
> coreutils: ponerlo en el PATH antes que el binario del sistema rompe scripts ajenos. El alias corto
> es `wa`, que está libre.

## Uso

```bash
wacosas               # abre la TUI
wacosas --no-splash   # sin animación de arranque, directo a la bandeja
wacosas --qr-png      # además de dibujarlo, escribe cada QR como PNG
wacosas --version     # imprime la versión y sale
wacosas --help        # ayuda
```

### `--qr-png[=RUTA]` — escanear el QR cuando no entra en la terminal

El QR de WhatsApp mide **34 filas × 67 columnas**: en una pane de 80×24 no entra, y por eso wacosas
ofrece el código de emparejamiento. Si igual querés el QR y agrandar la terminal no es opción,
arrancá con `--qr-png`: cada QR que emite WhatsApp se escribe **además** como imagen
(`~/.local/share/wacosas/qr.png` por defecto, o la ruta que le pases con `--qr-png=/tmp/qr.png`), con
permisos `0600`. Lo abrís con cualquier visor, escaneás desde ahí y **la vinculación la sigue
manejando la app**: el cierre `restartRequired` (515) que llega justo después del escaneo lo reconecta
el controlador solo, que es lo que deja la sesión completa.

El archivo se pisa en cada rotación del QR (cada 20-60 s): siempre tiene el vigente. Si el visor no
recarga solo, volvé a abrirlo. Si el PNG no se puede escribir (disco lleno, permisos), queda una línea
en el log y la vinculación sigue andando por pantalla.

## Dónde quedan las cosas

Se respeta XDG; si no tenés las variables seteadas, los defaults son:

| Qué | Ruta |
| --- | --- |
| Base SQLite | `~/.local/share/wacosas/wacosas.sqlite` |
| Credenciales de sesión | `~/.local/share/wacosas/creds/` |
| Configuración | `~/.local/share/wacosas/config.json` |
| Código del candado (hash) | `~/.local/share/wacosas/lock-code.json` |
| QR como PNG (sólo con `--qr-png`) | `~/.local/share/wacosas/qr.png` |
| Log | `~/.local/state/wacosas/wacosas.log` |

Los directorios de datos y de estado se crean solos al arrancar, con permisos `0700`.

Para desvincular la sesión y empezar de cero: cerrá wacosas y borrá `~/.local/share/wacosas/creds/`.

## Configuración

No hay pantalla de ajustes: `config.json` se edita a mano y se lee **una vez, al arrancar** (o sea
que hay que reiniciar wacosas para que un cambio tome efecto). No existir es normal: sin el archivo
valen los defaults. Si el JSON está mal formado se usan los defaults y queda una línea en el log.

```json
{ "readReceipts": true }
```

| Clave | Default | Qué hace |
| --- | --- | --- |
| `readReceipts` | `true` | Manda el recibo de lectura a WhatsApp cuando marcás un chat como leído — o sea, **el otro te ve el doble tilde azul**. En `false` el chat se marca leído sólo en tu máquina y no sale ni una llamada a WhatsApp. |

## Teclas

Pendiente: se documentan cuando esté la interfaz (tarea 18 del plan).

## Arquitectura

Pendiente: resumen de los módulos y sus límites (tarea 18 del plan). Por ahora, el diseño completo
está en `.sdd/wa-tui/design.md`.

## Limitaciones conocidas

### Un mismo contacto puede aparecerte como dos chats (`@lid`)

WhatsApp está migrando a un identificador que **no** es el número de teléfono, el **LID**
(`1234567890@lid`), pensado para no revelarle tu número a quien no lo tiene. Baileys 7 arma el chat
con el identificador que venga en el sobre —a veces el número, a veces el lid— y deja el otro al lado,
en `key.remoteJidAlt`.

wacosas **no fusiona las dos identidades**: cada una es un chat distinto en la base. Si el mismo
contacto te escribe una vez desde cada una, lo vas a ver dos veces en la bandeja, con el historial
partido. Los chats con lid se listan como `~1234567890` —con `~` y **sin** el `+`— justamente para
que se note que eso no es un número al que puedas llamar.

**Lo que sí se comparte entre las dos identidades es el NOMBRE**, y no es un detalle: WhatsApp manda
los nombres de tu agenda pegados al lid, mientras que muchos chats vienen bajo el número, así que sin
esto la bandeja te mostraba números casi en todos lados. wacosas anota la equivalencia
`lid ↔ número` cuando la ve —viene en el sobre de cada mensaje, en la ficha de cada contacto y en la
sincronización inicial— y le presta el nombre a la identidad que no lo tiene. Para los chats que ya
estaban guardados sin nombre, al conectar hace un barrido preguntándole a Baileys por la identidad
hermana: es una consulta **local** (lee `creds/`, no manda nada a WhatsApp), en lotes espaciados y una
sola vez por identidad.

Por qué la fusión no se resolvió: fusionarlas de verdad no es leer un campo más. Hay que elegir una identidad
canónica, **mover** los mensajes ya persistidos de un `chat_jid` al otro, sumar los contadores de no
leídos, y que el envío salga siempre por la identidad que el otro lado espera. Es una migración de
datos, no un ajuste de la vista, y se hace mal si se hace a medias. Queda anotado como el riesgo R7
del diseño.

### La agenda puede llegar incompleta (y `Ctrl-N` para volver a pedirla)

Los nombres de tu agenda no viajan con los chats: WhatsApp los manda por **app-state**, cinco
colecciones aparte que se sincronizan por su cuenta. Baileys las sincroniza **una sola vez**, en la
primera conexión después de vincular; si eso no sale bien —se corta la red, cerrás la app en el medio,
o se pasa el tope de 20 s que Baileys se da a sí mismo—, el contador interno igual queda marcado como
"ya sincronizado" y **no se vuelve a intentar nunca**, ni reiniciando. Cuando pasa, la bandeja te
muestra números en vez de nombres: en la cuenta con la que se encontró esto eran 844 contactos con
sólo 32 nombres.

wacosas lo repara solo: **30 segundos después de conectar** mira qué colecciones no tienen datos en
`creds/` y le pide a WhatsApp **sólo esas**. Si la sincronización de Baileys anduvo bien, no encuentra
nada que pedir y no manda ni una consulta. Está topeado (tres reparaciones por proceso, una por
conexión) y se apaga solo si dos intentos seguidos no traen nada nuevo: es una reparación, no un
reintento en loop.

Queda un caso que **no se puede arreglar del lado de la app**. A veces WhatsApp manda una colección
cifrada con una clave que tu teléfono todavía no compartió; Baileys la reintenta dos veces y la deja
"estacionada". Esa clave sólo la manda el teléfono cuando quiere —no hay forma de pedirla— así que
insistir automáticamente sería martillar sin poder ganar nunca. Para eso está **`Ctrl-N`**: vuelve a
pedir las cinco colecciones a mano, que es lo único que destraba una estacionada si la clave llegó. Si
después de un `Ctrl-N` seguís viendo números, la clave no llegó: la salida es desvincular y volver a
vincular (`~/.local/share/wacosas/creds/`), que le pide todo de cero al teléfono.

Todo esto queda en el log (`appstate.*`), con qué se pidió y qué entró.

### Los chats con candado (y los bloqueados) no se listan

Si escondiste un chat detrás de un código secreto en el teléfono (**Chat Lock**), en wacosas **no
aparece**: ni en la bandeja, ni en los contadores de arriba, ni en los resultados de `Ctrl-G` — ni
siquiera si lo tenías abierto cuando llegó el candado (ahí la conversación se vacía sola). Lo mismo
con los **contactos bloqueados** (WhatsApp sí te los deja en la lista; wacosas no).

**No se borra nada.** El chat y todos sus mensajes siguen en la base: en cuanto le saques el candado
—o desbloquees a la persona— desde el teléfono, vuelve a la bandeja con su historial completo. El
estado llega por WhatsApp (`chats.lock` y la lista de bloqueados al conectar), así que puede tardar
unos segundos después de vincular.

#### Verlos: escribí tu código en el buscador de la bandeja

Igual que en WhatsApp: **escribís tus dígitos en el buscador de la bandeja** (el campo que ya está
enfocado, no hay que apretar nada antes) y los chats con candado aparecen mientras dure. El campo se
vacía solo en cuanto el código coincide —así los dígitos no quedan en pantalla— y el título del panel
pasa a decir `chats N · candado`, que es la única forma de saber que están a la vista. **`Esc` los
vuelve a esconder** (y cierra el chat con candado que hayas abierto).

Un código que no coincide no hace nada: se queda ahí filtrando como cualquier otra búsqueda. No hay
ningún "código incorrecto" en pantalla, a propósito — que exista un código es algo que sabe el que lo
puso.

**La primera vez hay que fijarlo, con `Ctrl-P`.** Se escribe dos veces (no se ve: se pintan `•`) y
queda guardado. Usá **los mismos dígitos que ya usás en WhatsApp**: la idea es no obligarte a
recordar un código nuevo. Sólo dígitos, entre 4 y 16. `Ctrl-P` de nuevo lo reemplaza.

Los **bloqueados no se revelan nunca**: el código es del candado. Alguien bloqueado no es un chat
escondido detrás de un código, es una persona con la que decidiste no hablar.

#### Qué es y qué NO es este código

**No es el código de WhatsApp verificado contra WhatsApp.** El de Chat Lock viaja en el protocolo
como `UserPassword` con PBKDF2, pero **Baileys nunca emite `chatLockSettings`**, así que ese material
no nos llega: wacosas guarda el hash de *los mismos dígitos* y compara contra **su** copia local. Dos
consecuencias:

- **si cambiás el código en el teléfono, wacosas no se entera**: volvé a fijarlo con `Ctrl-P`;
- **es más débil que el candado del teléfono**, donde hay biometría y el sistema operativo. Acá es un
  hash en un disco donde **la base de mensajes está sin cifrar**.

Cómo se guarda: `~/.local/share/wacosas/lock-code.json`, permisos `0600`, con una **sal aleatoria** y
el código derivado con **scrypt** (`N=16384, r=8, p=1`); los dígitos no se escriben en ningún lado —ni
ahí, ni en el log— y la comparación es en tiempo constante. Si el archivo se rompe o lo borrás, es
como si no hubiera código: los chats con candado se quedan escondidos hasta que fijes uno nuevo.

**El alcance, dicho claro:** esto sirve contra una mirada de reojo a la terminal. **No** sirve contra
alguien que ya está sentado en tu sesión: esa persona puede volver a fijar el código con `Ctrl-P`
(no se pide el anterior, justamente para que no te quedes afuera si lo olvidás) y, sobre todo, puede
abrir la base con `sqlite3` y leer todo sin preguntarle nada a nadie.

### El resto

Pendiente de completar en la tarea 18 (ventana fija de mensajes, alcance de la búsqueda global,
atajos que chocan con tmux).
