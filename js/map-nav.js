import { navigate } from "./router.js";

export function returnToTripFromMap(vacationId) {
  if (history.state?.fromTrip === true && window.history.length > 1) {
    window.history.back();
    return;
  }
  navigate({ name: "urlaub-detail", id: vacationId }, { replace: true });
}

export function leaveMapScreen(vacationId) {
  returnToTripFromMap(vacationId);
}
