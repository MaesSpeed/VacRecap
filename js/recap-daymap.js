// Statische Tageskarte: OSM-Kacheln, nummerierte Pins, gestrichelte Verbindung.
const TILE = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

function project(lat, lng, z) {
  const ws = 256 * 2 ** z;
  const s = Math.sin((lat * Math.PI) / 180);
  return {
    x: ((lng + 180) / 360) * ws,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * ws,
  };
}

function paintColor(color) {
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(String(color || ""))
    ? color
    : "#1F6DB5";
}

function coord(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Pins nur für Orte mit echten Koordinaten. n bleibt die Besuchsreihenfolge. */
export function dayMapPoints(places) {
  const points = [];
  (places || []).forEach((place, index) => {
    const lat = coord(place?.lat);
    const lng = coord(place?.lng);
    if (lat == null || lng == null) return;
    points.push({ lat, lng, n: index + 1 });
  });
  return points;
}

export function dayMapSvg(points, color, { width = 340, height = 180, pad = 26, r = 11, fitWidth = width } = {}) {
  const ink = paintColor(color);
  const pts = (points || []).filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng));
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (!pts.length) return "";
  let z = 15;
  for (; z > 3; z -= 1) {
    const xy = pts.map((p) => project(p.lat, p.lng, z));
    const spanW = Math.max(...xy.map((q) => q.x)) - Math.min(...xy.map((q) => q.x));
    const spanH = Math.max(...xy.map((q) => q.y)) - Math.min(...xy.map((q) => q.y));
    if (spanW <= fitWidth - 2 * pad && spanH <= h - 2 * pad) break;
  }
  const raw = pts.map((p) => project(p.lat, p.lng, z));
  const bw = Math.max(...raw.map((q) => q.x)) - Math.min(...raw.map((q) => q.x));
  const bh = Math.max(...raw.map((q) => q.y)) - Math.min(...raw.map((q) => q.y));
  let k = Math.max(
    1,
    Math.min(
      1.9,
      (fitWidth - 2 * pad) / Math.max(bw, 1),
      (h - 2 * pad) / Math.max(bh, 1),
      pts.length > 1 ? 9 : 1
    )
  );
  let base = raw;
  if (k > 1.3 && z < 15) {
    z += 1;
    k /= 2;
    base = pts.map((p) => project(p.lat, p.lng, z));
  }
  const xy = base.map((q) => ({ x: q.x * k, y: q.y * k }));
  const cx = (Math.max(...xy.map((q) => q.x)) + Math.min(...xy.map((q) => q.x))) / 2;
  const cy = (Math.max(...xy.map((q) => q.y)) + Math.min(...xy.map((q) => q.y))) / 2;
  const ox = cx - w / 2;
  const oy = cy - h / 2;
  const n = 2 ** z;
  const tiles = [];
  const T = 256 * k;
  for (let tx = Math.floor(ox / T); tx <= Math.floor((ox + w) / T); tx += 1) {
    for (let ty = Math.floor(oy / T); ty <= Math.floor((oy + h) / T); ty += 1) {
      if (ty < 0 || ty >= n) continue;
      const href = TILE.replace("{z}", String(z))
        .replace("{x}", String(((tx % n) + n) % n))
        .replace("{y}", String(ty));
      tiles.push(
        `<image href="${href}" x="${(tx * T - ox).toFixed(1)}" y="${(ty * T - oy).toFixed(1)}" width="${(T + 0.5).toFixed(1)}" height="${(T + 0.5).toFixed(1)}"/>`
      );
    }
  }
  const local = xy.map((q, i) => ({ x: q.x - ox, y: q.y - oy, n: pts[i].n }));
  const line = local.map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(" ");
  const labelY = (r * 0.36).toFixed(1);
  const pins = local
    .map((q, i) => {
      const num = Number.isInteger(q.n) && q.n > 0 ? q.n : i + 1;
      return `<g transform="translate(${q.x.toFixed(1)} ${q.y.toFixed(1)})"><circle r="${r}" fill="${ink}" stroke="#fff" stroke-width="2.5"/><text y="${labelY}" text-anchor="middle" font-size="${r}" font-weight="900" fill="#fff" font-family="Nunito Sans, system-ui, sans-serif">${num}</text></g>`;
    })
    .join("");
  return `<svg class="recap-daymap" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <rect width="${w}" height="${h}" fill="#e8eef3"/>${tiles.join("")}
    <rect width="${w}" height="${h}" fill="#fff" opacity="0.12"/>
    <polyline points="${line}" fill="none" stroke="#fff" stroke-width="5" stroke-linejoin="round" stroke-linecap="round" opacity="0.9"/>
    <polyline points="${line}" fill="none" stroke="${ink}" stroke-width="2.5" stroke-dasharray="6 5" stroke-linejoin="round" stroke-linecap="round"/>
    ${pins}
  </svg>`;
}
