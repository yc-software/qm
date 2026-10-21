import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { connectorProvider, makeRefresh, setStoredOAuthProviders, type FetchLike } from "../src/connectors/oauth.ts";
import { parseCustomOAuthProvider, type StoredOAuthProvider } from "../src/connectors/custom-provider.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import type { TurnRequest } from "../src/types.ts";
import { buildApp } from "./support/build-app.ts";
import { selectDefaultSandbox } from "./support/default-sandbox.ts";
import { testConfig } from "./support/test-config.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };

const HUDDLE = {
  provider: "huddle",
  label: "Huddle",
  description: "Meetings",
  authUrl: "https://huddle.example/oauth/authorize",
  tokenUrl: "https://huddle.example/oauth/token",
  hosts: ["api.huddle.example"],
  scopes: [],
  clientAuth: "basic",
  docsUrl: "https://huddle.example/developers",
  setupSteps: ["Create a General app.", "Add the redirect URI shown below."],
};

function start() {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "custom-provider-")), maxAttempts: 1 }));
  const tokenCalls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const oauthFetch: FetchLike = async (url, init) => {
    tokenCalls.push({ url, headers: init.headers, body: init.body });
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: "huddle-access", refresh_token: "huddle-refresh", expires_in: 3600 }),
    };
  };
  const server = createInsecureTestServer(built.app, {
    oauthStateSecret: "custom-provider-oauth-state-secret",
    replayDedupe: built.replayDedupe,
    connectorTokens: built.connectorTokens,
    resolveClient: built.resolveClient,
    config: built.config,
    admin: built.admin,
    auditLog: built.auditLog,
    oauthFetch,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const put = (resource: string, body: object) =>
    fetch(`${base}/v1/admin/scopes/org:default-org/${resource}`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify(body),
    });
  const catalog = async () =>
    (
      (await (await fetch(`${base}/v1/connectors/catalog`)).json()) as {
        catalog: Array<{ provider: string; label: string; description?: string; configured: boolean }>;
      }
    ).catalog;
  return { base, built, tokenCalls, put, catalog, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function dm(text: string): TurnRequest {
  return {
    surface: "test",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "dm:U1" },
    text,
    liveActor: true,
  };
}

test("an admin-defined provider connects end to end and its host token reaches the agent", async () => {
  const srv = start();
  try {
    assert.equal((await srv.put("connector-providers", HUDDLE)).status, 200);
    const cfg = (await (
      await fetch(`${srv.base}/v1/admin/scopes/org:default-org?view=connectors`, { headers: ADMIN })
    ).json()) as { connectorProviders: Array<{ provider: string; updatedBy: string }> };
    assert.deepEqual(
      cfg.connectorProviders.map((p) => [p.provider, p.updatedBy]),
      [["huddle", "admin-alice"]],
    );
    assert.ok(
      (await srv.built.auditLog.events()).some(
        (e) => e.action === "connector-provider.create" && e.resource === "huddle",
      ),
    );

    const listed = (await srv.catalog()).find((c) => c.provider === "huddle");
    assert.deepEqual([listed?.label, listed?.description, listed?.configured], ["Huddle", "Meetings", false]);

    const redirectUri = `${srv.base}/v1/connectors/oauth/huddle/callback`;
    assert.equal(
      (await srv.put("connectors", { provider: "huddle", clientId: "huddle-cid", clientSecret: "huddle-secret" }))
        .status,
      200,
    );
    assert.equal((await srv.catalog()).find((c) => c.provider === "huddle")?.configured, true);

    const started = (await (
      await fetch(
        `${srv.base}/v1/connectors/oauth/huddle/start?principalId=U1&redirectUri=${encodeURIComponent(redirectUri)}`,
      )
    ).json()) as { authorizeUrl: string; hosts: string[] };
    assert.deepEqual(started.hosts, ["api.huddle.example"]);
    const consent = new URL(started.authorizeUrl);
    assert.equal(`${consent.origin}${consent.pathname}`, "https://huddle.example/oauth/authorize");
    assert.equal(consent.searchParams.get("client_id"), "huddle-cid");

    const cb = await fetch(
      `${srv.base}/v1/connectors/oauth/huddle/callback?code=c0de&state=${encodeURIComponent(consent.searchParams.get("state")!)}`,
    );
    assert.equal(cb.status, 200);
    const call = srv.tokenCalls[0]!;
    assert.equal(call.url, "https://huddle.example/oauth/token");
    assert.equal(call.headers.authorization, `Basic ${Buffer.from("huddle-cid:huddle-secret").toString("base64")}`);
    assert.doesNotMatch(call.body, /huddle-secret/);
    assert.equal(await srv.built.connectorTokens.connectorAccessToken("api.huddle.example", "U1"), "huddle-access");

    const status = (await (await fetch(`${srv.base}/v1/connectors/oauth/status?principalId=U1`)).json()) as {
      providers: Record<string, { label: string; description?: string; connected: boolean }>;
    };
    assert.deepEqual(status.providers.huddle, {
      ...status.providers.huddle,
      label: "Huddle",
      description: "Meetings",
      connected: true,
    });
    await selectDefaultSandbox(srv.built, "U1", "personal:U1");
    assert.match((await srv.built.app.turn(dm("!sysprompt"))).reply ?? "", /connector:api\.huddle\.example:default/);
    const run = `!execute ${JSON.stringify({ command: `test "$VAULT_TOKEN_API_HUDDLE_EXAMPLE" = huddle-access && echo injected`, credentials: ["connector:api.huddle.example:default"] })}`;
    assert.equal((await srv.built.app.turn(dm(run))).reply, "injected");
  } finally {
    await srv.close();
  }
});

test("provider endpoints are fixed once saved, and deletion waits for the OAuth app then purges its tokens", async () => {
  const srv = start();
  try {
    await srv.put("connector-providers", HUDDLE);
    await srv.put("connectors", { provider: "huddle", clientId: "huddle-cid", clientSecret: "huddle-secret" });
    const refused = await srv.put("connector-providers", { provider: "huddle", delete: true });
    assert.equal(refused.status, 409);
    assert.match(await refused.text(), /remove the huddle OAuth app before deleting its provider/);

    const moved = await srv.put("connector-providers", { ...HUDDLE, tokenUrl: "https://elsewhere.example/token" });
    assert.equal(moved.status, 409);
    assert.match(await moved.text(), /authUrl, tokenUrl and hosts cannot change/);
    assert.equal((await srv.put("connector-providers", { ...HUDDLE, label: "Huddle Calls" })).status, 200);

    await srv.built.connectorTokens.setConnectorToken("api.huddle.example", "U1", { accessToken: "huddle-access" });
    await srv.built.connectorTokens.setConnectorToken("gmail.googleapis.com", "U1", { accessToken: "gmail-access" });
    assert.equal((await srv.put("connectors", { provider: "huddle", delete: true })).status, 200);
    assert.equal((await srv.put("connector-providers", { provider: "huddle", delete: true })).status, 200);
    assert.equal(await srv.built.connectorTokens.connectorAccessToken("api.huddle.example", "U1"), null);
    assert.equal(await srv.built.connectorTokens.connectorAccessToken("gmail.googleapis.com", "U1"), "gmail-access");
    assert.equal(
      (await srv.catalog()).some((c) => c.provider === "huddle"),
      false,
    );
    const startPath = `/v1/connectors/oauth/huddle/start?principalId=U1&redirectUri=${encodeURIComponent(`${srv.base}/cb`)}`;
    assert.equal((await fetch(`${srv.base}${startPath}`)).status, 404);
    assert.equal((await srv.put("connector-providers", { provider: "huddle", delete: true })).status, 404);
  } finally {
    await srv.close();
  }
});

test("an instance whose provider cache is stale re-reads stored providers before refusing a connection", async () => {
  const srv = start();
  try {
    await srv.put("connector-providers", HUDDLE);
    await srv.put("connectors", { provider: "huddle", clientId: "huddle-cid", clientSecret: "huddle-secret" });
    setStoredOAuthProviders([]);
    const startPath = `/v1/connectors/oauth/huddle/start?principalId=U1&redirectUri=${encodeURIComponent(`${srv.base}/cb`)}`;
    const started = await fetch(`${srv.base}${startPath}`);
    assert.equal(started.status, 200);
    assert.equal(new URL(((await started.json()) as { authorizeUrl: string }).authorizeUrl).host, "huddle.example");

    setStoredOAuthProviders([]);
    const refreshFetch: FetchLike = async (url) => {
      assert.equal(url, "https://huddle.example/oauth/token");
      return { ok: true, status: 200, json: async () => ({ access_token: "rotated", expires_in: 3600 }) };
    };
    const refresh = makeRefresh({ resolveClient: srv.built.resolveClient, fetchImpl: refreshFetch });
    const fresh = await refresh("api.huddle.example", { accessToken: "old", refreshToken: "huddle-refresh" });
    assert.equal(fresh.accessToken, "rotated");
  } finally {
    await srv.close();
  }
});

test("a provider list reload that read before a save cannot undo that save", async () => {
  const stored = createMemoryMap<StoredOAuthProvider>();
  let gate: Promise<void> | undefined;
  let release!: () => void;
  const config = createMemoryConfigStore("default-org", {
    connectorProviders: {
      ...stored,
      all: async () => {
        const snapshot = await stored.all();
        await gate;
        return snapshot;
      },
    },
  });
  try {
    gate = new Promise((r) => (release = r));
    const sweep = config.syncConnectorProviders();
    await new Promise((r) => setImmediate(r));
    gate = undefined;
    const save = config.setConnectorProvider(parseCustomOAuthProvider(HUDDLE) as StoredOAuthProvider, "admin-alice");
    await new Promise((r) => setImmediate(r));
    release();
    await Promise.all([sweep, save]);
    assert.equal(connectorProvider("huddle")?.label, "Huddle");
  } finally {
    setStoredOAuthProviders([]);
  }
});

test("provider definitions are validated before they are stored", async () => {
  const srv = start();
  try {
    const rejects = async (patch: object, message: RegExp) => {
      const res = await srv.put("connector-providers", { ...HUDDLE, ...patch });
      assert.equal(res.status, 400);
      assert.match(await res.text(), message);
    };
    await rejects({ authUrl: "http://huddle.us/oauth/authorize" }, /authUrl: must be an https URL/);
    await rejects({ hosts: ["https://api.huddle.example"] }, /hosts\.0: must be a bare hostname/);
    await rejects({ provider: "google" }, /already used by another connector/);
    await rejects({ provider: "Huddle!" }, /provider: must be 1-32 characters/);
    await rejects({ hosts: ["gmail.googleapis.com"] }, /overlap the google connector/);
    await rejects({ hosts: ["eu.api.zoom.us"] }, /overlap the zoom connector/);
    await rejects({ authUrl: "https://huddle.example/oauth/authorize?x=1" }, /must not carry a query string/);
    await rejects({ authParams: { state: "fixed" } }, /authParams: cannot set OAuth flow parameters/);
    await rejects({ scopeParam: "redirect_uri" }, /scopeParam: cannot set OAuth flow parameters/);
    await rejects({ hosts: ["localhost"] }, /hosts\.0: must be a bare hostname/);
    await rejects({ tokenUrl: "https://user:pw@huddle.example/token" }, /tokenUrl: must not carry credentials/);
    await rejects(
      { authUrl: "https://huddle.example/oauth/authorize#" },
      /authUrl: must not carry credentials or a fragment/,
    );
    assert.equal(
      (await srv.catalog()).some((c) => c.provider === "huddle"),
      false,
    );
    const channel = await fetch(`${srv.base}/v1/admin/scopes/channel:C1/connector-providers`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify(HUDDLE),
    });
    assert.equal(channel.status, 400);
    assert.equal(
      (await srv.put("connector-providers", { ...HUDDLE, docsUrl: "https://huddle.example/docs#oauth" })).status,
      200,
    );
  } finally {
    await srv.close();
  }
});
