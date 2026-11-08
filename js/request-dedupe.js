import { StaleDataScopeError, dedupeScopeKey } from "./data-scope.js";

const inflight = new Map();

export function resetInflightRequests() {
  inflight.clear();
}

/** Coalesces in-flight async work for the same string key within the current data scope. */
export function dedupeRequest(key, fn) {
  if (!key) return fn();
  const scopeAtStart = dedupeScopeKey();
  const scopedKey = `${scopeAtStart}:${key}`;
  const existing = inflight.get(scopedKey);
  if (existing) return existing;
  const promise = Promise.resolve()
    .then(async () => {
      const result = await fn();
      if (dedupeScopeKey() !== scopeAtStart) throw new StaleDataScopeError();
      return result;
    })
    .finally(() => {
      if (inflight.get(scopedKey) === promise) inflight.delete(scopedKey);
    });
  inflight.set(scopedKey, promise);
  return promise;
}
