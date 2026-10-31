export class CloudOfflineError extends Error {
  constructor(message = "Du bist offline. Änderungen sind erst wieder online möglich.", { mediaRecord = null } = {}) {
    super(message);
    this.name = "CloudOfflineError";
    /** @type {object | null} Bereits angelegte media-Zeile für Retry mit derselben ID */
    this.mediaRecord = mediaRecord;
  }
}

export class CloudNetworkError extends Error {
  constructor(message = "Netzwerkfehler. Bitte Verbindung prüfen.") {
    super(message);
    this.name = "CloudNetworkError";
  }
}

export class CaptionUnavailableError extends Error {
  constructor(message = "Fotonotiz noch nicht verfügbar") {
    super(message);
    this.name = "CaptionUnavailableError";
  }
}

export class RecapUnavailableError extends Error {
  constructor(message = "Recap-Video ist noch nicht verfügbar.") {
    super(message);
    this.name = "RecapUnavailableError";
  }
}

export function isFetchNetworkFailure(err) {
  const msg = (err?.message || String(err || "")).toLowerCase();
  return (
    msg.includes("failed to fetch") ||
    msg.includes("networkerror") ||
    msg.includes("load failed") ||
    msg.includes("network request failed") ||
    msg.includes("access control checks")
  );
}

export function mapAuthError(err) {
  const msg = (err?.message || "").toLowerCase();
  const code = String(err?.code || err?.status || "").toLowerCase();
  if (!navigator.onLine) {
    return "Keine Internetverbindung. Bitte später erneut versuchen.";
  }
  if (isFetchNetworkFailure(err)) {
    return "Netzwerkfehler. Bitte Verbindung prüfen und erneut versuchen.";
  }
  if (
    code === "over_request_rate_limit" ||
    msg.includes("only request this after") ||
    msg.includes("rate limit")
  ) {
    return "Zu viele Anfragen. Bitte kurz warten und es erneut probieren.";
  }
  if (
    code === "otp_expired" ||
    code === "invalid_otp" ||
    msg.includes("expired") ||
    msg.includes("invalid")
  ) {
    return "Code falsch oder abgelaufen. Bitte prüfen oder neuen Code anfordern.";
  }
  if (msg.includes("rate") || code === "429") {
    return "Zu viele Versuche. Bitte kurz warten und es erneut probieren.";
  }
  return "Anmeldung fehlgeschlagen. Bitte E-Mail und Code prüfen.";
}

const PLACE_FAIL = "Der Ort konnte nicht angelegt werden. Bitte erneut versuchen.";
export const PHOTO_KEPT_MESSAGE =
  "Der Ort konnte nicht angelegt werden. Das Foto bleibt erhalten – bitte erneut versuchen.";
export const NOTE_KEPT_MESSAGE =
  "Der Ort konnte nicht angelegt werden. Die Notiz bleibt erhalten – bitte erneut versuchen.";

function isDbViolation(raw) {
  const text = String(raw || "");
  return (
    /new row for relation/i.test(text) ||
    /check constraint/i.test(text) ||
    /not-null constraint/i.test(text) ||
    /row-level security/i.test(text) ||
    /violates/i.test(text)
  );
}

/** Postgres-Text (Check, NOT NULL, RLS) durch eine deutsche Meldung ersetzen. */
export function friendlyDbMessage(raw) {
  const text = String(raw || "");
  if (!isDbViolation(text)) return text;
  if (/waypoints/i.test(text)) return PLACE_FAIL;
  if (/notes/i.test(text)) return "Die Notiz konnte nicht gespeichert werden. Bitte erneut versuchen.";
  if (/row-level security/i.test(text)) return "Dafür fehlt die Berechtigung.";
  return "Speichern fehlgeschlagen. Bitte erneut versuchen.";
}

export function photoKeptMessage(err) {
  const msg = err?.message || "";
  if (msg.startsWith("Der Ort konnte nicht") || isDbViolation(msg)) return PHOTO_KEPT_MESSAGE;
  return msg || "Foto konnte nicht zugeordnet werden.";
}

export function noteKeptMessage(err) {
  const msg = err?.message || "";
  if (msg.startsWith("Der Ort konnte nicht") || /waypoints/i.test(msg) || isDbViolation(msg)) {
    return NOTE_KEPT_MESSAGE;
  }
  return msg || "Notiz konnte nicht gespeichert werden.";
}

export function mapApiError(err) {
  if (!navigator.onLine) {
    return new CloudOfflineError();
  }
  if (isFetchNetworkFailure(err)) {
    return new CloudNetworkError();
  }
  const friendly = friendlyDbMessage(err?.message || "");
  return new Error(friendly || "Speichern fehlgeschlagen.");
}
