import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const SUPABASE_HOST = "hgboqdovlfeuqfhfeykn.supabase.co";

function resolveShotDir() {
  const candidates = [
    process.env.VACRECAP_SHOTS,
    path.join(__dirname, "artifacts"),
    path.join(os.tmpdir(), "vacrecap-paket8"),
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true });
      return dir;
    } catch {
      /* nächster Kandidat */
    }
  }
  return os.tmpdir();
}

const SHOTS = resolveShotDir();

const DOMI = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1";
const SABINE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2";
const ANNA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3";
const TOM = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4";
const GARDA = "trip-garda";
const TEST = "trip-test";
const SOLO = "trip-solo";
const DAY = "2026-10-27";

const PEOPLE = {
  [DOMI]: { id: DOMI, email: "domi@example.com", name: "Domi" },
  [SABINE]: { id: SABINE, email: "sabine@example.com", name: "Sabine" },
  [ANNA]: { id: ANNA, email: "anna@example.com", name: "Anna" },
  [TOM]: { id: TOM, email: "tom@example.com", name: "Tom" },
};

const VIEWPORTS = [
  { width: 375, height: 667 },
  { width: 360, height: 740 },
  { width: 390, height: 844 },
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function startServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      let rel = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
      if (rel.endsWith("/")) rel += "index.html";
      try {
        const data = await readFile(path.join(root, rel.replace(/^\//, "")));
        res.writeHead(200, { "Content-Type": MIME[path.extname(rel)] || "application/octet-stream" });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}/` }));
  });
}

function colorFor(name) {
  const value = String(name || "");
  if (value.startsWith("Dom")) return "#0066b3";
  if (value.startsWith("Sabine")) return "#D64541";
  if (value.startsWith("Anna")) return "#1F9D57";
  return "#C25E00";
}

function plusDays(iso, days) {
  return new Date(Date.parse(iso) + days * 86400000).toISOString();
}

function createState() {
  const profiles = Object.values(PEOPLE).map((person) => ({
    id: person.id,
    display_name: person.name,
    avatar_color: colorFor(person.name),
  }));
  const trips = [
    {
      id: GARDA,
      title: "Gardasee 2026",
      start_date: "2026-10-26",
      end_date: "2026-11-01",
      companions: [],
      companion_tags: [],
      cover_preset: "berge",
      cover_media_id: null,
      created_by: DOMI,
      created_at: "2026-10-01T10:00:00.000Z",
      updated_at: "2026-10-20T10:00:00.000Z",
    },
    {
      id: TEST,
      title: "Test",
      start_date: "2026-11-14",
      end_date: "2026-11-16",
      companions: [],
      companion_tags: [],
      cover_preset: "stadt",
      cover_media_id: null,
      created_by: DOMI,
      created_at: "2026-10-02T10:00:00.000Z",
      updated_at: "2026-10-02T10:00:00.000Z",
    },
    {
      id: SOLO,
      title: "Solo 2025",
      start_date: "2025-06-16",
      end_date: "2025-06-20",
      companions: ["Ida"],
      companion_tags: [],
      cover_preset: "strand",
      cover_media_id: null,
      created_by: DOMI,
      created_at: "2025-06-01T10:00:00.000Z",
      updated_at: "2025-06-01T10:00:00.000Z",
    },
  ];
  const members = [
    { trip_id: GARDA, user_id: DOMI, role: "owner", created_at: "2026-10-01T10:00:00.000Z" },
    { trip_id: GARDA, user_id: SABINE, role: "editor", created_at: "2026-10-02T10:00:00.000Z" },
    { trip_id: GARDA, user_id: ANNA, role: "viewer", created_at: "2026-10-03T10:00:00.000Z" },
    { trip_id: TEST, user_id: DOMI, role: "owner", created_at: "2026-10-02T10:00:00.000Z" },
    { trip_id: SOLO, user_id: DOMI, role: "owner", created_at: "2025-06-01T10:00:00.000Z" },
  ];
  const invites = [];
  const former = [];
  const waypoints = [
    place(GARDA, "p-hafen", DOMI, "Hafen Malcesine", "2026-10-27T09:10:00.000Z"),
    place(GARDA, "p-anna", ANNA, "Eigener Steg", "2026-10-27T15:00:00.000Z"),
    place(TEST, "p-test", DOMI, "Treffpunkt", "2026-11-14T09:00:00.000Z"),
  ];
  const notes = [
    note(GARDA, "n-domi", "p-hafen", DOMI, "Fähre nach Limone um 12:15.", "2026-10-27T09:20:00.000Z"),
  ];
  const media = [];
  for (let i = 0; i < 5; i += 1) {
    media.push(photo(GARDA, `m-sabine-${i}`, "p-hafen", SABINE, `2026-10-27T09:${10 + i}:00.000Z`));
  }
  media.push(photo(GARDA, "m-domi", "p-hafen", DOMI, "2026-10-27T09:30:00.000Z"));
  media.push(photo(GARDA, "m-anna", "p-hafen", ANNA, "2026-10-27T09:40:00.000Z"));
  media.push(photo(GARDA, "m-on-anna", "p-anna", DOMI, "2026-10-27T15:10:00.000Z"));
  media.push(photo(TEST, "m-sabine-test", "p-test", SABINE, "2026-11-14T09:05:00.000Z"));
  const presence = [];
  const state = {
    userId: DOMI,
    email: "domi@example.com",
    membersFail: false,
    blockDelete: false,
    lookups: 0,
    rpcLog: [],
    routeErrors: [],
    profiles,
    trips,
    members,
    invites,
    former,
    waypoints,
    notes,
    media,
    presence,
    session: null,
  };
  state.session = sessionFor(state);
  return state;
}

function sessionFor(state) {
  return {
    access_token: "test-access",
    refresh_token: "test-refresh",
    expires_in: 360000,
    expires_at: Math.floor(Date.now() / 1000) + 360000,
    token_type: "bearer",
    user: { id: state.userId, aud: "authenticated", role: "authenticated", email: state.email },
  };
}

function place(tripId, id, author, title, iso) {
  return {
    id,
    trip_id: tripId,
    day: iso.slice(0, 10),
    visited_at: iso,
    lat: 45.76,
    lng: 10.81,
    title,
    is_soft: false,
    source: "manual",
    deleted_at: null,
    created_by: author,
    created_at: iso,
    updated_at: iso,
    updated_by: author,
  };
}

function note(tripId, id, placeId, author, body, iso) {
  return {
    id,
    trip_id: tripId,
    waypoint_id: placeId,
    day: iso.slice(0, 10),
    body,
    deleted_at: null,
    created_by: author,
    created_at: iso,
    updated_at: iso,
    updated_by: author,
  };
}

function photo(tripId, id, placeId, author, iso) {
  return {
    id,
    trip_id: tripId,
    waypoint_id: placeId,
    day: iso.slice(0, 10),
    taken_at: iso,
    kind: "photo",
    storage_path: `${tripId}/${id}.jpg`,
    thumb_path: `${tripId}/${id}.jpg`,
    mime: "image/jpeg",
    upload_status: "uploaded",
    deleted_at: null,
    created_by: author,
    created_at: iso,
    updated_at: iso,
    updated_by: author,
    caption: null,
  };
}

function roleOn(state, tripId, userId = state.userId) {
  return state.members.find((row) => row.trip_id === tripId && row.user_id === userId)?.role || null;
}

function canWriteRow(state, row) {
  const role = roleOn(state, row.trip_id);
  if (role === "owner" || role === "editor") return true;
  return role === "viewer" && row.created_by === state.userId;
}

function applyFilters(rows, url) {
  let out = rows.slice();
  for (const [key, value] of url.searchParams.entries()) {
    if (["select", "order", "offset", "limit", "on_conflict"].includes(key)) continue;
    if (value === "is.null") out = out.filter((row) => row[key] == null);
    else if (value.startsWith("eq.")) out = out.filter((row) => String(row[key]) === value.slice(3));
    else if (value.startsWith("not.is.")) out = out.filter((row) => row[key] != null);
    else if (value.startsWith("in.(") && value.endsWith(")")) {
      const set = new Set(value.slice(4, -1).split(","));
      out = out.filter((row) => set.has(String(row[key])));
    }
  }
  return out;
}

function sendRows(rows, headers) {
  const accept = headers.accept || headers.Accept || "";
  if (String(accept).includes("application/vnd.pgrst.object+json")) {
    if (!rows.length) return { status: 406, json: { code: "PGRST116", message: "0 rows" } };
    return { status: 200, json: rows[0] };
  }
  return { status: 200, json: rows };
}

function personRow(state, userId, role, since) {
  const profile = state.profiles.find((row) => row.id === userId);
  return {
    person_kind: "member",
    user_id: userId,
    invite_id: null,
    display_name: profile?.display_name || "Jemand",
    avatar_color: profile?.avatar_color || "#5D6D7E",
    role,
    status: "aktiv",
    email: roleOn(state, null) === "owner" ? PEOPLE[userId]?.email || null : null,
    since,
    expires_at: null,
  };
}

function handleRpc(state, name, body) {
  state.rpcLog.push(name);
  const args = body ? JSON.parse(body) : {};
  if (name === "list_my_trip_invites") {
    const now = Date.parse("2026-10-30T10:00:00.000Z");
    const rows = state.invites.filter(
      (row) =>
        row.email === state.email &&
        !row.accepted_at &&
        !row.declined_at &&
        !row.revoked_at &&
        Date.parse(row.expires_at) > now
    );
    return {
      status: 200,
      json: rows.map((row) => {
        const trip = state.trips.find((item) => item.id === row.trip_id);
        const inviter = state.profiles.find((item) => item.id === row.created_by);
        return {
          invite_id: row.id,
          trip_id: row.trip_id,
          trip_title: trip?.title || "",
          start_date: trip?.start_date || null,
          end_date: trip?.end_date || null,
          cover_preset: trip?.cover_preset || "stadt",
          role: row.role,
          invited_by: row.created_by,
          inviter_name: inviter?.display_name || "",
          inviter_color: inviter?.avatar_color || "#0066b3",
          inviter_role: roleOn(state, row.trip_id, row.created_by) || "owner",
          members: state.members
            .filter((member) => member.trip_id === row.trip_id)
            .map((member) => personRow(state, member.user_id, member.role, member.created_at)),
          created_at: row.created_at,
          expires_at: row.expires_at,
        };
      }),
    };
  }
  if (name === "list_trip_people") {
    const tripId = args.p_trip_id;
    if (!roleOn(state, tripId)) return { status: 403, json: { code: "42501", message: "Kein Zugriff" } };
    const owner = roleOn(state, tripId) === "owner";
    const rows = state.members
      .filter((member) => member.trip_id === tripId)
      .map((member) => {
        const row = personRow(state, member.user_id, member.role, member.created_at);
        if (!owner) row.email = null;
        else row.email = PEOPLE[member.user_id]?.email || null;
        return row;
      });
    if (owner) {
      for (const invite of state.invites.filter((row) => row.trip_id === tripId && !row.accepted_at && !row.revoked_at && !row.declined_at)) {
        const expired = Date.parse(invite.expires_at) <= Date.parse("2026-10-30T10:00:00.000Z");
        rows.push({
          person_kind: "invite",
          user_id: invite.invited_user_id,
          invite_id: invite.id,
          display_name: invite.email,
          avatar_color: "#0066b3",
          role: invite.role,
          status: expired ? "abgelaufen" : "eingeladen",
          email: invite.email,
          since: invite.created_at,
          expires_at: invite.expires_at,
        });
      }
    }
    for (const row of state.former.filter((item) => item.trip_id === tripId)) rows.push(row);
    return { status: 200, json: rows };
  }
  if (name === "invite_to_trip") {
    const tripId = args.p_trip_id;
    if (roleOn(state, tripId) !== "owner") {
      return { status: 403, json: { code: "42501", message: "Nur der Besitzer kann Freigaben verwalten" } };
    }
    const list = args.p_invites || [];
    if (list.length > 20) return { status: 400, json: { code: "22023", message: "Höchstens 20 Adressen auf einmal" } };
    const results = [];
    for (const item of list) {
      const email = String(item.email || "").trim().toLowerCase();
      const role = item.role;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || (role !== "editor" && role !== "viewer")) {
        results.push({ email, result: "invalid", invite_id: null });
        continue;
      }
      state.lookups += 1;
      if (state.lookups > 50) {
        results.push({ email, result: "rate_limited", invite_id: null });
        continue;
      }
      if (email === state.email) {
        results.push({ email, result: "self", invite_id: null });
        continue;
      }
      const account = Object.values(PEOPLE).find((person) => person.email === email);
      if (!account) {
        results.push({ email, result: "not_registered", invite_id: null });
        continue;
      }
      if (state.members.some((member) => member.trip_id === tripId && member.user_id === account.id)) {
        results.push({ email, result: "already_member", invite_id: null });
        continue;
      }
      const open = state.invites.find(
        (row) => row.trip_id === tripId && row.email === email && !row.accepted_at && !row.declined_at && !row.revoked_at
      );
      if (open) {
        open.role = role;
        open.expires_at = plusDays("2026-10-30T10:00:00.000Z", 14);
        results.push({ email, result: "updated", invite_id: open.id });
      } else {
        const id = crypto.randomUUID();
        state.invites.push({
          id,
          trip_id: tripId,
          email,
          role,
          invited_user_id: account.id,
          token: crypto.randomUUID(),
          created_by: state.userId,
          created_at: "2026-10-30T10:00:00.000Z",
          expires_at: plusDays("2026-10-30T10:00:00.000Z", 14),
          accepted_at: null,
          declined_at: null,
          revoked_at: null,
        });
        results.push({ email, result: "invited", invite_id: id });
      }
    }
    return { status: 200, json: results };
  }
  if (name === "set_trip_access_role") {
    if (roleOn(state, args.p_trip_id) !== "owner") {
      return { status: 403, json: { code: "42501", message: "Nur der Besitzer kann Freigaben verwalten" } };
    }
    if (args.p_role !== "editor" && args.p_role !== "viewer") {
      return { status: 400, json: { code: "22023", message: "Unbekannte Rolle" } };
    }
    const targets = [args.p_user_id, args.p_invite_id].filter(Boolean);
    if (targets.length !== 1) return { status: 400, json: { code: "22023", message: "Genau eine Person oder Einladung angeben" } };
    if (args.p_user_id) {
      const member = state.members.find((row) => row.trip_id === args.p_trip_id && row.user_id === args.p_user_id);
      if (!member || member.role === "owner") return { status: 404, json: { code: "P0002", message: "Nicht gefunden" } };
      member.role = args.p_role;
    } else {
      const invite = state.invites.find((row) => row.id === args.p_invite_id && row.trip_id === args.p_trip_id);
      if (!invite) return { status: 404, json: { code: "P0002", message: "Nicht gefunden" } };
      invite.role = args.p_role;
    }
    return { status: 200, json: true };
  }
  if (name === "revoke_trip_access") {
    if (roleOn(state, args.p_trip_id) !== "owner") {
      return { status: 403, json: { code: "42501", message: "Nur der Besitzer kann Freigaben verwalten" } };
    }
    if (args.p_user_id) {
      const member = state.members.find((row) => row.trip_id === args.p_trip_id && row.user_id === args.p_user_id);
      if (!member) return { status: 404, json: { code: "P0002", message: "Nicht gefunden" } };
      if (member.role === "owner") return { status: 403, json: { code: "42501", message: "Als Besitzer nicht entfernbar" } };
      state.members = state.members.filter((row) => row !== member);
      const profile = state.profiles.find((row) => row.id === args.p_user_id);
      state.former.push({
        person_kind: "former",
        user_id: args.p_user_id,
        invite_id: null,
        display_name: profile?.display_name || "Jemand",
        avatar_color: profile?.avatar_color || "#5D6D7E",
        role: member.role,
        status: "ehemalig",
        email: null,
        since: member.created_at,
        expires_at: null,
        trip_id: args.p_trip_id,
      });
      for (const invite of state.invites) {
        if (invite.trip_id === args.p_trip_id && invite.invited_user_id === args.p_user_id && !invite.accepted_at) {
          invite.revoked_at = "2026-10-30T10:00:00.000Z";
        }
      }
    } else if (args.p_invite_id) {
      const invite = state.invites.find((row) => row.id === args.p_invite_id);
      if (!invite) return { status: 404, json: { code: "P0002", message: "Nicht gefunden" } };
      invite.revoked_at = "2026-10-30T10:00:00.000Z";
    }
    return { status: 200, json: true };
  }
  if (name === "accept_trip_invite_by_id") {
    const invite = state.invites.find((row) => row.id === args.p_invite_id && row.email === state.email && !row.accepted_at && !row.declined_at && !row.revoked_at);
    if (!invite || Date.parse(invite.expires_at) <= Date.parse("2026-10-30T10:00:00.000Z")) {
      return { status: 400, json: { code: "P0001", message: "Einladung ungueltig oder abgelaufen" } };
    }
    invite.accepted_at = "2026-10-30T10:05:00.000Z";
    invite.accepted_by = state.userId;
    if (!state.members.some((row) => row.trip_id === invite.trip_id && row.user_id === state.userId)) {
      state.members.push({ trip_id: invite.trip_id, user_id: state.userId, role: invite.role, created_at: invite.accepted_at });
    }
    return { status: 200, json: invite.trip_id };
  }
  if (name === "decline_trip_invite") {
    const invite = state.invites.find((row) => row.id === args.p_invite_id && row.email === state.email);
    if (!invite) return { status: 404, json: { code: "P0002", message: "Einladung nicht gefunden" } };
    invite.declined_at = "2026-10-30T10:06:00.000Z";
    return { status: 200, json: true };
  }
  if (name === "leave_trip") {
    const member = state.members.find((row) => row.trip_id === args.p_trip_id && row.user_id === state.userId);
    if (!member) return { status: 403, json: { code: "42501", message: "Kein Zugriff" } };
    if (member.role === "owner") {
      return { status: 403, json: { code: "42501", message: "Als Besitzer kannst du die Reise nicht verlassen" } };
    }
    state.members = state.members.filter((row) => row !== member);
    return { status: 200, json: true };
  }
  if (name === "touch_trip_presence") {
    if (!roleOn(state, args.p_trip_id)) return { status: 403, json: { code: "42501", message: "Kein Zugriff" } };
    const existing = state.presence.find((row) => row.trip_id === args.p_trip_id && row.user_id === state.userId);
    const next = { trip_id: args.p_trip_id, user_id: state.userId, target: args.p_target || "trip", seen_at: "2026-10-30T10:00:00.000Z" };
    if (existing) Object.assign(existing, next);
    else state.presence.push(next);
    return { status: 200, json: true };
  }
  if (name === "clear_trip_presence") {
    state.presence = state.presence.filter((row) => !(row.trip_id === args.p_trip_id && row.user_id === state.userId));
    return { status: 200, json: true };
  }
  if (name === "list_trip_presence") {
    if (!roleOn(state, args.p_trip_id)) return { status: 403, json: { code: "42501", message: "Kein Zugriff" } };
    return {
      status: 200,
      json: state.presence
        .filter((row) => row.trip_id === args.p_trip_id && row.user_id !== state.userId)
        .map((row) => {
          const profile = state.profiles.find((item) => item.id === row.user_id);
          return {
            user_id: row.user_id,
            display_name: profile?.display_name || "",
            avatar_color: profile?.avatar_color || "#5D6D7E",
            target: row.target,
            seen_at: row.seen_at,
          };
        }),
    };
  }
  return { status: 404, json: { code: "PGRST202", message: `missing rpc ${name}` } };
}

function handleRest(state, url, method, body, headers) {
  const table = url.pathname.split("/").filter(Boolean).pop();
  if (url.pathname.includes("/rpc/")) return handleRpc(state, table, body);
  const qp = (key) => {
    const value = url.searchParams.get(key);
    return value?.startsWith("eq.") ? value.slice(3) : value;
  };
  if (table === "trips") {
    if (method === "GET") {
      const visible = new Set(state.members.filter((row) => row.user_id === state.userId).map((row) => row.trip_id));
      let rows = state.trips.filter((row) => visible.has(row.id) || row.created_by === state.userId);
      rows = applyFilters(rows, url);
      return sendRows(rows, headers);
    }
    if (method === "POST" || method === "PATCH") {
      const parsed = JSON.parse(body || "{}");
      const id = parsed.id || qp("id") || crypto.randomUUID();
      let row = state.trips.find((item) => item.id === id);
      if (method === "PATCH") {
        const matched = applyFilters(state.trips.filter((item) => item.id === id), url);
        if (!matched.length || roleOn(state, id) === "viewer") return { status: 200, json: [] };
        if (!row) return { status: 200, json: [] };
      }
      if (!row) {
        row = { id, created_by: state.userId, created_at: "2026-10-30T10:00:00.000Z", companions: [], companion_tags: [] };
        state.trips.push(row);
        if (!state.members.some((member) => member.trip_id === id && member.user_id === state.userId)) {
          state.members.push({ trip_id: id, user_id: state.userId, role: "owner", created_at: row.created_at });
        }
      }
      Object.assign(row, parsed, { id, updated_at: "2026-10-30T11:00:00.000Z", updated_by: state.userId });
      return { status: 200, json: [row] };
    }
    if (method === "DELETE") {
      const id = qp("id");
      if (state.blockDelete || roleOn(state, id) !== "owner") return { status: 200, json: [] };
      const before = state.trips.length;
      state.trips = state.trips.filter((row) => row.id !== id);
      if (state.trips.length === before) return { status: 200, json: [] };
      return { status: 200, json: [{ id }] };
    }
  }
  if (table === "trip_members" && method === "GET") {
    if (state.membersFail) return { status: 500, json: { code: "57014", message: "role down" } };
    return sendRows(applyFilters(state.members, url), headers);
  }
  if (table === "profiles") {
    if (method === "GET") return sendRows(applyFilters(state.profiles, url), headers);
    if (method === "PATCH") {
      const id = qp("id");
      const row = state.profiles.find((item) => item.id === id);
      if (!row || id !== state.userId) return { status: 200, json: [] };
      const parsed = JSON.parse(body || "{}");
      Object.assign(row, parsed);
      row.avatar_color = colorFor(row.display_name);
      return { status: 200, json: [row] };
    }
  }
  if (table === "waypoints" || table === "notes" || table === "media") {
    const list = state[table];
    if (method === "GET") return sendRows(applyFilters(list, url), headers);
    if (method === "POST") {
      const parsed = JSON.parse(body || "{}");
      const id = parsed.id || crypto.randomUUID();
      const existing = list.find((row) => row.id === id);
      if (existing && !canWriteRow(state, existing)) {
        return { status: 403, json: { code: "42501", message: "new row violates row-level security policy" } };
      }
      const row = existing || {
        id,
        created_by: state.userId,
        created_at: "2026-10-30T10:00:00.000Z",
        deleted_at: null,
      };
      Object.assign(row, parsed, { id, updated_at: "2026-10-30T12:00:00.000Z", updated_by: state.userId, created_by: row.created_by || state.userId });
      if (!existing) list.push(row);
      return { status: 201, json: [row] };
    }
    if (method === "PATCH") {
      const parsed = JSON.parse(body || "{}");
      const matched = applyFilters(list, url);
      if (!matched.length) return { status: 200, json: [] };
      const row = matched[0];
      if (!canWriteRow(state, row)) return { status: 200, json: [] };
      if (table === "waypoints" && parsed.deleted_at && roleOn(state, row.trip_id) === "viewer") {
        const foreign = [...state.media, ...state.notes].some(
          (item) => item.waypoint_id === row.id && !item.deleted_at && item.created_by !== state.userId
        );
        if (foreign) {
          return { status: 400, json: { code: "P0001", message: "An diesem Ort hängen Inhalte von anderen" } };
        }
      }
      Object.assign(row, parsed, { updated_at: parsed.updated_at || "2026-10-30T12:05:00.000Z", updated_by: state.userId, created_by: row.created_by });
      return { status: 200, json: [row] };
    }
  }
  if (table === "trip_recaps" && method === "GET") return { status: 200, json: [] };
  return { status: 404, json: { message: `missing ${method} ${table}` } };
}

async function install(page, state) {
  page.on("console", (msg) => {
    if (msg.type() === "error") state.routeErrors.push(`CONSOLE ${msg.text()}`);
  });
  page.on("response", (res) => {
    if (res.status() >= 400) state.routeErrors.push(`HTTP ${res.status()} ${res.request().method()} ${res.url()}`);
  });
  page.on("requestfailed", (req) => {
    state.routeErrors.push(`FAIL ${req.method()} ${req.url()} ${req.failure()?.errorText || ""}`);
  });
  await page.context().route(`**/${SUPABASE_HOST}/**`, async (route) => {
    const req = route.request();
    const cors = {
      "access-control-allow-origin": req.headers()["origin"] || "http://127.0.0.1",
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": req.headers()["access-control-request-headers"] || "*",
      "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
      "access-control-expose-headers": "*",
      vary: "Origin",
    };
    if (req.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    const url = new URL(req.url());
    let result = { status: 404, json: {} };
    try {
    if (url.pathname.includes("/auth/v1/")) {
      state.session.user = { id: state.userId, aud: "authenticated", role: "authenticated", email: state.email };
      if (url.pathname.endsWith("/token") || url.pathname.endsWith("/verify")) result = { status: 200, json: state.session };
      else if (url.pathname.endsWith("/user")) result = { status: 200, json: state.session.user };
      else result = { status: 200, json: {} };
    } else if (url.pathname.includes("/storage/v1/")) {
      if (url.pathname.includes("/object/sign/")) {
        let paths = [];
        try {
          paths = JSON.parse(req.postData() || "{}").paths || [];
        } catch {
          paths = [];
        }
        result = {
          status: 200,
          json: (paths.length ? paths : ["x"]).map((item) => ({
            path: item,
            signedURL: `/object/sign/media-thumbs/${encodeURIComponent(item)}?token=t`,
          })),
        };
      } else {
        result = { status: 200, json: { Key: "ok" } };
      }
    } else if (url.pathname.includes("/rest/v1/")) {
      result = handleRest(state, url, req.method(), req.postData(), req.headers());
      if (result?.status >= 400) state.routeErrors.push(`${result.status} ${req.method()} ${url.pathname}${url.search}`);
    }
    } catch (err) {
      state.routeErrors.push(`${req.method()} ${url.pathname}: ${err.stack || err}`);
      result = { status: 500, json: { message: String(err.message || err) } };
    }
    await route.fulfill({
      status: result.status,
      contentType: "application/json",
      headers: cors,
      body: result.json == null ? "" : JSON.stringify(result.json),
    });
  });
  await page.addInitScript(() => {
    const RealDate = Date;
    const fixed = Date.parse("2026-10-30T10:00:00.000Z");
    function TestDate(...args) {
      if (!new.target) return new RealDate(fixed).toString();
      if (args.length === 0) return new RealDate(fixed);
      return new RealDate(...args);
    }
    TestDate.prototype = RealDate.prototype;
    TestDate.now = () => fixed;
    TestDate.parse = RealDate.parse.bind(RealDate);
    TestDate.UTC = RealDate.UTC.bind(RealDate);
    window.Date = TestDate;
  });
}

async function login(page, baseUrl) {
  await page.goto(baseUrl);
  await page.waitForSelector('[data-testid="login-screen"]');
  await page.evaluate(async () => {
    const { setRememberLocationOnOpen, setMapRoutesEnabled } = await import("./js/settings-store.js");
    await setRememberLocationOnOpen(false);
    await setMapRoutesEnabled(false);
  });
  await page.fill('input[name="email"]', "domi@example.com");
  await page.click('form[data-step="email"] button[type="submit"]');
  await page.waitForSelector('form[data-step="otp"]');
  await page.fill('input[name="otp"]', "123456");
  await page.click('form[data-step="otp"] button[type="submit"]');
  await page.waitForSelector(".screen--urlaube");
}

async function asUser(page, state, person) {
  state.userId = person.id;
  state.email = person.email;
  await page.evaluate((user) => {
    const key = Object.keys(localStorage).find((item) => item.startsWith("sb-") && item.endsWith("-auth-token"));
    if (!key) return;
    const parsed = JSON.parse(localStorage.getItem(key));
    parsed.user = { ...parsed.user, id: user.id, email: user.email };
    localStorage.setItem(key, JSON.stringify(parsed));
  }, person);
  await page.evaluate(() => {
    window.location.hash = "#/urlaube";
  });
  await page.reload();
  try {
    await page.waitForSelector(".screen--urlaube", { timeout: 8000 });
  } catch (err) {
    const text = await page.locator("body").innerText();
    throw new Error(`Wechsel zu ${person.email}: ${text.slice(0, 300)} ${state.routeErrors.slice(-3).join(" || ")} ${err.message}`);
  }
}

async function shot(page, name, enabled) {
  if (!enabled) return;
  await page.evaluate(() => document.querySelector('[data-testid="app-toast"]')?.remove());
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function overflow(page, selector) {
  return page.locator(selector).evaluate((root) => {
    const bad = [];
    const nodes = [root, ...root.querySelectorAll("*")];
    for (const el of nodes) {
      if (!el.clientWidth) continue;
      if (el.scrollWidth > el.clientWidth + 2) bad.push(`${el.className}: ${el.scrollWidth}>${el.clientWidth}`);
    }
    return bad.slice(0, 6);
  });
}

async function openEdit(page, id) {
  const titles = { [GARDA]: "Gardasee 2026", [TEST]: "Test", [SOLO]: "Solo 2025" };
  await page.evaluate((tripId) => {
    window.location.hash = `#/urlaub/${tripId}/bearbeiten`;
  }, id);
  await page.waitForFunction(
    ({ tripId, title }) =>
      location.hash.includes(`/urlaub/${tripId}/bearbeiten`) &&
      document.querySelector('input[name="title"]')?.value === title,
    { tripId: id, title: titles[id] }
  );
}

async function chipBlob(page) {
  return page.locator('[data-testid="share-chip"]').evaluateAll((nodes) => nodes.map((node) => node.textContent || "").join(" "));
}

async function waitRestoredChips(page) {
  await page.waitForFunction(() => {
    const section = document.querySelector('[data-testid="share-section"]');
    const chips = [...document.querySelectorAll('[data-testid="share-chip"]')].map((node) => node.textContent || "");
    if (!section || section.dataset.remount) return false;
    return chips.length === 2 && chips.some((text) => text.includes("kaputt")) && chips.some((text) => text.includes("tom@example.com"));
  });
}

async function checkOfflineDrafts(page, label) {
  await page.fill('[data-testid="share-email-input"]', "tom@example.com, kaputt");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="share-chip"]').length === 2);
  const before = await chipBlob(page);
  assert(before.includes("tom@example.com") && before.includes("kaputt"), `${label}: Chips vorher «${before}»`);
  await page.locator('[data-testid="share-section"]').evaluate((el) => {
    el.dataset.remount = "offline";
  });
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await waitRestoredChips(page);
  await page.locator('[data-testid="share-section"]').evaluate((el) => {
    el.dataset.remount = "online";
  });
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await waitRestoredChips(page);
  try {
    await page.locator('[data-testid="share-section"]').evaluate((el) => {
      el.dataset.remount = "save";
    });
    await page.context().setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await waitRestoredChips(page);
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => (document.querySelector('[data-testid="app-toast"]')?.textContent || "").includes("Einladen geht nur mit Verbindung"));
    assert((await page.locator('[data-testid="share-chip"]').count()) === 2, `${label}: Chips nach Offline-Speichern weg`);
    assert((await chipBlob(page)).includes("kaputt"), `${label}: roter Chip nach Offline-Speichern weg`);
  } finally {
    await page.context().setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
  }
  await page.locator('[data-testid="share-section"]').evaluate((el) => {
    el.dataset.remount = "clear";
  });
  await waitRestoredChips(page);
  while ((await page.locator('[data-testid="share-chip"]').count()) > 0) {
    await page.locator('[data-testid="share-chip"]').first().click();
  }
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="share-chip"]').length === 0);
}

async function runFlows(page, state, label, shots, baseUrl) {
  await login(page, baseUrl);

  await openEdit(page, GARDA);
  await page.waitForSelector('[data-testid="share-section"]');
  assert((await page.locator(".field__label").first().locator("xpath=following::span[contains(.,'Wer ist dabei') or contains(.,'Freigeben')]").count()) >= 0, "layout");
  const labels = await page.locator(".field__label").allInnerTexts();
  const dabei = labels.findIndex((text) => text.includes("Wer ist dabei"));
  const share = labels.findIndex((text) => text.includes("Freigeben"));
  assert(dabei >= 0 && share > dabei, `${label}: Freigeben steht nicht unter Wer ist dabei`);
  await checkOfflineDrafts(page, label);
  await page.fill('[data-testid="share-email-input"]', "tom@example.com, niemand@example.com, domi@example.com");
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-testid="share-chip"]');
  await page.locator('[data-mail="tom@example.com"] [data-share-role="editor"]').click();
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => (document.querySelector('[data-testid="app-toast"]')?.textContent || "").includes("Einladung gespeichert"));
  const toast = await page.locator('[data-testid="app-toast"]').innerText();
  assert(toast.includes("Das bist du"), `${label}: eigene Adresse «${toast}»`);
  assert(toast.includes("Noch kein Konto"), `${label}: ohne Konto «${toast}»`);
  await page.waitForFunction(() => (document.querySelector('[data-testid="share-access"]')?.innerText || "").includes("tom@example.com"));
  const accessInfo = await page.locator('[data-testid="share-access"]').evaluate((el) => ({
    text: el.textContent,
    hidden: el.hidden,
    html: el.innerHTML.slice(0, 800),
  }));
  const access = accessInfo.text || "";
  assert(access.includes("Eingeladen") && access.includes("Mitbearbeiter"), `${label}: Liste hidden=${accessInfo.hidden} «${access}» ${accessInfo.html}`);
  const sectionText = await page.locator('[data-testid="share-section"]').evaluate((el) => el.innerText);
  assert(sectionText.includes("Noch kein Konto"), `${label}: roter Chip fehlt «${sectionText}»`);
  const tomInvites = state.invites.filter((row) => row.email === "tom@example.com" && row.trip_id === GARDA && !row.revoked_at);
  assert(tomInvites.length === 1, `${label}: Tom steht ${tomInvites.length} mal in den Einladungen`);
  const bad = await overflow(page, '[data-testid="share-section"]');
  assert(!bad.length, `${label}: Formular läuft über ${bad.join(" | ")}`);
  await shot(page, "01-besitzer-form", shots);

  const more = page.locator('[data-testid="share-more"][data-email="tom@example.com"]');
  await more.click();
  await page.waitForSelector('[data-testid="share-action-sheet"]');
  await shot(page, "03-aktionsblatt", shots);
  await page.locator('[data-testid="share-action-sheet"] [data-action="viewer"]').click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="app-toast"]')?.textContent || "").includes("Rolle geändert"));
  assert((await page.locator('[data-testid="share-access"]').evaluate((el) => el.innerText)).includes("Beitragender"), `${label}: Rolle nicht aktualisiert`);
  await page.fill('[data-testid="share-email-input"]', "tom@example.com");
  await page.keyboard.press("Enter");
  await page.locator('[data-mail="tom@example.com"] [data-share-role="editor"]').click();
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => (document.querySelector('[data-testid="app-toast"]')?.textContent || "").includes("Einladung gespeichert"));
  assert(state.invites.filter((row) => row.email === "tom@example.com" && row.trip_id === GARDA && !row.revoked_at && !row.accepted_at).length === 1, `${label}: zweite Einladung ist doppelt`);
  assert((await page.locator('[data-testid="share-access"]').innerText()).includes("Beitragender"), `${label}: Rolle nicht aktualisiert`);
  await more.click();
  await page.locator('[data-testid="share-action-sheet"] [data-action="revoke"]').click();
  await page.waitForSelector('[data-testid="confirm-revoke"]');
  await shot(page, "04-dialog", shots);
  await page.locator('[data-testid="confirm-revoke"] [data-action="cancel"]').click();
  assert((await page.locator('[data-testid="share-access"]').innerText()).includes("tom@example.com"), `${label}: Abbrechen hat entfernt`);
  await more.click();
  await page.locator('[data-testid="share-action-sheet"] [data-action="revoke"]').click();
  await page.locator('[data-testid="confirm-revoke"] [data-action="confirm"]').click();
  await page.waitForFunction(() => !(document.querySelector('[data-testid="share-access"]')?.innerText || "").includes("tom@example.com"));

  await openEdit(page, TEST);
  const mail = page.locator('[data-testid="share-email-input"]');
  await mail.fill("sabine@example.com tom@example.com");
  await mail.press("Enter");
  await page.waitForSelector('[data-testid="share-chip"]');
  await page.click('button[type="submit"]');
  try {
    await page.waitForFunction(() => (document.querySelector('[data-testid="share-access"]')?.innerText || "").includes("sabine@example.com"), null, { timeout: 5000 });
  } catch (err) {
    const info = await page.evaluate(() => ({
      url: location.hash,
      text: document.body.innerText.slice(0, 700),
      dialog: document.querySelector('[data-testid="conflict-dialog"]')?.innerText || "",
      toast: document.querySelector('[data-testid="app-toast"]')?.textContent || "",
      share: window.__shareDebug || null,
    }));
    throw new Error(`${label}: Test-Einladung ${JSON.stringify(info)} ${err.message}`);
  }
  await shot(page, "02-zugriff-liste", shots);

  await asUser(page, state, PEOPLE[SABINE]);
  await page.waitForSelector('[data-testid="invite-card"]');
  const card = await page.locator('[data-testid="invite-card"]').innerText();
  assert(card.includes("Von") && card.includes("Domi") && card.includes("Besitzer"), `${label}: Von Domi «${card}»`);
  assert(card.includes("Rolle: Beitragender") && card.includes("Schon dabei"), `${label}: Karte «${card}»`);
  const inviteOverflow = await overflow(page, '[data-testid="invite-card"]');
  assert(!inviteOverflow.length, `${label}: Einladung läuft über ${inviteOverflow.join(" | ")}`);
  await shot(page, "05-einladung", shots);
  await page.click('[data-testid="invite-accept"]');
  await page.waitForFunction(() => (document.querySelector('[data-testid="app-toast"]')?.textContent || "").includes("Du bist jetzt dabei"));
  await page.waitForFunction(() => !document.querySelector('[data-testid="invite-card"]'));
  assert(await page.locator('[data-vacation-id="trip-test"]').count(), `${label}: Reise nach Beitreten fehlt`);

  await asUser(page, state, PEOPLE[TOM]);
  await page.waitForSelector('[data-testid="invite-card"]');
  await page.locator('[data-action="decline-invite"]').click();
  await page.locator('[data-testid="confirm-decline-invite"] [data-action="confirm"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="invite-card"]'));

  await asUser(page, state, PEOPLE[DOMI]);
  await openEdit(page, TEST);
  await page.waitForFunction(() => !(document.querySelector('[data-testid="share-access"]')?.innerText || "").includes("tom@example.com"));
  const beforePhotos = state.media.filter((row) => row.id === "m-sabine-test").length;
  await page.locator('[data-testid="share-more"][data-email="sabine@example.com"]').click();
  await page.locator('[data-testid="share-action-sheet"] [data-action="revoke"]').click();
  await page.locator('[data-testid="confirm-revoke"] [data-action="confirm"]').click();
  await page.waitForFunction(() => !(document.querySelector('[data-testid="share-access"]')?.innerText || "").includes("sabine@example.com"));
  assert(state.media.filter((row) => row.id === "m-sabine-test" && !row.deleted_at).length === beforePhotos, `${label}: Foto nach Entziehen weg`);

  await asUser(page, state, PEOPLE[ANNA]);
  await page.locator('[data-vacation-id="trip-garda"]').click();
  await page.waitForSelector('[data-testid="role-banner"]');
  assert((await page.locator('[data-testid="role-banner"]').innerText()).includes("Beitragender"), `${label}: Info-Leiste fehlt`);
  await page.locator(`[data-day="${DAY}"]`).first().click();
  try {
    await page.waitForSelector('[data-place-id="p-hafen"]', { timeout: 8000 });
  } catch (err) {
    const text = await page.locator('[data-testid="trip-content"]').innerText().catch(() => "");
    const http = state.routeErrors.filter((line) => line.startsWith("CONSOLE")).slice(-3);
    throw new Error(`${label}: Tag «${text.slice(0, 200)}» ${http.join(" || ")} ${err.message}`);
  }
  await page.locator('[data-place-id="p-hafen"]').click();
  await page.waitForSelector(".fg-lock");
  await page.waitForSelector(".fg-mine");
  const foreignNote = page.locator('[data-note-id="n-domi"]');
  assert((await foreignNote.innerText()).includes("Von Domi"), `${label}: Von Domi fehlt`);
  assert((await foreignNote.locator('[data-action="edit-note"]').count()) === 0, `${label}: fremde Notiz ist bearbeitbar`);
  await page.locator('[data-place-id="p-hafen"] [data-action="add-note"]').click();
  await page.waitForSelector('[data-testid="note-sheet"]');
  await page.fill('[data-testid="note-sheet"] [data-role="text"]', "Pistazien-Eis");
  await page.click('[data-testid="note-sheet"] [data-action="save"]');
  await page.waitForFunction(() => (document.querySelector('[data-place-id="p-hafen"]')?.innerText || "").includes("Pistazien-Eis"));
  assert((await page.locator('[data-place-id="p-hafen"]').innerText()).includes("Von dir"), `${label}: eigene Notiz ohne Von dir`);
  await shot(page, "06-beitragender", shots);
  await page.locator('[data-place-id="p-anna"]').click();
  await page.locator('[data-place-id="p-anna"] [data-action="edit-place"]').click();
  await page.locator('[data-action="delete"]').click();
  await page.locator('[data-testid="confirm-delete-place"] [data-action="confirm"]').click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="app-toast"]')?.textContent || "").includes("Inhalte von anderen"));
  await page.evaluate(() => {
    window.location.hash = "#/urlaub/trip-garda/einstellungen";
  });
  await page.waitForSelector('[data-testid="settings-screen"]');
  assert((await page.locator('[data-testid="settings-edit-trip"]').count()) === 0, `${label}: Beitragender bearbeitet die Reise`);
  assert((await page.locator('[data-testid="settings-delete-trip"]').count()) === 0, `${label}: Beitragender löscht`);
  assert((await page.locator('[data-testid="settings-recap-video"]').count()) === 0, `${label}: Recap für Beitragenden`);
  assert((await page.locator('[data-testid="settings-diary"]').count()) === 0, `${label}: Tagebuch für Beitragenden`);
  assert((await page.locator('[data-testid="settings-leave-trip"]').count()) === 1, `${label}: Verlassen fehlt`);
  await page.click('[data-testid="settings-leave-trip"]');
  await page.locator('[data-testid="confirm-leave-trip"] [data-action="confirm"]').click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="app-toast"]')?.textContent || "").includes("Reise verlassen"));
  await page.waitForSelector(".screen--urlaube");
  state.members.push({ trip_id: GARDA, user_id: ANNA, role: "viewer", created_at: "2026-10-03T10:00:00.000Z" });

  await asUser(page, state, PEOPLE[SABINE]);
  await page.locator('[data-vacation-id="trip-garda"]').click();
  await page.click(`[data-day="${DAY}"]`);
  await page.locator('[data-place-id="p-hafen"]').click();
  await page.locator('[data-note-id="n-domi"] [data-action="edit-note"]').click({ force: true });
  await page.fill('[data-testid="note-sheet"] [data-role="text"]', "Fähre um 12:30");
  await page.click('[data-testid="note-sheet"] [data-action="save"]');
  await page.waitForFunction(() => (document.querySelector('[data-note-id="n-domi"]')?.innerText || "").includes("12:30"));
  await openEdit(page, GARDA);
  assert((await page.locator('[data-testid="share-section"]').count()) === 0, `${label}: Mitbearbeiter sieht Freigeben`);
  await page.evaluate(() => {
    window.location.hash = "#/urlaub/trip-garda/einstellungen";
  });
  await page.waitForSelector('[data-testid="settings-screen"]');
  assert((await page.locator('[data-testid="settings-edit-trip"]').count()) === 1, `${label}: Mitbearbeiter ohne Reise bearbeiten`);
  assert((await page.locator('[data-testid="settings-delete-trip"]').count()) === 0, `${label}: Mitbearbeiter löscht`);

  await asUser(page, state, PEOPLE[DOMI]);
  await page.locator('[data-vacation-id="trip-garda"]').click();
  await page.waitForSelector('[data-testid="member-bar"]');
  const circles = page.locator('[data-testid="member-bar"] .kr-av');
  assert((await circles.count()) === 3, `${label}: Mitgliederleiste`);
  const colors = await circles.evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).backgroundColor));
  assert(colors.includes("rgb(0, 102, 179)") && colors.includes("rgb(214, 69, 65)") && colors.includes("rgb(31, 157, 87)"), `${label}: Farben ${colors.join(" | ")}`);
  const letters = await circles.allInnerTexts();
  assert(letters.join("") === "DSA" || letters.includes("D") && letters.includes("S") && letters.includes("A"), `${label}: Buchstaben ${letters.join(",")}`);
  await page.locator('[data-testid="member-chip"]', { hasText: "Mitbearbeiter" }).click();
  await page.waitForSelector('[data-testid="member-tip"]');
  const tip = await page.locator('[data-testid="member-tip"]').innerText();
  assert(tip.includes("Sabine · Mitbearbeiter"), `${label}: Tooltip «${tip}»`);
  assert(tip.includes("5 Fotos"), `${label}: Fotozahl «${tip}»`);
  await shot(page, "07-mitgliederleiste", shots);
  await page.locator('[data-testid="member-tip"]').evaluate((el) => el.remove()).catch(() => {});
  await page.locator(`[data-day="${DAY}"]`).first().click({ force: true });
  await page.waitForSelector('[data-place-id="p-hafen"]');
  await page.locator('[data-place-id="p-hafen"]').click();
  await page.waitForSelector('[data-place-id="p-hafen"] .tile');
  assert((await page.locator('[data-place-id="p-hafen"] .tile .kr-av').count()) >= 1, `${label}: Kreis am Foto fehlt`);
  await page.locator('[data-place-id="p-hafen"] .tile [data-kr-tip]').first().click();
  await page.waitForSelector('[data-testid="member-tip"]');
  const photoTip = await page.locator('[data-testid="member-tip"]').innerText();
  assert(photoTip.includes("·"), `${label}: Foto-Kreis ohne Rolle «${photoTip}»`);
  assert((await page.locator('[data-testid="media-viewer"]').count()) === 0, `${label}: Foto-Kreis öffnet den Viewer`);
  await page.locator('[data-testid="member-tip"]').evaluate((el) => el.remove()).catch(() => {});
  assert((await page.locator('[data-note-id="n-domi"] .kr-av').count()) === 1, `${label}: Kreis an der Notiz fehlt`);
  await page.evaluate(() => {
    window.location.hash = "#/urlaube";
  });
  await page.waitForSelector('[data-vacation-id="trip-solo"]');
  assert((await page.locator('[data-vacation-id="trip-solo"] .kr-stack').count()) === 0, `${label}: Solo mit Mitglieder-Kreisen`);
  assert((await page.locator('[data-vacation-id="trip-solo"] .avatar').count()) >= 1, `${label}: Solo ohne Initialen`);
  assert((await page.locator('[data-vacation-id="trip-garda"] .kr-stack').count()) === 1, `${label}: geteilte Karte ohne Kreise`);

  await page.locator('[data-action="settings"]').click();
  await page.waitForSelector('[data-testid="display-name-row"]');
  await page.click('[data-testid="display-name-row"]');
  await page.fill('[data-testid="display-name-input"]', "Dominik");
  await page.click('[data-testid="display-name-save"]');
  await page.waitForFunction(() => (document.querySelector('[data-testid="display-name-label"]')?.textContent || "").includes("Dominik"));
  const preview = await page.locator('[data-testid="display-name-preview"]').innerText();
  assert(preview === "D", `${label}: Vorschau «${preview}»`);
  await page.locator(".sheet__close").click();
  await page.locator('[data-vacation-id="trip-garda"]').click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="member-bar"]')?.innerText || "").includes("Besitzer"));
  await page.locator('[data-testid="member-chip"]').first().click();
  await page.waitForSelector('[data-testid="member-tip"]');
  assert((await page.locator('[data-testid="member-tip"]').innerText()).includes("Dominik"), `${label}: neuer Name fehlt im Kreis`);
  await page.locator('[data-testid="member-tip"]').evaluate((el) => el.remove());

  await page.locator(`[data-day="${DAY}"]`).first().click({ force: true });
  await page.waitForSelector('[data-place-id="p-hafen"]');
  await page.locator('[data-place-id="p-hafen"]').click();
  await page.locator('[data-note-id="n-domi"] [data-action="edit-note"]').click({ force: true });
  await page.waitForSelector('[data-testid="note-sheet"]');
  state.notes.find((row) => row.id === "n-domi").updated_at = "2026-10-30T13:32:00.000Z";
  state.notes.find((row) => row.id === "n-domi").updated_by = SABINE;
  state.notes.find((row) => row.id === "n-domi").body = "Servertext";
  await page.fill('[data-testid="note-sheet"] [data-role="text"]', "Mein Text");
  await page.click('[data-testid="note-sheet"] [data-action="save"]');
  await page.waitForSelector('[data-testid="conflict-dialog"]');
  const conflict = await page.locator('[data-testid="conflict-dialog"]').innerText();
  assert(conflict.includes("Inzwischen geändert") && conflict.includes("Sabine") && conflict.includes("14:32"), `${label}: Konflikt «${conflict}»`);
  await shot(page, "08-konflikt", shots);
  await page.locator('[data-testid="conflict-dialog"] [data-action="cancel"]').click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="note-sheet"] [data-role="text"]')?.value || "") === "Servertext");
  await page.fill('[data-testid="note-sheet"] [data-role="text"]', "Trotzdem");
  state.notes.find((row) => row.id === "n-domi").updated_at = "2026-10-30T13:40:00.000Z";
  await page.click('[data-testid="note-sheet"] [data-action="save"]');
  await page.waitForSelector('[data-testid="conflict-dialog"]');
  await page.locator('[data-testid="conflict-dialog"] [data-action="confirm"]').click();
  await page.waitForFunction(() => (document.querySelector('[data-note-id="n-domi"]')?.innerText || "").includes("Trotzdem"));

  state.presence.push({
    trip_id: GARDA,
    user_id: SABINE,
    target: "note:n-domi",
    seen_at: "2026-10-30T10:00:00.000Z",
  });
  await page.locator('[data-note-id="n-domi"] [data-action="edit-note"]').click({ force: true });
  try {
    await page.waitForSelector('[data-testid="presence-banner"]', { timeout: 4000 });
  } catch (err) {
    const html = await page.locator('[data-testid="note-sheet"]').innerHTML().catch(() => "kein sheet");
    throw new Error(`${label}: presence ${JSON.stringify(state.presence)} ${html.slice(0, 400)} ${err.message}`);
  }
  assert((await page.locator('[data-testid="presence-banner"]').innerText()).includes("Sabine bearbeitet gerade"), `${label}: Hinweis fehlt`);
  await shot(page, "09-bearbeitet-gerade", shots);
  await page.locator('[data-testid="note-sheet"] [data-action="cancel"]').click();
  state.presence.length = 0;
  await page.locator('[data-note-id="n-domi"] [data-action="edit-note"]').click({ force: true });
  await page.waitForTimeout(300);
  assert((await page.locator('[data-testid="presence-banner"]').count()) === 0, `${label}: Hinweis ohne Lebenszeichen`);
  await page.locator('[data-testid="note-sheet"] [data-action="cancel"]').click();
  await page.waitForSelector('[data-testid="note-sheet"]', { state: "detached" });

  await page.evaluate(() => {
    window.location.hash = "#/urlaub/trip-solo/einstellungen";
  });
  await page.waitForSelector('[data-testid="settings-delete-trip"]');
  await page.click('[data-testid="settings-delete-trip"]');
  await page.locator('[data-action="confirm"]').click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="app-toast"]')?.textContent || "").includes("Reise gelöscht"));
  await page.waitForSelector(".screen--urlaube");
  assert((await page.locator('[data-vacation-id="trip-solo"]').count()) === 0, `${label}: gelöschte Reise bleibt`);

  state.blockDelete = true;
  await page.evaluate(() => {
    window.location.hash = "#/urlaub/trip-garda/einstellungen";
  });
  await page.waitForSelector('[data-testid="settings-delete-trip"]');
  await page.click('[data-testid="settings-delete-trip"]');
  await page.locator('[data-action="confirm"]').click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="app-toast"]')?.textContent || "").includes("Nur der Besitzer"));
  await page.evaluate(() => {
    window.location.hash = "#/urlaube";
  });
  await page.waitForSelector('[data-vacation-id="trip-garda"]');
  state.blockDelete = false;

  state.membersFail = true;
  await page.reload();
  await page.waitForSelector(".screen--urlaube");
  await page.evaluate(() => {
    window.location.hash = "#/urlaub/trip-garda/einstellungen";
  });
  await page.waitForSelector('[data-testid="settings-screen"]');
  assert((await page.locator('[data-testid="settings-delete-trip"]').count()) === 0, `${label}: Löschen trotz Rollenfehler`);
  await openEdit(page, GARDA);
  assert((await page.locator('[data-testid="share-section"]').count()) === 0, `${label}: Freigeben trotz Rollenfehler`);
}

async function runSuite(browserType, baseUrl, label, viewport) {
  const browser = await browserType.launch({ headless: true });
  const context = await browser.newContext({
    viewport,
    timezoneId: "Europe/Rome",
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  const state = createState();
  await install(page, state);
  const shots = label.startsWith("chromium") && viewport.width === 375;
  try {
    await runFlows(page, state, `${label} ${viewport.width}x${viewport.height}`, shots, baseUrl);
    const fatal = errors.filter((item) => !/access control checks/i.test(item));
    assert(!fatal.length, `${label}: ${fatal.join(" | ")}`);
  } finally {
    await browser.close();
  }
}

const { server, baseUrl } = await startServer();
try {
  for (const viewport of VIEWPORTS) {
    await runSuite(chromium, baseUrl, "chromium", viewport);
    await runSuite(webkit, baseUrl, "webkit", viewport);
  }
  console.log("run-tests-8-freigabe: ok");
} finally {
  server.close();
}
