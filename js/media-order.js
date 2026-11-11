/** Rang aus sort_order. Ohne Wert (oder ohne Spalte) bleibt die Aufnahmezeit maßgeblich. */
export function mediaSortRank(item) {
  const value = item?.sortOrder;
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** sort_order aufsteigend, fehlende Werte hinten, dann Aufnahmezeit, dann Id. */
export function compareMediaOrder(a, b) {
  const left = mediaSortRank(a);
  const right = mediaSortRank(b);
  if (left != null && right != null && left !== right) return left - right;
  if (left != null && right == null) return -1;
  if (left == null && right != null) return 1;
  const delta = (a?.ts || 0) - (b?.ts || 0);
  if (delta) return delta;
  return String(a?.id || "").localeCompare(String(b?.id || ""));
}

/** orderedIds null setzt sort_order zurück. Sonst 1..n in der gegebenen Reihenfolge. */
export function applyMediaRanks(media, orderedIds) {
  if (!media) return;
  if (orderedIds == null) {
    for (const entry of media) entry.sortOrder = null;
    return;
  }
  const rank = new Map(orderedIds.map((id, index) => [id, index + 1]));
  for (const entry of media) {
    if (rank.has(entry.id)) entry.sortOrder = rank.get(entry.id);
  }
}
