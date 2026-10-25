const TOAST_MS = 3200;

export function showToast(message, { title } = {}) {
  const root = document.getElementById("toast-root");
  if (!root) return;

  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `
    <span class="toast__icon" aria-hidden="true">✓</span>
    <div class="toast__text">
      ${title ? `<strong>${title}</strong>` : ""}
      <span>${message}</span>
    </div>
  `;
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add("toast--visible"));

  const remove = () => {
    el.classList.remove("toast--visible");
    el.addEventListener("transitionend", () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400);
  };
  setTimeout(remove, TOAST_MS);
}
