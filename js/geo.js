const NOMINATIM = "https://nominatim.openstreetmap.org/reverse";

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
      maximumAge: 5000,
    }).finally(() => {
      capturePositionFlight = null;
    });
  }
  return capturePositionFlight;
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

export async function reverseGeocodeName(lat, lng) {
  const url = `${NOMINATIM}?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&accept-language=de&zoom=18`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
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
}
