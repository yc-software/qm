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
import { PROVIDERS, type FetchLike } from "../src/connectors/oauth.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "oauth-route-test-secret".repeat(3);
const oauthEnv = {
  GOOGLE_OAUTH_CLIENT_ID: "gid",
  GOOGLE_OAUTH_CLIENT_SECRET: "gsecret",
} as NodeJS.ProcessEnv;

function sign(method: string, pathWithQuery: string, body = ""): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000);
  return {
    "content-type": "application/json",
    "x-timestamp": String(ts),
    "x-signature": signRequest(SECRET, ts, `${method}\n${pathWithQuery}\n${body}`),
  };
}

function start(
  fetchImpl: FetchLike,
  opts: { oauthEnv?: NodeJS.ProcessEnv } = {},
): { base: string; built: BuiltApp; close: () => Promise<void> } {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "oauth-routes-")),
    }),
  );
  const server = createServer(built.app, {
    signingSecret: SECRET,
    replayDedupe: built.replayDedupe,
    connectorTokens: built.connectorTokens,
    oauthFlows: built.oauthFlows,
    auditLog: built.auditLog,
    oauthEnv: opts.oauthEnv ?? oauthEnv,
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
    assert.match(((await replay.json()) as { message: string }).message, /already used|invalid OAuth state/);
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

const X_ENV = { X_OAUTH_CLIENT_ID: "xid", X_OAUTH_CLIENT_SECRET: "xsecret" } as NodeJS.ProcessEnv;
const X_STATE_LIMIT = 500;

test("authorize state stays inside the tightest provider limit and still carries the PKCE verifier", async () => {
  let body = "";
  const srv = start(
    async (_url, init) => {
      body = init.body;
      return { ok: true, status: 200, json: async () => ({ access_token: "at-x", expires_in: 7200 }) };
    },
    { oauthEnv: X_ENV },
  );
  try {
    const redirectUri = "https://acme-portal.fly.dev/v1/connectors/oauth/x/callback";
    const query = `principalId=${encodeURIComponent("person@acme-corp.com")}&redirectUri=${encodeURIComponent(redirectUri)}&returnTo=${encodeURIComponent("/keychain")}`;
    const startPath = `/v1/connectors/oauth/x/start?${query}`;
    const startRes = await fetch(`${srv.base}${startPath}`, { headers: sign("GET", startPath) });
    assert.equal(startRes.status, 200);
    const consent = new URL(((await startRes.json()) as { authorizeUrl: string }).authorizeUrl);
    const state = consent.searchParams.get("state") ?? "";
    assert.ok(
      state.length <= X_STATE_LIMIT,
      `state is ${state.length} chars — X rejects authorize when state exceeds ${X_STATE_LIMIT}`,
    );
    assert.ok(consent.searchParams.get("code_challenge"));

    const callbackPath = `/v1/connectors/oauth/x/callback?code=code-x&state=${encodeURIComponent(state)}`;
    const cb = await fetch(`${srv.base}${callbackPath}`, { redirect: "manual" });
    assert.equal(cb.status, 302, await cb.text());
    assert.equal(cb.headers.get("location"), "/keychain?connector=x&status=connected");
    assert.match(body, /code_verifier=/);
    assert.equal(await srv.built.connectorTokens.connectorAccessToken("api.x.com", "person@acme-corp.com"), "at-x");
    const replayed = await fetch(`${srv.base}${callbackPath}`, { redirect: "manual" });
    assert.equal(replayed.status, 400, "the state is single-use");
  } finally {
    await srv.close();
  }
});
