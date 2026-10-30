const NOMINATIM = "https://nominatim.openstreetmap.org/reverse";
const GEOCODE_TIMEOUT_MS = 4000;
const GEOCODE_GAP_MS = 1000;

let geocodeChain = Promise.resolve();
let lastGeocodeAt = 0;

export function coordinatesAreUsable(lat, lng) {
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return false;
  if (la === 0 && ln === 0) return false;
  return la >= -90 && la <= 90 && ln >= -180 && ln <= 180;
}

function sleep(ms, signal) {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

export function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

let capturePositionFlight = null;

export function resetCapturePositionCache() {
  capturePositionFlight = null;
}

/** Ein laufender Capture-GPS-Request (Prefetch + Speichern teilen sich das Ergebnis). */
export function getCapturePosition() {
  if (!capturePositionFlight) {
    capturePositionFlight = getCurrentPosition({
      enableHighAccuracy: false,
      timeout: 4000,
      maximumAge: 0,
    }).finally(() => {
      capturePositionFlight = null;
    });
  }
  return capturePositionFlight;
}

/** Nur echte Standortfehler, keine Speicherfehler der Cloud. */
export function isLocationUnavailable(err) {
  const code = Number(err?.code);
  if (code === 1 || code === 2 || code === 3) return true;
  const msg = String(err?.message || "").toLowerCase();
  if (!msg) return false;
  return (
    msg === "unsupported" ||
    msg.includes("geolocation") ||
    msg.includes("position unavailable") ||
    msg.includes("timeout expired") ||
    msg.includes("timed out") ||
    msg.includes("user denied")
  );
}

export function getCurrentPosition(options = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("unsupported"));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 0,
      ...options,
    });
  });
}

export function formatTimeFromTs(ts) {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

export function fallbackPlaceName(ts) {
  return `Ort ${formatTimeFromTs(ts)}`;
}

async function fetchGeocodeName(lat, lng, signal) {
  const url = `${NOMINATIM}?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&accept-language=de&zoom=18`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GEOCODE_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error("geocode failed");
    const data = await res.json();
    const addr = data.address ?? {};
    if (data.name) return String(data.name);
    const road = addr.road || addr.pedestrian || addr.footway;
    if (road) {
      const num = addr.house_number ? ` ${addr.house_number}` : "";
      return `${road}${num}`;
    }
    if (addr.suburb) return addr.suburb;
    if (addr.neighbourhood) return addr.neighbourhood;
    if (addr.city || addr.town || addr.village) return addr.city || addr.town || addr.village;
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function reverseGeocodeName(lat, lng, { signal } = {}) {
  const run = geocodeChain.then(async () => {
    const wait = lastGeocodeAt ? Math.max(0, GEOCODE_GAP_MS - (performance.now() - lastGeocodeAt)) : 0;
    await sleep(wait, signal);
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    lastGeocodeAt = performance.now();
    return fetchGeocodeName(lat, lng, signal);
  });
  geocodeChain = run.then(
    () => {},
    () => {}
  );
  return run;
}
