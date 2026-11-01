import { clearTripPresence, listTripPresence, touchTripPresence } from "./trip-access.js";
import { escapeHtml } from "./utils.js";

const INTERVAL_MS = 30000;

export function presenceLine(rows) {
  const names = (rows || []).map((row) => row.display_name).filter(Boolean);
  if (!names.length) return "";
  if (names.length === 1) return `${names[0]} bearbeitet gerade`;
  if (names.length === 2) return `${names[0]} und ${names[1]} bearbeiten gerade`;
  return `${names.slice(0, -1).join(", ")} und ${names[names.length - 1]} bearbeiten gerade`;
}

export function presenceBannerHtml(rows) {
  const line = presenceLine(rows);
  if (!line) return "";
  const circles = (rows || [])
    .slice(0, 3)
    .map((row) => {
      const letter = Array.from(String(row.display_name || "?"))[0] || "?";
      const color = row.avatar_color || "#5D6D7E";
      return `<span class="kr-av kr-av--sm" style="--kr:${escapeHtml(color)}">${escapeHtml(letter.toLocaleUpperCase("de-DE"))}</span>`;
    })
    .join("");
  return `<div class="fg-role" data-testid="presence-banner">${circles}<span>${escapeHtml(line)}</span></div>`;
}

/**
 * Lebenszeichen, solange ein Bearbeiten-Bildschirm offen und sichtbar ist.
 * onOthers bekommt nur Personen mit demselben Ziel.
 */
export function watchPresence(tripId, target, onOthers) {
  if (!tripId || !navigator.onLine) return () => {};
  let stopped = false;
  let timer = 0;

  const tick = async () => {
    if (stopped || document.visibilityState === "hidden" || !navigator.onLine) return;
    await touchTripPresence(tripId, target);
    const rows = await listTripPresence(tripId);
    const same = rows.filter((row) => row.target === target);
    onOthers?.(same);
  };

  const loop = () => {
    if (stopped) return;
    void tick();
    timer = window.setTimeout(loop, INTERVAL_MS);
  };

  const onVis = () => {
    if (stopped) return;
    window.clearTimeout(timer);
    if (document.visibilityState === "hidden") {
      void clearTripPresence(tripId);
      return;
    }
    loop();
  };

  document.addEventListener("visibilitychange", onVis);
  loop();

  return () => {
    if (stopped) return;
    stopped = true;
    window.clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVis);
    void clearTripPresence(tripId);
  };
}

/** In der Reiseansicht nur nachsehen, ohne selbst ein Ziel zu setzen. */
export function watchTripActivity(tripId, onRows) {
  if (!tripId || !navigator.onLine) return () => {};
  let stopped = false;
  let timer = 0;
  const tick = async () => {
    if (stopped || document.visibilityState === "hidden" || !navigator.onLine) return;
    const rows = await listTripPresence(tripId);
    onRows?.(rows);
  };
  const loop = () => {
    if (stopped) return;
    void tick();
    timer = window.setTimeout(loop, INTERVAL_MS);
  };
  const onVis = () => {
    if (stopped) return;
    window.clearTimeout(timer);
    if (document.visibilityState === "hidden") return;
    loop();
  };
  document.addEventListener("visibilitychange", onVis);
  loop();
  return () => {
    stopped = true;
    window.clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVis);
  };
}
