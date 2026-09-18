import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeBrowserError, initializeBrowserErrors, stopBrowserErrors } from "../src/browser-errors.ts";
import { browserErrorConfig } from "../server/browser-error-config.ts";
import type { Me } from "../src/shell-state.ts";

const origin = "https://app.example.com";

test("browser errors discard content and retain only local asset stack positions", () => {
  const event = sanitizeBrowserError(
    {
      type: undefined,
      event_id: "a".repeat(32),
      timestamp: 123,
      message: "secret",
      user: { email: "secret@example.com" },
      request: { url: `${origin}/s/secret`, headers: { authorization: "secret" } },
      breadcrumbs: [{ message: "secret" }],
      extra: { content: "secret" },
      contexts: { trace: { trace_id: "secret", span_id: "secret" } },
      tags: { secret: "secret" },
      release: "secret",
      exception: {
        values: [
          {
            type: "TypeError",
            value: "secret",
            mechanism: { type: "auto.browser.global_handlers.onunhandledrejection", data: { secret: "secret" } },
            stacktrace: {
              frames: [
                {
                  filename: `${origin}/web/assets/main-Abc12345.js?secret#secret`,
                  function: "secret",
                  lineno: 42,
                  colno: 8,
                  vars: { secret: "secret" },
                  pre_context: ["secret"],
                },
                { filename: "https://secret.example.com/assets/main-Abc12345.js", lineno: 2 },
                { filename: `${origin}/s/secret`, lineno: 3 },
                { filename: "data:secret", lineno: 4 },
                { filename: `${origin}/assets/main-Abc12345.js`, lineno: -1, colno: Infinity },
              ],
            },
          },
          { type: "secret", value: "secret" },
        ],
      },
    },
    origin,
    "release-1",
  );
  assert.equal(JSON.stringify(event).includes("secret"), false);
  assert.equal(JSON.stringify(event).includes("https:"), false);
  assert.equal(event.release, "release-1");
  assert.deepEqual(event.tags, { service: "web-ui-browser" });
  assert.equal(event.exception?.values?.[0]?.type, "TypeError");
  assert.equal(event.exception?.values?.[1]?.type, "Error");
  assert.deepEqual(event.exception?.values?.[0]?.stacktrace?.frames, [
    { filename: "main-Abc12345.js", lineno: 42, colno: 8, in_app: true },
    { filename: "main-Abc12345.js", lineno: undefined, colno: undefined, in_app: true },
  ]);
  assert.equal(event.exception?.values?.[0]?.mechanism?.type, "onunhandledrejection");
});

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

test("browser grouping separates minified locations without using private content", () => {
  const makeEvent = (colno: number, secret = "secret", asset = "main-Abc12345.js") => ({
    type: undefined,
    fingerprint: [secret],
    message: secret,
    exception: {
      values: [
        {
          type: "TypeError",
          value: secret,
          stacktrace: {
            frames: [
              { filename: `${origin}/assets/caller-Abc12345.js`, lineno: 1, colno: 12 },
              { filename: `${origin}/assets/${asset}?${secret}`, lineno: 1, colno, function: secret },
              { filename: `https://external.example.com/${secret}`, lineno: 1, colno: 99 },
            ],
          },
        },
      ],
    },
  });
  const first = sanitizeBrowserError(makeEvent(100), origin, "release-1").fingerprint;
  assert.deepEqual(first, ["web-ui-browser-v1", "TypeError", "onerror", "main-Abc12345.js:1:100"]);
  assert.notDeepEqual(first, sanitizeBrowserError(makeEvent(101), origin, "release-1").fingerprint);
  assert.deepEqual(
    first,
    sanitizeBrowserError(makeEvent(100, "other-private-content"), origin, "release-2").fingerprint,
  );
  assert.notDeepEqual(first, sanitizeBrowserError(makeEvent(100, "secret", "main-Def67890.js"), origin).fingerprint);
  const fallback = sanitizeBrowserError(
    { type: undefined, exception: { values: [{ type: "secret", value: "secret", mechanism: { type: "secret" } }] } },
    origin,
  ).fingerprint;
  assert.deepEqual(fallback, ["web-ui-browser-v1", "Error", "onerror", "no-app-frame"]);
});

test("SDK processing failures cannot bypass browser event redaction", async () => {
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
      user: "test",
      org: "test",
      browserErrors: { dsn: "https://public@sentry.example.com/1" },
    });
    const sdk = await import("@sentry/browser");
    const client = sdk.getClient()!;
    sdk.captureException(new Error("private original event"));
    await sdk.flush(1000);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.includes("private"), false);
    const beforeSend = client.getOptions().beforeSend;
    client.getOptions().beforeSend = () => {
      throw new Error("private SDK failure");
    };
    sdk.captureException(new Error("private trigger"));
    await sdk.flush(1000);
    assert.equal(sent.length, 1);
    client.getOptions().beforeSend = beforeSend;
    client.addEventProcessor(() => {
      throw new Error("private processor failure");
    });
    sdk.captureException(new Error("private processor trigger"));
    await sdk.flush(1000);
    assert.equal(sent.length, 1);
  } finally {
    stopBrowserErrors();
    globalThis.fetch = realFetch;
    if (realWindow) Object.defineProperty(globalThis, "window", realWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
