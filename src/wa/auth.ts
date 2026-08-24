// Credenciales de la sesión de WhatsApp: cargarlas, endurecer sus permisos y
// borrarlas cuando dejan de servir (design §3, §6.1 pasos 7 y 8).
//
// Viven en `$XDG_DATA_HOME/wacosas/creds/` y las escribe `useMultiFileAuthState`
// de baileys: `creds.json` (la identidad del dispositivo) más un archivo por
// clave de sesión. Son EL secreto de la app —con ese directorio cualquiera se
// hace pasar por esta sesión—, así que:
//
//   · el directorio queda 0700 y los archivos 0600. El `umask(0o077)` del entry
//     ya hace nacer así todo lo que escriba el proceso; el `chmod` de acá es
//     defensivo, para una instalación previa que los haya dejado laxos (§4).
//   · `wipeCreds` borra SÓLO este directorio. La base con el historial no se
//     toca nunca (CA-3.2): re-vincular no puede costarle los mensajes al usuario.
import { useMultiFileAuthState } from "baileys";
import type { AuthenticationState } from "baileys";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export type Auth = {
  state: AuthenticationState;
  /** Persiste las creds en disco. Lo llama el handler de `creds.update`. */
  saveCreds(): Promise<void>;
};

/** Nombre del archivo donde `useMultiFileAuthState` guarda la identidad. */
const ARCHIVO_CREDS = "creds.json";

/**
 * ¿Hay una sesión VINCULADA en disco?
 *
 * El criterio es `creds.me?.id`, **el mismo que usa baileys** para decidir entre
 * vincular y retomar (`Socket/socket.js:320`): sin `creds.me` manda un
 * `generateRegistrationNode` —o sea, pide QR—; con él, un `generateLoginNode`.
 * Lo escribe `configureSuccessfulPairing` (`Utils/validate-connection.js:190`)
 * en cuanto WhatsApp acepta el dispositivo, por CUALQUIERA de los dos caminos.
 *
 * NO sirve `registered: true`, que es lo que miraba esta función: baileys lo
 * setea en un solo lugar (`Socket/messages-recv.js:940`, dentro del
 * `case 'link_code_companion_reg'`), o sea **sólo en el flujo del código de
 * emparejamiento**. Una sesión vinculada por QR —el camino más común— queda con
 * `registered: false` para siempre, así que mirarlo hacía que la app pidiera QR
 * de nuevo con la sesión ya buena, y que CA-3.4 no se pudiera disparar nunca por
 * ese camino (visto con una cuenta real: `me.id` + `platform: iphone` puestos y
 * `registered: false`).
 *
 * Que exista `creds.json` tampoco alcanza: baileys lo escribe apenas arranca el
 * handshake, mucho antes de que el usuario escanee nada, y ahí todavía no hay
 * `me` — un proceso cortado a mitad de la vinculación deja exactamente eso.
 *
 * De esto depende el `flujo` del socket (`link` vs `reconnect`) y con él CA-3.4:
 * un QR durante una RECONEXIÓN significa que las creds no sirven y hay que
 * borrarlas; durante una vinculación es lo esperado.
 */
export function hasCreds(credsDir: string): boolean {
  try {
    const raw = readFileSync(join(credsDir, ARCHIVO_CREDS), "utf8");
    const id = JSON.parse(raw)?.me?.id;
    return typeof id === "string" && id !== "";
  } catch {
    // No existe, no se puede leer o es JSON roto: para el caso es lo mismo.
    return false;
  }
}

/** Deja el dir en 0700 y todo lo de adentro en 0600. Nunca lanza. */
export function hardenCreds(credsDir: string): void {
  try {
    chmodSync(credsDir, 0o700);
  } catch {
    /* todavía no existe: lo crea `loadAuth` con el modo correcto */
  }
  let archivos: string[];
  try {
    archivos = readdirSync(credsDir);
  } catch {
    return;
  }
  for (const a of archivos) {
    try {
      chmodSync(join(credsDir, a), 0o600);
    } catch {
      /* uno que no se puede tocar no puede frenar a los demás */
    }
  }
}

/**
 * Carga el estado de autenticación del directorio (lo crea si no está).
 *
 * El `chmod` corre UNA vez acá y no en cada `saveCreds`: con la sesión andando
 * el directorio junta cientos de archivos de claves y endurecerlos en cada
 * `creds.update` serían cientos de syscalls por evento. Lo que garantiza el modo
 * de los archivos NUEVOS es el `umask(0o077)` del arranque.
 */
export async function loadAuth(credsDir: string): Promise<Auth> {
  mkdirSync(credsDir, { recursive: true, mode: 0o700 });
  hardenCreds(credsDir);
  return await useMultiFileAuthState(credsDir);
}

/**
 * Borra las credenciales. SÓLO el directorio de creds: la base con el historial
 * queda intacta (CA-3.2, CA-3.5). Nunca lanza — se llama desde el camino de
 * error del socket, donde tirar sería peor que fallar en silencio.
 */
export function wipeCreds(credsDir: string): boolean {
  try {
    rmSync(credsDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
