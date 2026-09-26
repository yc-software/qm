import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { observe } from "./run.mjs";

test("observer retains pending and failed starts without mixing measurement generations", async () => {
  const page = new EventEmitter();
  const origin = "http://127.0.0.1:8129";
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  };
  const request = (path, options = {}) => ({
    url: () => origin + path,
    method: () => "GET",
    resourceType: () => "fetch",
    timing: () => ({ startTime: 1000 }),
    sizes: async () => ({ responseBodySize: 2 }),
    failure: () => ({ errorText: "net::ERR_CONNECTION_RESET" }),
    ...options,
  });
  const response = (req, options = {}) => ({
    request: () => req,
    status: () => 200,
    fromServiceWorker: () => false,
    json: async () => ({ principal: "current@example.invalid" }),
    allHeaders: async () => ({ "content-type": "application/json" }),
    ...options,
  });
  const observer = observe(
    page,
    origin,
    ["/done", "/pending", "/missing", "/failed"].map((path) => ({ path })),
  );
  observer.start();
  const oldIdentity = deferred();
  const oldHeaders = deferred();
  const oldSizes = deferred();
  const previousMe = request("/me");
  const previousDone = request("/done", { sizes: () => oldSizes.promise });
  const previousMissing = request("/missing");
  for (const req of [previousMe, previousDone, previousMissing]) page.emit("request", req);
  page.emit("response", response(previousMe, { json: () => oldIdentity.promise }));
  page.emit("response", response(previousDone, { allHeaders: () => oldHeaders.promise }));
  page.emit("requestfinished", previousDone);

  observer.start();
  const done = request("/done?private=secret-query");
  const completedDuplicate = request("/pending");
  const pending = request("/pending");
  const failed = request("/failed");
  const me = request("/me");
  for (const req of [done, completedDuplicate, pending, failed, me]) page.emit("request", req);
  for (const req of [done, completedDuplicate, me]) {
    page.emit("response", response(req));
    page.emit("requestfinished", req);
  }
  page.emit("requestfailed", failed);
  page.emit("response", response(previousMissing));
  page.emit("requestfinished", previousMissing);
  oldIdentity.resolve({ principal: "previous@example.invalid" });
  oldHeaders.reject(new Error("Previous measurement headers failed"));
  oldSizes.resolve({ responseBodySize: 999 });

  await assert.rejects(observer.waitResponses(10), {
    message: "Required page requests did not finish: /pending, /missing, /failed",
  });
  const evidence = await observer.finish();
  assert.equal(evidence.identity, "current@example.invalid");
  assert.equal(evidence.requests.length, 5);
  assert.equal(
    evidence.requests.some((entry) => entry.path === "/missing"),
    false,
  );
  const duplicates = evidence.requests.filter((entry) => entry.path === "/pending");
  assert.equal(duplicates[0].completed, true);
  assert.equal(duplicates[0].phase, "finished");
  assert.equal(duplicates[1].completed, false);
  assert.equal(duplicates[1].phase, "started");
  assert.equal(duplicates[1].status, undefined);
  assert.ok(duplicates[1].pendingForMs >= 0);
  const failedEntry = evidence.requests.find((entry) => entry.path === "/failed");
  assert.equal(failedEntry.phase, "failed");
  assert.equal(failedEntry.failure, "net::ERR_CONNECTION_RESET");
  assert.equal(failedEntry.completed, false);
  assert.deepEqual(evidence.errors, [{ type: "requestfailed", path: "/failed", message: "net::ERR_CONNECTION_RESET" }]);
  assert.equal(JSON.stringify(evidence).includes("secret-query"), false);
});
