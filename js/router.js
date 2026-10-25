const listeners = new Set();
const NAV_FROM_OVERVIEW_KEY = "vacrecap-nav-from-overview";

export function leaveTripToOverview() {
  const fromOverview = sessionStorage.getItem(NAV_FROM_OVERVIEW_KEY) === "1";
  sessionStorage.removeItem(NAV_FROM_OVERVIEW_KEY);
  if (fromOverview && history.length > 1) {
    history.back();
    return;
  }
  navigate({ name: "urlaube" }, { replace: true });
}

function parseHash() {
  const raw = window.location.hash.replace(/^#/, "") || "/";
  const path = raw.startsWith("/") ? raw : `/${raw}`;
  const parts = path.split("/").filter(Boolean);
  return { path, parts };
}

export function getRoute() {
  const { parts } = parseHash();
  if (parts.length === 0 || parts[0] === "urlaube") {
    return { name: "urlaube" };
  }
  if (parts[0] === "urlaub" && parts[1] === "neu") {
    return { name: "urlaub-form", mode: "create" };
  }
  if (parts[0] === "urlaub" && parts[2] === "bearbeiten") {
    return { name: "urlaub-form", mode: "edit", id: parts[1] };
  }
  if (parts[0] === "urlaub" && parts[2] === "einstellungen") {
    return { name: "urlaub-settings", id: parts[1] };
  }
  if (parts[0] === "urlaub" && parts[2] === "mediathek") {
    return { name: "urlaub-mediathek", id: parts[1] };
  }
  if (parts[0] === "urlaub" && parts[2] === "karte") {
    return { name: "urlaub-map", id: parts[1] };
  }
  if (parts[0] === "urlaub" && parts[1]) {
    return { name: "urlaub-detail", id: parts[1] };
  }
  return { name: "urlaube" };
}

export function navigate(route, { replace = false } = {}) {
  const current = getRoute();
  const fromOverview = !replace && current.name === "urlaube" && route.name === "urlaub-detail";
  if (fromOverview) {
    sessionStorage.setItem(NAV_FROM_OVERVIEW_KEY, "1");
  }
  let hash = "#/urlaube";
  switch (route.name) {
    case "urlaube":
      hash = "#/urlaube";
      break;
    case "urlaub-form":
      hash =
        route.mode === "edit"
          ? `#/urlaub/${route.id}/bearbeiten`
          : "#/urlaub/neu";
      break;
    case "urlaub-detail":
      hash = `#/urlaub/${route.id}`;
      break;
    case "urlaub-settings":
      hash = `#/urlaub/${route.id}/einstellungen`;
      break;
    case "urlaub-mediathek":
      hash = `#/urlaub/${route.id}/mediathek`;
      break;
    case "urlaub-map":
      hash = `#/urlaub/${route.id}/karte`;
      break;
    default:
      break;
  }
  const url = `${window.location.pathname}${window.location.search}${hash}`;
  if (replace) {
    history.replaceState(null, "", url);
    notify();
    return;
  }
  const apply = () => {
    if (window.location.hash !== hash) {
      window.location.hash = hash;
    } else {
      notify();
    }
  };
  apply();
}

function notify() {
  const route = getRoute();
  listeners.forEach((fn) => fn(route));
}

export function startRouter() {
  sessionStorage.removeItem("vacrecap-last-hash");
  sessionStorage.removeItem(NAV_FROM_OVERVIEW_KEY);
  window.addEventListener("hashchange", () => notify());
  notify();
}

export function onRouteChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
