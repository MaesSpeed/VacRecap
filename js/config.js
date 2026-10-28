/** Basis-Pfad für GitHub Pages (/VacRecap/) oder lokale Entwicklung. */
export function getBasePath() {
  const segments = window.location.pathname.split("/").filter(Boolean);
  const idx = segments.indexOf("VacRecap");
  if (idx >= 0) {
    return `/${segments.slice(0, idx + 1).join("/")}/`;
  }
  const last = segments[segments.length - 1];
  if (last && /\.html?$/i.test(last)) {
    segments.pop();
  }
  return segments.length ? `/${segments.join("/")}/` : "/";
}

export function assetUrl(relativePath) {
  const base = getBasePath();
  const clean = relativePath.replace(/^\//, "");
  return `${base}${clean}`;
}

export const SUPABASE_URL = "https://hgboqdovlfeuqfhfeykn.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY =
  "sb_publishable_0xW8Ns4iyXiRJQRc8xeMIQ_CQIQx9I2";
export const SUPABASE_JS_VERSION = "2.49.4";

/** Paket 7a: Cloud-Fotos (Storage); Videos später. */
export const CLOUD_MEDIA_ENABLED = true;
