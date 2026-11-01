import { getSupabase } from "./supabase-client.js";
import { ROLE_LABEL } from "./trip-role.js";

const cache = new Map();

const FIXED_COLORS = new Set(["#0066b3", "#d64541", "#1f9d57"]);
const PALETTE = ["#C25E00", "#7B4FB8", "#00838F", "#B83280", "#5D6D7E", "#8D6E00", "#3F51B5", "#A0522D"];

export async function loadTripPeople(tripId, { refresh = false } = {}) {
  if (!tripId) return [];
  if (!refresh && cache.has(tripId)) return cache.get(tripId);
  try {
    const { data, error } = await getSupabase().rpc("list_trip_people", { p_trip_id: tripId });
    if (error) return cache.get(tripId) || [];
    const rows = Array.isArray(data) ? data : [];
    cache.set(tripId, rows);
    return rows;
  } catch {
    return cache.get(tripId) || [];
  }
}

export function peekTripPeople(tripId) {
  return cache.get(tripId) || [];
}

export function clearTripPeople(tripId) {
  if (tripId) cache.delete(tripId);
  else cache.clear();
}

export function personKey(person) {
  return person?.user_id || person?.invite_id || "";
}

/** Doppelte Palettenfarben nur in der Anzeige auflösen. Fixfarben bleiben. */
export function displayColorMap(people) {
  const sorted = (people || [])
    .slice()
    .sort((a, b) => String(a.since || a.created_at || "").localeCompare(String(b.since || b.created_at || "")));
  const used = new Set();
  const map = new Map();
  for (const person of sorted) {
    const raw = String(person.avatar_color || "#5D6D7E");
    const key = raw.toLowerCase();
    let color = raw;
    if (!FIXED_COLORS.has(key) && used.has(key)) {
      const next = PALETTE.find((entry) => !used.has(entry.toLowerCase()));
      if (next) color = next;
    }
    used.add(color.toLowerCase());
    const id = personKey(person);
    if (id) map.set(id, color);
  }
  return map;
}

export function personLetter(person) {
  const source = String(person?.display_name || person?.email || "?").trim();
  const ch = Array.from(source)[0] || "?";
  return ch.toLocaleUpperCase("de-DE");
}

export function personRoleLabel(person) {
  if (person?.status === "ehemalig" || person?.person_kind === "former") return "ehemalig";
  return ROLE_LABEL[person?.role] || "";
}

export function membersOf(people) {
  return (people || []).filter((person) => person.person_kind === "member");
}

export function circlePeople(people) {
  return (people || []).filter((person) => person.person_kind === "member" || person.person_kind === "former");
}
