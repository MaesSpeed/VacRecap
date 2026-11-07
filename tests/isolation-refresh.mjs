import { fileURLToPath } from "node:url";
import { resetDataScope, syncDataScopeUser, StaleDataScopeError, dedupeScopeKey } from "../js/data-scope.js";
import { dedupeRequest, resetInflightRequests } from "../js/request-dedupe.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

export async function runIsolationRefreshTest() {
  let resolveA;
  const fetchA = () =>
    new Promise((resolve) => {
      resolveA = resolve;
    });

  syncDataScopeUser("user-a");
  const scopeA = dedupeScopeKey();
  const jobA = dedupeRequest("trips:all", fetchA);

  resetInflightRequests();
  resetDataScope();
  syncDataScopeUser("user-b");
  assert(dedupeScopeKey() !== scopeA, "scope must change after account switch");

  let runsB = 0;
  const jobB = dedupeRequest("trips:all", async () => {
    runsB += 1;
    return "trips-b";
  });
  await Promise.resolve();
  assert(runsB === 1, "user B must start a fresh in-flight request");

  resolveA("trips-a");
  let aFailed = false;
  try {
    await jobA;
  } catch (err) {
    aFailed = err instanceof StaleDataScopeError;
  }
  assert(aFailed, "stale user A request must not deliver after scope change");

  const bValue = await jobB;
  assert(bValue === "trips-b", `user B got ${bValue}`);
  console.log("isolation-refresh unit test grün");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runIsolationRefreshTest().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
