import { getCapturePosition } from "./geo.js";
import { getRememberCaptureLocation } from "./settings-store.js";

let prefetchPromise = null;

export function resetCaptureGpsPrefetch() {
  prefetchPromise = null;
}

/** GPS beim Tipp auf Kamera (vor nativem Dialog). */
export function prefetchCaptureGps() {
  if (prefetchPromise) return;
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
  const p = prefetchPromise;
  prefetchPromise = null;
  return await p;
}
