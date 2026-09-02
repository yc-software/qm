import { test } from "node:test";
import assert from "node:assert/strict";
import { runBrowserUseTask, validateBrowserUseKey } from "../src/tools/browser-use.ts";
import { createMemoryConfigStore, type PersistedBrowserUseKey } from "../src/resolution/config-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { scopeId } from "../src/types.ts";
import { settle } from "./support/settle.ts";

type Handler = (init?: RequestInit) => { status?: number; body: unknown };

function fakeApi(handlers: Record<string, Handler>, log: string[] = []): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    const path = String(url).replace("https://api.browser-use.com/api/v4", "");
    const key = `${init?.method ?? "GET"} ${path}`;
    log.push(key);
    for (const [prefix, handler] of Object.entries(handlers)) {
      if (key.startsWith(prefix)) {
        const { status = 200, body } = handler(init);
        return new Response(JSON.stringify(body), { status });
      }
    }
    throw new Error(`unexpected request: ${key}`);
  }) as typeof fetch;
}

const readyEvent = (url: string) => ({ id: 2, type: "browser.ready", data: { live_view_url: url } });

test("a run resolves with the result and surfaces the live view as soon as the browser is ready", async () => {
  const log: string[] = [];
  let polls = 0;
  let apiKeyHeader = "";
  const fetchImpl = fakeApi(
    {
      "GET /runs/r1/events": () => ({ body: { events: [{ id: 1, type: "run.created", data: {} }, readyEvent("https://live.browser-use.com/abc")] } }),
      "GET /runs/r1": () => ({
        body:
          ++polls < 3
            ? { id: "r1", status: "running", result: null, error: null }
            : { id: "r1", status: "completed", result: "the top story is X", error: null },
      }),
      "POST /runs": (init) => {
        apiKeyHeader = (init?.headers as Record<string, string> | undefined)?.["X-Browser-Use-API-Key"] ?? "";
        assert.deepEqual(JSON.parse(String(init?.body)), { task: "find the top story" });
        return { body: { id: "r1", status: "queued" } };
      },
    },
    log,
  );
  const liveViews: string[] = [];
  const outcome = await runBrowserUseTask("bu_key", "find the top story", {
    fetchImpl,
    pollMs: 1,
    onLiveView: (url) => {
      liveViews.push(url);
    },
  });
  assert.deepEqual(outcome, {
    status: "completed",
    result: "the top story is X",
    error: null,
    liveViewUrl: "https://live.browser-use.com/abc",
  });
  assert.deepEqual(liveViews, ["https://live.browser-use.com/abc"]);
  assert.equal(apiKeyHeader, "bu_key");
  assert.equal(log.includes("POST /runs/r1/cancel"), false);
  assert.equal(log.filter((entry) => entry.startsWith("GET /runs/r1/events")).length, 1);
});

test("an untrusted live view url is ignored", async () => {
  let polls = 0;
  const fetchImpl = fakeApi({
    "GET /runs/r2/events": () => ({ body: { events: [readyEvent("https://evil.example/phish"), { id: 3, type: "browser.ready", data: { live_view_url: "javascript:alert(1)" } }] } }),
    "GET /runs/r2": () => ({
      body: { id: "r2", status: ++polls < 2 ? "running" : "completed", result: "ok", error: null },
    }),
    "POST /runs": () => ({ body: { id: "r2", status: "queued" } }),
  });
  const liveViews: string[] = [];
  const outcome = await runBrowserUseTask("bu_key", "task", {
    fetchImpl,
    pollMs: 1,
    onLiveView: (url) => {
      liveViews.push(url);
    },
  });
  assert.equal(outcome.liveViewUrl, null);
  assert.deepEqual(liveViews, []);
});

test("a failed run resolves with the provider error", async () => {
  const fetchImpl = fakeApi({
    "GET /runs/r3/events": () => ({ body: { events: [] } }),
    "GET /runs/r3": () => ({ body: { id: "r3", status: "failed", result: null, error: "the site blocked the agent" } }),
    "POST /runs": () => ({ body: { id: "r3", status: "queued" } }),
  });
  const outcome = await runBrowserUseTask("bu_key", "buy a thing", { fetchImpl, pollMs: 1 });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.error, "the site blocked the agent");
});

test("an unexpected run status resolves as failed instead of polling forever", async () => {
  const fetchImpl = fakeApi({
    "GET /runs/r4/events": () => ({ body: { events: [] } }),
    "GET /runs/r4": () => ({ body: { id: "r4", status: "paused", result: null, error: null } }),
    "POST /runs": () => ({ body: { id: "r4", status: "queued" } }),
  });
  const outcome = await runBrowserUseTask("bu_key", "task", { fetchImpl, pollMs: 1 });
  assert.equal(outcome.status, "failed");
  assert.match(outcome.error ?? "", /unexpected run status: paused/);
});

test("an abort landing on an in-flight poll still cancels the run", async () => {
  const log: string[] = [];
  const controller = new AbortController();
  const fetchImpl = fakeApi(
    {
      "POST /runs/r5/cancel": () => ({ body: {} }),
      "GET /runs/r5/events": () => ({ body: { events: [] } }),
      "GET /runs/r5": () => {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      },
      "POST /runs": () => ({ body: { id: "r5", status: "queued" } }),
    },
    log,
  );
  const outcome = await runBrowserUseTask("bu_key", "slow task", { fetchImpl, pollMs: 1, signal: controller.signal });
  assert.equal(outcome.status, "cancelled");
  assert.equal(log.includes("POST /runs/r5/cancel"), true);
});

test("transient poll failures are tolerated but repeated failures cancel and rethrow", async () => {
  let flaky = 0;
  const tolerant = fakeApi({
    "GET /runs/r6/events": () => ({ body: { events: [] } }),
    "GET /runs/r6": () => {
      if (++flaky < 3) throw new Error("socket hang up");
      return { body: { id: "r6", status: "completed", result: "done", error: null } };
    },
    "POST /runs": () => ({ body: { id: "r6", status: "queued" } }),
  });
  const outcome = await runBrowserUseTask("bu_key", "task", { fetchImpl: tolerant, pollMs: 1 });
  assert.equal(outcome.status, "completed");

  const log: string[] = [];
  const dead = fakeApi(
    {
      "POST /runs/r7/cancel": () => ({ body: {} }),
      "GET /runs/r7/events": () => ({ body: { events: [] } }),
      "GET /runs/r7": () => {
        throw new Error("socket hang up");
      },
      "POST /runs": () => ({ body: { id: "r7", status: "queued" } }),
    },
    log,
  );
  await assert.rejects(runBrowserUseTask("bu_key", "task", { fetchImpl: dead, pollMs: 1 }), /socket hang up/);
  assert.equal(log.includes("POST /runs/r7/cancel"), true);
});

test("a run past the wall-clock limit is cancelled and reported as timed out", async () => {
  const log: string[] = [];
  const fetchImpl = fakeApi(
    {
      "POST /runs/r8/cancel": () => ({ body: {} }),
      "POST /runs": () => ({ body: { id: "r8", status: "queued" } }),
    },
    log,
  );
  const outcome = await runBrowserUseTask("bu_key", "endless task", { fetchImpl, pollMs: 1, maxWallMs: -1 });
  assert.equal(outcome.status, "timed_out");
  assert.match(outcome.error ?? "", /wall-clock/);
  assert.equal(log.includes("POST /runs/r8/cancel"), true);
});

test("key validation passes on a 2xx and returns the provider detail on a rejection", async () => {
  const ok = await validateBrowserUseKey("bu_good", {
    fetchImpl: fakeApi({ "GET /sessions": () => ({ body: { items: [] } }) }),
  });
  assert.equal(ok, null);
  const rejected = await validateBrowserUseKey("bu_bad", {
    fetchImpl: fakeApi({ "GET /sessions": () => ({ status: 401, body: { detail: "Invalid API key" } }) }),
  });
  assert.match(rejected ?? "", /401/);
  assert.match(rejected ?? "", /Invalid API key/);
});

test("the browser use key round-trips encrypted, survives a restart, and clears", async () => {
  const browserUseKeys = createMemoryMap<PersistedBrowserUseKey>();
  const org = scopeId("org", "default-org");
  const a = createMemoryConfigStore("default-org", { browserUseKeys, connectorSecretKey: "key-material" });
  assert.equal(a.getBrowserUseKey(org), null);

  a.setBrowserUseKey(org, "bu_secret_123");
  assert.equal(a.getBrowserUseKey(org), "bu_secret_123");
  await settle(async () => !!(await browserUseKeys.get(org)));
  const stored = await browserUseKeys.get(org);
  assert.equal(stored?.secretEnc.includes("bu_secret_123"), false);

  const b = createMemoryConfigStore("default-org", { browserUseKeys, connectorSecretKey: "key-material" });
  await b.hydrate?.();
  assert.equal(b.getBrowserUseKey(org), "bu_secret_123");

  const wrongKey = createMemoryConfigStore("default-org", { browserUseKeys, connectorSecretKey: "other-material" });
  await wrongKey.hydrate?.();
  assert.equal(wrongKey.getBrowserUseKey(org), null);

  b.setBrowserUseKey(org, null);
  assert.equal(b.getBrowserUseKey(org), null);
  await settle(async () => !(await browserUseKeys.get(org)));
});

test("the runner resolves granted secrets into domain-pinned bindings the model never sees", async () => {
  const { createBrowserUseRunner } = await import("../src/tools/browser-use.ts");
  let body: Record<string, unknown> = {};
  let polls = 0;
  const fetchImpl = fakeApi({
    "GET /runs/r9/events": () => ({ body: { events: [] } }),
    "GET /runs/r9": () => ({ body: { id: "r9", status: ++polls < 2 ? "running" : "completed", result: "signed in", error: null } }),
    "POST /runs": (init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return { body: { id: "r9", status: "queued" } };
    },
  });
  const runner = createBrowserUseRunner("bu_key", new Map([["ACME_PASSWORD", "hunter2"]]));
  const outcome = await runner("sign in to acme using the secret ACME_PASSWORD", {
    fetchImpl,
    pollMs: 1,
    secrets: [{ envKey: "ACME_PASSWORD", domains: ["Acme.com "] }],
  });
  assert.equal(outcome.status, "completed");
  assert.deepEqual(body.secretBindings, [
    { alias: "ACME_PASSWORD", source: { type: "inline", value: "hunter2" }, allowedDomains: ["acme.com"] },
  ]);
});

test("an ungranted secret fails fast, naming the granted keys and the keychain flow", async () => {
  const { createBrowserUseRunner } = await import("../src/tools/browser-use.ts");
  const runner = createBrowserUseRunner("bu_key", new Map([["OTHER_KEY", "x"]]));
  await assert.rejects(
    runner("task", { secrets: [{ envKey: "ACME_PASSWORD", domains: ["acme.com"] }] }),
    (e: Error) => /no credential is granted under env key ACME_PASSWORD/.test(e.message) && /OTHER_KEY/.test(e.message) && /keychain/.test(e.message),
  );
});

test("secret domains must be bare registrable hostnames", async () => {
  const { createBrowserUseRunner } = await import("../src/tools/browser-use.ts");
  const runner = createBrowserUseRunner("bu_key", new Map([["K", "v"]]));
  for (const domain of ["https://acme.com/login", "com", "acme..com", ".acme.com", "*.acme.com"]) {
    await assert.rejects(runner("task", { secrets: [{ envKey: "K", domains: [domain] }] }), /bare registrable hostnames/);
  }
});

test("a provider error that echoes a bound secret is scrubbed before it can reach the transcript", async () => {
  const { createBrowserUseRunner } = await import("../src/tools/browser-use.ts");
  const fetchImpl = fakeApi({
    "POST /runs": () => ({
      status: 422,
      body: { detail: [{ loc: ["secretBindings", 0], input: { source: { value: "hunter2" } } }] },
    }),
  });
  const runner = createBrowserUseRunner("bu_key", new Map([["ACME_PASSWORD", "hunter2"]]));
  await assert.rejects(
    runner("task", { fetchImpl, pollMs: 1, secrets: [{ envKey: "ACME_PASSWORD", domains: ["acme.com"] }] }),
    (e: Error) => !e.message.includes("hunter2") && e.message.includes("[secret ACME_PASSWORD]"),
  );
});

test("a run result that echoes a bound secret is scrubbed", async () => {
  const { createBrowserUseRunner } = await import("../src/tools/browser-use.ts");
  const fetchImpl = fakeApi({
    "GET /runs/r10/events": () => ({ body: { events: [] } }),
    "GET /runs/r10": () => ({
      body: { id: "r10", status: "completed", result: "typed hunter2 into the form", error: null },
    }),
    "POST /runs": () => ({ body: { id: "r10", status: "queued" } }),
  });
  const bound: unknown[] = [];
  const runner = createBrowserUseRunner("bu_key", new Map([["ACME_PASSWORD", "hunter2"]]), {
    onSecretsBound: (bindings) => {
      bound.push(...bindings);
    },
  });
  const outcome = await runner("task", { fetchImpl, pollMs: 1, secrets: [{ envKey: "ACME_PASSWORD", domains: ["acme.com"] }] });
  assert.equal(outcome.result, "typed [secret ACME_PASSWORD] into the form");
  assert.deepEqual(bound, [{ alias: "ACME_PASSWORD", domains: ["acme.com"] }]);
});
