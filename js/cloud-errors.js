export class CloudOfflineError extends Error {
  constructor(message = "Du bist offline. Änderungen sind erst wieder online möglich.") {
    super(message);
    this.name = "CloudOfflineError";
  }
}

export class CloudNetworkError extends Error {
  constructor(message = "Netzwerkfehler. Bitte Verbindung prüfen.") {
    super(message);
    this.name = "CloudNetworkError";
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

export function mapApiError(err) {
  if (!navigator.onLine) {
    return new CloudOfflineError();
  }
  if (isFetchNetworkFailure(err)) {
    return new CloudNetworkError();
  }
  const userMsg = err?.message || "Speichern fehlgeschlagen.";
  return new Error(userMsg);
}
