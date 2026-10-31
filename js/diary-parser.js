// Reisetagebuch-Parser (Paket 12a). Läuft im Browser, ohne Server.
// parseDiary(text, { startDate: "2025-06-16", endDate: "2025-06-20" })
const WD = [
  // JS getUTCDay(): 0 = Sonntag
  ["sonntag", "so"],
  ["montag", "mo"],
  ["dienstag", "di"],
  ["mittwoch", "mi"],
  ["donnerstag", "do"],
  ["freitag", "fr"],
  ["samstag", "sonnabend", "sa"],
];
const NAME2WD = new Map(WD.flatMap((names, wd) => names.map((n) => [n, wd])));
// Zeile = Überschrift, wenn sie (nach Markdown-/Satzzeichen-Abzug) nur aus Wochentag [+ Datum] besteht,
// oder Wochentag + ":" + Text (dann Text = erster Absatz des Tages).
const HEAD =
  /^(?:#{1,6}\s*)?(?:\*\*|__)?\s*([a-zäöü]+)\.?\s*(?:,?\s*(?:den\s+)?(\d{1,2})\.\s*(\d{1,2})\.?(?:\s*(\d{2,4}))?)?\s*(?:\*\*|__)?\s*(?:([:\-–—])\s*(.*))?$/i;
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => {
  const d = new Date(s + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};

export function tripDays(startDate, endDate) {
  const out = [];
  for (let d = startDate; d <= endDate; d = addDays(d, 1)) out.push(d);
  return out;
}

export function matchHeading(rawLine) {
  const line = rawLine.replace(/\u00a0/g, " ").trim();
  if (!line || line.length > 200) return null;
  const m = HEAD.exec(line);
  if (!m) return null;
  const word = m[1].toLowerCase();
  if (!NAME2WD.has(word)) return null;
  const isAbbr = word.length <= 2;
  const sep = m[5];
  const rest = (m[6] || "").trim();
  // "So war das." / "Mo hat geregnet" sind keine Überschriften: Kurzform nur allein, mit Datum oder mit ":".
  // "Montag – Text" bleibt eine Überschrift, der Text danach ist der erste Absatz.
  if (isAbbr && rest && sep !== ":") return null;
  return {
    weekday: NAME2WD.get(word),
    label: m[1],
    day: m[2] ? +m[2] : null,
    month: m[3] ? +m[3] : null,
    inline: rest,
  };
}

export function parseDiary(text, { startDate, endDate }) {
  const days = tripDays(startDate, endDate);
  const lines = String(text || "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const blocks = [];
  let cur = { kind: "intro", lines: [] };
  for (const l of lines) {
    const h = matchHeading(l);
    if (h) {
      blocks.push(cur);
      cur = { kind: "day", head: h, raw: l.trim(), lines: h.inline ? [h.inline] : [] };
    } else cur.lines.push(l);
  }
  blocks.push(cur);
  const clean = (ls) => ls.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const result = {
    intro: "",
    days: days.map((date) => ({
      date,
      weekday: new Date(date + "T00:00:00Z").getUTCDay(),
      text: "",
      sources: [],
      parts: [],
    })),
    hints: [],
    unassigned: [],
  };
  let ptr = 0; // nächster freier Reisetag (Reihenfolge-Regel)
  for (const b of blocks) {
    const body = clean(b.lines);
    if (b.kind === "intro") {
      result.intro = body;
      continue;
    }
    const h = b.head;
    let idx = -1;
    if (h.day && h.month) {
      // explizites Datum gewinnt
      idx = result.days.findIndex((d) => +d.date.slice(8) === h.day && +d.date.slice(5, 7) === h.month);
      if (idx >= 0 && result.days[idx].weekday !== h.weekday) {
        result.hints.push({ type: "weekday-date-mismatch", line: b.raw, date: result.days[idx].date });
      }
    }
    if (idx < 0) {
      // nächster passender Wochentag ab Zeiger
      for (let i = ptr; i < result.days.length; i++) if (result.days[i].weekday === h.weekday) {
        idx = i;
        break;
      }
    }
    if (idx < 0) {
      // kein späterer Tag: an letzten früheren gleichen Wochentag anhängen
      for (let i = Math.min(ptr, result.days.length) - 1; i >= 0; i--) if (result.days[i].weekday === h.weekday) {
        idx = i;
        break;
      }
      if (idx >= 0) result.hints.push({ type: "appended-to-earlier", line: b.raw, date: result.days[idx].date });
    }
    if (idx < 0) {
      result.unassigned.push({ line: b.raw, text: body, heading: h.label });
      result.hints.push({ type: "weekday-not-in-trip", line: b.raw });
      continue;
    }
    const day = result.days[idx];
    day.text = day.text ? day.text + "\n\n" + body : body;
    day.sources.push(b.raw);
    day.parts.push({ line: b.raw, heading: h.label, text: body });
    if (!body) result.hints.push({ type: "empty-day-text", line: b.raw, date: day.date });
    const occurrences = result.days.filter((d) => d.weekday === h.weekday).length;
    if (occurrences > 1 && !(h.day && h.month)) {
      result.hints.push({ type: "weekday-repeats", line: b.raw, date: day.date, occurrences });
    }
    ptr = Math.max(ptr, idx + 1);
  }
  for (const d of result.days) if (!d.text) result.hints.push({ type: "day-without-text", date: d.date });
  result.recognized = result.days.filter((d) => d.text).length;
  return result;
}
