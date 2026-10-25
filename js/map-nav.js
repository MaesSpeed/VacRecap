import { navigate } from "./router.js";

const FROM_TRIP_KEY = "vacrecap-map-from-trip";
const FROM_TRIP_AT_KEY = "vacrecap-map-from-trip-at";
const FROM_TRIP_MAX_AGE_MS = 12_000;

export function markMapOpenedFromTrip() {
  sessionStorage.setItem(FROM_TRIP_KEY, "1");
  sessionStorage.setItem(FROM_TRIP_AT_KEY, String(Date.now()));
}

export function mapOpenedFromTrip() {
  if (sessionStorage.getItem(FROM_TRIP_KEY) !== "1") return false;
  const at = Number(sessionStorage.getItem(FROM_TRIP_AT_KEY));
  if (!at || Date.now() - at > FROM_TRIP_MAX_AGE_MS) {
    clearMapFromTripFlag();
    return false;
  }
  return true;
}

export function clearMapFromTripFlag() {
  sessionStorage.removeItem(FROM_TRIP_KEY);
  sessionStorage.removeItem(FROM_TRIP_AT_KEY);
}

export function returnToTripFromMap(vacationId) {
  const fromTrip = mapOpenedFromTrip();
  clearMapFromTripFlag();
  if (fromTrip && window.history.length > 1) {
    window.history.back();
    return;
  }
  navigate({ name: "urlaub-detail", id: vacationId }, { replace: true });
}

export function leaveMapScreen(vacationId) {
  returnToTripFromMap(vacationId);
}
