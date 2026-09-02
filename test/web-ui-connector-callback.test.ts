import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "./support/portal-identity.ts";
import "./support/auto-fake-sprites.ts";

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { sealOAuthState } from "../src/connectors/oauth.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "web-ui-callback-secret".repeat(3);

let exchanges = 0;
const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "webui-cb-")) }));
const core = createServer(built.app, {
  signingSecret: SECRET,
  replayDedupe: built.replayDedupe,
  connectorTokens: built.connectorTokens,
  oauthEnv: { GOOGLE_OAUTH_CLIENT_ID: "gid", GOOGLE_OAUTH_CLIENT_SECRET: "gsecret" } as NodeJS.ProcessEnv,
  oauthFetch: async () => {
    exchanges += 1;
    return { ok: true, status: 200, json: async () => ({ access_token: "at-google" }) };
  },
  portalUrl: "http://web.test",
});
core.listen(0);
const corePort = (core.address() as AddressInfo).port;

process.env.CORE_API_URL = `http://localhost:${corePort}`;
process.env.CORE_SIGNING_SECRET = SECRET;
process.env.WEB_UI_PRINCIPALS = "";
const { handler } = await import("../plugins/web-ui/server/index.ts");
const web = createHttpServer(handler);
web.listen(0);
const webBase = `http://localhost:${(web.address() as AddressInfo).port}`;

after(async () => {
  await new Promise<void>((r) => web.close(() => r()));
  await new Promise<void>((r) => core.close(() => r()));
});

function identity(user: string, impersonator?: string): Record<string, string> {
  return {
    [PORTAL_IDENTITY_HEADER]: mintPortalIdentity(
      { p: user, exp: Date.now() + 60_000, ...(impersonator ? { imp: impersonator } : {}) },
      SECRET,
    ),
  };
}

async function callbackFor(principalId: string): Promise<string> {
  const state = await sealOAuthState(
    {
      nonce: randomUUID(),
      provider: "google",
      principalId,
      redirectUri: `${webBase}/v1/connectors/oauth/google/callback`,
      orgId: "default-org",
      returnTo: "/keychain",
    },
    { secret: SECRET },
  );
  return `${webBase}/v1/connectors/oauth/google/callback?code=code-1&state=${encodeURIComponent(state)}`;
}

test("the connector callback only completes for the signed-in principal it was minted for", async () => {
  const cb = await callbackFor("alice");

  const anonymous = await fetch(cb, { redirect: "manual" });
  assert.equal(anonymous.status, 400);
  assert.equal(exchanges, 0, "an unauthenticated browser must not spend the authorization");

  const stranger = await fetch(cb, { redirect: "manual", headers: identity("bob") });
  assert.equal(stranger.status, 400);
  assert.equal(exchanges, 0);
  assert.equal(await built.connectorTokens.connectorAccessToken("gmail.googleapis.com", "alice"), null);

  const owner = await fetch(cb, { redirect: "manual", headers: identity("alice") });
  assert.equal(owner.status, 200);
  assert.match(await owner.text(), /status=connected/);
  assert.equal(exchanges, 1);
  assert.equal(await built.connectorTokens.connectorAccessToken("gmail.googleapis.com", "alice"), "at-google");
});

test("an impersonating admin cannot start a connector flow in someone else's name", async () => {
  const res = await fetch(`${webBase}/api/connectors/google/start`, {
    method: "POST",
    headers: identity("alice", "admin"),
  });
  assert.equal(res.status, 403);
  assert.match(((await res.json()) as { message: string }).message, /stop impersonating/);
});

test("an impersonated browser cannot launder the marker away and bind a provider account", async () => {
  const spent = exchanges;
  const cb = await callbackFor("carol");
  const res = await fetch(cb, { redirect: "manual", headers: identity("carol", "admin") });
  assert.equal(res.status, 400);
  assert.equal(exchanges, spent, "an impersonated browser must not spend the authorization");
  assert.equal(await built.connectorTokens.connectorAccessToken("gmail.googleapis.com", "carol"), null);
});
