import { signInWithEmailOtp, verifyEmailOtp } from "./auth-service.js";

const OTP_MIN_DIGITS = 6;
const OTP_MAX_DIGITS = 10;

function normalizeEmailOtp(value) {
  const withoutSeparators = String(value ?? "").replace(/[\s-]/g, "");
  return withoutSeparators.replace(/\D/g, "").slice(0, OTP_MAX_DIGITS);
}

function writeOtpValue(input, raw) {
  const next = normalizeEmailOtp(raw);
  if (input.value !== next) input.value = next;
}

export function renderLoginScreen(appEl, onSignedIn) {
  appEl.className = "screen screen--login";
  appEl.innerHTML = `
    <header class="top-bar">
      <h1 class="top-bar__title">Reisetagebuch</h1>
    </header>
    <main class="login-main" data-testid="login-screen">
      <p class="login-lead">Melde dich mit deiner E-Mail an. Du erhältst einen Code per E-Mail.</p>
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
          <span class="field__label">Code aus der E-Mail</span>
          <input type="text" name="otp" inputmode="numeric" pattern="[0-9]*" maxlength="10" autocomplete="one-time-code" required placeholder="12345678" />
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
      otpForm.querySelector("[data-role=email-display]").textContent = pendingEmail;
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

  const otpInput = otpForm.otp;

  const insertOtpText = (text) => {
    const start = otpInput.selectionStart ?? otpInput.value.length;
    const end = otpInput.selectionEnd ?? start;
    const prefix = otpInput.value.slice(0, start);
    const merged = prefix + text + otpInput.value.slice(end);
    writeOtpValue(otpInput, merged);
    const caret = normalizeEmailOtp(prefix + text).length;
    try {
      otpInput.setSelectionRange(caret, caret);
    } catch {
      /* ignore */
    }
  };

  otpInput.addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text");
    if (typeof text !== "string") return;
    event.preventDefault();
    insertOtpText(text);
  });

  otpInput.addEventListener("input", () => {
    writeOtpValue(otpInput, otpInput.value);
  });

  otpForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    showError(otpForm, "");
    const code = normalizeEmailOtp(otpInput.value);
    writeOtpValue(otpInput, code);
    if (code.length < OTP_MIN_DIGITS) {
      showError(otpForm, "Bitte den ganzen Code aus der E-Mail eingeben.");
      return;
    }
    try {
      await verifyEmailOtp(pendingEmail, code);
      onSignedIn?.();
    } catch (err) {
      showError(otpForm, err.message || "Anmeldung fehlgeschlagen.");
    }
  });
}
