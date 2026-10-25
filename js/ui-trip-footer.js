import { FOOTER_CAMERA, FOOTER_GALLERY, FOOTER_NOTE, FOOTER_PIN } from "./icons.js";
import { showToast } from "./toast.js";

const LONG_PRESS_MS = 500;

const ACTIONS = [
  { id: "pin", label: "Ort merken", html: FOOTER_PIN, className: "trip-footer__btn--pin" },
  { id: "note", label: "Notiz", html: FOOTER_NOTE, className: "trip-footer__btn--note" },
  { id: "camera", label: "Kamera", html: FOOTER_CAMERA, className: "trip-footer__btn--camera" },
  { id: "gallery", label: "Mediathek", html: FOOTER_GALLERY, className: "trip-footer__btn--gallery" },
];

export function mountTripFooter(container, handlers = {}) {
  const bar = document.createElement("footer");
  bar.className = "trip-footer";
  bar.setAttribute("role", "toolbar");
  bar.innerHTML = ACTIONS.map(
    (a) => `
    <button type="button" class="trip-footer__btn ${a.className}" data-footer-action="${a.id}" aria-label="${a.label}">
      ${a.html}
    </button>`
  ).join("");

  container.appendChild(bar);

  let pressTimer = null;
  let hintEl = null;

  const clearHint = () => {
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = null;
    hintEl?.remove();
    hintEl = null;
  };

  bar.querySelectorAll("[data-footer-action]").forEach((btn) => {
    const action = ACTIONS.find((a) => a.id === btn.dataset.footerAction);

    const showHint = () => {
      hintEl = document.createElement("div");
      hintEl.className = "trip-footer-hint";
      hintEl.textContent = action.label;
      bar.appendChild(hintEl);
      requestAnimationFrame(() => hintEl.classList.add("trip-footer-hint--visible"));
      setTimeout(clearHint, 900);
    };

    btn.addEventListener("pointerdown", () => {
      btn.classList.add("trip-footer__btn--pressed");
      pressTimer = setTimeout(showHint, LONG_PRESS_MS);
    });
    ["pointerup", "pointerleave", "pointercancel"].forEach((ev) =>
      btn.addEventListener(ev, () => {
        btn.classList.remove("trip-footer__btn--pressed");
        if (pressTimer) clearTimeout(pressTimer);
        pressTimer = null;
      })
    );

    btn.addEventListener("click", async () => {
      if (action.id === "pin" && handlers.onRememberPlace) {
        await handlers.onRememberPlace();
        return;
      }
      showToast("Kommt im nächsten Schritt");
    });
  });

  return bar;
}
