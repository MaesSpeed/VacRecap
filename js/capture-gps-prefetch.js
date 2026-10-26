import { getCapturePosition } from "./geo.js";
import { getRememberCaptureLocation } from "./settings-store.js";

const PREFETCH_MAX_AGE_MS = 8000;

let prefetchPromise = null;
let prefetchStartedAt = 0;

export function resetCaptureGpsPrefetch() {
  prefetchPromise = null;
  prefetchStartedAt = 0;
}

/** GPS beim Tipp auf Kamera (vor nativem Dialog). Jeder Tipp startet einen neuen Prefetch. */
export function prefetchCaptureGps() {
  prefetchStartedAt = Date.now();
  prefetchPromise = (async () => {
    try {
      if (!(await getRememberCaptureLocation())) return null;
      const pos = await getCapturePosition();
      return {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        ts: Date.now(),
      };
    } catch {
      return null;
    }
  })();
}

export async function consumePrefetchedCaptureGps() {
  if (!prefetchPromise) return null;
  const startedAt = prefetchStartedAt;
  const p = prefetchPromise;
  prefetchPromise = null;
  prefetchStartedAt = 0;
  if (!startedAt || Date.now() - startedAt > PREFETCH_MAX_AGE_MS) {
    return null;
  }
  const result = await p;
  if (!result) return null;
  if (Date.now() - result.ts > PREFETCH_MAX_AGE_MS) return null;
  return result;
}
