import { assetUrl, getBasePath } from "./config.js";
import { getAllVacations, requestPersistentStorage } from "./db.js";
import { getRoute, navigate, onRouteChange, startRouter } from "./router.js";
import { renderUrlaubDetail } from "./ui-urlaub-detail.js";
import { renderUrlaubSettings } from "./ui-urlaub-settings.js";
import { renderUrlaubForm } from "./ui-urlaub-form.js";
import { renderMapScreen } from "./ui-map.js";
import { renderMediathekScreen } from "./ui-mediathek.js";
import { renderUrlaubeScreen } from "./ui-urlaube.js";
import { installGestureGuards } from "./gesture-guard.js";
import { dismissOverlayOnly, initOverlayHistory } from "./overlay-stack.js";

const appEl = document.getElementById("app");

async function render() {
  const route = getRoute();
  const vacations = await getAllVacations();
  if (appEl?._mapCleanup) {
    appEl._mapCleanup();
  }

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
    case "urlaub-mediathek":
      await renderMediathekScreen(appEl, route.id);
      break;
    case "urlaub-map":
      await renderMapScreen(appEl, route.id);
      break;
    case "urlaube":
    default:
      await renderUrlaubeScreen(appEl, vacations);
      break;
  }
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  const swUrl = assetUrl("sw.js");
  navigator.serviceWorker.register(swUrl, { scope: getBasePath() }).catch(() => {
    /* offline dev */
  });
}

async function boot() {
  installGestureGuards();
  initOverlayHistory();
  await requestPersistentStorage();
  registerServiceWorker();
  onRouteChange(() => {
    dismissOverlayOnly();
    void render();
  });
  startRouter();
  window.addEventListener("vacrecap:data-changed", render);
}

boot();
