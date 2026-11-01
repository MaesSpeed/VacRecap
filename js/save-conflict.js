import { StaleWriteError } from "./cloud-errors.js";
import { loadTripPeople } from "./trip-people.js";
import { openConfirmDialog } from "./ui-confirm.js";
import { showToast } from "./toast.js";

export function formatChangeClock(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

export function nameForUpdatedBy(people, userId) {
  if (!userId) return "Jemand";
  const person = (people || []).find((item) => item.user_id === userId);
  return person?.display_name || "Jemand";
}

export function staleChangeCopy(err, people) {
  const fresh = err?.fresh || {};
  const name = nameForUpdatedBy(people, fresh.updated_by);
  const time = formatChangeClock(fresh.updated_at);
  return {
    name,
    time,
    line: time ? `${name} hat das um ${time} geändert.` : `${name} hat das geändert.`,
    hint: time ? `${name} hat das gerade geändert · Neu laden` : `${name} hat das gerade geändert · Neu laden`,
  };
}

/** Dialog für ein bewusstes Speichern. Autosave nutzt den Hinweis statt dieses Dialogs. */
export async function decideStaleWrite(err, { tripId = null, people = null } = {}) {
  if (!(err instanceof StaleWriteError)) return null;
  if (err.deleted || !err.fresh || err.fresh.deleted_at) {
    showToast("Wurde inzwischen gelöscht");
    return "deleted";
  }
  const freshAt = err.fresh.updated_at || null;
  if (freshAt && String(freshAt) === String(err.expected)) {
    showToast("Dafür fehlt die Berechtigung.");
    return "denied";
  }
  const list = people || (tripId ? await loadTripPeople(tripId).catch(() => []) : []);
  const copy = staleChangeCopy(err, list);
  const force = await openConfirmDialog({
    title: "Inzwischen geändert",
    message: copy.line,
    confirmLabel: "Trotzdem speichern",
    cancelLabel: "Neu laden",
    danger: false,
    testId: "conflict-dialog",
  });
  return force ? "force" : "reload";
}

const STALE_KEY = "vacrecap-stale:";

export function rememberStaleNotice(tripId, notice) {
  if (!tripId) return;
  try {
    sessionStorage.setItem(STALE_KEY + tripId, JSON.stringify(notice || {}));
  } catch {
    /* privater Modus */
  }
}

export function takeStaleNotice(tripId) {
  if (!tripId) return null;
  try {
    const raw = sessionStorage.getItem(STALE_KEY + tripId);
    if (!raw) return null;
    sessionStorage.removeItem(STALE_KEY + tripId);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
