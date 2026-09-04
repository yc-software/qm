import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { PROVIDERS, openOAuthState, type FetchLike } from "../src/connectors/oauth.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import {
  mintCapabilityToken,
  CAPABILITY_TTL_MS,
  OAUTH_CONSENT_AUD,
  CONTROL_PLANE_AUD,
} from "../src/auth/capability-token.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "consent-bridge-secret".repeat(3);
const oauthEnv = { GOOGLE_OAUTH_CLIENT_ID: "gid", GOOGLE_OAUTH_CLIENT_SECRET: "gsecret" } as NodeJS.ProcessEnv;

function start(
  fetchImpl: FetchLike,
  opts: { portalUrl?: string } = { portalUrl: "http://callback.test" },
): { base: string; built: BuiltApp; close: () => Promise<void> } {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "consent-")), signingSecret: SECRET }));
  void built.directory.replaceChannels(
    [
      { channelId: "C1", name: "consent", isPrivate: false },
      { channelId: "C9", name: "connectors", isPrivate: false },
    ],
    [
      { channelId: "C1", principalId: "U1" },
      { channelId: "C9", principalId: "U1" },
    ],
  );
  const server = createServer(built.app, {
    signingSecret: SECRET,
    replayDedupe: built.replayDedupe,
    connectorTokens: built.connectorTokens,
    keychain: built.keychain,
    consentLinks: built.consentLinks,
    auditLog: built.auditLog,
    oauthEnv,
    oauthFetch: fetchImpl,
    publicUrl: "http://callback.test",
    ...(opts.portalUrl ? { portalUrl: opts.portalUrl } : {}),
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const consentTok = async (actorId: string, opts: { scopeId?: string } = {}) => {
  return await mintCapabilityToken(
    {
      actorId,
      scopeId: opts.scopeId ?? `personal:${actorId}`,
      aud: OAUTH_CONSENT_AUD,
      exp: Date.now() + CAPABILITY_TTL_MS,
    },
    SECRET,
  );
};
const controlTok = async (actorId: string) =>
  await mintCapabilityToken(
    { actorId, scopeId: `personal:${actorId}`, aud: CONTROL_PLANE_AUD, exp: Date.now() + CAPABILITY_TTL_MS },
    SECRET,
  );

const coreRedeemPath = (connectPath: string): string =>
  connectPath.replace(/^\/connect\/redeem\//, "/v1/connectors/oauth/consent/redeem/");

function redeem(base: string, path: string, clicker?: string): Promise<Response> {
  const ts = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = {
    "x-timestamp": String(ts),
    "x-signature": signRequest(SECRET, ts, `GET\n${path}\n`),
    ...(clicker ? { "x-consent-clicker": clicker } : {}),
  };
  return fetch(`${base}${path}`, { headers });
}

async function mint(base: string, cap: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/v1/connectors/oauth/consent/mint`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agent-capability": cap },
    body: JSON.stringify(body),
  });
}

test("mint → intended teammate redeems → callback connects them; the link is then single-use", async () => {
  let exchanged = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    exchanged++;
    assert.equal(url, PROVIDERS.google!.tokenUrl);
    assert.match(init.body, /grant_type=authorization_code/);
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: "at-google", refresh_token: "rt", expires_in: 3600 }),
    };
  };
  const srv = start(fetchImpl);
  try {
    const mintRes = await mint(srv.base, await consentTok("U1"), { provider: "google" });
    assert.equal(mintRes.status, 200);
    const { connectPath, connectUrl } = (await mintRes.json()) as { connectPath: string; connectUrl: string };
    assert.match(connectPath, /^\/connect\/redeem\//);
    assert.equal(connectUrl, `http://callback.test${connectPath}`);

    const res = await redeem(srv.base, coreRedeemPath(connectPath), "U1");
    assert.equal(res.status, 200);
    const decision = (await res.json()) as { status: string; authorizeUrl: string };
    assert.equal(decision.status, "authorize");
    const consent = new URL(decision.authorizeUrl);
    assert.equal(consent.origin + consent.pathname, PROVIDERS.google!.authUrl);
    assert.equal(consent.searchParams.get("client_id"), "gid");
    const state = await openOAuthState(consent.searchParams.get("state") ?? "", { secret: SECRET });
    assert.equal(state.principalId, "U1");
    assert.equal(state.orgId, "default-org");

    const second = await redeem(srv.base, coreRedeemPath(connectPath), "U1");
    assert.equal(
      ((await second.json()) as { status: string }).status,
      "authorize",
      "a re-click before the user finishes Google still mints",
    );

    const cb = `/v1/connectors/oauth/google/callback?code=code-1&state=${encodeURIComponent(consent.searchParams.get("state") ?? "")}`;
    const cbRes = await fetch(`${srv.base}${cb}`, { redirect: "manual" });
    assert.equal(cbRes.status, 302);
    assert.match(cbRes.headers.get("location") ?? "", /^\/connectors\?connector=google&status=connected/);
    assert.equal(exchanged, 1);
    assert.equal(await srv.built.connectorTokens.connectorAccessToken("gmail.googleapis.com", "U1"), "at-google");

    const third = await redeem(srv.base, coreRedeemPath(connectPath), "U1");
    assert.equal(
      ((await third.json()) as { status: string }).status,
      "invalid",
      "the link is consumed once the connection completes",
    );
  } finally {
    await srv.close();
  }
});

test("redeem refuses without a verified clicker (the portal's session gate)", async () => {
  const srv = start(async () => {
    throw new Error("must not exchange");
  });
  try {
    const mintRes = await mint(srv.base, await consentTok("U1"), { provider: "google" });
    const { connectPath } = (await mintRes.json()) as { connectPath: string };
    const res = await redeem(srv.base, coreRedeemPath(connectPath));
    assert.equal(res.status, 401);
  } finally {
    await srv.close();
  }
});

test("a wrong-recipient click is refused, leaves the link usable, and reports whether they're already connected", async () => {
  const fetchImpl: FetchLike = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ access_token: "at-google", refresh_token: "rt", expires_in: 3600 }),
  });
  const srv = start(fetchImpl, { portalUrl: "http://callback.test" });
  try {
    const cap = await consentTok("U1", { scopeId: "channel:C1" });
    const mintRes = await mint(srv.base, cap, { provider: "google", intendedPrincipalId: "U1" });
    const { connectPath } = (await mintRes.json()) as { connectPath: string };

    const wrong = (await (await redeem(srv.base, coreRedeemPath(connectPath), "U2")).json()) as {
      status: string;
      provider: string;
      clickerConnected: boolean;
    };
    assert.equal(wrong.status, "wrong_recipient");
    assert.equal(wrong.provider, "google");
    assert.equal(wrong.clickerConnected, false);

    await srv.built.connectorTokens.setConnectorToken("gmail.googleapis.com", "U2", {
      accessToken: "ya29.u2",
      expiresAt: Date.now() + 3_600_000,
    });
    const already = (await (await redeem(srv.base, coreRedeemPath(connectPath), "U2")).json()) as {
      status: string;
      clickerConnected: boolean;
    };
    assert.equal(already.status, "wrong_recipient");
    assert.equal(already.clickerConnected, true);

    const ok = (await (await redeem(srv.base, coreRedeemPath(connectPath), "U1")).json()) as { status: string };
    assert.equal(ok.status, "authorize");
  } finally {
    await srv.close();
  }
});

test("connecting from a channel never re-grants a previously private connector", async () => {
  const fetchImpl: FetchLike = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ access_token: "at-google", refresh_token: "rt", expires_in: 3600 }),
  });
  const srv = start(fetchImpl);
  try {
    const cap = await consentTok("U1", { scopeId: "channel:C9" });
    const mintRes = await mint(srv.base, cap, { provider: "google" });
    const { connectPath } = (await mintRes.json()) as { connectPath: string };
    const decision = (await (await redeem(srv.base, coreRedeemPath(connectPath), "U1")).json()) as {
      status: string;
      authorizeUrl: string;
    };
    assert.equal(decision.status, "authorize");
    const state = new URL(decision.authorizeUrl).searchParams.get("state") ?? "";
    const cb = `/v1/connectors/oauth/google/callback?code=code-1&state=${encodeURIComponent(state)}`;
    assert.equal((await fetch(`${srv.base}${cb}`, { redirect: "manual" })).status, 302);
    assert.equal(await srv.built.connectorTokens.connectorAccessToken("gmail.googleapis.com", "U1"), "at-google");
    assert.equal((await srv.built.keychain!.materializeStanding("channel:C9")).length, 0);
  } finally {
    await srv.close();
  }
});

test("mint refuses naming anyone but the actor, and points at the self-connect page", async () => {
  const srv = start(async () => {
    throw new Error("must not exchange");
  });
  try {
    const cap = await consentTok("U1", { scopeId: "channel:C1" });
    for (const who of ["U2", "outsider@x"]) {
      const res = await mint(srv.base, cap, { provider: "google", intendedPrincipalId: who });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { message: string };
      assert.match(body.message, /\/connect\/google\/self-connect/);
    }
  } finally {
    await srv.close();
  }
});

test("on an API-only host (no PUBLIC_WEB_URL) the callback does NOT default to the web UI — it falls through to JSON", async () => {
  const fetchImpl: FetchLike = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ access_token: "at-google", refresh_token: "rt", expires_in: 3600 }),
  });
  const srv = start(fetchImpl, {});
  try {
    const mintRes = await mint(srv.base, await consentTok("U1"), { provider: "google" });
    assert.equal(mintRes.status, 200);
    const { connectPath } = (await mintRes.json()) as { connectPath: string };
    const decision = (await (await redeem(srv.base, coreRedeemPath(connectPath), "U1")).json()) as {
      status: string;
      authorizeUrl: string;
    };
    const consent = new URL(decision.authorizeUrl);
    const cb = `/v1/connectors/oauth/google/callback?code=code-1&state=${encodeURIComponent(consent.searchParams.get("state") ?? "")}`;
    const cbRes = await fetch(`${srv.base}${cb}`, { redirect: "manual" });
    assert.equal(cbRes.status, 200);
    const body = (await cbRes.json()) as { ok: boolean; provider: string };
    assert.equal(body.ok, true);
    assert.equal(body.provider, "google");
  } finally {
    await srv.close();
  }
});

test("the consent-mint route rejects a control-plane / aud-less / missing token (the cross-onramp wall)", async () => {
  const srv = start(async () => {
    throw new Error("must not exchange");
  });
  try {
    const body = JSON.stringify({ provider: "google", redirectUri: `${srv.base}/cb` });
    const headers = (cap?: string) => ({
      "content-type": "application/json",
      ...(cap ? { "x-agent-capability": cap } : {}),
    });
    assert.equal(
      (
        await fetch(`${srv.base}/v1/connectors/oauth/consent/mint`, {
          method: "POST",
          headers: headers(await controlTok("U1")),
          body,
        })
      ).status,
      403,
    );
    const audless = await mintCapabilityToken(
      { actorId: "U1", scopeId: "personal:U1", exp: Date.now() + CAPABILITY_TTL_MS },
      SECRET,
    );
    assert.equal(
      (await fetch(`${srv.base}/v1/connectors/oauth/consent/mint`, { method: "POST", headers: headers(audless), body }))
        .status,
      403,
    );
    assert.equal(
      (await fetch(`${srv.base}/v1/connectors/oauth/consent/mint`, { method: "POST", headers: headers(), body }))
        .status,
      401,
    );
  } finally {
    await srv.close();
  }
});

test("an oauth-consent token cannot drive control-plane routes (crons)", async () => {
  const srv = start(async () => {
    throw new Error("must not exchange");
  });
  try {
    const res = await fetch(`${srv.base}/v1/crons`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-capability": await consentTok("U1") },
      body: JSON.stringify({ schedule: { everyMs: 1000 }, action: "x" }),
    });
    assert.equal(res.status, 403);
  } finally {
    await srv.close();
  }
});

test("mint refuses an unconfigured provider even when PUBLIC_WEB_URL is set", async () => {
  const srv = start(async () => {
    throw new Error("must not exchange");
  });
  try {
    const res = await mint(srv.base, await consentTok("U1"), { provider: "github" });
    assert.equal(res.status, 501);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "oauth_not_configured");
  } finally {
    await srv.close();
  }
});

test("an expired consent link reports an expiry status", async () => {
  const srv = start(async () => {
    throw new Error("must not exchange");
  });
  try {
    const { linkId } = await srv.built.consentLinks.mint(
      {
        principalId: "U1",
        provider: "google",
        accountType: "default",
        redirectUri: `${srv.base}/v1/connectors/oauth/google/callback`,
      },
      Date.now() - 25 * 60 * 60_000,
    );
    const res = await redeem(srv.base, `/v1/connectors/oauth/consent/redeem/${linkId}`, "U1");
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { status: string }).status, "expired");
  } finally {
    await srv.close();
  }
});
