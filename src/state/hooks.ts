// El puente React → store (design §5.5). Es la ÚNICA forma en que un componente
// lee estado del dominio máquina.
//
// `useSyncExternalStore` re-renderiza sólo cuando el snapshot cambia de
// identidad, y el store cambia esa identidad únicamente en el flush coalescido
// (D3). De ahí sale el techo de ~30 renders por segundo pase lo que pase con la
// red (RNF-5).
//
// Las dos funciones van memoizadas por slice: si `subscribe` cambiara de
// identidad en cada render, React se daría de baja y de alta en cada uno.
import { useCallback, useSyncExternalStore } from "react";

import { getSnapshot, subscribe, type Slice, type Snapshots } from "./store";

/** Suscribe el componente a un slice y devuelve su snapshot vigente. */
export function useSlice<S extends Slice>(s: S): Snapshots[S] {
  const suscribir = useCallback((cb: () => void) => subscribe(s, cb), [s]);
  const leer = useCallback(() => getSnapshot(s), [s]);
  return useSyncExternalStore(suscribir, leer);
}
