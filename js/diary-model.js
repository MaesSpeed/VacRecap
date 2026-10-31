export const DIARY_TEXT_MAX = 30000;

export function clampDiaryText(value) {
  const chars = Array.from(String(value ?? ""));
  if (chars.length <= DIARY_TEXT_MAX) return chars.join("");
  return chars.slice(0, DIARY_TEXT_MAX).join("");
}

export function countSentences(text) {
  const value = String(text || "").trim();
  if (!value) return 0;
  const chunks = value
    .split(/[.!?]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return chunks.length || 1;
}

export function dayBody(day) {
  let text = "";
  for (const part of day?.parts || []) {
    const body = part.text || "";
    text = text ? `${text}\n\n${body}` : body;
  }
  return text;
}

export function isNoHeadings(model) {
  const anyPart = (model?.days || []).some((day) => (day.parts || []).length > 0);
  return !anyPart && (model?.loose || []).length === 0 && Boolean(String(model?.intro || "").trim());
}

function touch(model) {
  model.noHeadings = isNoHeadings(model);
  model.hints = (model.hints || []).filter((hint) => hint.type !== "day-without-text");
  for (const day of model.days) {
    if (!(day.parts || []).length && !dayBody(day).trim()) {
      model.hints.push({ type: "day-without-text", date: day.date });
    }
  }
  return model;
}

export function createDiaryModel(parsed) {
  const model = {
    intro: parsed?.intro || "",
    days: (parsed?.days || []).map((day) => ({
      date: day.date,
      weekday: day.weekday,
      parts: (day.parts || []).map((part) => ({
        line: part.line,
        heading: part.heading || "",
        text: part.text || "",
      })),
    })),
    loose: (parsed?.unassigned || []).map((item) => ({
      line: item.line,
      heading: item.heading || "",
      text: item.text || "",
    })),
    hints: (parsed?.hints || []).map((hint) => ({ ...hint })),
  };
  return touch(model);
}

function takePart(model, line) {
  for (const day of model.days) {
    const idx = (day.parts || []).findIndex((part) => part.line === line);
    if (idx >= 0) return day.parts.splice(idx, 1)[0];
  }
  const looseIdx = model.loose.findIndex((part) => part.line === line);
  if (looseIdx >= 0) return model.loose.splice(looseIdx, 1)[0];
  return null;
}

export function reassignLine(model, line, date) {
  const part = takePart(model, line);
  const target = model.days.find((day) => day.date === date);
  if (part && target) target.parts.push(part);
  else if (part) model.loose.push(part);
  model.hints = model.hints.filter((hint) => hint.line !== line);
  return touch(model);
}

export function omitLine(model, line) {
  model.loose = model.loose.filter((part) => part.line !== line);
  model.hints = model.hints.filter((hint) => hint.line !== line);
  return touch(model);
}

export function diaryEndDate(startDate, endDate, places, photos, today) {
  if (endDate) return endDate;
  const found = [];
  for (const place of places || []) {
    const day = place?.day || place?.dayDate;
    if (day) found.push(day);
  }
  for (const photo of photos || []) {
    if (photo?.day) found.push(photo.day);
  }
  const last = found.filter((day) => !startDate || day >= startDate).sort().at(-1) || "";
  const candidates = [today, last, startDate].filter(Boolean).sort();
  const end = candidates.at(-1) || startDate || today || "";
  if (startDate && end < startDate) return startDate;
  return end;
}

function placeDayMap(places) {
  const map = new Map();
  for (const place of places || []) {
    if (place?.id) map.set(place.id, place.day || place.dayDate || "");
  }
  return map;
}

export function photosForDay(photos, places, date) {
  const days = placeDayMap(places);
  return (photos || [])
    .filter((photo) => {
      if (!photo?.id || photo.deletedAt) return false;
      if (photo.type === "video") return false;
      if ((photo.uploadStatus || "uploaded") !== "uploaded") return false;
      const day = photo.day || days.get(photo.placeId) || "";
      return day === date;
    })
    .sort((a, b) => (a.ts || 0) - (b.ts || 0) || String(a.id).localeCompare(String(b.id)))
    .slice(0, 3)
    .map((photo) => photo.id);
}

export function placesForDay(places, date) {
  return (places || [])
    .filter((place) => place?.id && !place.soft && (place.day || place.dayDate) === date)
    .sort((a, b) => (a.ts || 0) - (b.ts || 0) || String(a.id).localeCompare(String(b.id)));
}

function hintPayload(hint) {
  const out = { type: hint.type };
  if (hint.date) out.date = hint.date;
  if (hint.line) out.line = hint.line;
  if (hint.occurrences) out.occurrences = hint.occurrences;
  return out;
}

export function buildDiaryContent(model, material = {}) {
  const places = material.places || [];
  const photos = material.photos || [];
  const days = (model?.days || []).map((day) => {
    const parts = day.parts || [];
    const heading = parts.find((part) => part.heading)?.heading || "";
    return {
      date: day.date,
      heading,
      text: dayBody(day),
      media_ids: photosForDay(photos, places, day.date),
      waypoint_ids: placesForDay(places, day.date).map((place) => place.id),
    };
  });
  const hints = (model?.hints || []).map(hintPayload);
  if (model?.noHeadings) hints.unshift({ type: "no-weekdays" });
  return {
    parser_version: 1,
    intro: model?.intro || "",
    days,
    hints,
  };
}

/** Neuer Entwurf: Text der Fassung bleibt, Fotos und Orte kommen aus dem aktuellen Stand. */
export function refreshDiaryContent(content, material, dates) {
  const byDate = new Map((content?.days || []).map((day) => [day.date, day]));
  const days = (dates || []).map((date) => {
    const prev = byDate.get(date) || {};
    return {
      date,
      heading: prev.heading || "",
      text: prev.text || "",
      media_ids: photosForDay(material?.photos, material?.places, date),
      waypoint_ids: placesForDay(material?.places, date).map((place) => place.id),
    };
  });
  return {
    parser_version: 1,
    intro: content?.intro || "",
    days,
    hints: Array.isArray(content?.hints) ? content.hints : [],
  };
}
