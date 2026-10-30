import { uploadCloudPhoto } from "./cloud-photo-upload.js";
import { COVER_PRESETS, normalizePresetId, presetThumbUrl } from "./covers.js";
import { coverStatusLabel } from "./cover-sources.js";
import { getPlacesForDay } from "./db.js";
import { vacationDays } from "./days.js";
import { libraryDayTitle } from "./library-groups.js";
import { processPhotoForCloud } from "./media-process.js";
import { getSignedThumbUrls } from "./media-signed-url-cache.js";
import { closeOverlayHistory, openOverlayHistory } from "./overlay-stack.js";
import { getSupabase } from "./supabase-client.js";
import { getOrCreateOhneOrtPlace } from "./target-place.js";
import { showWarnToast } from "./toast.js";
import { escapeHtml } from "./utils.js";

const CHECK_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#0066b3"/><path d="M7 12.2l3.1 3.1L17 8.8" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const PHONE_SVG = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2" fill="none" stroke="#0066b3" stroke-width="1.8"/><circle cx="12" cy="18.2" r="0.9" fill="#0066b3"/></svg>`;

function fotoLabel(count) {
  const n = Number(count) || 0;
  return n === 1 ? "1 Foto" : `${n} Fotos`;
}

async function placeForDay(vacationId, day) {
  const places = await getPlacesForDay(vacationId, day);
  const hard = (places || []).filter((place) => place && !place.soft);
  hard.sort((a, b) => (b.ts || 0) - (a.ts || 0) || String(b.id).localeCompare(String(a.id)));
  if (hard[0]) return hard[0];
  const created = await getOrCreateOhneOrtPlace({ vacationId, day, showToastOnCreate: false });
  return created.place;
}

/**
 * Sheet «Titelbild wählen»: aktuelles Bild, Gerät, Fotos dieser Reise, Motive.
 * Abbrechen verwirft die Auswahl. Ein bereits hochgeladenes Foto bleibt ein Reisefoto.
 * @returns {Promise<{ type: string, presetId: string, mediaId: string|null, media: object|null }|null>}
 */
export function openCoverSheet({ vacation, photos = [], places = [], allowDevice = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const layer = document.createElement("div");
    layer.className = "cover-layer";
    layer.dataset.testid = "cover-sheet";
    document.body.appendChild(layer);

    let result = null;
    const localPhotos = (photos || []).filter(
      (photo) => photo && photo.vacationId === vacation.id && photo.type !== "video" && !photo.deletedAt
    );
    const localPlaces = (places || []).slice();
    const freshIds = new Set();
    let thumbUrls = {};
    let pendingFile = null;
    let uploading = false;
    let draft = {
      type: vacation.cover?.type === "media" && vacation.cover.mediaId ? "media" : "preset",
      presetId: normalizePresetId(vacation.cover?.presetId),
      mediaId: vacation.cover?.type === "media" ? vacation.cover.mediaId || null : null,
    };

    const closeDom = () => {
      window.removeEventListener("keydown", onKey);
      layer.remove();
      finish(result);
    };
    const choose = (value) => {
      result = value;
      closeOverlayHistory(closeDom);
    };
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      choose(null);
    };
    openOverlayHistory(closeDom);
    window.addEventListener("keydown", onKey);

    function draftVacation() {
      return {
        ...vacation,
        cover:
          draft.type === "media" && draft.mediaId
            ? { type: "media", mediaId: draft.mediaId, presetId: draft.presetId }
            : { type: "preset", presetId: draft.presetId },
      };
    }

    function selectedMedia() {
      if (draft.type !== "media" || !draft.mediaId) return null;
      return localPhotos.find((photo) => photo.id === draft.mediaId) || null;
    }

    function groups() {
      const byDay = new Map();
      for (const photo of localPhotos) {
        const day = photo.day || "";
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(photo);
      }
      return [...byDay.keys()]
        .filter(Boolean)
        .sort()
        .map((day) => ({
          day,
          photos: byDay
            .get(day)
            .slice()
            .sort((a, b) => (a.ts || 0) - (b.ts || 0) || String(a.id).localeCompare(String(b.id))),
        }));
    }

    async function refreshThumbs() {
      const paths = localPhotos.map((photo) => photo.thumbPath).filter(Boolean);
      thumbUrls = paths.length ? await getSignedThumbUrls(getSupabase(), paths) : {};
    }

    function render() {
      const view = draftVacation();
      const media = selectedMedia();
      const label = coverStatusLabel(view, { media, places: localPlaces });
      const currentSrc = media && thumbUrls[media.thumbPath] ? thumbUrls[media.thumbPath] : presetThumbUrl(draft.presetId);
      const dayBlocks = groups()
        .map((group) => {
          const tiles = group.photos
            .map((photo) => {
              const on = draft.type === "media" && draft.mediaId === photo.id;
              const src = thumbUrls[photo.thumbPath] || "";
              const neu = freshIds.has(photo.id) ? `<span class="cover-photo__neu">neu</span>` : "";
              const mark = on ? `<span class="cover-photo__mark">${CHECK_SVG}</span>` : "";
              return `<button type="button" class="cover-photo${on ? " cover-photo--on" : ""}" data-cover-photo="${escapeHtml(photo.id)}" data-testid="cover-photo" aria-pressed="${on ? "true" : "false"}">
                <img src="${escapeHtml(src)}" alt="" />
                ${neu}${mark}
              </button>`;
            })
            .join("");
          return `<section class="cover-day" data-testid="cover-day" data-day="${escapeHtml(group.day)}">
            <div class="cover-day__head">
              <h3>${escapeHtml(libraryDayTitle(vacation, group.day))}</h3>
              <span>${fotoLabel(group.photos.length)}</span>
            </div>
            <div class="cover-grid">${tiles}</div>
          </section>`;
        })
        .join("");

      const dayPicker = pendingFile
        ? `<div class="cover-day-picker" data-testid="cover-day-picker">
            <p class="cover-day-picker__title">Tag wählen</p>
            <div class="cover-day-picker__row">
              ${vacationDays(vacation)
                .map(
                  (iso) =>
                    `<button type="button" class="cover-day-picker__btn" data-cover-day="${iso}" data-testid="cover-day-choice">${escapeHtml(libraryDayTitle(vacation, iso))}</button>`
                )
                .join("")}
            </div>
          </div>`
        : "";

      const device = allowDevice
        ? `<button type="button" class="cover-device" data-action="device" data-testid="cover-from-device"${uploading ? " disabled" : ""}>
            <span class="cover-device__icon">${PHONE_SVG}</span>
            <span class="cover-device__text">
              <strong>Vom Gerät wählen</strong>
              <small>${uploading ? "Wird hochgeladen…" : "Foto aus deiner iPhone-Mediathek"}</small>
            </span>
          </button>
          <input type="file" accept="image/*" hidden data-testid="cover-device-input" />
          ${dayPicker}`
        : "";

      const motifs = COVER_PRESETS.map((preset) => {
        const on = draft.type === "preset" && draft.presetId === preset.id;
        return `<button type="button" class="cover-thumb${on ? " cover-thumb--active" : ""}" data-preset="${preset.id}" data-testid="cover-preset" aria-pressed="${on ? "true" : "false"}">
          <img class="cover-thumb__img" src="${presetThumbUrl(preset.id)}" alt="" />
          <span class="cover-thumb__label">${preset.label}</span>
        </button>`;
      }).join("");

      layer.innerHTML = `
        <header class="cover-layer__bar">
          <button type="button" class="link-btn" data-action="cancel" data-testid="cover-sheet-cancel">Abbrechen</button>
          <h2 class="cover-layer__title">Titelbild wählen</h2>
          <button type="button" class="link-btn" data-action="done" data-testid="cover-sheet-done">Fertig</button>
        </header>
        <div class="cover-layer__main">
          <div class="cover-current" data-testid="cover-current">
            <img src="${escapeHtml(currentSrc)}" alt="" />
            <div>
              <span class="cover-current__kicker">Aktuelles Titelbild</span>
              <strong data-testid="cover-current-label">${escapeHtml(label)}</strong>
            </div>
          </div>
          ${device}
          <div class="cover-library-head">
            <h3>Fotos dieser Reise</h3>
            <span data-testid="cover-photo-count">${fotoLabel(localPhotos.length)}</span>
          </div>
          ${dayBlocks || `<p class="cover-empty" data-testid="cover-photos-empty">Noch keine Fotos auf dieser Reise.</p>`}
          <h3 class="cover-motifs__title">Automatisches Motiv</h3>
          <div class="cover-picker" data-testid="cover-presets">${motifs}</div>
        </div>`;

      layer.querySelector('[data-action="cancel"]')?.addEventListener("click", () => choose(null));
      layer.querySelector('[data-action="done"]')?.addEventListener("click", () => {
        const next = draftVacation().cover;
        choose({
          type: next.type,
          presetId: next.presetId,
          mediaId: next.type === "media" ? next.mediaId : null,
          media: selectedMedia(),
        });
      });
      layer.querySelectorAll("[data-cover-photo]").forEach((btn) => {
        btn.addEventListener("click", () => {
          draft = { type: "media", mediaId: btn.dataset.coverPhoto, presetId: draft.presetId };
          pendingFile = null;
          render();
        });
      });
      layer.querySelectorAll("[data-preset]").forEach((btn) => {
        btn.addEventListener("click", () => {
          draft = { type: "preset", presetId: normalizePresetId(btn.dataset.preset), mediaId: null };
          pendingFile = null;
          render();
        });
      });
      const fileInput = layer.querySelector('[data-testid="cover-device-input"]');
      layer.querySelector('[data-action="device"]')?.addEventListener("click", () => {
        if (uploading) return;
        fileInput?.click();
      });
      fileInput?.addEventListener("change", () => {
        const file = fileInput.files?.[0];
        fileInput.value = "";
        if (!file || uploading) return;
        if (!vacationDays(vacation).length) {
          showWarnToast("Bitte zuerst den Zeitraum speichern.");
          return;
        }
        pendingFile = file;
        render();
      });
      layer.querySelectorAll("[data-cover-day]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const file = pendingFile;
          const day = btn.dataset.coverDay;
          if (!file || !day || uploading) return;
          pendingFile = null;
          void upload(file, day);
        });
      });
    }

    async function upload(file, day) {
      uploading = true;
      render();
      try {
        const place = await placeForDay(vacation.id, day);
        if (place && !localPlaces.some((entry) => entry.id === place.id)) localPlaces.push(place);
        const processed = await processPhotoForCloud(file);
        const media = await uploadCloudPhoto({
          place,
          vacationId: vacation.id,
          day: place?.day || place?.dayDate || day,
          ts: processed.takenAt ?? Date.now(),
          originalBlob: processed.blob,
          thumbBlob: processed.thumbBlob,
          width: processed.w,
          height: processed.h,
        });
        media.vacationId = vacation.id;
        media.placeId = place?.id || media.placeId;
        media.day = place?.day || place?.dayDate || day;
        localPhotos.push(media);
        freshIds.add(media.id);
        draft = { type: "media", mediaId: media.id, presetId: draft.presetId };
        await refreshThumbs();
      } catch (err) {
        showWarnToast(err?.message || "Foto konnte nicht hochgeladen werden.");
      } finally {
        uploading = false;
        if (layer.isConnected) render();
      }
    }

    render();
    void refreshThumbs().then(() => {
      if (layer.isConnected) render();
    });
  });
}
