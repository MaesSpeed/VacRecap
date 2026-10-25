import { navigate } from "./router.js";

const FROM_TRIP_KEY = "vacrecap-map-from-trip";

export function markMapOpenedFromTrip() {
  sessionStorage.setItem(FROM_TRIP_KEY, "1");
}

export function mapOpenedFromTrip() {
  return sessionStorage.getItem(FROM_TRIP_KEY) === "1";
}

export function clearMapFromTripFlag() {
  sessionStorage.removeItem(FROM_TRIP_KEY);
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
