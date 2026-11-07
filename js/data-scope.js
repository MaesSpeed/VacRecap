/** Bumps on sign-out and whenever the authenticated user id changes. */
let dataEpoch = 0;
let scopedUserId = null;

export class StaleDataScopeError extends Error {
  constructor() {
    super("Stale data scope");
    this.name = "StaleDataScopeError";
  }
}

export function getDataEpoch() {
  return dataEpoch;
}

export function captureDataScope() {
  return { epoch: dataEpoch, userId: scopedUserId };
}

export function dataScopeStillValid(scope) {
  if (!scope) return false;
  return scope.epoch === dataEpoch && scope.userId === scopedUserId;
}

export function dedupeScopeKey() {
  return `${dataEpoch}:${scopedUserId || "none"}`;
}

export function syncDataScopeUser(userId) {
  const next = userId || null;
  if (next !== scopedUserId) {
    scopedUserId = next;
    dataEpoch += 1;
  }
}

export function resetDataScope() {
  scopedUserId = null;
  dataEpoch += 1;
}
