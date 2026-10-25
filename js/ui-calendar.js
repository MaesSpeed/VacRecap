import { bindOverlay, closeOverlayHistory } from "./overlay-stack.js";
import {
  dayCountInclusive,
  formatDateShort,
  formatIsoDate,
  parseIsoDate,
} from "./utils.js";

const MONTH_NAMES = [
  "Januar",
  "Februar",
  "März",
  "April",
  "Mai",
  "Juni",
  "Juli",
  "August",
  "September",
  "Oktober",
  "November",
  "Dezember",
];

function dayLabelsForRange(startIso, endIso) {
  const n = dayCountInclusive(startIso, endIso);
  if (n === 1) return "1 Tag";
  const labels = ["Anreise"];
  for (let i = 2; i < n; i++) labels.push(`${i}. Tag`);
  labels.push("Abreise");
  return `${n} Tage · ${labels.join(", ")}`;
}

function buildMonthGrid(year, month) {
  const first = new Date(year, month, 1);
  const startPad = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startPad; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push(formatIsoDate(new Date(year, month, d)));
  }
  return cells;
}

function monthStartFromIso(iso) {
  const d = parseIsoDate(iso);
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function buildMonthList(today, tripStartDate) {
  const todayMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  let anchor = todayMonth;
  if (tripStartDate) {
    const tripMonth = monthStartFromIso(tripStartDate);
    if (tripMonth < todayMonth) anchor = tripMonth;
  }
  const endMonth = new Date(today.getFullYear(), today.getMonth() + 15, 1);
  const monthStarts = [];
  let y = anchor.getFullYear();
  let m = anchor.getMonth();
  while (y < endMonth.getFullYear() || (y === endMonth.getFullYear() && m <= endMonth.getMonth())) {
    monthStarts.push(new Date(y, m, 1));
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  return monthStarts;
}

export function openDateRangePicker({ startDate, endDate, tripStartDate = "", onApply }) {
  const overlay = document.getElementById("overlay-root");
  overlay.hidden = false;
  overlay.innerHTML = "";

  let draftStart = startDate || "";
  let draftEnd = endDate || "";
  let pickingEnd = Boolean(draftStart && !draftEnd);

  const sheet = document.createElement("div");
  sheet.className = "sheet sheet--calendar";
  sheet.innerHTML = `
    <header class="sheet__header sheet__header--row">
      <h2 class="sheet__title">Zeitraum</h2>
      <button type="button" class="sheet__close" data-action="cancel" aria-label="Schließen">Abbrechen</button>
    </header>
    <div class="range-summary">
      <div class="range-box" data-role="start-box">
        <span class="range-box__label">Start · Anreise</span>
        <span class="range-box__value" data-role="start-label">–</span>
      </div>
      <div class="range-box" data-role="end-box">
        <span class="range-box__label">Ende · Abreise</span>
        <span class="range-box__value" data-role="end-label">–</span>
      </div>
    </div>
    <div class="calendar-scroll" data-role="months"></div>
    <p class="calendar-hint" data-role="hint"></p>
    <button type="button" class="btn btn-emaille btn-emaille--block" data-action="apply" disabled>
      Zeitraum übernehmen
    </button>
  `;
  overlay.appendChild(sheet);

  const monthsEl = sheet.querySelector('[data-role="months"]');
  const hintEl = sheet.querySelector('[data-role="hint"]');
  const applyBtn = sheet.querySelector('[data-action="apply"]');
  const startLabel = sheet.querySelector('[data-role="start-label"]');
  const endLabel = sheet.querySelector('[data-role="end-label"]');

  const today = new Date();
  const todayIso = formatIsoDate(today);
  const monthStarts = buildMonthList(today, tripStartDate);

  monthStarts.forEach((monthDate) => {
    const y = monthDate.getFullYear();
    const m = monthDate.getMonth();
    const section = document.createElement("section");
    section.className = "calendar-month";
    section.dataset.yearMonth = `${y}-${String(m + 1).padStart(2, "0")}`;
    section.innerHTML = `<h3 class="calendar-month__title">${MONTH_NAMES[m]} ${y}</h3>`;
    const grid = document.createElement("div");
    grid.className = "calendar-grid";
    const weekdays = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
    weekdays.forEach((wd) => {
      const h = document.createElement("span");
      h.className = "calendar-grid__weekday";
      h.textContent = wd;
      grid.appendChild(h);
    });
    buildMonthGrid(y, m).forEach((iso) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "calendar-day";
      if (!iso) {
        btn.classList.add("calendar-day--empty");
        btn.disabled = true;
        btn.tabIndex = -1;
      } else {
        btn.dataset.date = iso;
        const dayNum = parseIsoDate(iso).getDate();
        btn.innerHTML = `<span class="calendar-day__num">${dayNum}</span>`;
        if (iso === todayIso) {
          btn.classList.add("calendar-day--today");
          btn.innerHTML += `<span class="calendar-day__heute">heute</span>`;
        }
      }
      grid.appendChild(btn);
    });
    section.appendChild(grid);
    monthsEl.appendChild(section);
  });

  function refresh() {
    startLabel.textContent = draftStart ? formatDateShort(draftStart) : "–";
    endLabel.textContent = draftEnd ? formatDateShort(draftEnd) : "–";
    const valid = draftStart && draftEnd && draftEnd >= draftStart;
    applyBtn.disabled = !valid;
    const days = valid ? dayCountInclusive(draftStart, draftEnd) : 0;
    hintEl.textContent = valid
      ? dayLabelsForRange(draftStart, draftEnd)
      : pickingEnd
        ? "Enddatum wählen"
        : "Startdatum wählen";
    if (valid && days === 1) {
      hintEl.textContent = "1 Tag";
    }

    sheet.querySelectorAll(".calendar-day[data-date]").forEach((btn) => {
      const iso = btn.dataset.date;
      btn.classList.remove(
        "calendar-day--selected",
        "calendar-day--range",
        "calendar-day--start",
        "calendar-day--end"
      );
      if (!draftStart) return;
      if (iso === draftStart) btn.classList.add("calendar-day--start", "calendar-day--selected");
      if (draftEnd && iso === draftEnd)
        btn.classList.add("calendar-day--end", "calendar-day--selected");
      if (draftEnd && iso > draftStart && iso < draftEnd) {
        btn.classList.add("calendar-day--range");
      }
    });
  }

  sheet.addEventListener("click", (e) => {
    const day = e.target.closest(".calendar-day[data-date]");
    if (!day) return;
    const iso = day.dataset.date;
    if (!draftStart || (draftStart && draftEnd) || iso < draftStart) {
      draftStart = iso;
      draftEnd = "";
      pickingEnd = true;
    } else {
      draftEnd = iso < draftStart ? draftStart : iso;
      if (draftEnd < draftStart) [draftStart, draftEnd] = [draftEnd, draftStart];
      pickingEnd = false;
    }
    refresh();
  });

  const close = () => {
    overlay.hidden = true;
    overlay.innerHTML = "";
  };

  const activeClose = bindOverlay(overlay, close);

  applyBtn.addEventListener("click", () => {
    if (!draftStart || !draftEnd) return;
    onApply({ startDate: draftStart, endDate: draftEnd });
    closeOverlayHistory(activeClose);
  });

  sheet.querySelector('[data-action="cancel"]').addEventListener("click", () => {
    closeOverlayHistory(activeClose);
  });

  refresh();

  function jumpToScrollMonth() {
    const scrollIso = draftStart || todayIso;
    const scrollDate = parseIsoDate(scrollIso);
    const ym = `${scrollDate.getFullYear()}-${String(scrollDate.getMonth() + 1).padStart(2, "0")}`;
    const target = monthsEl.querySelector(`[data-year-month="${ym}"]`);
    target?.scrollIntoView({ block: "start", behavior: "instant" });
  }

  jumpToScrollMonth();
  requestAnimationFrame(jumpToScrollMonth);
  setTimeout(jumpToScrollMonth, 350);
}

export function formatRangeSummary(startIso, endIso) {
  if (!startIso || !endIso) return "";
  return `${dayLabelsForRange(startIso, endIso)}`;
}
