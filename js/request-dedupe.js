const inflight = new Map();

/** Coalesces in-flight async work for the same string key. */
export function dedupeRequest(key, fn) {
  if (!key) return fn();
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = Promise.resolve()
    .then(fn)
    .finally(() => {
      if (inflight.get(key) === promise) inflight.delete(key);
    });
  inflight.set(key, promise);
  return promise;
}
