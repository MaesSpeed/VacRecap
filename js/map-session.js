const segmentByVacation = new Map();

export function getMapSegment(vacationId) {
  return segmentByVacation.get(vacationId) ?? "all";
}

export function setMapSegment(vacationId, segment) {
  segmentByVacation.set(vacationId, segment);
}
