import { fetchUploadedPhotosForTrip, getPlacesForVacation, getVacation } from "./db.js";
import { ICON_BACK_CHEVRON } from "./icons.js";
import { groupLibraryPhotos, isLibraryPhoto, libraryDayTitle } from "./library-groups.js";
import { getSignedThumbUrl } from "./media-signed-url-cache.js";
import { navigate } from "./router.js";
import { getSupabase } from "./supabase-client.js";
import { canEditTripMedia, getMyTripRole } from "./trip-role.js";
import { openMediaViewer } from "./ui-media-viewer.js";
import { escapeHtml } from "./utils.js";

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

  function shell(bodyHtml) {
    cleanup();
    const scrollTop = appEl.querySelector(".library-main")?.scrollTop || 0;
    appEl.className = "screen screen--library";
    appEl.dataset.testid = "trip-library-screen";
    appEl.dataset.vacationId = vacationId;
    appEl.innerHTML = `
      <header class="map-header settings-header">
        <button type="button" class="map-header__back" data-action="back" data-testid="library-back">${ICON_BACK_CHEVRON}<span class="map-header__trip">${escapeHtml(vacation.title)}</span></button>
        <h1 class="map-header__title">Mediathek</h1>
        <span class="map-header__spacer" aria-hidden="true"></span>
      </header>
      <main class="library-main" data-testid="trip-library">${bodyHtml}</main>
    `;
    bindBack();
    const main = appEl.querySelector(".library-main");
    if (main && scrollTop) main.scrollTop = scrollTop;
    return main;
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

  function paintEmpty() {
    shell(`
      <div class="trip-empty" data-testid="library-empty">
        <p class="trip-empty__title">Noch keine Fotos</p>
        <p class="trip-empty__hint">Hochgeladene Fotos dieser Reise erscheinen hier.</p>
      </div>
    `);
  }

  function paintPhotos(groups, flat, canDelete) {
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

    const main = shell(html);
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

  async function load() {
    const token = ++loadToken;
    if (!stillCurrent(token)) return;
    paintLoading();
    if (!stillCurrent(token)) return;

    const [photoResult, placesResult] = await Promise.all([
      fetchUploadedPhotosForTrip(vacationId),
      getPlacesForVacation(vacationId).then(
        (places) => ({ places, error: null }),
        (error) => ({ places: [], error })
      ),
    ]);
    if (!stillCurrent(token)) return;
    if (photoResult.error || placesResult.error) {
      paintError();
      return;
    }

    const canDelete = canEditTripMedia(await getMyTripRole(vacationId));
    if (!stillCurrent(token)) return;

    const photos = (photoResult.media || []).filter(isLibraryPhoto);
    if (!photos.length) {
      paintEmpty();
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
