import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { mintSignedPayload } from "../src/auth/signed-token.ts";
import { codeChallengeS256, PROVIDERS, type FetchLike } from "../src/connectors/oauth.ts";
import { createOAuthFlowStore, type OAuthFlowContext } from "../src/connectors/oauth-flow.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "oauth-route-test-secret".repeat(3);
const oauthEnv = {
  GOOGLE_OAUTH_CLIENT_ID: "gid",
  GOOGLE_OAUTH_CLIENT_SECRET: "gsecret",
  X_OAUTH_CLIENT_ID: "xid",
  X_OAUTH_CLIENT_SECRET: "xsecret",
} as NodeJS.ProcessEnv;

function sign(method: string, pathWithQuery: string, body = ""): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000);
  return {
    "content-type": "application/json",
    "x-timestamp": String(ts),
    "x-signature": signRequest(SECRET, ts, `${method}\n${pathWithQuery}\n${body}`),
  };
}

function start(fetchImpl: FetchLike): { base: string; built: BuiltApp; close: () => Promise<void> } {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "oauth-routes-")),
    }),
  );
  const server = createServer(built.app, {
    signingSecret: SECRET,
    replayDedupe: built.replayDedupe,
    connectorTokens: built.connectorTokens,
    oauthFlows: createOAuthFlowStore(createMemoryMap<OAuthFlowContext>()),
    auditLog: built.auditLog,
    oauthEnv,
    oauthFetch: fetchImpl,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("OAuth start, unsigned callback, status, and revoke are principal-bound", async () => {
  let exchanged = false;
  const fetchImpl: FetchLike = async (url, init) => {
    exchanged = true;
    assert.equal(url, PROVIDERS.google!.tokenUrl);
    assert.match(init.body, /grant_type=authorization_code/);
    assert.match(init.body, /code=code-123/);
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: "at-google", refresh_token: "rt-google", expires_in: 3600 }),
    };
  };

  const srv = start(fetchImpl);
  try {
    const redirectUri = `${srv.base}/v1/connectors/oauth/google/callback`;
    const startPath = `/v1/connectors/oauth/google/start?principalId=U1&redirectUri=${encodeURIComponent(redirectUri)}`;
    const startRes = await fetch(`${srv.base}${startPath}`, { headers: sign("GET", startPath) });
    assert.equal(startRes.status, 200);
    const startBody = (await startRes.json()) as { authorizeUrl: string; hosts: string[] };
    assert.deepEqual(startBody.hosts, PROVIDERS.google!.hosts);
    const consent = new URL(startBody.authorizeUrl);
    const state = consent.searchParams.get("state");
    assert.ok(state);
    assert.equal(consent.searchParams.get("client_id"), "gid");

    const callbackPath = `/v1/connectors/oauth/google/callback?code=code-123&state=${encodeURIComponent(state)}`;
    const callbackRes = await fetch(`${srv.base}${callbackPath}`);
    assert.equal(callbackRes.status, 200);
    assert.equal(exchanged, true);
    const replay = await fetch(`${srv.base}${callbackPath}`);
    assert.equal(replay.status, 400);
    assert.match(((await replay.json()) as { message: string }).message, /already used/);
    assert.equal(await srv.built.connectorTokens.connectorAccessToken("gmail.googleapis.com", "U1"), "at-google");
    assert.equal(await srv.built.connectorTokens.connectorAccessToken("gmail.googleapis.com", "U2"), null);

    const statusPath = "/v1/connectors/oauth/status?principalId=U1";
    const statusRes = await fetch(`${srv.base}${statusPath}`, { headers: sign("GET", statusPath) });
    assert.equal(statusRes.status, 200);
    const statusBody = await statusRes.text();
    assert.match(statusBody, /"google"/);
    assert.match(statusBody, /"connected":true/);
    assert.doesNotMatch(statusBody, /at-google|rt-google/);

    const revokeBody = JSON.stringify({ principalId: "U1", provider: "google" });
    const revokeRes = await fetch(`${srv.base}/v1/connectors/oauth/revoke`, {
      method: "POST",
      headers: sign("POST", "/v1/connectors/oauth/revoke", revokeBody),
      body: revokeBody,
    });
    assert.equal(revokeRes.status, 200);
    assert.equal(await srv.built.connectorTokens.connectorAccessToken("gmail.googleapis.com", "U1"), null);
  } finally {
    await srv.close();
  }
});

test("revoke clears a connector linked under a non-default account type", async () => {
  const srv = start(async () => {
    throw new Error("no token exchange expected");
  });
  try {
    await srv.built.connectorTokens.setConnectorToken(
      "gmail.googleapis.com",
      "U1",
      { accessToken: "at-company", expiresAt: Date.now() + 3_600_000 },
      "company",
    );

    const statusPath = "/v1/connectors/oauth/status?principalId=U1";
    const before = (await (await fetch(`${srv.base}${statusPath}`, { headers: sign("GET", statusPath) })).json()) as {
      providers: Record<string, { connected?: boolean }>;
    };
    assert.equal(before.providers.google?.connected, true);

    const revokeBody = JSON.stringify({ principalId: "U1", provider: "google" });
    const revokeRes = await fetch(`${srv.base}/v1/connectors/oauth/revoke`, {
      method: "POST",
      headers: sign("POST", "/v1/connectors/oauth/revoke", revokeBody),
      body: revokeBody,
    });
    assert.equal(revokeRes.status, 200);

    assert.equal(await srv.built.connectorTokens.connectorAccessToken("gmail.googleapis.com", "U1", "company"), null);
    const after = (await (await fetch(`${srv.base}${statusPath}`, { headers: sign("GET", statusPath) })).json()) as {
      providers: Record<string, { connected?: boolean }>;
    };
    assert.equal(after.providers.google?.connected, false);
  } finally {
    await srv.close();
  }
});

test("OAuth status reports expired non-refreshable connectors as reconnect-needed", async () => {
  const srv = start(async () => {
    throw new Error("no token exchange expected");
  });
  try {
    await srv.built.connectorTokens.setConnectorToken("slack.com", "U1", { accessToken: "stale-slack", expiresAt: 1 });

    const statusPath = "/v1/connectors/oauth/status?principalId=U1";
    const statusRes = await fetch(`${srv.base}${statusPath}`, { headers: sign("GET", statusPath) });
    assert.equal(statusRes.status, 200);
    const status = (await statusRes.json()) as {
      providers: Record<string, { connected?: boolean; needsReconnect?: boolean }>;
    };
    assert.equal(status.providers.slack?.connected, false);
    assert.equal(status.providers.slack?.needsReconnect, true);
  } finally {
    await srv.close();
  }
});

test("OAuth callback rejects forged state even without source-auth", async () => {
  const srv = start(async () => {
    throw new Error("must not exchange forged state");
  });
  try {
    const res = await fetch(`${srv.base}/v1/connectors/oauth/google/callback?code=abc&state=forged`);
    assert.equal(res.status, 400);
    assert.match(await res.text(), /oauth_callback_failed/);
  } finally {
    await srv.close();
  }
});

test("OAuth callback accepts and replay-protects an in-flight legacy signed state", async () => {
  const srv = start(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ access_token: "at-legacy", refresh_token: "rt-legacy", expires_in: 3600 }),
  }));
  try {
    const state = await mintSignedPayload(
      {
        provider: "google",
        principalId: "U-LEGACY",
        redirectUri: `${srv.base}/v1/connectors/oauth/google/callback`,
        orgId: "default-org",
        clientRef: "env:google",
        issuedAt: Date.now(),
        nonce: "legacy-rollout-nonce",
      },
      SECRET,
    );
    const callbackPath = `/v1/connectors/oauth/google/callback?code=legacy-code&state=${encodeURIComponent(state)}`;
    assert.equal((await fetch(`${srv.base}${callbackPath}`)).status, 200);
    const replay = await fetch(`${srv.base}${callbackPath}`);
    assert.equal(replay.status, 400);
    assert.match(await replay.text(), /already used/);
  } finally {
    await srv.close();
  }
});

test("provider denial consumes the durable OAuth flow", async () => {
  const srv = start(async () => {
    throw new Error("denied flow must not exchange");
  });
  try {
    const redirectUri = `${srv.base}/v1/connectors/oauth/google/callback`;
    const startPath = `/v1/connectors/oauth/google/start?principalId=U1&redirectUri=${encodeURIComponent(redirectUri)}`;
    const started = (await (await fetch(`${srv.base}${startPath}`, { headers: sign("GET", startPath) })).json()) as {
      authorizeUrl: string;
    };
    const state = new URL(started.authorizeUrl).searchParams.get("state") ?? "";
    const deniedPath = `/v1/connectors/oauth/google/callback?error=access_denied&state=${encodeURIComponent(state)}`;
    const denied = await fetch(`${srv.base}${deniedPath}`);
    assert.equal(denied.status, 400);
    assert.match(await denied.text(), /oauth_denied/);

    const replayPath = `/v1/connectors/oauth/google/callback?code=fake&state=${encodeURIComponent(state)}`;
    const replay = await fetch(`${srv.base}${replayPath}`);
    assert.equal(replay.status, 400);
    assert.match(await replay.text(), /already used/);
  } finally {
    await srv.close();
  }
});

test("OAuth starts fail closed when durable flow storage is unavailable", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "oauth-no-db-")) }));
  assert.equal(built.oauthFlows, undefined);
  const server = createServer(built.app, {
    signingSecret: SECRET,
    replayDedupe: built.replayDedupe,
    connectorTokens: built.connectorTokens,
    oauthEnv,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const redirectUri = `${base}/v1/connectors/oauth/google/callback`;
    const startPath = `/v1/connectors/oauth/google/start?principalId=U1&redirectUri=${encodeURIComponent(redirectUri)}`;
    const response = await fetch(`${base}${startPath}`, { headers: sign("GET", startPath) });
    assert.equal(response.status, 501);
    assert.match(await response.text(), /durable OAuth flow store not wired/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("OAuth callback rejects a client ID change during the flow", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "oauth-client-change-")) }));
  const oauthFlows = createOAuthFlowStore(createMemoryMap<OAuthFlowContext>());
  let clientId = "client-before";
  let exchanged = false;
  const server = createServer(built.app, {
    signingSecret: SECRET,
    replayDedupe: built.replayDedupe,
    connectorTokens: built.connectorTokens,
    oauthFlows,
    resolveClient: async () => ({ id: clientId, secret: "client-secret", clientRef: "org:default-org:google" }),
    oauthFetch: async () => {
      exchanged = true;
      return { ok: true, status: 200, json: async () => ({ access_token: "must-not-store" }) };
    },
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const redirectUri = `${base}/v1/connectors/oauth/google/callback`;
    const startPath = `/v1/connectors/oauth/google/start?principalId=U1&redirectUri=${encodeURIComponent(redirectUri)}`;
    const started = (await (await fetch(`${base}${startPath}`, { headers: sign("GET", startPath) })).json()) as {
      authorizeUrl: string;
    };
    const state = new URL(started.authorizeUrl).searchParams.get("state") ?? "";
    clientId = "client-after";
    const callback = await fetch(
      `${base}/v1/connectors/oauth/google/callback?code=code&state=${encodeURIComponent(state)}`,
    );
    assert.equal(callback.status, 400);
    assert.match(await callback.text(), /OAuth client changed during flow/);
    assert.equal(exchanged, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("X receives provider-safe state while PKCE survives the server-side flow", async () => {
  let exchangeBody = "";
  const srv = start(async (url, init) => {
    assert.equal(url, PROVIDERS.x!.tokenUrl);
    exchangeBody = init.body;
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: "at-x", refresh_token: "rt-x", expires_in: 7200 }),
    };
  });
  try {
    const principalId = "person@example.comxx";
    const redirectUri = "https://prefix-portal.fly.dev/v1/connectors/oauth/x/callback";
    const startPath = `/v1/connectors/oauth/x/start?principalId=${encodeURIComponent(principalId)}&redirectUri=${encodeURIComponent(redirectUri)}&returnTo=%2Fconnectors`;
    const startRes = await fetch(`${srv.base}${startPath}`, { headers: sign("GET", startPath) });
    assert.equal(startRes.status, 200);
    const consent = new URL(((await startRes.json()) as { authorizeUrl: string }).authorizeUrl);
    const state = consent.searchParams.get("state") ?? "";
    const challenge = consent.searchParams.get("code_challenge") ?? "";
    assert.equal(state.length, 43);
    assert.ok(state.length < 500);
    assert.equal(consent.searchParams.get("code_challenge_method"), "S256");

    const callbackPath = `/v1/connectors/oauth/x/callback?code=code-x&state=${encodeURIComponent(state)}`;
    const callbackRes = await fetch(`${srv.base}${callbackPath}`, { redirect: "manual" });
    assert.equal(callbackRes.status, 302);
    const verifier = new URLSearchParams(exchangeBody).get("code_verifier") ?? "";
    assert.equal(codeChallengeS256(verifier), challenge);
    assert.equal(await srv.built.connectorTokens.connectorAccessToken("api.x.com", principalId), "at-x");
  } finally {
    await srv.close();
  }
});

test("connector token route normalizes expiry seconds before storing", async () => {
  const srv = start(async () => {
    throw new Error("token route must not call OAuth exchange");
  });
  try {
    const expiresAtMs = Math.floor((Date.now() + 3_600_000) / 1000) * 1000;
    const body = JSON.stringify({
      host: "api.example.test",
      principalId: "U1",
      accessToken: "at-route",
      expiresAt: expiresAtMs / 1000,
    });
    const res = await fetch(`${srv.base}/v1/connectors/token`, {
      method: "POST",
      headers: sign("POST", "/v1/connectors/token", body),
      body,
    });
    assert.equal(res.status, 200);
    const status = await srv.built.connectorTokens.connectorTokenStatus("api.example.test", "U1");
    assert.equal(status.connected, true);
    assert.equal(status.expiresAt, expiresAtMs);
  } finally {
    await srv.close();
  }
});
