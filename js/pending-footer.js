const STORAGE_KEY = "vacrecap-pending-footer";
const MAX_AGE_MS = 5000;

export function queuePendingFooter(action) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ action, at: Date.now() }));
}

export function consumePendingFooter() {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  sessionStorage.removeItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const { action, at } = JSON.parse(raw);
    if (!action || typeof at !== "number") return null;
    if (Date.now() - at > MAX_AGE_MS) return null;
    return action;
  } catch {
    return null;
  }
}
