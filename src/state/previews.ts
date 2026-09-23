import type { ResultadoImagen } from "../boot/chafa";

/** One conversion/download at a time; cancelled subscribers never receive late results. */
export function createPreviewQueue<T = ResultadoImagen>({ gapMs = 1_000, limit = 64, error = { ok: false, reason: "no se pudo cargar la miniatura" } as T } = {}) {
  type Job = { key: string; load: (wanted: () => boolean) => Promise<T>; listeners: Set<(r: T) => void> };
  const cache = new Map<string, T>();
  const jobs = new Map<string, Job>();
  const waiting: Job[] = [];
  let running = false;
  let stopped = false;
  let nextAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function pump() {
    if (running || stopped) return;
    while (waiting.length && !waiting[0]!.listeners.size) {
      const job = waiting.shift()!;
      jobs.delete(job.key);
    }
    if (!waiting.length) return;
    if (Date.now() < nextAt) {
      if (!timer) timer = setTimeout(() => { timer = undefined; pump(); }, nextAt - Date.now());
      return;
    }
    const job = waiting.shift()!;
    running = true;
    void Promise.resolve().then(() => job.load(() => !stopped && job.listeners.size > 0)).catch((): T => error).then(r => {
      if (stopped) return;
      if (job.listeners.size) {
        cache.delete(job.key);
        cache.set(job.key, r);
      }
      while (cache.size > limit) cache.delete(cache.keys().next().value!);
      for (const listener of job.listeners) listener(r);
    }).finally(() => {
      jobs.delete(job.key);
      running = false;
      nextAt = Date.now() + gapMs;
      pump();
    });
  }

  return {
    request(key: string, load: (wanted: () => boolean) => Promise<T>, listener: (r: T) => void): () => void {
      if (stopped) return () => {};
      const cached = cache.get(key);
      if (cached) {
        cache.delete(key);
        cache.set(key, cached);
        listener(cached);
        return () => {};
      }
      let job = jobs.get(key);
      if (!job) {
        job = { key, load, listeners: new Set() };
        jobs.set(key, job);
        waiting.push(job);
      }
      job.listeners.add(listener);
      pump();
      return () => {
        job.listeners.delete(listener);
        // Remove cancelled queued jobs immediately, not after a slow download.
        const i = waiting.indexOf(job);
        if (!job.listeners.size && i >= 0) { waiting.splice(i, 1); jobs.delete(key); }
      };
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      for (const job of jobs.values()) job.listeners.clear();
      waiting.length = 0;
      jobs.clear();
      cache.clear();
    },
  };
}
