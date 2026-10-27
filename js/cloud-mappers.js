export function tripRowToVacation(row) {
  if (!row) return null;
  const companions = Array.isArray(row.companions) ? row.companions : [];
  return {
    id: row.id,
    createdAt: Date.parse(row.created_at) || Date.now(),
    updatedAt: Date.parse(row.updated_at) || Date.now(),
    author: row.created_by,
    title: row.title || "",
    startDate: row.start_date || "",
    endDate: row.end_date || "",
    cover: { type: "preset", presetId: "stadt" },
    companions: { tags: [], names: companions },
    stats: { places: 0, photos: 0, notes: 0 },
  };
}

export function vacationToTripRow(vacation) {
  const names = vacation.companions?.names?.filter(Boolean) ?? [];
  return {
    title: vacation.title?.trim() || "Reise",
    start_date: vacation.startDate || null,
    end_date: vacation.endDate || null,
    companions: names,
  };
}

export function waypointRowToPlace(row) {
  const day = row.day || "";
  const ts = Date.parse(row.visited_at) || Date.now();
  return {
    id: row.id,
    createdAt: Date.parse(row.created_at) || ts,
    updatedAt: Date.parse(row.updated_at) || ts,
    author: row.created_by,
    vacationId: row.trip_id,
    day,
    dayDate: day,
    ts,
    lat: row.lat ?? null,
    lng: row.lng ?? null,
    accuracy: row.accuracy_m ?? null,
    name: row.title || "",
    title: row.title || "",
    soft: Boolean(row.is_soft),
    source: row.source || "manual",
    kind: row.is_soft ? "soft" : "place",
    mediaIds: [],
    noteIds: [],
    rememberCount: 0,
    rememberFirstTs: null,
    rememberLastTs: null,
  };
}

export function placeToWaypointRow(place) {
  return {
    trip_id: place.vacationId,
    day: place.day || place.dayDate,
    visited_at: new Date(place.ts || Date.now()).toISOString(),
    lat: place.lat ?? null,
    lng: place.lng ?? null,
    accuracy_m: place.accuracy ?? null,
    title: place.name || place.title || "",
    is_soft: Boolean(place.soft),
    source: place.source || "manual",
  };
}

export function noteRowToApp(row) {
  return {
    id: row.id,
    placeId: row.waypoint_id,
    vacationId: row.trip_id,
    day: row.day,
    ts: Date.parse(row.updated_at) || Date.now(),
    text: row.body || "",
    author: row.created_by,
  };
}

export function noteToRow(note) {
  return {
    trip_id: note.vacationId,
    waypoint_id: note.placeId || null,
    day: note.day,
    body: (note.text || "").trim(),
  };
}
