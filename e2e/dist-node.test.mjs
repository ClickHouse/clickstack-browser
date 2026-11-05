// The built package must be safe to import and call where there is no page (server-side
// rendering, Node, workers): nothing may throw, schedule work or send a request. Runs against
// dist/, so `npm run build` comes first.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const DIST = new URL("../dist/", import.meta.url);
const OPTIONS = {
  endpoint: "https://example.clickhouse.com:4318",
  serviceName: "dist-node-test",
};
const SESSION_MANAGER = {
  getSessionId: () => "a".repeat(32),
  addObserver: () => undefined,
};

/**
 * Replaces the timers and `fetch` on a global object with probes that record each call.
 *
 * @param {Record<string, unknown>} target - The global object.
 * @returns {string[]} The names of the probed functions, once per call.
 */
function probe(target) {
  /** @type {string[]} */
  const calls = [];

  for (const name of ["setTimeout", "setInterval", "queueMicrotask", "fetch"]) {
    target[name] = () => {
      calls.push(name);
    };
  }

  return calls;
}

/**
 * Treats a module namespace or global as an object of functions.
 *
 * @param {unknown} value - The namespace or global.
 * @returns {Record<string, (...args: unknown[]) => unknown>} The same value.
 */
function functions(value) {
  return /** @type {Record<string, (...args: unknown[]) => unknown>} */ (value);
}

/**
 * Calls every public function of the `.` entry and of a `./replay` controller.
 *
 * @param {Record<string, (...args: unknown[]) => unknown>} api - The `.` exports.
 * @param {(options: unknown) => unknown} startReplay - The `./replay` export.
 */
async function exercise(api, startReplay) {
  api["setUser"]?.({ id: "user-1" });
  api["init"]?.(OPTIONS);
  assert.equal(api["getSessionId"]?.(), null);
  api["pauseReplay"]?.();
  api["resumeReplay"]?.();
  api["startNewSession"]?.();
  api["setAttributes"]?.({ "app.team.name": "core" });
  api["recordException"]?.(new Error("server-side"));
  await api["shutdown"]?.();

  const controller = functions(
    startReplay({ ...OPTIONS, sessionManager: SESSION_MANAGER }),
  );

  controller["pause"]?.();
  controller["resume"]?.();
  await controller["shutdown"]?.();
}

test("the ESM entries import and run without a page", async () => {
  const calls = probe(/** @type {Record<string, unknown>} */ (globalThis));
  const main = functions(await import(new URL("index.js", DIST).href));
  const replay = functions(await import(new URL("replay.js", DIST).href));

  await exercise(main, (options) => replay["startReplay"]?.(options));
  assert.deepEqual(calls, []);
});

test("the IIFE evaluates and runs in a context without a page", async () => {
  const context = vm.createContext({ URL, TextEncoder, performance });
  const calls = probe(/** @type {Record<string, unknown>} */ (context));
  vm.runInContext(
    readFileSync(new URL("clickstack.iife.js", DIST), "utf8"),
    context,
  );

  const api = functions(context["ClickStack"]);
  assert.deepEqual(Object.keys(api).sort(), [
    "getSessionId",
    "init",
    "otel",
    "pauseReplay",
    "recordException",
    "resumeReplay",
    "setAttributes",
    "setUser",
    "shutdown",
    "startNewSession",
  ]);

  await exercise(api, () => ({}));
  assert.deepEqual(calls, []);
});
