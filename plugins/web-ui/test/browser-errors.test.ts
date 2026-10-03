import assert from "node:assert/strict";
import { test } from "node:test";
import { initializeBrowserErrors, reportHandledError, stopBrowserErrors } from "../src/browser-errors.ts";
import { browserErrorConfig } from "../server/browser-error-config.ts";
import { ApiError } from "../src/core-bridge.ts";
import type { Me } from "../src/shell-state.ts";

const origin = "https://app.example.com";

test("browser config is opt-in and does not expose a backend secret DSN", () => {
  assert.equal(browserErrorConfig({ SENTRY_DSN: "https://public:secret@sentry.example.com/1" }), undefined);
  assert.deepEqual(
    browserErrorConfig({ SENTRY_BROWSER_DSN: "https://public@sentry.example.com/1", GIT_SHA: "abc1234" }),
    {
      dsn: "https://public@sentry.example.com/1",
      release: "abc1234",
    },
  );
  for (const dsn of [
    "broken",
    "http://public@sentry.example.com/1",
    "https://public:secret@sentry.example.com/1",
    "https://sentry.example.com/1",
    "https://public@sentry.example.com/secret",
    "https://public@sentry.example.com/1?secret",
    "https://public@sentry.example.com/1#secret",
  ])
    assert.throws(() => browserErrorConfig({ SENTRY_BROWSER_DSN: dsn }), /public HTTPS DSN/);
});

test("disabled and impersonated reporting never requires a browser SDK", async () => {
  await initializeBrowserErrors({} as Me);
  await initializeBrowserErrors({
    browserErrors: { dsn: "https://public@sentry.example.com/1" },
    impersonatedBy: "admin",
  } as Me);
  stopBrowserErrors();
});

test("browser errors keep HTTP failures and their context while dropping network failures and aborts", async () => {
  const realFetch = globalThis.fetch;
  const realWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const sent: string[] = [];
  globalThis.fetch = async (_input, init) => {
    sent.push(String(init?.body));
    return new Response("{}", { status: 200 });
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin } } });
  try {
    await initializeBrowserErrors({
      user: "alice@example.com",
      org: "acme",
      browserErrors: { dsn: "https://public@sentry.example.com/1" },
    });
    const sdk = await import("@sentry/browser");
    for (const message of ["Failed to fetch", "NetworkError when attempting to fetch resource.", "Load failed"]) {
      reportHandledError("web:network", new TypeError(message));
      sdk.captureException(new TypeError(message));
    }
    reportHandledError("web:network", new DOMException("request cancelled", "AbortError"));
    sdk.captureException(new DOMException("request cancelled", "AbortError"));
    const body = { error: { details: { reason: "db down" } } };
    reportHandledError(
      "web:approvals_fetch",
      Object.assign(new ApiError("approvals 500", 500, body), { cause: new Error("db down") }),
    );
    await sdk.flush(1000);
    assert.equal(sent.length, 1);
    const event = JSON.parse(sent[0]!.split("\n")[2]!);
    const values = event.exception.values.map((value: { value: string }) => value.value);
    assert.ok(values.includes("approvals 500"));
    assert.ok(values.includes("db down"));
    assert.equal(event.contexts.ApiError.status, 500);
    assert.deepEqual(event.contexts.ApiError.body, body);
    assert.equal(event.tags.error_code, "web:approvals_fetch");
    assert.deepEqual(event.fingerprint, ["{{ default }}", "web:approvals_fetch"]);
    assert.equal(event.user.username, "alice@example.com");
    stopBrowserErrors();
    sdk.captureException(new Error("after stop"));
    await sdk.flush(1000);
    assert.equal(sent.length, 1);
  } finally {
    stopBrowserErrors();
    globalThis.fetch = realFetch;
    if (realWindow) Object.defineProperty(globalThis, "window", realWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
