import { getVacation } from "./db.js";
import { navigate } from "./router.js";
import { escapeHtml, formatDateRange } from "./utils.js";

export async function renderUrlaubDetail(appEl, id) {
  const vacation = await getVacation(id);
  if (!vacation) {
    navigate({ name: "urlaube" });
    return;
  }

  appEl.className = "screen screen--detail";
  appEl.innerHTML = `
    <header class="detail-header">
      <button type="button" class="link-btn link-btn--back" data-action="back">‹ Urlaube</button>
      <h1 class="detail-header__title">${escapeHtml(vacation.title)}</h1>
      <span class="detail-header__spacer"></span>
    </header>
    <main class="detail-placeholder">
      <p class="detail-placeholder__dates">${formatDateRange(vacation.startDate, vacation.endDate)}</p>
      <p class="detail-placeholder__hint">Die Urlaub-Ansicht mit Tages-Chips und Timeline kommt in <strong>Paket 1b</strong>.</p>
    </main>
  `;

  appEl.querySelector('[data-action="back"]').addEventListener("click", () => {
    navigate({ name: "urlaube" });
  });
}
