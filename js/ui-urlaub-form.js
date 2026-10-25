import { COVER_PRESETS, presetThumbUrl, presetUrl, resolveCoverSrc } from "./covers.js";
import { ICON_COVER_CUSTOM } from "./icons.js";
import { deleteBlob, getBlob, getVacation, putBlob, putVacation } from "./db.js";
import { navigate } from "./router.js";
import { clearTripUiState } from "./ui-urlaub-detail.js";
import { showToast } from "./toast.js";
import { COMPANION_TAGS, createEmptyVacation, normalizeVacation } from "./vacation.js";
import {
  createId,
  dayCountInclusive,
  escapeHtml,
  formatDateRange,
  formatDateRangeOverlay,
  resizeImageFile,
} from "./utils.js";
import { openDateRangePicker } from "./ui-calendar.js";

export async function renderUrlaubForm(appEl, { mode, id }) {
  let vacation =
    mode === "edit" && id
      ? normalizeVacation(await getVacation(id))
      : createEmptyVacation();

  if (mode === "edit" && !vacation.id) {
    navigate({ name: "urlaube" });
    return;
  }

  const isEdit = mode === "edit";
  let coverPreviewUrl = await resolveCoverSrc(vacation, getBlob);
  let customObjectUrl = null;

  appEl.className = "screen screen--form";
  appEl.innerHTML = `
    <header class="form-header form-header--minimal">
      <button type="button" class="link-btn" data-action="cancel">Abbrechen</button>
    </header>
    <form class="vacation-form" id="vacation-form">
      <label class="field">
        <span class="field__label">Titel</span>
        <input name="title" type="text" required autocomplete="off" placeholder="z. B. Paris" value="${escapeHtml(vacation.title)}" />
      </label>

      <div class="field">
        <span class="field__label">Zeitraum</span>
        <button type="button" class="picker-btn" data-action="pick-dates">
          <span class="picker-btn__icon" aria-hidden="true">📅</span>
          <span class="picker-btn__text">
            <strong data-role="date-label">${vacation.startDate && vacation.endDate ? formatDateRange(vacation.startDate, vacation.endDate) : "Datum wählen"}</strong>
            <small data-role="date-sub">${vacation.startDate && vacation.endDate ? `${dayCountInclusive(vacation.startDate, vacation.endDate)} Tage` : "Start und Ende im Kalender"}</small>
          </span>
        </button>
      </div>

      <div class="field">
        <span class="field__label">Titelbild</span>
        <div class="cover-preview" data-role="cover-preview">
          <img src="${coverPreviewUrl}" alt="" />
          <div class="cover-preview__overlay">
            <strong data-role="cover-title">${escapeHtml(vacation.title || "Titel")}</strong>
            <span data-role="cover-dates">${vacation.startDate && vacation.endDate ? formatDateRangeOverlay(vacation.startDate, vacation.endDate) : ""}</span>
          </div>
        </div>
        <div class="cover-picker" role="list" data-testid="cover-picker">
          <button type="button" class="cover-thumb cover-thumb--custom" data-preset="custom">
            <span class="cover-thumb__img cover-thumb__img--custom">${ICON_COVER_CUSTOM}</span>
            <span class="cover-thumb__label">Eigenes Foto</span>
          </button>
          ${COVER_PRESETS.map(
            (p) => `
            <button type="button" class="cover-thumb" data-preset="${p.id}">
              <img class="cover-thumb__img" src="${presetThumbUrl(p.id)}" alt="" />
              <span class="cover-thumb__label">${p.label}</span>
            </button>`
          ).join("")}
        </div>
        <input type="file" accept="image/*" hidden data-role="file-input" />
      </div>

      <div class="field">
        <span class="field__label">Wer ist dabei?</span>
        <div class="chip-row" data-role="tag-chips">
          ${COMPANION_TAGS.map(
            (t) => `
            <button type="button" class="chip" data-tag="${t.id}" aria-pressed="${vacation.companions.tags.includes(t.id)}">${t.label}</button>`
          ).join("")}
        </div>
        <div class="name-chip-input">
          <input type="text" data-role="name-input" placeholder="+ Name" autocomplete="off" />
        </div>
        <div class="chip-row chip-row--names" data-role="name-chips"></div>
      </div>
    </form>
    <footer class="form-footer">
      <button type="submit" form="vacation-form" class="btn btn-emaille btn-emaille--block">
        ${isEdit ? "Speichern" : "Urlaub anlegen"}
      </button>
    </footer>
  `;

  const form = appEl.querySelector("#vacation-form");
  const titleInput = form.querySelector('[name="title"]');
  const dateLabel = appEl.querySelector('[data-role="date-label"]');
  const dateSub = appEl.querySelector('[data-role="date-sub"]');
  const coverTitle = appEl.querySelector('[data-role="cover-title"]');
  const coverDates = appEl.querySelector('[data-role="cover-dates"]');
  const coverImg = appEl.querySelector(".cover-preview img");
  const fileInput = appEl.querySelector('[data-role="file-input"]');
  const nameInput = appEl.querySelector('[data-role="name-input"]');
  const nameChipsEl = appEl.querySelector('[data-role="name-chips"]');

  function refreshNames() {
    nameChipsEl.innerHTML = vacation.companions.names
      .map(
        (n, i) =>
          `<button type="button" class="chip chip--filled" data-remove-name="${i}">${escapeHtml(n)} <span aria-hidden="true">×</span></button>`
      )
      .join("");
  }

  function syncMeta() {
    coverTitle.textContent = titleInput.value.trim() || "Titel";
    if (vacation.startDate && vacation.endDate) {
      coverDates.textContent = formatDateRangeOverlay(
        vacation.startDate,
        vacation.endDate
      );
    }
  }

  refreshNames();
  highlightPresetButtons();

  appEl.querySelector('[data-action="cancel"]').addEventListener("click", () => {
    if (customObjectUrl) URL.revokeObjectURL(customObjectUrl);
    const raw = sessionStorage.getItem("vacrecap-form-return");
    sessionStorage.removeItem("vacrecap-form-return");
    if (raw) {
      navigate(JSON.parse(raw));
    } else {
      navigate({ name: "urlaube" });
    }
  });

  appEl.querySelector('[data-action="pick-dates"]').addEventListener("click", () => {
    openDateRangePicker({
      startDate: vacation.startDate,
      endDate: vacation.endDate,
      onApply: ({ startDate, endDate }) => {
        vacation.startDate = startDate;
        vacation.endDate = endDate;
        dateLabel.textContent = formatDateRange(startDate, endDate);
        const n = dayCountInclusive(startDate, endDate);
        dateSub.textContent = n === 1 ? "1 Tag" : `${n} Tage`;
        syncMeta();
      },
    });
  });

  titleInput.addEventListener("input", syncMeta);

  appEl.querySelectorAll("[data-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const preset = btn.dataset.preset;
      if (preset === "custom") {
        fileInput.click();
        return;
      }
      vacation.cover = { type: "preset", presetId: preset };
      coverPreviewUrl = presetUrl(preset);
      coverImg.src = coverPreviewUrl;
      highlightPresetButtons();
    });
  });

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const blob = await resizeImageFile(file);
    const blobId = vacation.cover.blobId || createId();
    await putBlob({ id: blobId, data: blob, createdAt: Date.now() });
    vacation.cover = { type: "custom", blobId };
    if (customObjectUrl) URL.revokeObjectURL(customObjectUrl);
    customObjectUrl = URL.createObjectURL(blob);
    coverImg.src = customObjectUrl;
    highlightPresetButtons();
  });

  appEl.querySelector('[data-role="tag-chips"]').addEventListener("click", (e) => {
    const chip = e.target.closest("[data-tag]");
    if (!chip) return;
    const tag = chip.dataset.tag;
    const set = new Set(vacation.companions.tags);
    if (set.has(tag)) set.delete(tag);
    else set.add(tag);
    vacation.companions.tags = [...set];
    chip.setAttribute("aria-pressed", String(set.has(tag)));
  });

  nameInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) return;
    if (!vacation.companions.names.includes(name)) {
      vacation.companions.names.push(name);
      refreshNames();
    }
    nameInput.value = "";
  });

  nameChipsEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-remove-name]");
    if (!btn) return;
    const idx = Number(btn.dataset.removeName);
    vacation.companions.names.splice(idx, 1);
    refreshNames();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = titleInput.value.trim();
    if (!title) {
      showToast("Bitte Titel eingeben");
      titleInput.focus();
      return;
    }
    if (!vacation.startDate || !vacation.endDate) {
      showToast("Bitte Zeitraum wählen");
      return;
    }

    const old = isEdit ? await getVacation(vacation.id) : null;
    vacation.title = title;
    vacation.updatedAt = Date.now();

    if (
      old?.cover?.type === "custom" &&
      old.cover.blobId &&
      old.cover.blobId !== vacation.cover?.blobId
    ) {
      await deleteBlob(old.cover.blobId);
    }

    await putVacation(vacation);
    if (customObjectUrl) URL.revokeObjectURL(customObjectUrl);

    sessionStorage.removeItem("vacrecap-form-return");
    if (isEdit) {
      showToast(formatDateRange(vacation.startDate, vacation.endDate), {
        title: `«${title}» gespeichert`,
      });
      window.dispatchEvent(new CustomEvent("vacrecap:data-changed"));
      clearTripUiState(vacation.id);
      navigate({ name: "urlaub-detail", id: vacation.id }, { replace: true });
    } else {
      showToast(formatDateRange(vacation.startDate, vacation.endDate), {
        title: `Urlaub «${title}» angelegt`,
      });
      window.dispatchEvent(new CustomEvent("vacrecap:data-changed"));
      clearTripUiState(vacation.id);
      navigate({ name: "urlaub-detail", id: vacation.id }, { replace: true });
    }
  });

  function highlightPresetButtons() {
    appEl.querySelectorAll(".cover-thumb").forEach((el) => {
      el.classList.toggle(
        "cover-thumb--active",
        el.dataset.preset ===
          (vacation.cover.type === "custom" ? "custom" : vacation.cover.presetId)
      );
    });
  }
}
