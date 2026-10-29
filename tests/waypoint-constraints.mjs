import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQL_PATH = path.resolve(__dirname, "../docs/supabase/paket-8d-waypoints-checks.sql");

function parseWaypointChecks(sql) {
  const checks = [];
  let notNull = [];
  for (const rawLine of sql.split("\n")) {
    const line = rawLine.replace(/^\s*--\s?/, "").trim();
    const check = /^CHECK\s+(\w+):\s*(.+)$/.exec(line);
    if (check) checks.push({ name: check[1], expr: check[2].trim() });
    const nn = /^NOT NULL:\s*(.+)$/.exec(line);
    if (nn) notNull = nn[1].split(",").map((part) => part.trim()).filter(Boolean);
  }
  return { checks, notNull };
}

export function loadWaypointConstraintSpec(sql = readFileSync(SQL_PATH, "utf8")) {
  const spec = parseWaypointChecks(sql);
  const names = spec.checks.map((c) => c.name);
  for (const required of [
    "waypoints_lat_check",
    "waypoints_lng_check",
    "waypoints_source_check",
    "waypoints_title_check",
  ]) {
    if (!names.includes(required)) {
      throw new Error(`SQL-Datei enthält ${required} nicht`);
    }
  }
  if (!spec.notNull.includes("source") || !spec.notNull.includes("day")) {
    throw new Error("SQL-Datei enthält die NOT-NULL-Spalten nicht");
  }
  return spec;
}

function isNull(value) {
  return value === null || value === undefined;
}

function checkPasses(check, row) {
  if (check.name === "waypoints_lat_check") {
    if (isNull(row.lat)) return true;
    const lat = Number(row.lat);
    return Number.isFinite(lat) && lat >= -90 && lat <= 90;
  }
  if (check.name === "waypoints_lng_check") {
    if (isNull(row.lng)) return true;
    const lng = Number(row.lng);
    return Number.isFinite(lng) && lng >= -180 && lng <= 180;
  }
  if (check.name === "waypoints_source_check") {
    const allowed = [...check.expr.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    if (!allowed.length) throw new Error("source-Check ohne Werte");
    return allowed.includes(row.source);
  }
  if (check.name === "waypoints_title_check") {
    if (isNull(row.title)) return true;
    const max = Number(/char_length\(title\)\s*<=\s*(\d+)/.exec(check.expr)?.[1]);
    if (!Number.isFinite(max)) throw new Error("title-Check ohne Grenze");
    return String(row.title).length <= max;
  }
  throw new Error(`Check ${check.name} ist im Mock nicht nachgebildet`);
}

/**
 * Bildet die Wegpunkt-Checks nach. null = Zeile ist gültig.
 * Sonst PostgREST-Fehler mit dem Postgres-Text.
 */
export function validateWaypointInsert(row, spec = loadWaypointConstraintSpec()) {
  for (const column of spec.notNull) {
    if (isNull(row?.[column])) {
      return {
        code: "23502",
        message: `null value in column "${column}" of relation "waypoints" violates not-null constraint`,
      };
    }
  }
  for (const check of spec.checks) {
    if (!checkPasses(check, row)) {
      return {
        code: "23514",
        message: `new row for relation "waypoints" violates check constraint "${check.name}"`,
      };
    }
  }
  return null;
}

export const WAYPOINT_SOURCE_CHECK_MESSAGE =
  'new row for relation "waypoints" violates check constraint "waypoints_source_check"';
