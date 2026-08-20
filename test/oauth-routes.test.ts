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
import { scopeId } from "../src/types.ts";
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

test("a first Google connection is classified and stored without another setup choice", async () => {
  const payload = Buffer.from(JSON.stringify({ email: "alex@example.com", hd: "example.com" })).toString(
    "base64url",
  );
  const srv = start(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ access_token: "at-company", refresh_token: "rt-company", id_token: `e30.${payload}.sig` }),
  }));
  try {
    await srv.built.connectorTokens.setConnectorToken("gmail.googleapis.com", "U1", {
      accessToken: "old-default",
    });
    const legacy = (await srv.built.keychain!.listConnectorsByOwners(["U1"])).get("U1")![0]!;
    const grant = await srv.built.keychain!.createGrant({
      credentialId: legacy.credentialId,
      ownerId: "U1",
      audienceScopeId: scopeId("channel", "C1"),
      mode: "standing",
      purpose: "preserve existing Google automation",
    });
    const redirectUri = `${srv.base}/v1/connectors/oauth/google/callback`;
    const startPath = `/v1/connectors/oauth/google/start?principalId=U1&redirectUri=${encodeURIComponent(redirectUri)}`;
    const startBody = (await (await fetch(`${srv.base}${startPath}`, { headers: sign("GET", startPath) })).json()) as {
      authorizeUrl: string;
    };
    const state = new URL(startBody.authorizeUrl).searchParams.get("state");
    assert.ok(state);

    const callback = await fetch(
      `${srv.base}/v1/connectors/oauth/google/callback?code=code-company&state=${encodeURIComponent(state)}`,
    );

    assert.equal(callback.status, 200);
    assert.equal(
      await srv.built.connectorTokens.connectorAccessToken("gmail.googleapis.com", "U1", "company"),
      "at-company",
    );
    assert.equal(await srv.built.connectorTokens.connectorAccessToken("gmail.googleapis.com", "U1"), "at-company");
    assert.equal((await srv.built.keychain!.getGrant(grant.id))?.status, "active");
  } finally {
    await srv.close();
  }
});

test("reconnecting the primary Google account refreshes its retained alias and grants", async () => {
  const payload = Buffer.from(JSON.stringify({ email: "alex@example.com", hd: "example.com" })).toString(
    "base64url",
  );
  const srv = start(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      access_token: "fresh-company",
      refresh_token: "fresh-refresh",
      id_token: `e30.${payload}.sig`,
    }),
  }));
  try {
    const stale = { accessToken: "stale-company", expiresAt: 1, accountType: "company" as const };
    await srv.built.connectorTokens.setConnectorToken("gmail.googleapis.com", "U1", stale, "default");
    const primaryId = (await srv.built.keychain!.listConnectorsByOwners(["U1"])).get("U1")![0]!.credentialId;
    await srv.built.connectorTokens.setConnectorToken("gmail.googleapis.com", "U1", stale, "company");
    const grant = await srv.built.keychain!.createGrant({
      credentialId: primaryId,
      ownerId: "U1",
      audienceScopeId: scopeId("channel", "C1"),
      mode: "standing",
      purpose: "keep primary Google automation current",
    });
    const redirectUri = `${srv.base}/v1/connectors/oauth/google/callback`;
    const startPath = `/v1/connectors/oauth/google/start?principalId=U1&redirectUri=${encodeURIComponent(redirectUri)}&accountType=company`;
    const startBody = (await (await fetch(`${srv.base}${startPath}`, { headers: sign("GET", startPath) })).json()) as {
      authorizeUrl: string;
    };
    const state = new URL(startBody.authorizeUrl).searchParams.get("state");
    assert.ok(state);
    const callback = await fetch(
      `${srv.base}/v1/connectors/oauth/google/callback?code=reconnect&state=${encodeURIComponent(state)}`,
    );

    assert.equal(callback.status, 200);
    assert.equal(await srv.built.connectorTokens.connectorAccessToken("gmail.googleapis.com", "U1"), "fresh-company");
    assert.equal((await srv.built.keychain!.getGrant(grant.id))?.status, "active");
    const materialized = await srv.built.keychain!.materializeStanding(scopeId("channel", "C1"));
    assert.equal(materialized.length, 1);
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

test("revoke can disconnect one Google account without removing the other", async () => {
  const srv = start(async () => {
    throw new Error("no token exchange expected");
  });
  try {
    await srv.built.connectorTokens.setConnectorToken(
      "gmail.googleapis.com",
      "U1",
      { accessToken: "at-company", accountType: "company" },
      "company",
    );
    await srv.built.connectorTokens.setConnectorToken(
      "gmail.googleapis.com",
      "U1",
      { accessToken: "at-personal", accountType: "personal" },
      "personal",
    );
    await srv.built.connectorTokens.setConnectorToken("gmail.googleapis.com", "U1", {
      accessToken: "at-personal",
      accountType: "personal",
    });

    const revokeBody = JSON.stringify({ principalId: "U1", provider: "google", accountType: "personal" });
    const revokeRes = await fetch(`${srv.base}/v1/connectors/oauth/revoke`, {
      method: "POST",
      headers: sign("POST", "/v1/connectors/oauth/revoke", revokeBody),
      body: revokeBody,
    });

    assert.equal(revokeRes.status, 200);
    assert.equal(await srv.built.connectorTokens.connectorAccessToken("gmail.googleapis.com", "U1", "personal"), null);
    assert.equal(await srv.built.connectorTokens.connectorAccessToken("gmail.googleapis.com", "U1"), null);
    assert.equal(
      await srv.built.connectorTokens.connectorAccessToken("gmail.googleapis.com", "U1", "company"),
      "at-company",
    );
  } finally {
    await srv.close();
  }
});

test("account-specific revoke is rejected for non-Google providers", async () => {
  const srv = start(async () => {
    throw new Error("no token exchange expected");
  });
  try {
    await srv.built.connectorTokens.setConnectorToken("api.github.com", "U1", { accessToken: "github-token" });
    const body = JSON.stringify({ principalId: "U1", provider: "github", accountType: "personal" });
    const response = await fetch(`${srv.base}/v1/connectors/oauth/revoke`, {
      method: "POST",
      headers: sign("POST", "/v1/connectors/oauth/revoke", body),
      body,
    });

    assert.equal(response.status, 400);
    assert.equal(await srv.built.connectorTokens.connectorAccessToken("api.github.com", "U1"), "github-token");
  } finally {
    await srv.close();
  }
});

test("host-scoped Google revoke removes a matching retained primary alias", async () => {
  const srv = start(async () => {
    throw new Error("no token exchange expected");
  });
  try {
    const token = { accessToken: "company-token", accountType: "company" as const };
    await srv.built.connectorTokens.setConnectorToken("gmail.googleapis.com", "U1", token, "company");
    await srv.built.connectorTokens.setConnectorToken("gmail.googleapis.com", "U1", token, "default");
    const body = JSON.stringify({ principalId: "U1", host: "gmail.googleapis.com", accountType: "company" });
    const response = await fetch(`${srv.base}/v1/connectors/oauth/revoke`, {
      method: "POST",
      headers: sign("POST", "/v1/connectors/oauth/revoke", body),
      body,
    });

    assert.equal(response.status, 200);
    assert.equal(await srv.built.connectorTokens.connectorAccessToken("gmail.googleapis.com", "U1", "company"), null);
    assert.equal(await srv.built.connectorTokens.connectorAccessToken("gmail.googleapis.com", "U1"), null);
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
