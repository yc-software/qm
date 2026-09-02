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
import { PROVIDERS, codeChallengeS256, type FetchLike } from "../src/connectors/oauth.ts";
import { testConfig } from "./support/test-config.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "./support/portal-identity.ts";

const SECRET = "oauth-route-test-secret".repeat(3);
const oauthEnv = {
  GOOGLE_OAUTH_CLIENT_ID: "gid",
  GOOGLE_OAUTH_CLIENT_SECRET: "gsecret",
  X_OAUTH_CLIENT_ID: "xid",
  X_OAUTH_CLIENT_SECRET: "xsecret",
} as NodeJS.ProcessEnv;

function finisher(principalId: string): Record<string, string> {
  return { [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: principalId, exp: Date.now() + 60_000 }, SECRET) };
}

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
    auditLog: built.auditLog,
    oauthEnv,
    oauthFetch: fetchImpl,
    portalUrl: "http://web.test",
    identity: built.identity,
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
    const anonymous = await fetch(`${srv.base}${callbackPath}`);
    assert.equal(anonymous.status, 400);
    assert.match(((await anonymous.json()) as { message: string }).message, /signed-in browser session/);

    const stranger = await fetch(`${srv.base}${callbackPath}`, { headers: finisher("U2") });
    assert.equal(stranger.status, 400);
    assert.match(((await stranger.json()) as { message: string }).message, /signed-in browser session/);
    assert.equal(exchanged, false, "a stranger's browser must not complete U1's connection");

    const callbackRes = await fetch(`${srv.base}${callbackPath}`, { headers: finisher("U1") });
    assert.equal(callbackRes.status, 200);
    assert.equal(exchanged, true);
    const replay = await fetch(`${srv.base}${callbackPath}`, { headers: finisher("U1") });
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

test("a PKCE flow never exposes the verifier to the user-agent and still exchanges it end to end", async () => {
  let sentVerifier = "";
  const fetchImpl: FetchLike = async (url, init) => {
    assert.equal(url, PROVIDERS.x!.tokenUrl);
    sentVerifier = new URLSearchParams(init.body).get("code_verifier") ?? "";
    return { ok: true, status: 200, json: async () => ({ access_token: "at-x", expires_in: 7200 }) };
  };

  const srv = start(fetchImpl);
  try {
    const redirectUri = `${srv.base}/v1/connectors/oauth/x/callback`;
    const startPath = `/v1/connectors/oauth/x/start?principalId=U1&redirectUri=${encodeURIComponent(redirectUri)}`;
    const startRes = await fetch(`${srv.base}${startPath}`, { headers: sign("GET", startPath) });
    assert.equal(startRes.status, 200);
    const consent = new URL(((await startRes.json()) as { authorizeUrl: string }).authorizeUrl);
    const state = consent.searchParams.get("state") ?? "";
    const challenge = consent.searchParams.get("code_challenge") ?? "";
    assert.ok(state && challenge, "the authorize URL carries both state and challenge");

    const payload = Buffer.from(state.split(".")[1]!, "base64url").toString("utf8");
    const claims = JSON.parse(payload) as Record<string, unknown>;
    for (const [name, value] of [...Object.entries(claims), ...consent.searchParams]) {
      if (typeof value !== "string") continue;
      assert.notEqual(
        codeChallengeS256(value),
        challenge,
        `the URL the browser follows must not carry the verifier — "${name}" is it in plain sight`,
      );
    }

    const callbackPath = `/v1/connectors/oauth/x/callback?code=code-x&state=${encodeURIComponent(state)}`;
    assert.equal((await fetch(`${srv.base}${callbackPath}`, { headers: finisher("U1") })).status, 200);
    assert.equal(codeChallengeS256(sentVerifier), challenge, "the exchange sends the verifier behind that challenge");
    assert.ok(!payload.includes(sentVerifier), "the state the user-agent carries is free of the verifier at any depth");
    assert.equal(await srv.built.connectorTokens.connectorAccessToken("api.x.com", "U1"), "at-x");
  } finally {
    await srv.close();
  }
});

test("an impersonated browser cannot finish a connection the impersonated user started", async () => {
  let exchanged = false;
  const srv = start(async () => {
    exchanged = true;
    return { ok: true, status: 200, json: async () => ({ access_token: "at" }) };
  });
  try {
    const redirectUri = `${srv.base}/v1/connectors/oauth/google/callback`;
    const startPath = `/v1/connectors/oauth/google/start?principalId=U1&redirectUri=${encodeURIComponent(redirectUri)}`;
    const startBody = (await (await fetch(`${srv.base}${startPath}`, { headers: sign("GET", startPath) })).json()) as {
      authorizeUrl: string;
    };
    const state = new URL(startBody.authorizeUrl).searchParams.get("state") ?? "";
    const cb = `/v1/connectors/oauth/google/callback?code=c&state=${encodeURIComponent(state)}`;

    const impersonated = {
      [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "U1", imp: "admin", exp: Date.now() + 60_000 }, SECRET),
    };
    const res = await fetch(`${srv.base}${cb}`, { headers: impersonated });
    assert.equal(res.status, 400, "an admin impersonating U1 must not bind a provider account to U1");
    assert.match(((await res.json()) as { message: string }).message, /stop impersonating/);
    assert.equal(exchanged, false, "the token exchange must not run for an impersonated finisher");

    assert.equal(
      (await fetch(`${srv.base}${cb}`, { headers: finisher("U1") })).status,
      200,
      "the real signed-in owner still completes the flow",
    );
  } finally {
    await srv.close();
  }
});

test("a principal who left the workspace cannot finish a connection started before departure", async () => {
  let exchanged = false;
  const srv = start(async () => {
    exchanged = true;
    return { ok: true, status: 200, json: async () => ({ access_token: "at-google" }) };
  });
  try {
    const redirectUri = `${srv.base}/v1/connectors/oauth/google/callback`;
    const startPath = `/v1/connectors/oauth/google/start?principalId=U9&redirectUri=${encodeURIComponent(redirectUri)}`;
    const startRes = await fetch(`${srv.base}${startPath}`, { headers: sign("GET", startPath) });
    assert.equal(startRes.status, 200);
    const state = new URL(((await startRes.json()) as { authorizeUrl: string }).authorizeUrl).searchParams.get("state");
    assert.ok(state);

    await srv.built.identity.deactivate("U9");

    const callbackPath = `/v1/connectors/oauth/google/callback?code=code-9&state=${encodeURIComponent(state)}`;
    const res = await fetch(`${srv.base}${callbackPath}`, { headers: finisher("U9") });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { message: string }).message, /no longer active/);
    assert.equal(exchanged, false, "a departed principal must not spend the authorization");
    assert.equal(await srv.built.connectorTokens.connectorAccessToken("gmail.googleapis.com", "U9"), null);
  } finally {
    await srv.close();
  }
});
