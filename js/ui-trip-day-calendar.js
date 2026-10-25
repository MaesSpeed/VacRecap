import { isDayInVacation, vacationDays } from "./days.js";
import { formatIsoDate, parseIsoDate } from "./utils.js";

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

function monthsForVacation(vacation) {
  const start = parseIsoDate(vacation.startDate);
  const end = parseIsoDate(vacation.endDate);
  const months = [];
  const cur = new Date(start.getFullYear(), start.getMonth(), 1);
  const last = new Date(end.getFullYear(), end.getMonth(), 1);
  while (cur <= last) {
    months.push(new Date(cur));
    cur.setMonth(cur.getMonth() + 1);
  }
  return months;
}

export function openTripDayCalendar({ vacation, activeDay, onSelect }) {
  const overlay = document.getElementById("overlay-root");
  overlay.hidden = false;
  overlay.innerHTML = "";

  const tripDays = new Set(vacationDays(vacation));

  const sheet = document.createElement("div");
  sheet.className = "sheet sheet--trip-calendar";
  sheet.innerHTML = `
    <header class="sheet__header">
      <h2 class="sheet__title">Kalender</h2>
      <p class="sheet__subtitle" data-role="subtitle"></p>
    </header>
    <div class="calendar-scroll" data-role="months"></div>
  `;
  sheet.querySelector('[data-role="subtitle"]').textContent = vacation.title;
  overlay.appendChild(sheet);

  const monthsEl = sheet.querySelector('[data-role="months"]');

  monthsForVacation(vacation).forEach((monthDate) => {
    const y = monthDate.getFullYear();
    const m = monthDate.getMonth();
    const section = document.createElement("section");
    section.className = "calendar-month";
    section.innerHTML = `<h3 class="calendar-month__title">${MONTH_NAMES[m]} ${y}</h3>`;
    const grid = document.createElement("div");
    grid.className = "calendar-grid calendar-grid--trip";
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
        btn.textContent = String(parseIsoDate(iso).getDate());
        const inTrip = tripDays.has(iso);
        if (!inTrip) btn.classList.add("calendar-day--disabled");
        if (iso === activeDay) btn.classList.add("calendar-day--selected");
      }
      grid.appendChild(btn);
    });
    section.appendChild(grid);
    monthsEl.appendChild(section);
  });

  function close() {
    overlay.hidden = true;
    overlay.innerHTML = "";
  }

  sheet.addEventListener("click", (e) => {
    const day = e.target.closest(".calendar-day[data-date]");
    if (!day || day.classList.contains("calendar-day--disabled")) return;
    const iso = day.dataset.date;
    if (!isDayInVacation(vacation, iso)) return;
    onSelect(iso);
    close();
  });

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
}
