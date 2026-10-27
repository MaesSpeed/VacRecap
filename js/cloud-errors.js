export class CloudOfflineError extends Error {
  constructor(message = "Du bist offline. Änderungen sind erst wieder online möglich.") {
    super(message);
    this.name = "CloudOfflineError";
  }
}

export function mapAuthError(err) {
  const msg = (err?.message || "").toLowerCase();
  const code = err?.code || err?.status || "";
  if (!navigator.onLine) {
    return "Keine Internetverbindung. Bitte später erneut versuchen.";
  }
  if (code === "otp_expired" || msg.includes("expired")) {
    return "Der Code ist abgelaufen. Bitte einen neuen Code anfordern.";
  }
  if (msg.includes("invalid") || code === "invalid_otp") {
    return "Der Code ist nicht korrekt. Bitte noch einmal prüfen.";
  }
  if (msg.includes("rate") || code === 429) {
    return "Zu viele Versuche. Bitte kurz warten und es erneut probieren.";
  }
  return "Anmeldung fehlgeschlagen. Bitte E-Mail und Code prüfen.";
}

export function mapApiError(err) {
  if (!navigator.onLine) {
    return new CloudOfflineError();
  }
  const msg = err?.message || "Speichern fehlgeschlagen.";
  return new Error(msg);
}
