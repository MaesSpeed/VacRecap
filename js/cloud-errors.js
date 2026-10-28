export class CloudOfflineError extends Error {
  constructor(message = "Du bist offline. Änderungen sind erst wieder online möglich.") {
    super(message);
    this.name = "CloudOfflineError";
  }
}

export function mapAuthError(err) {
  const msg = (err?.message || "").toLowerCase();
  const code = String(err?.code || err?.status || "").toLowerCase();
  if (!navigator.onLine) {
    return "Keine Internetverbindung. Bitte später erneut versuchen.";
  }
  if (
    msg.includes("failed to fetch") ||
    msg.includes("networkerror") ||
    msg.includes("load failed")
  ) {
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
  const msg = (err?.message || "").toLowerCase();
  if (msg.includes("failed to fetch") || msg.includes("networkerror")) {
    return new CloudOfflineError("Netzwerkfehler. Bitte Verbindung prüfen.");
  }
  const userMsg = err?.message || "Speichern fehlgeschlagen.";
  return new Error(userMsg);
}
