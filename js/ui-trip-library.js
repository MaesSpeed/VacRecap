import { CloudOfflineError } from "./cloud-errors.js";
import { fetchUploadedPhotosForTrip, getPlacesForVacation, getVacation } from "./db.js";
import { startGalleryPhotoUpload } from "./gallery-upload.js";
import { ICON_BACK_CHEVRON } from "./icons.js";
import { groupLibraryPhotos, isLibraryPhoto, libraryDayTitle } from "./library-groups.js";
import { getSignedThumbUrl } from "./media-signed-url-cache.js";
import { navigate } from "./router.js";
import { getSupabase } from "./supabase-client.js";
import { loadTripSelection } from "./trip-selection-store.js";
import { canEditTripMedia, getMyTripRole } from "./trip-role.js";
import { openMediaViewer } from "./ui-media-viewer.js";
import { showWarnToast } from "./toast.js";
import { escapeHtml } from "./utils.js";

/** Letzter erfolgreicher Stand je Reise (nur Metadaten, keine Blobs). */
const libraryMemory = new Map();

const PIN_SVG = `<svg width="19" height="19" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M16 2.8c-5.8 0-10 4.3-10 9.7 0 6.9 10 15.7 10 15.7s10-8.8 10-15.7c0-5.4-4.2-9.7-10-9.7z" fill="#d4523e"/><circle cx="16" cy="12.6" r="3.8" fill="#fff"/></svg>`;

const LAZY_ROOT_MARGIN = "160px 0px";
const SIGN_CONCURRENCY = 4;
const MAX_MOUNTED_THUMBS = 64;

export async function renderTripLibrary(appEl, vacationId) {
  const mountGen = appEl?.dataset?.appRenderGen ?? "";
  const vacation = await getVacation(vacationId);
  if (appEl?.dataset?.appRenderGen !== mountGen) return;
  if (!vacation) {
    navigate({ name: "urlaube" }, { replace: true });
    return;
  }

  let lazyStop = () => {};
  let loadToken = 0;

  const cleanup = () => {
    lazyStop();
    lazyStop = () => {};
  };
  appEl._libraryCleanup = cleanup;

  const stillCurrent = (token) =>
    token === loadToken && appEl?.dataset?.appRenderGen === mountGen && appEl.isConnected;

  function bindBack() {
    appEl.querySelector('[data-action="back"]')?.addEventListener("click", () => {
      if (window.history.length > 1) {
        window.history.back();
        return;
      }
      navigate({ name: "urlaub-detail", id: vacationId }, { replace: true });
    });
  }

  function shell(bodyHtml, { canEdit = false, offline = false } = {}) {
    cleanup();
    const scrollTop = appEl.querySelector(".library-main")?.scrollTop || 0;
    const addBtn = canEdit
      ? `<button type="button" class="library-add" data-action="add-photos" data-testid="library-add-photos">+ Fotos</button>`
      : `<span class="map-header__spacer" aria-hidden="true"></span>`;
    const banner = offline
      ? `<p class="library-offline" data-testid="library-offline">Du bist offline.</p>`
      : "";
    appEl.className = "screen screen--library";
    appEl.dataset.testid = "trip-library-screen";
    appEl.dataset.vacationId = vacationId;
    appEl.innerHTML = `
      <header class="map-header settings-header">
        <button type="button" class="map-header__back" data-action="back" data-testid="library-back">${ICON_BACK_CHEVRON}<span class="map-header__trip">${escapeHtml(vacation.title)}</span></button>
        <h1 class="map-header__title">Mediathek</h1>
        ${addBtn}
      </header>
      <main class="library-main" data-testid="trip-library">${banner}${bodyHtml}</main>
      <input type="file" accept="image/*" multiple hidden data-role="gallery-input" data-testid="library-gallery-input" />
    `;
    bindBack();
    bindGallery(canEdit);
    const main = appEl.querySelector(".library-main");
    if (main && scrollTop) main.scrollTop = scrollTop;
    return main;
  }

  function bindGallery(canEdit) {
    const input = appEl.querySelector('[data-testid="library-gallery-input"]');
    if (!input || !canEdit) return;
    appEl.querySelectorAll('[data-action="add-photos"]').forEach((btn) => {
      btn.addEventListener("click", () => input.click());
    });
    input.addEventListener("change", () => {
      const files = [...(input.files || [])];
      input.value = "";
      if (!files.length) return;
      void (async () => {
        try {
          const saved = await loadTripSelection(vacationId);
          const day = saved?.activeDay;
          const selectedPlaceId = day ? saved?.selectedByDay?.[day] : null;
          await startGalleryPhotoUpload({
            vacation,
            vacationId,
            files,
            day,
            selectedPlaceId,
            onDone: () => {
              void load();
            },
          });
        } catch (err) {
          showWarnToast(err?.message || "Foto konnte nicht zugeordnet werden.");
        }
      })();
    });
  }

  function paintLoading() {
    shell(`
      <div class="trip-empty" data-testid="library-loading">
        <p class="trip-empty__hint">Fotos werden geladen…</p>
      </div>
    `);
  }

  function paintError() {
    shell(`
      <div class="trip-empty" data-testid="library-error">
        <p class="trip-empty__title">Fotos konnten nicht geladen werden.</p>
        <button type="button" class="btn btn-emaille library-retry" data-testid="library-retry">Erneut versuchen</button>
      </div>
    `);
    appEl.querySelector('[data-testid="library-retry"]')?.addEventListener("click", () => {
      void load();
    });
  }

  function paintEmpty(canEdit) {
    shell(
      `
      <div class="trip-empty" data-testid="library-empty">
        <p class="trip-empty__title">Noch keine Fotos</p>
        <p class="trip-empty__hint">Hochgeladene Fotos dieser Reise erscheinen hier.</p>
        ${
          canEdit
            ? `<button type="button" class="btn btn-emaille library-add-block" data-action="add-photos" data-testid="library-add-photos-empty">+ Fotos</button>`
            : ""
        }
      </div>
    `,
      { canEdit }
    );
  }

  function paintOfflineEmpty(canEdit) {
    shell(
      `
      <div class="trip-empty" data-testid="library-offline">
        <p class="trip-empty__title">Du bist offline.</p>
        <button type="button" class="btn btn-emaille library-retry" data-testid="library-retry">Erneut versuchen</button>
        ${
          canEdit
            ? `<button type="button" class="btn btn-emaille library-add-block" data-action="add-photos" data-testid="library-add-photos-empty">+ Fotos</button>`
            : ""
        }
      </div>
    `,
      { canEdit }
    );
    appEl.querySelector('[data-testid="library-retry"]')?.addEventListener("click", () => {
      void load();
    });
  }

  function paintPhotos(groups, flat, canDelete, { offline = false } = {}) {
    const html = groups
      .map((group) => {
        const places = group.places
          .map((place) => {
            const countLabel = place.photos.length === 1 ? "1 Foto" : `${place.photos.length} Fotos`;
            const tiles = place.photos
              .map(
                (photo) =>
                  `<button type="button" class="library-thumb" data-media-id="${escapeHtml(photo.id)}" aria-label="Foto anzeigen"></button>`
              )
              .join("");
            return `
              <article class="oc library-place" data-place-id="${escapeHtml(place.placeId || "")}">
                <div class="pinb" aria-hidden="true">${PIN_SVG}</div>
                <div class="oc__body">
                  <h3 class="oc__title">${escapeHtml(place.placeName)}</h3>
                  <p class="oc__meta">${countLabel}</p>
                  <div class="library-grid">${tiles}</div>
                </div>
              </article>`;
          })
          .join("");
        return `
          <section class="library-day" data-day="${escapeHtml(group.day)}">
            <h2 class="library-day__title">${escapeHtml(libraryDayTitle(vacation, group.day))}</h2>
            <div class="library-places">${places}</div>
          </section>`;
      })
      .join("");

    const main = shell(html, { canEdit: canDelete, offline });
    main?.addEventListener("click", (e) => {
      const thumb = e.target.closest(".library-thumb[data-media-id]");
      if (!thumb || !main.contains(thumb)) return;
      openMediaViewer(flat, thumb.dataset.mediaId, {
        canDelete,
        onChanged: () => {
          void load();
        },
      });
    });
    if (main) lazyStop = mountLazyThumbs(main, flat);
  }

  function paintRemembered(canDelete, { offline = false } = {}) {
    const remembered = libraryMemory.get(vacationId);
    if (!remembered?.photos?.length) return false;
    const groups = groupLibraryPhotos(remembered.photos, remembered.places);
    const flat = remembered.photos
      .slice()
      .sort((a, b) => a.ts - b.ts || String(a.id).localeCompare(String(b.id)));
    paintPhotos(groups, flat, canDelete, { offline });
    return true;
  }

  async function load() {
    const token = ++loadToken;
    if (!stillCurrent(token)) return;

    const rolePromise = getMyTripRole(vacationId);
    if (!navigator.onLine && libraryMemory.has(vacationId)) {
      const canDelete = canEditTripMedia(await rolePromise);
      if (!stillCurrent(token)) return;
      if (paintRemembered(canDelete, { offline: true })) return;
    }

    paintLoading();
    if (!stillCurrent(token)) return;

    const [photoResult, placesResult, role] = await Promise.all([
      fetchUploadedPhotosForTrip(vacationId),
      getPlacesForVacation(vacationId).then(
        (places) => ({ places, error: null }),
        (error) => ({ places: [], error })
      ),
      rolePromise,
    ]);
    if (!stillCurrent(token)) return;

    const canDelete = canEditTripMedia(role);
    const offline =
      !navigator.onLine ||
      photoResult.error instanceof CloudOfflineError ||
      placesResult.error instanceof CloudOfflineError;

    if (photoResult.error || placesResult.error) {
      if (offline && paintRemembered(canDelete, { offline: true })) return;
      if (offline) {
        paintOfflineEmpty(canDelete);
        return;
      }
      paintError();
      return;
    }

    const photos = (photoResult.media || []).filter(isLibraryPhoto);
    libraryMemory.set(vacationId, { photos, places: placesResult.places || [] });
    if (!photos.length) {
      paintEmpty(canDelete);
      return;
    }
    const groups = groupLibraryPhotos(photos, placesResult.places);
    const flat = photos
      .slice()
      .sort((a, b) => a.ts - b.ts || String(a.id).localeCompare(String(b.id)));
    paintPhotos(groups, flat, canDelete);
  }

  await load();
}

function mountLazyThumbs(root, photos) {
  const byId = new Map(photos.map((p) => [p.id, p]));
  const visible = new Set();
  const mounted = [];
  const queue = [];
  let active = 0;
  let stopped = false;
  const supabase = getSupabase();

  const pump = () => {
    if (stopped) return;
    while (active < SIGN_CONCURRENCY && queue.length) {
      const el = queue.shift();
      if (!el?.isConnected || el.dataset.thumbState === "ready" || el.dataset.thumbState === "pending") {
        continue;
      }
      const media = byId.get(el.dataset.mediaId);
      const path = media?.thumbPath || media?.storagePath;
      if (!path) continue;
      active += 1;
      el.dataset.thumbState = "pending";
      getSignedThumbUrl(supabase, path)
        .then((url) => {
          if (stopped || !el.isConnected || el.dataset.thumbState !== "pending") return;
          if (!url) {
            delete el.dataset.thumbState;
            return;
          }
          const img = document.createElement("img");
          img.className = "library-thumb__img";
          img.alt = "";
          img.decoding = "async";
          img.loading = "lazy";
          img.addEventListener("error", () => {
            if (!el.isConnected) return;
            el.replaceChildren();
            el.dataset.thumbState = "missing";
            const hint = document.createElement("span");
            hint.className = "library-thumb__missing";
            hint.dataset.testid = "library-thumb-missing";
            hint.textContent = "Datei fehlt";
            el.appendChild(hint);
          });
          img.src = url;
          el.replaceChildren(img);
          el.dataset.thumbState = "ready";
          const idx = mounted.indexOf(el);
          if (idx >= 0) mounted.splice(idx, 1);
          mounted.push(el);
          trimMounted();
        })
        .catch(() => {
          if (el.dataset.thumbState === "pending") delete el.dataset.thumbState;
        })
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  };

  function trimMounted() {
    while (mounted.length > MAX_MOUNTED_THUMBS) {
      const idx = mounted.findIndex((el) => !visible.has(el));
      if (idx < 0) break;
      const el = mounted.splice(idx, 1)[0];
      if (!el?.isConnected) continue;
      el.replaceChildren();
      delete el.dataset.thumbState;
    }
  }

  const enqueue = (el) => {
    if (!el || el.dataset.thumbState === "ready" || el.dataset.thumbState === "pending") return;
    if (queue.includes(el)) return;
    queue.push(el);
    pump();
  };

  const thumbs = [...root.querySelectorAll(".library-thumb[data-media-id]")];
  if (typeof IntersectionObserver !== "function") {
    thumbs.slice(0, 24).forEach(enqueue);
    return () => {
      stopped = true;
    };
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const el = entry.target;
        if (entry.isIntersecting) {
          visible.add(el);
          enqueue(el);
        } else {
          visible.delete(el);
        }
      }
      trimMounted();
    },
    { root, rootMargin: LAZY_ROOT_MARGIN, threshold: 0.01 }
  );
  const arm = requestAnimationFrame(() => {
    if (stopped) return;
    thumbs.forEach((el) => io.observe(el));
  });

  return () => {
    stopped = true;
    cancelAnimationFrame(arm);
    io.disconnect();
    visible.clear();
    queue.length = 0;
  };
}
