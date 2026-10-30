import { normalizePresetId, presetUrl } from "./covers.js";
import { bindCoverImage, coverStatusLabel, resolveVacationCover } from "./cover-sources.js";
import { deleteBlob, fetchUploadedPhotosForTrip, getPlacesForVacation, getVacation, putVacation } from "./db.js";
import { navigate } from "./router.js";
import { clearTripUiState } from "./ui-urlaub-detail.js";
import { CloudNetworkError, CloudOfflineError } from "./cloud-errors.js";
import { showToast } from "./toast.js";
import { canEditTripMedia, getMyTripRole } from "./trip-role.js";
import { openCoverSheet } from "./ui-cover-sheet.js";
import { COMPANION_TAGS, createEmptyVacation, normalizeVacation } from "./vacation.js";
import {
  clampTitle,
  dayCountInclusive,
  escapeHtml,
  formatDateRange,
  formatDateRangeOverlay,
} from "./utils.js";
import { openDateRangePicker } from "./ui-calendar.js";

export async function renderUrlaubForm(appEl, { mode, id }) {
  const mountGen = appEl?.dataset?.appRenderGen ?? "";
  let vacation =
    mode === "edit" && id
      ? normalizeVacation(await getVacation(id))
      : createEmptyVacation();

  if (mode === "edit" && !vacation.id) {
    navigate({ name: "urlaube" });
    return;
  }

  const isEdit = mode === "edit";
  const [role, photoResult, places] = await Promise.all([
    isEdit ? getMyTripRole(vacation.id) : Promise.resolve("owner"),
    isEdit ? fetchUploadedPhotosForTrip(vacation.id) : Promise.resolve({ media: [] }),
    isEdit ? getPlacesForVacation(vacation.id).catch(() => []) : Promise.resolve([]),
  ]);
  const canEditCover = canEditTripMedia(role);
  const tripPhotos = (photoResult?.media || []).filter((photo) => photo.vacationId === vacation.id);
  let placeList = places;
  let coverInfo = await resolveVacationCover(vacation, { variant: "original" });
  if (coverInfo.invalid && !coverInfo.unknown && vacation.cover?.type === "media") {
    vacation.cover = { type: "preset", presetId: normalizePresetId(vacation.cover?.presetId) };
    coverInfo = await resolveVacationCover(vacation, { variant: "original" });
  }
  let coverMedia = coverInfo.media;
  const coverUnknown = Boolean(coverInfo.unknown) && vacation.cover?.type === "media";
  if (appEl?.dataset?.appRenderGen !== mountGen) return;

  appEl.className = "screen screen--form";
  appEl.innerHTML = `
    <header class="form-header form-header--minimal">
      <button type="button" class="link-btn" data-action="cancel">Abbrechen</button>
      <h1 class="form-header__title">${isEdit ? "Reise bearbeiten" : "Neue Reise"}</h1>
      <span class="form-header__spacer" aria-hidden="true"></span>
    </header>
    <form class="vacation-form" id="vacation-form">
      <label class="field">
        <span class="field__label">Titel</span>
        <input name="title" type="text" required maxlength="200" autocomplete="off" placeholder="z. B. Paris" value="${escapeHtml(vacation.title)}" />
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
        <div class="cover-preview${vacation.cover?.type === "media" && !coverUnknown ? " cover-preview--photo" : ""}${coverUnknown ? " cover-preview--unknown" : ""}" data-role="cover-preview" data-testid="cover-preview">
          <span class="cover-preview__badge" data-role="cover-badge" data-testid="cover-badge">${escapeHtml(coverUnknown ? "Titelbild wird geladen" : coverStatusLabel(vacation, { media: coverMedia, places }))}</span>
          <img data-testid="cover-preview-img" alt="" ${coverUnknown ? "hidden" : ""} />
          <div class="cover-preview__overlay">
            <strong data-role="cover-title">${escapeHtml(vacation.title || "Titel")}</strong>
            <span data-role="cover-dates">${vacation.startDate && vacation.endDate ? formatDateRangeOverlay(vacation.startDate, vacation.endDate) : ""}</span>
          </div>
        </div>
        ${
          canEditCover
            ? `<button type="button" class="cover-change" data-action="change-cover" data-testid="cover-change">
          <svg class="cover-change__icon" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="1.8"/><circle cx="8.5" cy="10" r="1.6" fill="currentColor"/><path d="M3 16l5-5 3 3 2-2 8 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Titelbild ändern
        </button>
        <button type="button" class="cover-reset" data-action="reset-cover" data-testid="cover-reset" hidden>
          <span aria-hidden="true">↺</span> Auf automatisches Titelbild zurücksetzen
        </button>
        <p class="cover-save-hint" data-testid="cover-save-hint" hidden>Erst «Speichern» übernimmt das Bild, auch für Mitreisende.</p>
        <button type="button" class="cover-retry" data-action="retry-cover" data-testid="cover-retry"${coverUnknown ? "" : " hidden"}>Erneut versuchen</button>`
            : ""
        }
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
        ${isEdit ? "Speichern" : "Reise anlegen"}
      </button>
    </footer>
  `;

  const form = appEl.querySelector("#vacation-form");
  const titleInput = form.querySelector('[name="title"]');
  const dateLabel = appEl.querySelector('[data-role="date-label"]');
  const dateSub = appEl.querySelector('[data-role="date-sub"]');
  const coverTitle = appEl.querySelector('[data-role="cover-title"]');
  const coverDates = appEl.querySelector('[data-role="cover-dates"]');
  const coverPreview = appEl.querySelector('[data-role="cover-preview"]');
  const coverBadge = appEl.querySelector('[data-role="cover-badge"]');
  const coverImg = appEl.querySelector(".cover-preview img");
  const resetBtn = appEl.querySelector('[data-action="reset-cover"]');
  const retryBtn = appEl.querySelector('[data-action="retry-cover"]');
  const saveHint = appEl.querySelector('[data-testid="cover-save-hint"]');
  const nameInput = appEl.querySelector('[data-role="name-input"]');
  const nameChipsEl = appEl.querySelector('[data-role="name-chips"]');

  function paintCover() {
    const photo = vacation.cover?.type === "media";
    const unknown = Boolean(coverInfo?.unknown) && photo;
    coverPreview?.classList.toggle("cover-preview--photo", photo && !unknown);
    coverPreview?.classList.toggle("cover-preview--unknown", unknown);
    if (coverBadge) {
      coverBadge.textContent = unknown
        ? "Titelbild wird geladen"
        : coverStatusLabel(vacation, { media: coverMedia, places: placeList });
    }
    if (resetBtn) resetBtn.hidden = !photo;
    if (saveHint) saveHint.hidden = !photo || unknown;
    if (retryBtn) retryBtn.hidden = !unknown;
    if (coverImg) {
      if (unknown) {
        coverImg.onerror = null;
        coverImg.removeAttribute("src");
        coverImg.hidden = true;
      } else {
        coverImg.hidden = false;
        bindCoverImage(coverImg, coverInfo, vacation, { variant: "original" });
      }
    }
  }

  function refreshNames() {
    nameChipsEl.innerHTML = vacation.companions.names
      .map(
        (n, i) =>
          `<button type="button" class="chip chip--filled" data-remove-name="${i}">${escapeHtml(n)} <span aria-hidden="true">×</span></button>`
      )
      .join("");
  }

  function syncMeta() {
    if (titleInput.value.length > 200) titleInput.value = titleInput.value.slice(0, 200);
    coverTitle.textContent = titleInput.value.trim() || "Titel";
    if (vacation.startDate && vacation.endDate) {
      coverDates.textContent = formatDateRangeOverlay(
        vacation.startDate,
        vacation.endDate
      );
    }
  }

  refreshNames();
  paintCover();

  appEl.querySelector('[data-action="cancel"]').addEventListener("click", () => {
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
      tripStartDate: isEdit ? vacation.startDate : "",
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

  let coverOpening = false;
  appEl.querySelector('[data-action="change-cover"]')?.addEventListener("click", () => {
    if (coverOpening) return;
    coverOpening = true;
    void (async () => {
      try {
      if (isEdit) {
        const [freshPhotos, freshPlaces] = await Promise.all([
          fetchUploadedPhotosForTrip(vacation.id),
          getPlacesForVacation(vacation.id).catch(() => placeList),
        ]);
        tripPhotos.splice(0, tripPhotos.length, ...(freshPhotos?.media || []).filter((photo) => photo.vacationId === vacation.id));
        placeList = freshPlaces || placeList;
      }
      const next = await openCoverSheet({
        vacation,
        photos: tripPhotos,
        places: placeList,
        allowDevice: isEdit,
      });
      if (!next || !appEl.isConnected) return;
      const presetId = normalizePresetId(next.presetId || vacation.cover?.presetId);
      if (next.type === "media" && next.mediaId) {
        vacation.cover = { type: "media", mediaId: next.mediaId, presetId };
        coverMedia = next.media || tripPhotos.find((photo) => photo.id === next.mediaId) || null;
        if (coverMedia && !tripPhotos.some((photo) => photo.id === coverMedia.id)) tripPhotos.push(coverMedia);
      } else {
        vacation.cover = { type: "preset", presetId };
        coverMedia = null;
      }
      coverInfo = {
        src: presetUrl(presetId),
        kind: vacation.cover.type === "media" ? "media" : "preset",
        presetId,
        path: "",
        bucket: "",
        media: coverMedia,
        fellBack: false,
      };
      paintCover();
      const resolved = await resolveVacationCover(vacation, { variant: "original" });
      if (!appEl.isConnected) return;
      if (resolved.invalid && !resolved.unknown && vacation.cover?.type === "media") {
        vacation.cover = { type: "preset", presetId };
        coverMedia = null;
        coverInfo = {
          src: presetUrl(presetId),
          kind: "preset",
          presetId,
          path: "",
          bucket: "",
          media: null,
          fellBack: true,
          invalid: true,
        };
      } else {
        coverInfo = resolved;
        if (resolved.media) coverMedia = resolved.media;
      }
      paintCover();
      } finally {
        coverOpening = false;
      }
    })();
  });

  retryBtn?.addEventListener("click", () => {
    void (async () => {
      const resolved = await resolveVacationCover(vacation, { variant: "original" });
      if (!appEl.isConnected) return;
      if (resolved.invalid && !resolved.unknown && vacation.cover?.type === "media") {
        vacation.cover = { type: "preset", presetId: normalizePresetId(vacation.cover?.presetId) };
        coverMedia = null;
      } else if (resolved.media) {
        coverMedia = resolved.media;
      }
      coverInfo = resolved;
      paintCover();
    })();
  });

  resetBtn?.addEventListener("click", () => {
    const presetId = normalizePresetId(vacation.cover?.presetId);
    vacation.cover = { type: "preset", presetId };
    coverMedia = null;
    coverInfo = {
      src: presetUrl(presetId),
      kind: "preset",
      presetId,
      path: "",
      bucket: "",
      media: null,
      fellBack: false,
    };
    paintCover();
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

  const scrollNameIntoView = () => {
    requestAnimationFrame(() => {
      nameInput.scrollIntoView({ block: "center", behavior: "instant" });
      const footer = appEl.querySelector(".form-footer");
      const footerH = footer?.getBoundingClientRect().height ?? 76;
      const kb =
        parseInt(getComputedStyle(document.documentElement).getPropertyValue("--kb"), 10) || 0;
      const rect = nameInput.getBoundingClientRect();
      const visibleBottom = window.innerHeight - kb - footerH - 12;
      if (rect.bottom > visibleBottom) {
        window.scrollBy({ top: rect.bottom - visibleBottom, behavior: "instant" });
      }
    });
  };
  nameInput.addEventListener("focus", scrollNameIntoView);
  window.visualViewport?.addEventListener("resize", () => {
    if (document.activeElement === nameInput) scrollNameIntoView();
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
    const title = clampTitle(titleInput.value);
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

    try {
      await putVacation(vacation);
    } catch (err) {
      showToast(
        err instanceof CloudOfflineError || err instanceof CloudNetworkError
          ? err.message
          : err?.message || "Speichern fehlgeschlagen."
      );
      return;
    }

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
        title: `Reise «${title}» angelegt`,
      });
      window.dispatchEvent(new CustomEvent("vacrecap:data-changed"));
      clearTripUiState(vacation.id);
      navigate({ name: "urlaub-detail", id: vacation.id }, { replace: true });
    }
  });
}
