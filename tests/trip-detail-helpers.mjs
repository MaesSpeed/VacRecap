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

/** Wait for an in-flight incremental place-list patch on the open trip detail screen. */
export async function waitTripListPatch(page) {
  await page.evaluate(async () => {
    const wait = window.__vacrecapTripListPatch;
    if (typeof wait === "function") await wait();
  });
}

/** Mirrors db.js skipFullRender events so tests do not trigger a full app remount. */
export async function dispatchTripDetailRefresh(page, { tripId, placeId = null, placeDay = null } = {}) {
  await page.evaluate(
    async ({ tripId: tid, placeId: pid, placeDay: pd }) => {
      window.dispatchEvent(
        new CustomEvent("vacrecap:data-changed", {
          detail: {
            skipFullRender: true,
            tripId: tid,
            ...(pid ? { placeId: pid, mergeTrip: true } : {}),
            ...(pd && !pid ? { placeDay: pd, mergeTrip: true } : {}),
          },
        })
      );
      const wait = window.__vacrecapTripListPatch;
      if (typeof wait === "function") await wait();
    },
    { tripId, placeId, placeDay }
  );
}
