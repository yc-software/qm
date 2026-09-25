import assert from "node:assert/strict";
import { test } from "node:test";
import {
  apiRouteName,
  initializeBrowserErrors,
  reportRequestTiming,
  stopBrowserErrors,
} from "../src/browser-errors.ts";
import { browserErrorConfig } from "../server/browser-error-config.ts";

const origin = "https://app.example.com";

test("browser request names come from a static resource allowlist, never the path", () => {
  assert.equal(apiRouteName("/api/sessions/0f3a9c1e-1d2b-4c5d-8e9f-abcdef012345/entries"), "/api/sessions/*");
  assert.equal(apiRouteName("/web/api/ui-state"), "/api/ui-state");
  assert.equal(apiRouteName("/api/private-resource/id"), "/*");
  assert.equal(apiRouteName("/d/private-app/"), "/*");
  assert.equal(apiRouteName("/"), "/*");
});

test("browser trace sampling is opt-in, bounded, and omitted when zero", () => {
  const env = { SENTRY_BROWSER_DSN: "https://public@sentry.example.com/1" };
  assert.equal(browserErrorConfig(env)?.tracesSampleRate, undefined);
  assert.equal(browserErrorConfig({ ...env, SENTRY_BROWSER_TRACES_SAMPLE_RATE: "0.1" })?.tracesSampleRate, 0.1);
  for (const rate of ["2", "-1", "nope", ""])
    assert.equal(browserErrorConfig({ ...env, SENTRY_BROWSER_TRACES_SAMPLE_RATE: rate })?.tracesSampleRate, undefined);
});

const sent: Record<string, any>[][] = [];
const collectingFetch: typeof fetch = async (_input, init) => {
  sent.push(
    String(init?.body)
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  );
  return new Response("{}", { status: 200 });
};

async function withBrowser(run: (sent: Record<string, any>[][]) => Promise<void>): Promise<void> {
  const realFetch = globalThis.fetch;
  const globals = ["window", "document", "performance", "PerformanceObserver"].map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  sent.length = 0;
  globalThis.fetch = collectingFetch;
  const navigation = {
    entryType: "navigation",
    responseStart: 120.4,
    domContentLoadedEventEnd: 800,
    loadEventEnd: 1500,
    name: `${origin}/s/private-session?token=private`,
  };
  const define = (name: string, value: unknown) =>
    Object.defineProperty(globalThis, name, { configurable: true, value });
  define("window", {
    location: { origin, pathname: "/s/private-session-id", search: "" },
    addEventListener() {},
  });
  define("document", { readyState: "complete", addEventListener() {} });
  define("performance", {
    timeOrigin: 1_700_000_000_000,
    now: () => Date.now() - 1_700_000_000_000,
    getEntriesByType: (type: string) => (type === "navigation" ? [navigation] : []),
    getEntriesByName: (name: string) => (name === "first-contentful-paint" ? [{ startTime: 640 }] : []),
  });
  define(
    "PerformanceObserver",
    class {
      callback: (list: { getEntries(): { startTime: number }[] }) => void;
      constructor(callback: (list: { getEntries(): { startTime: number }[] }) => void) {
        this.callback = callback;
      }
      observe() {
        this.callback({ getEntries: () => [{ startTime: 900 }] });
      }
    },
  );
  try {
    await run(sent);
  } finally {
    stopBrowserErrors();
    globalThis.fetch = realFetch;
    for (const [name, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

const me = (tracesSampleRate?: number) => ({
  user: "private-user",
  org: "private-org",
  browserErrors: { dsn: "https://public@sentry.example.com/1", release: "release-1", tracesSampleRate },
});

test("real browser SDK sends sanitized page load and request timings when sampled", async () => {
  await withBrowser(async (sent) => {
    await initializeBrowserErrors(me(1));
    const sdk = await import("@sentry/browser");
    await new Promise((resolve) => setTimeout(resolve, 600));
    reportRequestTiming(
      `${origin}/api/sessions/0f3a9c1e-1d2b-4c5d-8e9f-abcdef012345/entries?after=private`,
      "GET",
      Date.now() - 40,
      200,
    );
    reportRequestTiming("/api/ui-state?key=private", "PUT", Date.now() - 5, 409);
    reportRequestTiming("/api/runs", "POST", Date.now() - 5, null);
    reportRequestTiming("https://other.example.com/private", "GET", Date.now(), 200);
    sdk.captureEvent({
      type: "transaction",
      transaction: "GET /api/private/1234",
      start_timestamp: 1,
      timestamp: 2,
      contexts: { trace: { trace_id: "a".repeat(32), span_id: "b".repeat(16), op: "http.client", status: "ok" } },
    });
    sdk.captureEvent({
      type: "transaction",
      transaction: "GET /api/direct",
      start_timestamp: 1,
      timestamp: 2,
      user: { id: "private-user" },
      request: { url: "private" },
      spans: [{ span_id: "1", trace_id: "2", description: "private", start_timestamp: 1, timestamp: 2, data: {} }],
      tags: { private: "private" },
      contexts: {
        trace: {
          trace_id: "a".repeat(32),
          span_id: "b".repeat(16),
          op: "http.client",
          status: "ok",
          data: { private: 1 },
        },
      },
    });
    await sdk.flush(1000);
    const payload = JSON.stringify(sent);
    assert.equal(payload.includes("private"), false);
    assert.equal(payload.includes("0f3a9c1e"), false);
    const items = sent.map((envelope) => [envelope[1]!.type, envelope[2]!.transaction, envelope[2]]);
    assert.deepEqual(
      items.map(([type, name]) => [type, name]),
      [
        ["transaction", "pageload"],
        ["transaction", "GET /api/sessions/*"],
        ["transaction", "PUT /api/ui-state"],
        ["transaction", "POST /api/runs"],
        ["transaction", "GET /api/direct"],
      ],
    );
    const pageload = items[0]![2]!;
    assert.deepEqual(pageload.tags, { page: "chats" });
    assert.equal(pageload.contexts.trace.data, undefined);
    assert.deepEqual(pageload.measurements, {
      ttfb: { value: 120, unit: "millisecond" },
      dom_content_loaded: { value: 800, unit: "millisecond" },
      load: { value: 1500, unit: "millisecond" },
      fcp: { value: 640, unit: "millisecond" },
      lcp: { value: 900, unit: "millisecond" },
    });
    assert.equal(pageload.timestamp - pageload.start_timestamp, 1.5);
    assert.equal(pageload.release, "release-1");
    assert.equal(pageload.platform, "javascript");
    assert.equal(items[1]![2]!.contexts.trace.status, "ok");
    assert.equal(items[2]![2]!.contexts.trace.status, "invalid_argument");
    assert.deepEqual(items[3]![2]!.tags, { http_status: "network" });
    assert.equal(items[3]![2]!.contexts.trace.status, "internal_error");
    assert.deepEqual(items[4]![2]!.spans, []);
    assert.deepEqual(items[4]![2]!.tags, {});
    const traceIds = new Set(items.slice(0, 4).map(([, , event]) => event!.contexts.trace.trace_id));
    assert.equal(traceIds.size, 4);
    for (const [, , event] of items) {
      assert.equal(event!.user, undefined);
      assert.equal(event!.request, undefined);
      assert.equal(event!.breadcrumbs, undefined);
      assert.deepEqual(Object.keys(sent[0]![0]!).sort(), ["event_id", "sdk", "sent_at"]);
    }
    assert.doesNotMatch(JSON.stringify(sent.map((envelope) => envelope[0]!.trace)), /private|user|segment/);
  });
});

test("unsampled and stopped browsers send no timings and error reporting stays intact", async () => {
  await withBrowser(async (sent) => {
    await initializeBrowserErrors(me());
    const sdk = await import("@sentry/browser");
    await new Promise((resolve) => setTimeout(resolve, 10));
    reportRequestTiming("/api/runs", "GET", Date.now(), 200);
    sdk.captureException(new Error("private failure"));
    await sdk.flush(1000);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]![1]!.type, "event");
    await initializeBrowserErrors(me(1));
    stopBrowserErrors();
    reportRequestTiming("/api/runs", "GET", Date.now(), 200);
    await sdk.flush(1000);
    assert.equal(sent.length, 1);
  });
});
