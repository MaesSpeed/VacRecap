import { signInWithEmailOtp, verifyEmailOtp } from "./auth-service.js";
import { escapeHtml } from "./utils.js";

export function renderLoginScreen(appEl, onSignedIn) {
  appEl.className = "screen screen--login";
  appEl.innerHTML = `
    <header class="top-bar">
      <h1 class="top-bar__title">Reisetagebuch</h1>
    </header>
    <main class="login-main" data-testid="login-screen">
      <p class="login-lead">Melde dich mit deiner E-Mail an. Du erhältst einen 6-stelligen Code.</p>
      <form class="login-form" data-step="email" novalidate>
        <label class="field">
          <span class="field__label">E-Mail</span>
          <input type="email" name="email" autocomplete="email" required placeholder="du@beispiel.de" />
        </label>
        <p class="login-error" data-role="error" hidden></p>
        <button type="submit" class="btn btn-emaille">Code senden</button>
      </form>
      <form class="login-form" data-step="otp" hidden novalidate>
        <p class="login-hint">Code an <strong data-role="email-display"></strong> gesendet.</p>
        <label class="field">
          <span class="field__label">6-stelliger Code</span>
          <input type="text" name="otp" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" required placeholder="123456" />
        </label>
        <p class="login-error" data-role="error" hidden></p>
        <button type="submit" class="btn btn-emaille">Anmelden</button>
        <button type="button" class="btn btn-emaille btn-emaille--ghost" data-action="back">Andere E-Mail</button>
      </form>
    </main>
  `;

  const emailForm = appEl.querySelector('[data-step="email"]');
  const otpForm = appEl.querySelector('[data-step="otp"]');
  let pendingEmail = "";

  const showError = (form, message) => {
    const el = form.querySelector('[data-role="error"]');
    if (!message) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = message;
  };

  emailForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    showError(emailForm, "");
    const email = emailForm.email.value;
    try {
      pendingEmail = await signInWithEmailOtp(email);
      emailForm.hidden = true;
      otpForm.hidden = false;
      otpForm.querySelector("[data-role=email-display]").textContent = escapeHtml(pendingEmail);
      otpForm.otp.focus();
    } catch (err) {
      showError(emailForm, err.message || "Code konnte nicht gesendet werden.");
    }
  });

  otpForm.querySelector('[data-action="back"]')?.addEventListener("click", () => {
    otpForm.hidden = true;
    emailForm.hidden = false;
    showError(otpForm, "");
  });

  otpForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    showError(otpForm, "");
    try {
      await verifyEmailOtp(pendingEmail, otpForm.otp.value);
      onSignedIn?.();
    } catch (err) {
      showError(otpForm, err.message || "Anmeldung fehlgeschlagen.");
    }
  });
}
