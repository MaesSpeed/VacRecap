import { assetUrl, getBasePath } from "./config.js";
import { getAllVacations, requestPersistentStorage } from "./db.js";
import { getRoute, navigate, onRouteChange, startRouter } from "./router.js";
import { renderUrlaubDetail } from "./ui-urlaub-detail.js";
import { renderUrlaubForm } from "./ui-urlaub-form.js";
import { renderUrlaubeScreen } from "./ui-urlaube.js";

const appEl = document.getElementById("app");

async function render() {
  const route = getRoute();
  const vacations = await getAllVacations();

  switch (route.name) {
    case "urlaub-form":
      await renderUrlaubForm(appEl, route);
      break;
    case "urlaub-detail":
      await renderUrlaubDetail(appEl, route.id);
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
  await requestPersistentStorage();
  registerServiceWorker();
  onRouteChange(render);
  startRouter();
  window.addEventListener("vacrecap:data-changed", render);
}

boot();
