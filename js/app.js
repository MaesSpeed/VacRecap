import { getSession, onAuthStateChange } from "./auth-service.js";
import { flushPendingMediaPurges, getAllVacations } from "./db.js";
import { installGestureGuards } from "./gesture-guard.js";
import { runLegacyCleanup } from "./legacy-cleanup.js";
import { isOfflineReadOnly, setCacheUserId, setOfflineReadOnly } from "./local-cache.js";
import { getRoute, navigate, onRouteChange, startRouter } from "./router.js";
import { renderLoginScreen } from "./ui-login.js";
import { renderUrlaubDetail } from "./ui-urlaub-detail.js";
import { renderMapScreen } from "./ui-map.js";
import { renderTripLibrary } from "./ui-trip-library.js";
import { renderRecapVideo } from "./ui-recap-video.js";
import { renderDiary } from "./ui-diary.js";
import { renderUrlaubSettings } from "./ui-urlaub-settings.js";
import { renderUrlaubForm } from "./ui-urlaub-form.js";
import { renderUrlaubeScreen } from "./ui-urlaube.js";
import { installVisualViewportKeyboard } from "./visual-viewport.js";
import { dismissOverlayOnly, initOverlayHistory } from "./overlay-stack.js";
import { showWarnToast } from "./toast.js";
import { CloudNetworkError, CloudOfflineError } from "./cloud-errors.js";

const appEl = document.getElementById("app");

let renderGeneration = 0;
let renderCoalescePending = false;
let appStarted = false;
let loadErrorShown = false;

function renderCloudLoadError(retry) {
  if (!appEl) return;
  loadErrorShown = true;
  appEl.className = "screen screen--login";
  appEl.innerHTML = `
    <main class="login-main" data-testid="cloud-load-error">
      <p class="login-lead">Die Cloud ist gerade nicht erreichbar. Bitte Verbindung prüfen.</p>
      <button type="button" class="btn btn-emaille" data-testid="cloud-retry">Erneut versuchen</button>
    </main>
  `;
  appEl.querySelector('[data-testid="cloud-retry"]')?.addEventListener("click", () => {
    loadErrorShown = false;
    retry();
  });
}

function updateOnlineBanner() {
  const offline = isOfflineReadOnly();
  let banner = document.getElementById("vr-offline-banner");
  if (!offline) {
    banner?.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "vr-offline-banner";
    banner.className = "offline-banner";
    banner.setAttribute("role", "status");
    banner.textContent = "Offline – nur Lesen aus dem letzten Stand.";
    document.body.prepend(banner);
  }
}

async function renderNow() {
  const gen = ++renderGeneration;
  if (appEl) appEl.dataset.appRenderGen = String(gen);

  const route = getRoute();
  let vacations = [];
  try {
    vacations = await getAllVacations();
  } catch (err) {
    if (err instanceof CloudOfflineError) {
      setOfflineReadOnly(true);
      vacations = await getAllVacations();
    } else {
      throw err;
    }
  }
  if (appEl?.dataset.appRenderGen !== String(gen)) return;

  if (appEl?._mapCleanup) {
    appEl._mapCleanup();
  }
  if (appEl?._libraryCleanup) {
    appEl._libraryCleanup();
    delete appEl._libraryCleanup;
  }
  if (typeof appEl?._screenCleanup === "function") {
    appEl._screenCleanup();
    delete appEl._screenCleanup;
  }

  updateOnlineBanner();

  switch (route.name) {
    case "urlaub-form":
      await renderUrlaubForm(appEl, route);
      break;
    case "urlaub-detail":
      await renderUrlaubDetail(appEl, route.id);
      break;
    case "urlaub-settings":
      await renderUrlaubSettings(appEl, route.id);
      break;
    case "urlaub-recap":
      await renderRecapVideo(appEl, route.id);
      break;
    case "urlaub-tagebuch":
      await renderDiary(appEl, route.id);
      break;
    case "urlaub-map":
      await renderMapScreen(appEl, route.id);
      break;
    case "urlaub-mediathek":
      await renderTripLibrary(appEl, route.id);
      break;
    case "urlaube":
    default:
      await renderUrlaubeScreen(appEl, vacations);
      break;
  }
}

function scheduleRender() {
  if (renderCoalescePending) return;
  renderCoalescePending = true;
  queueMicrotask(() => {
    renderCoalescePending = false;
    void renderNow().catch((err) => {
      if (err instanceof CloudOfflineError) {
        showWarnToast(err.message);
        return;
      }
      if (err instanceof CloudNetworkError) {
        renderCloudLoadError(scheduleRender);
        return;
      }
      renderCloudLoadError(scheduleRender);
    });
  });
}

async function startApp() {
  if (appStarted) return;
  appStarted = true;
  const session = await getSession();
  if (session?.user?.id) setCacheUserId(session.user.id);
  onRouteChange(() => {
    dismissOverlayOnly();
    scheduleRender();
  });
  startRouter();
  window.addEventListener("vacrecap:data-changed", () => {
    if (document.querySelector("[data-testid='cover-sheet']")) return;
    scheduleRender();
  });
  window.addEventListener("online", () => {
    setOfflineReadOnly(false);
    scheduleRender();
  });
  window.addEventListener("offline", () => {
    setOfflineReadOnly(true);
    scheduleRender();
  });
  scheduleRender();
}

async function boot() {
  installGestureGuards();
  installVisualViewportKeyboard();
  initOverlayHistory();
  runLegacyCleanup();
  void flushPendingMediaPurges();

  const session = await getSession();
  if (!session) {
    renderLoginScreen(appEl, () => startApp());
    onAuthStateChange((s) => {
      if (s?.user?.id) setCacheUserId(s.user.id);
      if (s) startApp();
    });
    return;
  }
  setCacheUserId(session.user.id);
  startApp();
}

boot();
