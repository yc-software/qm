import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { getSlackInstallation, startSlackInstallation } from "../src/api/routes/admin/slack-installation.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createSlackInstallationStore } from "../src/surfaces/slack-installation.ts";
import { createManagedSlack } from "../src/surfaces/slack-managed.ts";

type SlackSetupStatus = {
  configured: boolean;
  source: string;
  setupUnavailable?: boolean;
  installAvailable?: boolean;
  setup?: {
    tokenUrl: string;
    submitUrl: string;
    installUrl: string;
    connected: boolean;
  };
};

async function fixture(t: test.TestContext) {
  const map = createMemoryMap();
  const store = createSlackInstallationStore(
    "test",
    map as Parameters<typeof createSlackInstallationStore>[1],
    "test-key",
  );
  const calls: Array<{ path: string; body?: string }> = [];
  let remote = Response.json({ companyOwned: true, appReady: false, connected: false });
  const managedSlack = createManagedSlack({
    serviceUrl: "https://bridge.example",
    token: "SENTINEL-bridge",
    store,
    fetchImpl: (async (url: URL, init: RequestInit) => {
      calls.push({ path: url.pathname, body: init.body as string | undefined });
      return url.pathname === "/install/start"
        ? Response.json({ url: "https://bridge.example/install/launch?ticket=opaque" })
        : remote.clone();
    }) as typeof fetch,
  });
  const deps = {
    slackInstallation: store,
    managedSlack,
    portalUrl: "https://agent.example",
    slackEnvironmentState: "none",
    admin: {
      listGrants: async () => [{ principalId: "admin", role: "org_admin", scopeId: "org:test" }],
      resolveActor: (id: string) => ({ id, type: "internal" }),
    },
  };
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    const ctx = { req, res, deps, body: raw ? JSON.parse(raw) : {} } as unknown as ApiCtx;
    await (req.method === "GET" ? getSlackInstallation : startSlackInstallation)(ctx);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    store,
    deps,
    calls,
    remote: (response: Response) => {
      remote = response;
    },
    request: (method = "GET", body?: object, actor = "admin") =>
      fetch(`http://127.0.0.1:${address.port}/`, {
        method,
        headers: { "x-admin-actor": actor, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
  };
}

test("admin status supplies stable links before creation without enabling installation", async (t) => {
  const f = await fixture(t);
  const first = (await (await f.request()).json()) as SlackSetupStatus;
  const second = (await (await f.request()).json()) as SlackSetupStatus;
  assert.ok(first.setup);
  assert.ok(second.setup);
  assert.deepEqual(first.setup, second.setup);
  assert.equal(first.setup.submitUrl, "https://agent.example/admin?slack=setup");
  assert.equal(first.setup.installUrl, "https://agent.example/admin?slack=install");
  assert.equal(first.setup.tokenUrl, "https://api.slack.com/apps");
  assert.equal(first.setup.connected, false);
  assert.equal((await f.store.status()).managed, false);
  assert.ok(!JSON.stringify(first).includes("SENTINEL"));
  assert.equal((await f.request("GET", undefined, "member")).status, 403);
  assert.equal(f.calls.length, 2);
});

test("environment-backed bot skips service lookup and missing service status remains unknown", async (t) => {
  const f = await fixture(t);
  f.deps.slackEnvironmentState = "configured";
  const installed = (await (await f.request()).json()) as SlackSetupStatus;
  assert.equal(installed.configured, true);
  assert.equal(installed.source, "environment");
  assert.equal(installed.setup, undefined);
  assert.equal(f.calls.length, 0);
  f.deps.slackEnvironmentState = "none";
  f.remote(new Response("", { status: 503 }));
  const failed = (await (await f.request()).json()) as SlackSetupStatus;
  assert.equal(failed.setupUnavailable, true);
  assert.equal(failed.setup, undefined);
  f.remote(new Response("", { status: 404 }));
  const legacy = (await (await f.request()).json()) as SlackSetupStatus;
  assert.equal(legacy.setup, undefined);
  assert.equal(legacy.installAvailable, true);
});

test("explicit browser start selects setup or installation and rejects arbitrary steps", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("POST", { step: "setup" }, "member")).status, 403);
  assert.equal((await f.request("POST", { step: "other" })).status, 400);
  assert.equal(f.calls.length, 0);
  for (const step of ["setup", "install"]) {
    assert.equal((await f.request("POST", { step })).status, 200);
    assert.equal(f.calls.at(-1)?.body, JSON.stringify({ step }));
  }
});
