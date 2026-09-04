import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { request as httpRequest, createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/api/app.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createDirectoryStore } from "../src/directory/directory-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { portalSessionSub } from "../src/deploy/viewer-session.ts";
import { scopeId } from "../src/types.ts";

const auditLog = { record() {}, events: async () => [], tail: async () => [] };
const SESSION_SECRET = "portal-session-secret";
const LOGIN_URL = "https://portal.example.com";

function mintPortalSession(sub: string, expInSeconds = 3600, secret = SESSION_SECRET): string {
  const key = createHmac("sha256", secret).update("portal.session.v1").digest();
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(
    JSON.stringify({ k: "session", sub, org: "acme", iat: now, exp: now + expInSeconds }),
  ).toString("base64url");
  const sig = createHmac("sha256", key).update(body).digest("base64url");
  return `${body}.${sig}`;
}

test("portalSessionSub: verifies, and rejects tampering, expiry, wrong kind, wrong secret", () => {
  const good = mintPortalSession("alice@example.com");
  assert.equal(portalSessionSub(`portal_session=${good}`, SESSION_SECRET), "alice@example.com");
  assert.equal(portalSessionSub(`other=1; portal_session=${good}; x=2`, SESSION_SECRET), "alice@example.com");
  assert.equal(portalSessionSub(`portal_session=${good}x`, SESSION_SECRET), null, "tampered signature");
  assert.equal(
    portalSessionSub(`portal_session=junk; portal_session=${good}`, SESSION_SECRET),
    "alice@example.com",
    "an app's junk same-named cookie cannot shadow the real session",
  );
  assert.equal(portalSessionSub(`portal_session=${good}`, "other-secret"), null, "wrong secret");
  assert.equal(
    portalSessionSub(`portal_session=${mintPortalSession("alice@example.com", -10)}`, SESSION_SECRET),
    null,
    "expired",
  );
  assert.equal(portalSessionSub(undefined, SESSION_SECRET), null);
  assert.equal(portalSessionSub("portal_session=", SESSION_SECRET), null);
  const key = createHmac("sha256", SESSION_SECRET).update("portal.session.v1").digest();
  const body = Buffer.from(
    JSON.stringify({ k: "impersonate", sub: "eve", exp: Math.floor(Date.now() / 1000) + 60 }),
  ).toString("base64url");
  const sig = createHmac("sha256", key).update(body).digest("base64url");
  assert.equal(portalSessionSub(`portal_session=${body}.${sig}`, SESSION_SECRET), null, "non-session claims");
});

function httpGet(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "localhost", port, path, method: "GET", headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function httpPost(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "localhost", port, path, method: "POST", headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("subdomain ingress: portal sign-in admits the owner, denies strangers, bounces the signed-out", async () => {
  let upstreamCookie: string | undefined = "unset";
  let upstreamUrl = "";
  const upstream = createHttpServer((req, res) => {
    upstreamCookie = req.headers.cookie as string | undefined;
    upstreamUrl = req.url ?? "";
    res.writeHead(200, {
      "content-type": "text/plain",
      "set-cookie": ["portal_session=evil; Domain=example.com; Path=/", "dpl_access=evil", "app_pref=ok"],
    });
    res.end("UPSTREAM OK");
  });
  upstream.listen(0);
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const deployStore = createDeployStore();
  const deploy = createDeployService({
    deployStore,
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: upstreamPort }),
      destroy: async () => {},
    },
    auditLog,
    acl: createAclStore(),
    deployDir: mkdtempSync(join(tmpdir(), "signin-")),
  });
  const app = createApp({
    deploy,
    acl: createAclStore(),
    directory: createDirectoryStore(),
    sessions: createMemorySessionStore(),
    identity: createIdentityService(),
  } as unknown as Parameters<typeof createApp>[0]);
  await app.deploy({
    ownerScopeId: scopeId("personal", "alice@example.com"),
    createdBy: "alice@example.com",
    entrypoint: "x",
    files: [],
    name: "mysite",
  });
  const deliveries: { destination: unknown; text: string; idempotencyKey: string }[] = [];
  (app as unknown as Record<string, unknown>).enqueueDelivery = async (input: (typeof deliveries)[number]) => {
    deliveries.push(input);
  };
  const server = createInsecureTestServer(app, {
    deployAppsDomain: "apps.example.com",
    deployGateSecret: "gate-secret",
    deployAppsSessionSecret: SESSION_SECRET,
    deployAppsLoginUrl: LOGIN_URL,
  });
  server.listen(0);
  const port = (server.address() as AddressInfo).port;
  const host = "mysite.apps.example.com";

  try {
    const browser = await httpGet(port, "/consultants?x=1", { Host: host, Accept: "text/html,*/*" });
    assert.equal(browser.status, 302, "signed-out browser is bounced to sign-in");
    assert.equal(
      browser.headers.location,
      `${LOGIN_URL}/auth/login?returnTo=${encodeURIComponent("https://mysite.apps.example.com/consultants?x=1&dpl_signin=1")}`,
    );

    const stillSignedOut = await httpGet(port, "/consultants?x=1&dpl_signin=1", { Host: host, Accept: "text/html" });
    assert.equal(
      stillSignedOut.status,
      401,
      "coming back from sign-in still signed-out is an error page, not another bounce",
    );
    assert.match(stillSignedOut.body, /Sign-in didn&#39;t reach this app|Sign-in didn't reach this app/);

    const xhr = await httpGet(port, "/api/data", { Host: host, Accept: "application/json" });
    assert.equal(xhr.status, 401, "a non-HTML request never gets a login redirect");
    assert.match(xhr.body, /loginUrl/, "…but is told where sign-in lives");

    const backFromLogin = await httpGet(port, "/consultants?x=1&dpl_signin=1", {
      Host: host,
      Accept: "text/html",
      Cookie: `portal_session=${mintPortalSession("alice@example.com")}`,
    });
    assert.equal(backFromLogin.status, 302, "landing back from sign-in redirects to the clean URL");
    assert.equal(backFromLogin.headers.location, "/consultants?x=1", "the dpl_signin marker leaves the address bar");

    const owner = await httpGet(port, "/consultants?x=1", {
      Host: host,
      Accept: "text/html",
      Cookie: `portal_session=${mintPortalSession("alice@example.com")}`,
    });
    assert.equal(owner.status, 200, "the signed-in owner reaches the app with no capability link");
    assert.equal(owner.body, "UPSTREAM OK");
    assert.equal(upstreamCookie, undefined, "the portal session cookie never reaches the app");
    assert.equal(upstreamUrl, "/consultants?x=1", "the app sees the clean URL");
    const ownerSetCookies = ([] as string[]).concat(owner.headers["set-cookie"] ?? []);
    assert.deepEqual(
      ownerSetCookies,
      ["app_pref=ok"],
      "an app cannot set or clear the gateway's cookies on the visitor",
    );

    const stranger = await httpGet(port, "/consultants", {
      Host: host,
      Accept: "text/html",
      Cookie: `portal_session=${mintPortalSession("mallory@example.com")}`,
    });
    assert.equal(stranger.status, 403, "a signed-in stranger is denied");
    assert.match(stranger.body, /hasn&#39;t been shared with you|hasn't been shared with you/);
    assert.match(String(stranger.headers["content-type"]), /text\/html/, "denial is a friendly page, not bare JSON");

    const strangerXhr = await httpGet(port, "/consultants", {
      Host: host,
      Accept: "application/json",
      Cookie: `portal_session=${mintPortalSession("mallory@example.com")}`,
    });
    assert.equal(strangerXhr.status, 403, "non-HTML denial stays JSON");

    assert.match(stranger.body, /Request access/, "the denial page offers a request-access button");
    const asked = await httpPost(port, "/__claw__/request-access", {
      Host: host,
      Cookie: `portal_session=${mintPortalSession("mallory@example.com")}`,
    });
    assert.equal(asked.status, 200, "a denied visitor can ask the owner for access");
    const again = await httpPost(port, "/__claw__/request-access", {
      Host: host,
      Cookie: `portal_session=${mintPortalSession("mallory@example.com")}`,
    });
    assert.equal(again.status, 200, "asking twice is idempotent, not an error");
    assert.equal(deliveries.length, 2, "both posts enqueue (the outbox dedupes by idempotency key)");
    assert.equal(deliveries[0]!.idempotencyKey, deliveries[1]!.idempotencyKey, "same visitor+app+day dedupes");
    assert.match(deliveries[0]!.text, /mallory@example\.com is asking for access/);
    assert.match(deliveries[0]!.text, /mysite/);
    assert.deepEqual(deliveries[0]!.destination, {
      type: "principal",
      target: "alice@example.com",
      audienceScopeId: "personal:alice@example.com",
      onBehalfOf: "mallory@example.com",
    });

    const signedOutAsk = await httpPost(port, "/__claw__/request-access", { Host: host });
    assert.equal(signedOutAsk.status, 401, "a signed-out visitor cannot send access requests");

    const forged = await httpGet(port, "/consultants", {
      Host: host,
      Accept: "text/html",
      Cookie: `portal_session=${mintPortalSession("alice@example.com", 3600, "wrong-secret")}`,
    });
    assert.equal(forged.status, 302, "a forged session is just a signed-out visitor");

    const crafted = await httpGet(port, "//evil.com?dpl_signin=1", {
      Host: host,
      Accept: "text/html",
      Cookie: `portal_session=${mintPortalSession("alice@example.com")}`,
    });
    assert.equal(crafted.status, 302);
    assert.equal(crafted.headers.location, "/", "a scheme-relative pathname never enters a gateway redirect");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("subdomain ingress: without the session config the domain has no door — a 503, not a bounce", async () => {
  const deployStore = createDeployStore();
  const deploy = createDeployService({
    deployStore,
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: 1 }),
      destroy: async () => {},
    },
    auditLog,
    acl: createAclStore(),
    deployDir: mkdtempSync(join(tmpdir(), "signin-off-")),
  });
  const app = createApp({
    deploy,
    acl: createAclStore(),
    directory: createDirectoryStore(),
    sessions: createMemorySessionStore(),
    identity: createIdentityService(),
  } as unknown as Parameters<typeof createApp>[0]);
  await app.deploy({
    ownerScopeId: scopeId("personal", "alice@example.com"),
    createdBy: "alice@example.com",
    entrypoint: "x",
    files: [],
    name: "mysite",
  });
  const server = createInsecureTestServer(app, {
    deployAppsDomain: "apps.example.com",
    deployGateSecret: "gate-secret",
  });
  server.listen(0);
  const port = (server.address() as AddressInfo).port;
  try {
    const r = await httpGet(port, "/", {
      Host: "mysite.apps.example.com",
      Accept: "text/html",
      Cookie: `portal_session=${mintPortalSession("alice@example.com")}`,
    });
    assert.equal(
      r.status,
      503,
      "no session secret ⇒ sign-in cannot work; surface the misconfiguration, not a dead-end bounce",
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
