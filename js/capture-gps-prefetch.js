import { getCapturePosition } from "./geo.js";
import { getRememberCaptureLocation } from "./settings-store.js";

let prefetchPromise = null;

/** GPS beim Tipp auf Kamera (vor nativem Dialog). */
export function prefetchCaptureGps() {
  void getRememberCaptureLocation().then((remember) => {
    if (!remember) {
      prefetchPromise = null;
      return;
    }
    prefetchPromise = getCapturePosition()
      .then((pos) => ({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        ts: Date.now(),
      }))
      .catch(() => null);
  });
}

export async function consumePrefetchedCaptureGps() {
  if (!prefetchPromise) return null;
  const p = prefetchPromise;
  prefetchPromise = null;
  return await p;
}
