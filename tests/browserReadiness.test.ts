import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { waitForBrowserReady } from "../scripts/browserReadiness.ts";

// Reproduce an old ready document remaining active while reload is still pending.
let phase = 0;
const origins = [10, 20, 20, 20];
await waitForBrowserReady(async (expression) => {
  if (phase === 2) throw new Error('Execution context was destroyed.');
  return runInNewContext(expression, {
    performance: { timeOrigin: origins[phase] },
    document: { readyState: phase === 1 ? "loading" : "complete" },
    window: { __fixture: { ready: () => true } },
  });
}, { previousTimeOrigin: 10, sleep: async () => { phase++; }, attempts: 4 });
assert.equal(phase, 3, "wait for a new document, DOM initialization, and CDP context");
await assert.rejects(waitForBrowserReady(async (expression) => runInNewContext(expression, {
  performance: { timeOrigin: 10 }, document: { readyState: "complete" },
  window: { __fixture: { ready: () => true } },
}), { previousTimeOrigin: 10, attempts: 2, sleep: async () => {} }), /UI not ready in new document/);
await assert.rejects(waitForBrowserReady(async () => { throw new Error("fixture assertion failed"); }), /fixture assertion failed/);
await waitForBrowserReady(async (expression) => runInNewContext(expression, {
  document: { readyState: "interactive" }, window: { __fixture: { ready: () => true } },
}));
console.log("browser navigation readiness tests ok");
