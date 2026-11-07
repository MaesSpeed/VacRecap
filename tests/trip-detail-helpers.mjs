/**
 * Trip detail opens on "today" when it falls within the trip range; Playwright
 * suites often seed the first calendar day. Switch explicitly so list content
 * matches the seeded dates.
 */
export async function ensureTripDetailDay(page, dayIso, { timeout = 15_000 } = {}) {
  await page.waitForSelector('[data-testid="trip-content"]', { timeout });
  const active = await page.locator('[data-testid="trip-content"]').getAttribute("data-active-day");
  if (active === dayIso) return;
  await page.click(`[data-day="${dayIso}"]`);
  await page.waitForFunction(
    (d) => document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay === d,
    dayIso,
    { timeout }
  );
}
