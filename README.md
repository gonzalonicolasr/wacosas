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
wacosas --version     # imprime la versión y sale
wacosas --help        # ayuda
```

## Dónde quedan las cosas

Se respeta XDG; si no tenés las variables seteadas, los defaults son:

| Qué | Ruta |
| --- | --- |
| Base SQLite | `~/.local/share/wacosas/wacosas.sqlite` |
| Credenciales de sesión | `~/.local/share/wacosas/creds/` |
| Configuración | `~/.local/share/wacosas/config.json` |
| Log | `~/.local/state/wacosas/wacosas.log` |

Los directorios de datos y de estado se crean solos al arrancar, con permisos `0700`.

Para desvincular la sesión y empezar de cero: cerrá wacosas y borrá `~/.local/share/wacosas/creds/`.

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

Por qué no se resolvió: fusionarlas de verdad no es leer un campo más. Hay que elegir una identidad
canónica, **mover** los mensajes ya persistidos de un `chat_jid` al otro, sumar los contadores de no
leídos, y que el envío salga siempre por la identidad que el otro lado espera. Es una migración de
datos, no un ajuste de la vista, y se hace mal si se hace a medias. Queda anotado como el riesgo R7
del diseño.

### El resto

Pendiente de completar en la tarea 18 (ventana fija de mensajes, alcance de la búsqueda global,
atajos que chocan con tmux).
