import { getSession, onAuthStateChange, syncAuthFromSession } from "./auth-service.js";
import { flushPendingMediaPurges, getAllVacations } from "./db.js";
import { installGestureGuards } from "./gesture-guard.js";
import { runLegacyCleanup } from "./legacy-cleanup.js";
import { isOfflineReadOnly, setOfflineReadOnly } from "./local-cache.js";
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
import { dismissOverlayOnly, initOverlayHistory, stripOverlayHistoryState } from "./overlay-stack.js";
import { installToastPositionSync, showWarnToast } from "./toast.js";
import { CloudNetworkError, CloudOfflineError } from "./cloud-errors.js";
import { StaleDataScopeError } from "./data-scope.js";

const appEl = document.getElementById("app");

let renderGeneration = 0;
let renderCoalescePending = false;
let renderQueued = false;
let renderChain = Promise.resolve();
let appStarted = false;
let loadErrorShown = false;
let hasRenderedScreen = false;

function cloudLoadErrorCopy(err) {
  if (err instanceof CloudNetworkError) {
    return "Die Cloud ist gerade nicht erreichbar. Bitte Verbindung prüfen.";
  }
  return "Die Cloud antwortet gerade nicht. Bitte gleich nochmal versuchen.";
}

function renderCloudLoadError(retry, err) {
  if (!appEl) return;
  loadErrorShown = true;
  appEl.className = "screen screen--login";
  appEl.innerHTML = `
    <main class="login-main" data-testid="cloud-load-error">
      <p class="login-lead">${cloudLoadErrorCopy(err)}</p>
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

  let vacations = [];
  try {
    vacations = await getAllVacations();
  } catch (err) {
    if (err instanceof CloudOfflineError) {
      setOfflineReadOnly(true);
      vacations = await getAllVacations();
    } else if (err instanceof StaleDataScopeError) {
      vacations = await getAllVacations();
    } else {
      throw err;
    }
  }
  if (appEl?.dataset.appRenderGen !== String(gen)) return;

  const route = getRoute();

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
      await renderRecapVideo(appEl, route.id, { recapId: route.recapId || "" });
      break;
    case "urlaub-tagebuch":
      await renderDiary(appEl, route.id, { recapId: route.recapId || "" });
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
  if (appEl?.dataset.appRenderGen === String(gen)) hasRenderedScreen = true;
}

function scheduleRender() {
  renderQueued = true;
  if (renderCoalescePending) return;
  renderCoalescePending = true;
  queueMicrotask(() => {
    renderCoalescePending = false;
    if (!renderQueued) return;
    renderQueued = false;
    renderChain = renderChain
      .then(() => renderNow())
      .catch((err) => {
        if (err instanceof CloudOfflineError) {
          showWarnToast(err.message);
          return;
        }
        if (hasRenderedScreen) {
          showWarnToast("Neu laden hat nicht geklappt. Bitte gleich nochmal versuchen.");
          return;
        }
        renderCloudLoadError(scheduleRender, err);
      });
  });
}

async function startApp() {
  if (appStarted) return;
  appStarted = true;
  const session = await getSession();
  if (session) syncAuthFromSession(session);
  onRouteChange(() => {
    dismissOverlayOnly();
    stripOverlayHistoryState();
    scheduleRender();
  });
  startRouter();
  window.addEventListener("vacrecap:data-changed", () => {
    if (document.querySelector("[data-testid='cover-sheet']")) return;
    if (document.getElementById("app")?.dataset.formSaving === "1") return;
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
  installToastPositionSync();
  initOverlayHistory();
  runLegacyCleanup();
  void flushPendingMediaPurges();

  const session = await getSession();
  if (!session) {
    renderLoginScreen(appEl, () => startApp());
    onAuthStateChange((s) => {
      syncAuthFromSession(s);
      if (s) startApp();
    });
    return;
  }
  syncAuthFromSession(session);
  startApp();
}

boot();
