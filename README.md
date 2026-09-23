# wacosas

Cliente de WhatsApp en la terminal (TUI), en un solo proceso: interfaz y conexión juntas, sin
servicio aparte. Corre con **Bun**.

> ## ⚠️ Cliente NO oficial: te pueden banear la cuenta
>
> wacosas **no está afiliado, asociado ni respaldado por WhatsApp LLC ni por Meta**. "WhatsApp" es
> marca de ellos; acá no hay ningún acuerdo ni bendición de por medio.
>
> Es un cliente **no oficial**, construido sobre [Baileys](https://github.com/WhiskeySockets/Baileys),
> que es una implementación de **ingeniería inversa** del protocolo de WhatsApp Web. Usar un cliente
> no oficial **puede violar los Términos de Servicio de WhatsApp**, y eso **puede terminar en que te
> suspendan o te baneen la cuenta**. No es un riesgo teórico ni una fórmula para cubrirse: es el
> riesgo real que corrés, y lo corrés vos.
>
> El software se entrega **como está**, sin garantía de ningún tipo (ver [`LICENSE`](LICENSE)).

> ## ⚠️ Aviso: la base local **NO se cifra**
>
> Todo el historial (chats, mensajes, contadores) vive en un SQLite en claro y las credenciales de
> sesión de WhatsApp quedan en archivos en tu disco. wacosas los deja con permisos privados
> —directorios `0700`, archivos `0600`, sólo tu usuario— pero **cualquiera que entre con tu usuario,
> o que se lleve el disco, puede leer todo**. En la v1 no hay cifrado en reposo. Si eso no te sirve,
> no lo instales en una máquina compartida.
>
> Desde que se pueden **ver las imágenes** (`Ctrl-O`), en esa base también va, por cada imagen
> recibida, la **clave con la que se descifra** el archivo en el servidor de WhatsApp. O sea que quien
> pueda leer el `.sqlite` puede además **bajarse las fotos** mientras WhatsApp las siga sirviendo. Es
> una ampliación real de lo que ya quedaba expuesto, y está acá para que la sepas: el archivo en sí
> se guarda cuando su foto entra en la conversación visible (o cuando la ampliás).

**Estado: usable.** Vincula, sincroniza el historial, lista la bandeja, abre conversaciones, envía
texto, marca leído, busca en todo lo guardado y sale limpio. Lo que **no** hace está en
[Limitaciones conocidas](#limitaciones-conocidas) — leelas antes de esperar algo que no está.

## Requisitos

- **Bun ≥ 1.3** — es el único runtime soportado. Con Node no arranca: OpenTUI usa FFI nativo que en
  Node no levanta.
- Linux con una terminal de al menos **80 × 24** (abajo de 60 × 15 te va a pedir que la agrandes).
- *(opcional)* **`wl-clipboard`** —o `xclip` en X11— para pegar imágenes con `Ctrl-V`. Sin ninguno de
  los dos, todo lo demás anda igual y `Ctrl-V` te avisa que le falta el comando.
- *(opcional)* **`chafa`** para preparar fotos inline y avatares reales. Para píxeles inline hace
  falta **Ghostty directo, sin tmux**, y una respuesta positiva a la consulta Kitty. No alcanza
  con la variable `TERM_PROGRAM`. Sin soporte se muestra un aviso, no bloques disfrazados de fotos;
  `Ctrl-O` conserva el visor ampliado y `o` abre el visor del sistema (`xdg-open`).

## Instalación

```bash
git clone https://github.com/gonzalonicolasr/wacosas.git && cd wacosas
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

### La primera vez: vincular

Al arrancar sin sesión, wacosas te muestra la pantalla de vinculación y **elige el método por el
tamaño de tu terminal**:

- **QR** si entra (necesita **67 × 34**, o sea una terminal grande);
- **código de emparejamiento** de 8 caracteres si no: escribís tu número con el código de país y sin
  `+`, y lo tipeás en el teléfono (*Dispositivos vinculados → Vincular con número de teléfono*).

`Tab` alterna entre los dos cuando quieras. Con el código a la vista, `Ctrl-R` pide otro y `Esc`
vuelve al campo del número (WhatsApp devuelve un código para **cualquier** número bien formado: no
valida que sea tuyo, así que un dígito de más te deja esperando un código que tu teléfono nunca te va
a pedir). Después del escaneo, WhatsApp cierra la conexión a propósito y wacosas la reabre sola: eso
es lo que deja la sesión completa, no lo interrumpas.

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
| Marca de instancia única | `~/.local/share/wacosas/wacosas.lock` |
| Imágenes visibles y ampliaciones (`Ctrl-O`) | `~/.local/share/wacosas/media/` |
| Fotos de perfil de la bandeja | `~/.local/share/wacosas/avatars/` |
| Log | `~/.local/state/wacosas/wacosas.log` (+ `.log.1`) |

Los directorios se crean solos al arrancar, con permisos `0700`, y los archivos con `0600`.

**`media/` y `avatars/` son caché descartable**: borralos cuando quieras y no perdés nada —lo único
que pasa es que la próxima vez se vuelven a bajar—. `media/` contiene las imágenes que entraron en el área visible de una conversación y las que
ampliaste con `Ctrl-O`. Si el mensaje trae una miniatura JPEG, se usa esa primero y el original
no se baja hasta ampliar. `avatars/` contiene las fotos de perfil de las filas visibles. Estas
cachés de disco no tienen límite global ni borrado automático.

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

Todas las vigentes. En la app las tenés con **`?`** (se abre sólo con el buscador vacío; con texto
tipeado el `?` es un carácter más).

### En cualquier lado

| Tecla | Qué hace |
| --- | --- |
| `?` | abrir / cerrar la ayuda |
| `Ctrl-R` | reconectar **ya**, sin esperar el backoff. En la pantalla de vinculación con el código a la vista, pide **otro** código |
| `Ctrl-N` | volver a pedirle a WhatsApp las colecciones de app-state (los **nombres de la agenda**, los candados). Ver la limitación de más abajo |
| `Ctrl-C` · `Ctrl-Q` | salir ordenado. Un **segundo** `Ctrl-C` sale en el acto, sin esperar nada |

### En la bandeja

| Tecla | Qué hace |
| --- | --- |
| *(escribir)* | filtra la lista por nombre o número — el buscador está **siempre** enfocado, no hay que apretar nada |
| `Ctrl-G` | búsqueda global en todo el historial |
| `↑` `↓` · `Ctrl-K` `Ctrl-J` | mover la selección (la rueda del mouse también) |
| `PgUp` `PgDn` | saltar una pantalla · `Inicio` `Fin` van a las puntas |
| `⏎` | abrir el chat (o **doble click**; un click solo lo selecciona) |
| `Ctrl-L` | marcarlo leído **sin** abrirlo |
| `Tab` | ciclar el filtro: Todos → No leídos → Grupos (los tabs también se clickean) |
| `Esc` | limpiar el buscador · volver a esconder los chats con candado · en terminal angosta, volver de panel |
| `Ctrl-P` | fijar el código que revela los chats con candado |
| `Ctrl-X` | esconder a mano el chat seleccionado — **dos veces**: la primera pregunta en el pie, la segunda esconde |
| *(tu código)* | escrito en el buscador, revela los chats con candado |

### En la conversación

| Tecla | Qué hace |
| --- | --- |
| `Shift-↑` `Shift-↓` | scrollear el chat línea a línea |
| `Shift-PgUp` `Shift-PgDn` | media página · `Shift-Inicio` `Shift-Fin` a las puntas |
| `Ctrl-E` | enfocar el campo de redacción |
| `⏎` | **enviar** |
| `Alt-⏎` | salto de línea dentro del mensaje |
| `Ctrl-V` | **pegar**: si hay una imagen copiada, **la manda**; si hay texto, lo escribe en el campo |
| `Ctrl-O` | **ver las imágenes del chat** (pantalla aparte) |
| `Esc` | volver a la bandeja **conservando el borrador** |
| `Ctrl-Y` | reintentar el último envío que falló en ese chat |

### Mirando una imagen (`Ctrl-O`)

| Tecla | Qué hace |
| --- | --- |
| `←` `→` | la imagen anterior / la siguiente (`↑` `↓` hacen lo mismo) |
| `Inicio` `Fin` | la más nueva / la más vieja |
| `o` | abrirla en el **visor del sistema** (`xdg-open`) |
| `Esc` · `Ctrl-O` | cerrar y volver a la conversación |

> **`Shift-PgUp` te lo puede robar tmux** (entra en copy-mode antes que la app). Si te pasa:
> `tmux unbind -n S-PPage` (y `S-NPage`). `Shift-↑`/`Shift-↓` no lo intercepta nadie.
>
> **`Ctrl-K`/`Ctrl-J`** andan en cualquier terminal: sin el protocolo de teclado kitty, `Ctrl-J` llega
> como *linefeed* y se distingue igual de `⏎`. Las flechas son el camino de siempre.

#### `Ctrl-V`: pegar una imagen del portapapeles

Copiás una captura (`Print`, un `grim -g`, `Ctrl-C` sobre una imagen del navegador), abrís el chat,
`Ctrl-E` para escribir y **`Ctrl-V`**. Si además tenías algo escrito en el campo, ese texto viaja como
**epígrafe** de la imagen, que es lo que hace WhatsApp.

**Lo contraintuitivo, por si algún día parece un bug:** una terminal **no le puede pasar una imagen a
una aplicación de terminal**. El pegado de la terminal (*bracketed paste*) entrega **texto** y nada
más. Así que `Ctrl-V` no *recibe* la imagen: es la tecla con la que le decís a wacosas que salga
**él** a leer el portapapeles del sistema. Por eso hace falta que tengas instalado uno de estos:

| Backend | Sirve para | Dónde |
| --- | --- | --- |
| **`wl-paste`** (paquete `wl-clipboard`) | **imágenes** y texto | Wayland |
| **`xclip`** | **imágenes** y texto | X11 |
| `xsel` | sólo texto | X11 |
| `pbpaste` | sólo texto | macOS |

Se usa **el primero que exista**, en ese orden. Si no hay ninguno, `Ctrl-V` te lo dice en el pie y no
pasa nada más. Con `xsel` o `pbpaste` el pegado de **texto** anda igual; el de imágenes no.

Lo que **no** puede hacer `Ctrl-V`:

- **mandar un texto solo.** Si en el portapapeles hay texto, se escribe en el campo y ahí se queda:
  mandarlo sigue siendo `⏎`. La única acción irreversible está siempre detrás de la misma tecla.
- **mandar algo de un chat en el que ya no estás.** Leer el portapapeles tarda (hasta 3 s si el
  backend no contesta); si en el medio cambiaste de chat, el pegado se descarta.
- **subir cualquier cosa.** Los bytes se validan por su **firma** (PNG, JPEG, GIF, WebP), no por lo
  que el portapapeles diga tener, y **arriba de 16 MB se rechaza antes de subir nada**.

### En la búsqueda global (`Ctrl-G`)

Escribís y la lista se arma sola (chats por nombre arriba, mensajes abajo). `↑`/`↓` —o `Ctrl-K`/
`Ctrl-J`, `PgUp`/`PgDn`, `Inicio`/`Fin`— mueven; **`⏎`** abre el chat **posicionado en ese mensaje**,
señalado; **`Esc`** vuelve a la bandeja con el mismo chat seleccionado y el mismo filtro que tenías.

### En terminales angostas (menos de 72 columnas)

Se ve **un panel por vez**: `⏎` entra a la conversación, `Esc` vuelve a la bandeja, y ahí las flechas
y `PgUp`/`PgDn` **sin `Shift`** scrollean el chat.

## Arquitectura

Un solo proceso Bun con los dos mundos adentro y **un límite explícito** entre ellos:

- **`src/wa/`** — WhatsApp (Baileys). El socket (`socket.ts`) tiene un ciclo de vida propio con
  backoff; todo lo que llega entra por **una cola serializada** (`ingest.ts`) que escribe a SQLite de
  a chunks (400 filas u 8 ms por vuelta, lo que llegue primero), así una sincronización de miles de
  mensajes nunca traba el teclado. Los envíos salen por otra cola con rate limit (1/s, 20/min).
- **`src/db/`** — SQLite (`bun:sqlite`, WAL, FTS5) es la **fuente de verdad**: la interfaz arranca
  leyendo la base y es navegable **sin conexión**. WhatsApp es un productor de eventos, no un
  requisito para que la app funcione.
- **`src/state/`** — un store externo con notificación **coalescida** (como mucho un render cada
  33 ms). React lo lee con `useSyncExternalStore` por *slice* y es dueño sólo de lo que no toca ni la
  red ni el disco. La UI habla con la máquina por un único módulo de comandos.
- **`src/ui/`** — OpenTUI + React. Un solo manejador de teclado que rutea por modo.
- **`src/boot/`** — rutas XDG, permisos, log con rotación, instancia única, cierre ordenado y los dos
  procesos externos: la lectura del portapapeles (`clipboard.ts`, `wl-paste` y compañía) y la
  conversión de imágenes a celdas de color (`chafa.ts`). Los dos con timeout y tope de tamaño, porque
  un proceso externo puede no existir, colgarse o devolver basura.

**Las fotos inline son píxeles reales, no medios bloques.** `chafa` sólo decodifica y reduce la
foto a RGBA; `boot/pixels.ts` descarta sus secuencias y transmite esos píxeles como imágenes
virtuales Kitty (`U=1`). OpenTUI dibuja los placeholders Unicode con ID/color y coordenadas de
cada celda: el mismo buffer controla scroll, recorte, capas y redibujado. No se suspende la TUI
ni se posicionan imágenes por encima del renderer. El transporte usa la salida nativa ordenada
de OpenTUI 0.4.2. El soporte se verificó en Ghostty 1.3.1 directo; tmux queda deshabilitado para
inline (no se verificó el passthrough de placeholders).

El visor aparte (`Ctrl-O`) sigue disponible: `⏎` pide calidad real a pantalla completa,
suspendiendo temporalmente la TUI, y `o` abre el original en el visor del sistema.

### El log

`~/.local/state/wacosas/wacosas.log`, rotado a `.log.1` al pasar los 5 MB. Ahí va **todo**: la
conexión con su código de cierre, los envíos, los errores de base y hasta los avisos de Baileys. Es
también el destino del `stderr` del proceso, así que ningún warning suelto te rompe la pantalla.

**Nunca se loguea el cuerpo de un mensaje ni una credencial**: los campos que acepta el logger son
escalares y la regla es explícita. Si buscás el texto de algo que mandaste, no está.

### Códigos de salida

| Código | Qué pasó |
| --- | --- |
| `0` | salida ordenada (`Ctrl-C`, `Ctrl-Q`, `SIGTERM`, `SIGINT`, `SIGHUP`) |
| `1` | segundo `Ctrl-C` (salida de apuro) o una excepción no atrapada |
| `2` | la base está corrupta (te lo dice en pantalla, con la ruta) |
| `3` | **ya hay otra instancia** corriendo sobre el mismo directorio de datos |

El `3` es a propósito distinto del `2`: un script puede diferenciarlos. La segunda instancia imprime
**una línea** con el PID de la primera y sale **sin** abrir la base, sin tocar `creds/` y sin
conectarse a WhatsApp. Si la primera murió de golpe, su marca queda huérfana y se detecta sola (se
verifica que el PID exista **y** que sea realmente wacosas, así un PID reciclado no te bloquea).

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
colecciones aparte que se sincronizan por su cuenta. Por ahí viajan también los **candados** de los
chats y los silenciados.

Baileys las sincroniza **una sola vez**, en la primera conexión después de vincular, y ahí está el
agujero: espera hasta **20 segundos** (un tope hardcodeado, no configurable) a que WhatsApp empiece a
mandar el historial y, si no llega a tiempo —una cuenta con 899 chats tarda más—, se rinde **y se
anota a sí misma que ya sincronizó** (`accountSyncCounter`, que vive en `creds.json`). Desde ese
momento, toda conexión posterior saltea el sync completo: no lo arregla reiniciar, ni esperar. Cuando
pasa, la bandeja te muestra números en vez de nombres —en la cuenta con la que se encontró esto eran
844 contactos con sólo 32 nombres— y los candados no llegan nunca.

**wacosas lo detecta y lo intenta reparar solo**: si al conectar ve que falta app-state *y* que ese
contador está en la posición que impide rehacerlo, lo pone en 0, reconecta y deja que Baileys haga su
sincronización completa como si fuera la primera vez. Se hace **una sola vez por sesión** (queda
anotado en la base) y nunca si la sincronización está sana: resetear el contador con todo en orden
sería un sync completo de más en cada arranque. En el log queda todo (`appstate.sync_completo_*`) y
también en qué terminó del lado de Baileys (`appstate.sync_baileys fase=…`).

⚠️ **Ese reset no siempre alcanza, y conviene saberlo antes de esperar magia.** Probado en vivo: con
el contador en 0, Baileys vuelve a esperar el historial, pero **el servidor no le manda ninguna
notificación de historial a un dispositivo ya vinculado**, así que vuelve a saltar el timeout de 20 s
y el contador vuelve a 1. Si además falta una **clave** de app-state (ver el párrafo siguiente), lo
único que la trae es **desvincular y volver a vincular**: esa clave la comparte el teléfono cuando
enlaza el dispositivo, y no hay forma de pedirla después. En la cuenta donde se encontró todo esto,
después de re-vincular aparecieron 3 claves donde había 2 y llegaron los 11 chats con candado. El
historial local **no se pierde** al re-vincular (la base es aparte de `creds/`).

**Actualización automática al abrir o volver a vincular (2026-09-09):** 30 segundos después de
cada conexión, wacosas pide las cinco colecciones de app-state desde sus versiones guardadas,
incluso si todas tienen estado local. Actualiza datos de chats y contactos; los mensajes pendientes
entran por los eventos normales de Baileys. No borra la base, no cierra sesión y no pide el historial
antiguo completo. Cerrar la app con `Ctrl-C` conserva la vinculación.

El pedido se cancela si la conexión se cierra antes de ejecutarlo. Las reconexiones rápidas respetan
un mínimo de 60 segundos entre actualizaciones automáticas, sin solaparse con `Ctrl-N` ni con una
reparación en curso. El pie avisa si la actualización falló o quedó parcial: no se anuncia que todo
el historial está sincronizado. Si quedan colecciones pendientes, sigue el diagnóstico y la
reparación acotada (hasta tres reparaciones por proceso), sin un bucle de reintentos ilimitado.

Contrato consultado: Baileys instalado, `lib/Socket/chats.js` (`resyncAppState` y el handler de
`receivedPendingNotifications`). La sincronización inicial al re-vincular sigue siendo la de
Baileys; esta actualización incremental no reemplaza la entrega de historial del teléfono.

Queda un caso que **puede** no tener arreglo del lado de la app. A veces WhatsApp manda una colección
cifrada con una clave que tu teléfono nunca compartió con esta sesión; Baileys la reintenta dos veces
y la deja **estacionada**. Esa clave sólo la manda el teléfono cuando quiere y Baileys no implementa
el pedido, así que lo único que se puede hacer es preguntar **de otra manera**: antes de reintentar
una colección estacionada, wacosas le borra su marcador de versión local para que la consulta pase de
"mandame los cambios desde la v68" —que son los que no se pueden descifrar— a "mandame el estado
completo", que viene con otra clave. Es la misma consulta, no una de más, y se hace una vez por
colección.

Si ni así entra, la reparación vuelve a pedirla hasta el tope de tres y frena: insistir cada 30 s
sería martillar sin poder ganar nunca. Cuando frena queda dicho en el log
(`appstate.tope_alcanzado … salida=Ctrl-N`). **`Ctrl-N`** vuelve a pedir las cinco colecciones a mano,
que es lo único que destraba una estacionada si la clave llegó.

#### Receta: la bandeja muestra números en vez de nombres

En orden, de lo barato a lo definitivo:

1. **Esperá 30 segundos** después de conectar. La reparación automática corre sola y en muchos casos
   alcanza. Mirá el log: `grep appstate ~/.local/state/wacosas/wacosas.log`.
2. **`Ctrl-N`.** Vuelve a pedir las cinco colecciones a mano. Es lo único que destraba una colección
   estacionada **si la clave ya llegó**.
3. **Re-vinculá.** Si después del `Ctrl-N` seguís viendo números —o chats con candado que no se
   esconden—, es que **falta una clave de app-state**, y no hay forma de pedirla: el mensaje que
   existe para eso (`APP_STATE_SYNC_KEY_REQUEST`) está en el protocolo de WhatsApp pero **Baileys no
   lo implementa** (cero usos en la librería). Esa clave la comparte el **teléfono**, y sólo cuando
   enlaza el dispositivo. O sea:

   ```bash
   # con wacosas cerrado
   rm -rf ~/.local/share/wacosas/creds/
   wacosas          # y escaneás de nuevo
   ```

   **El historial local no se pierde**: la base es un archivo aparte de `creds/`, y lo que vuelva a
   entrar se mergea por el índice único en vez de duplicarse.

   Es lo que pasó de verdad en la cuenta con la que se desarrolló esto: después de re-vincular
   aparecieron **3 claves donde había 2** y llegaron los **11 chats con candado** que nunca habían
   bajado.

Ojo con una diferencia que el log tardó en decir bien: una colección estacionada **tiene** datos
locales (viejos), así que no alcanza con mirar si hay archivo para saber si está al día. Hoy el log
las nombra aparte (`appstate.resync_ok … resueltas=N faltan=… estacionadas=…`) y una estacionada
**nunca** cuenta como resuelta.

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
queda guardado. Sólo dígitos, entre 4 y 16. `Ctrl-P` de nuevo lo reemplaza.

La pantalla te sugiere usar **los mismos dígitos que ya usás en WhatsApp**, para no obligarte a
recordar un código nuevo, y para el uso diario está bien. Pero elegí a conciencia: el hash local es
**crackeable offline** (ver [más abajo](#el-código-del-candado-es-crackeable-offline)), así que
reusar el del teléfono significa que quien se lleve este archivo se queda **también** con el código
de tu Chat Lock. Si eso te importa, **poné acá uno distinto** — y sobre todo, no reuses el de
ninguna otra cosa (banco, PIN del teléfono).

Los **bloqueados no se revelan nunca**: el código es del candado. Alguien bloqueado no es un chat
escondido detrás de un código, es una persona con la que decidiste no hablar.

#### Esconder un chat a mano: `Ctrl-X` (la salida de emergencia)

Los candados viajan por **app-state**, o sea por el mismo camino que puede quedar estacionado (ver la
limitación de arriba). Mientras esa sincronización no se destrabe, **un chat que tenés con candado en
el teléfono se te puede ver igual en wacosas**. Lo que corresponde es que llegue solo —de eso se
ocupan las reparaciones de arriba—, pero mientras tanto esto te deja esconderlo vos.

Para eso está `Ctrl-X`: **esconde a mano el chat seleccionado**, y queda igual que uno con candado —no
aparece en la bandeja, ni en los contadores, ni en `Ctrl-G`; si lo tenías abierto, se cierra— y vuelve
con **el mismo código**. Con los chats revelados, `Ctrl-X` sobre uno escondido a mano lo **desmarca**
(eso no pregunta nada: hace aparecer un chat, no desaparecer).

Tres cosas que conviene saber:

- **hay que apretarla dos veces**: la primera pregunta en el pie (`¿ocultar «Ana»? ^X de nuevo para
  confirmar`) y la segunda esconde. La confirmación vale mientras la pregunta está en pantalla; si se
  fue, `Ctrl-X` vuelve a preguntar;
- **sin código fijado no esconde nada**: te manda a fijarlo con `Ctrl-P` primero. Si no, un chat
  escondido no tendría forma de volver;
- **no se pisa con el candado de WhatsApp**: son dos marcas distintas sobre el mismo chat. Si
  WhatsApp te levanta el candado, el chat que escondiste a mano sigue escondido; si desmarcás el
  tuyo, el candado de WhatsApp sigue en pie. Y si perdés el código, `Ctrl-P` fija uno nuevo (no se
  pide el anterior) y con ese ya podés revelar.

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

### Imágenes dentro de la conversación, sin `Ctrl-O`

Al abrir una conversación, las fotos **visibles** se cargan automáticamente y se muestran entre
los mensajes, con el epígrafe debajo. Se reserva un espacio de hasta **32 columnas × 8 filas**;
la foto conserva su proporción y usa píxeles reales dentro de ese espacio. `Ctrl-O` sigue
ampliando y recorriendo los originales; `⏎` dentro del visor pide calidad real a pantalla completa.

**Privacidad y descargas automáticas:**

- no se descarga todo el historial ni las imágenes fuera del viewport. Scroll y cambio de chat
  descartan los pedidos pendientes que dejaron de verse; una descarga ya iniciada puede terminar
  en la caché privada, pero nunca se pinta en otro chat;
- si el mensaje trae `jpegThumbnail`, se conserva esa miniatura JPEG (máximo **64 KiB**, base64 en
  el SQLite **sin cifrar**) y se usa sin pedir el original. Los mensajes viejos sin miniatura
  usan la referencia guardada para bajar el original automáticamente cuando entran en pantalla;
- los pedidos/conversiones inline son seriales, con un segundo entre trabajos y caché de hasta
  32 resultados. Las colocaciones de terminal se liberan al salir de pantalla; no quedan fotos
  flotando sobre el siguiente chat. El archivo original se deduplica y queda en `media/`;
- `media/` tiene permisos `0700` y cada archivo `0600`. Las miniaturas usan archivos separados
  (`*.thumb.jpg`), así que ampliar nunca confunde una miniatura con el original;
- sin referencia ni miniatura (historial antiguo), con archivo vencido en WhatsApp, error de red,
  falta de `chafa` o terminal sin soporte, aparece un texto explicativo. No se intenta dibujar
  bloques como reemplazo de una foto real;
- audio, video, documentos y stickers siguen sin descargarse. Los originales tienen tope de
  16 MB; no se piden reenvíos de archivos vencidos.

**Mandar** una imagen (`Ctrl-V`) es otra cosa y sigue igual: son bytes que ya elegiste vos y que van y
vuelven **en memoria**, sin tocar el disco. **Consecuencia práctica**: si una imagen que mandaste
falla, **`Ctrl-Y` no la puede reintentar** —esos bytes no están guardados en ningún lado—. Los
reintentos automáticos (1/3/9 s) sí funcionan; para uno manual hay que volver a copiarla y `Ctrl-V`
de nuevo. La app te lo dice cuando pasa.

### Fotos de perfil pequeñas al lado de cada chat

Cada fila reserva **8 columnas × 4 filas** para la foto real de perfil: a 80×24 entran menos chats
que antes, pero se ve la persona en lugar de un cuadrado teñido. Nombre, indicador de grupo,
fecha, no leídos y selección siguen al lado; `PgUp`/`PgDn` saltan esa nueva ventana visible.

Sólo se consultan las filas visibles, en serie y espaciadas a un segundo. Al scrollear, la cola
se reemplaza por las nuevas filas (no sigue bajando todos los chats recorridos). La miniatura
`preview` de WhatsApp queda en `avatars/` con permisos privados; una foto cacheada no vuelve a
consultar la red. La marca de falta de foto vale siete días. Sin foto o sin permiso aparece el
indicador de siempre; no se inventa un avatar ni se reemplaza por un promedio de color.

### Un chat abre con 500 mensajes, y no hay "cargar más"

Al abrir un chat se cargan los **últimos 500** mensajes y **eso es todo**: no hay paginado hacia
arriba. Si scrolleás hasta el principio y quedó historial más viejo, la conversación te lo dice
(`↑ hay mensajes más viejos…`) pero no hay tecla que los traiga.

**No se perdió nada**: los mensajes siguen en la base y la **búsqueda global (`Ctrl-G`) sí los
encuentra** — y abrir un resultado te posiciona ahí, con su contexto alrededor. Ése es hoy el camino
para llegar a algo viejo.

Por qué: anclar el scroll mientras se insertan filas arriba es la parte más frágil de una TUI, y en
v1 **no hay sincronización de historial viejo contra WhatsApp** —lo que hay es lo que WhatsApp
entregó—, así que una ventana más grande resuelve el 99% del uso real sin el riesgo. La consulta de
paginado (`messagesBefore`) está escrita y testeada; lo único que falta es engancharla al scroll.

### La búsqueda global mira **el cuerpo** del mensaje, nada más

`Ctrl-G` busca sobre el **texto** de los mensajes (y los **nombres de chat**, que se listan aparte
arriba de los resultados). Lo que **no** encuentra:

- **nombres de archivo de adjuntos** — buscar `presupuesto.pdf` no trae el documento: el nombre vive
  en otra columna que no está indexada;
- **el contenido de un adjunto** — lo que hay indexado es texto, no imágenes. (El **epígrafe** sí se
  encuentra: se guarda como cuerpo del mensaje.);
- **mensajes eliminados** — un borrado sale del índice, que es lo correcto.

Acentos y mayúsculas dan igual (`manana` encuentra `Mañana`) y lo que escribas se sanitiza, así que
comillas, guiones, asteriscos y paréntesis no rompen nada: son texto.

### Los recibos de lectura están **prendidos** por default

Abrir un chat (o `Ctrl-L`) le manda el recibo a WhatsApp: **la otra persona te ve el doble tilde
azul**, igual que en el teléfono. Si querés leer invisible, `{"readReceipts": false}` en
`config.json` y reiniciá: ahí el chat se marca leído **sólo en tu máquina** y no sale ni una llamada.

Dos detalles: el recibo es *best effort* (si falla, el chat queda leído igual y queda una línea en el
log) y **sin conexión no se manda ni se encola** — un recibo que sale tres horas después le miente al
otro sobre cuándo lo leíste.

### El código del candado es **crackeable offline**

Ya está dicho arriba, pero conviene el número: el código se guarda derivado con **scrypt**
(`N=16384, r=8, p=1`) y una derivación cuesta **~26 ms** en esta máquina. O sea que alguien que se
lleve el archivo puede probarlos todos:

| Largo | Combinaciones | Tiempo en **un** core |
| --- | --- | --- |
| 4 dígitos | 10.000 | **~5 minutos** |
| 6 dígitos | 1.000.000 | **~7-9 horas** |
| 8 dígitos | 100.000.000 | ~1 mes |

Con varios cores, dividí. (Con hardware dedicado no está medido; lo único que se puede decir con
certeza es que cada derivación necesita **16 MB de memoria** —`128 · N · r`—, que es justamente lo
que scrypt pone para que paralelizar salga caro.)

Dos consecuencias prácticas:

- **6 dígitos es una tarde de cómputo.** Si querés que cueste de verdad, usá más dígitos (el máximo
  es 16).
- **Acá está el motivo para no reusar el código del teléfono**: quien se lleve `lock-code.json` y lo
  reviente se queda con **el código de tu Chat Lock**, que sirve en el aparato donde sí hay algo que
  proteger.

Ahora, el orden de magnitud del riesgo: quien tenga ese archivo tiene **la base sin cifrar al lado**,
así que reventar el código sólo le ahorra abrir `sqlite3`. Esto sirve contra una mirada de reojo a la
terminal, **no** contra alguien sentado en tu sesión.

### Lo que directamente no está en v1

Bajar audio, video, documentos y stickers (se ven como `🎤 audio 0:12`, `🎬 video 1:07`,
`📎 informe.pdf` y nada más — las **imágenes** sí se ven inline y se amplían con `Ctrl-O`), enviar cualquier cosa que no
sea texto o una imagen (`Ctrl-V`), reacciones, responder citando, editar, borrar para todos,
reenviar, fijar, archivar, silenciar, bloquear, llamadas, estados, administrar grupos (leer y
escribir texto en grupos **sí**), multi-cuenta, notificaciones del sistema, y **cifrado de la base**.
