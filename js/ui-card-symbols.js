import { bindOverlay, releaseOverlayHistory } from "./overlay-stack.js";
import { cardSymbolSummary, listRecapCardRows, listRecaps } from "./recap-service.js";
import { navigate } from "./router.js";
import { escapeHtml, formatDateShort } from "./utils.js";

const HINT_KEY = "vacrecap-card-symbol-hint";

const FILM = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/></svg>`;
const DOC = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>`;
const HAND = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11M12 10V9a1.5 1.5 0 0 1 3 0v2M15 10.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-2.7L3.5 15a1.5 1.5 0 0 1 2.5-1.6L9 16"/></svg>`;

const KIND_LABEL = { video: "Recap-Video", diary: "Reisetagebuch" };

function hintSeen() {
  try {
    return localStorage.getItem(HINT_KEY) === "1";
  } catch {
    return false;
  }
}

export function markCardSymbolHintSeen() {
  try {
    localStorage.setItem(HINT_KEY, "1");
  } catch {
    /* privater Modus: die Zeile bleibt, bis die Seite neu geladen wird */
  }
  document.querySelectorAll("[data-testid='card-symbol-hint']").forEach((el) => {
    el.hidden = true;
    el.replaceChildren();
  });
}

export function cardSymbolHint(summary) {
  const video = summary?.video;
  const diary = summary?.diary;
  const visible = (bucket) => Boolean(bucket && (bucket.final || bucket.drafts > 0));
  if (!visible(video) && !visible(diary)) return "";
  if (video?.final) return "Tipp aufs Symbol öffnet Recap bzw. Tagebuch";
  if (diary?.final) return "Tipp aufs Symbol öffnet Tagebuch bzw. Entwurf";
  return "Tipp aufs Symbol öffnet die Entwürfe";
}

function draftNoun(n) {
  return n === 1 ? "Entwurf" : "Entwürfe";
}

function symbolButton(kind, bucket) {
  if (!bucket || (!bucket.final && !bucket.drafts)) return "";
  const label = KIND_LABEL[kind];
  const state = bucket.final ? "final" : "draft";
  const drafts = bucket.drafts || 0;
  const aria = drafts ? `${label}, ${drafts} ${draftNoun(drafts)}` : label;
  const play = state === "final" ? `<span class="card-sym__play" aria-hidden="true"></span>` : "";
  const badge = drafts ? `<span class="card-sym__count" aria-hidden="true">${drafts}</span>` : "";
  const icon = kind === "video" ? FILM : DOC;
  return `<button type="button" class="card-sym card-sym--${state} card-sym--${kind}" data-testid="card-symbol" data-kind="${kind}" data-state="${state}" data-drafts="${drafts}" aria-label="${escapeHtml(aria)}">${icon}${play}${badge}</button>`;
}

function symbolsHtml(summary) {
  if (!summary) return "";
  return symbolButton("video", summary.video) + symbolButton("diary", summary.diary);
}

function feedbackLabel(n) {
  const count = Number(n) || 0;
  return count === 1 ? "1 Feedback-Eintrag" : `${count} Feedback-Einträge`;
}

function draftWhen(row) {
  const iso = String(row?.updatedAt || row?.createdAt || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
  return formatDateShort(iso);
}

function applyCard(card, summary, showHint, title) {
  const slot = card.querySelector("[data-card-syms]");
  if (!slot) return;
  const html = symbolsHtml(summary);
  slot.innerHTML = html;
  const hint = card.querySelector("[data-testid='card-symbol-hint']");
  const text = showHint ? cardSymbolHint(summary) : "";
  if (hint) {
    if (text && html) {
      hint.hidden = false;
      hint.innerHTML = `${HAND}<span>${escapeHtml(text)}</span>`;
    } else {
      hint.hidden = true;
      hint.replaceChildren();
    }
  }
  slot.querySelectorAll("[data-testid='card-symbol']").forEach((button) => {
    button.addEventListener("pointerdown", (event) => event.stopPropagation());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      markCardSymbolHintSeen();
      const kind = button.dataset.kind === "diary" ? "diary" : "video";
      if (button.dataset.state === "final") {
        navigate({
          name: kind === "diary" ? "urlaub-tagebuch" : "urlaub-recap",
          id: card.dataset.vacationId,
          recapId: "final",
        });
        return;
      }
      void openDraftSheet(card.dataset.vacationId, kind, title);
    });
  });
}

/**
 * Symbole nach den Karten. Die Übersicht wartet nicht auf diese Abfrage.
 * Fehler und fehlende Tabelle bleiben still.
 */
export function paintCardSymbols(appEl, vacations, mountGen) {
  const ids = (vacations || []).map((v) => v.id).filter(Boolean);
  const titles = new Map((vacations || []).map((v) => [v.id, v.title || ""]));
  if (!ids.length) {
    if (appEl?.dataset?.appRenderGen === mountGen) appEl.dataset.cardSymbols = "done";
    return;
  }
  listRecapCardRows(ids)
    .then((rows) => {
      if (appEl?.dataset?.appRenderGen !== mountGen) return;
      if (!appEl.classList.contains("screen--urlaube")) return;
      const summary = cardSymbolSummary(rows);
      const showHint = !hintSeen();
      appEl.querySelectorAll("[data-vacation-id]").forEach((card) => {
        applyCard(card, summary.get(card.dataset.vacationId), showHint, titles.get(card.dataset.vacationId) || "");
      });
    })
    .catch(() => {
      /* keine Symbole, kein Fehlerdialog */
    })
    .finally(() => {
      if (appEl?.dataset?.appRenderGen === mountGen) appEl.dataset.cardSymbols = "done";
    });
}

let draftToken = 0;

async function openDraftSheet(tripId, kind, title) {
  const overlay = document.getElementById("overlay-root");
  if (!overlay || !tripId) return;
  const token = ++draftToken;
  const label = KIND_LABEL[kind] || "Entwürfe";
  overlay.hidden = false;
  overlay.innerHTML = `
    <div class="sheet sheet--card-drafts" role="dialog" aria-modal="true" aria-labelledby="card-drafts-title" data-testid="card-drafts-sheet" data-kind="${kind}">
      <div class="sheet__header sheet__header--row">
        <div class="card-drafts__head">
          <h2 class="sheet__title" id="card-drafts-title">Entwürfe</h2>
          <p class="settings-item__sub" data-testid="card-drafts-meta">${escapeHtml(title ? `${title} · ${label}` : label)}</p>
        </div>
        <button type="button" class="sheet__close" data-action="close" aria-label="Schließen">×</button>
      </div>
      <div class="settings-card settings-card--links" data-testid="card-drafts-list">
        <p class="card-drafts__status" data-testid="card-drafts-loading">Wird geladen…</p>
      </div>
    </div>`;

  const close = () => {
    if (overlay.dataset.draftToken !== String(token)) return;
    overlay.hidden = true;
    overlay.innerHTML = "";
    delete overlay.dataset.draftToken;
  };
  overlay.dataset.draftToken = String(token);
  const activeClose = bindOverlay(overlay, close);
  overlay.querySelector('[data-action="close"]')?.addEventListener("click", () => {
    releaseOverlayHistory(activeClose);
  });

  let drafts = [];
  try {
    const rows = await listRecaps(tripId, kind);
    drafts = rows
      .filter((row) => row && row.status === "draft" && !row.deletedAt)
      .sort((a, b) => (b.version || 1) - (a.version || 1) || String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  } catch {
    drafts = null;
  }
  if (token !== draftToken || overlay.dataset.draftToken !== String(token)) return;
  const list = overlay.querySelector("[data-testid='card-drafts-list']");
  if (!list) return;
  if (!drafts) {
    list.innerHTML = `<p class="card-drafts__status" data-testid="card-drafts-empty">Die Entwürfe konnten nicht geladen werden.</p>`;
    return;
  }
  if (!drafts.length) {
    list.innerHTML = `<p class="card-drafts__status" data-testid="card-drafts-empty">Keine Entwürfe.</p>`;
    return;
  }
  list.innerHTML = drafts
    .map((row) => {
      const when = draftWhen(row);
      const feedback = feedbackLabel(row.feedback?.length || 0);
      const sub = [when, feedback].filter(Boolean).join(" · ");
      return `<button type="button" class="settings-item settings-item--link" data-testid="card-draft-item" data-recap-id="${escapeHtml(row.id)}" data-version="${row.version || 1}">
        <span class="settings-item__text">
          <span class="settings-item__title">Version ${row.version || 1}</span>
          <span class="settings-item__sub">${escapeHtml(sub)}</span>
        </span>
      </button>`;
    })
    .join("");
  list.querySelectorAll("[data-testid='card-draft-item']").forEach((button) => {
    button.addEventListener("click", () => {
      const recapId = button.dataset.recapId;
      if (!recapId) return;
      releaseOverlayHistory(activeClose);
      navigate({
        name: kind === "diary" ? "urlaub-tagebuch" : "urlaub-recap",
        id: tripId,
        recapId,
      });
    });
  });
}
