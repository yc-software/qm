import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { deriveKey, open, seal, readCookie } from "../src/session.ts";
import { coreEmailAdmission, coreEmailAllowed } from "../../chassis/src/external-members.ts";

const secret = "app-only-session-test-secret";
const origin = "http://portal.test";
const sessionKey = deriveKey(secret, "portal.session.v1");
const tmpKey = deriveKey(secret, "portal.tmp.v1");
const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const jwk = { ...(await exportJWK(publicKey)), kid: "test-key" };
let admission: unknown = { allowed: true, appOnly: true };
let coreStatus = 200;
let nonce = "";
const email = "guest@partner.test";
const seen: Array<{ path: string; headers: Record<string, unknown> }> = [];
const upstream = createServer((req, res) => {
  void (async () => {
    const path = new URL(req.url!, origin).pathname;
    res.setHeader("content-type", "application/json");
    if (path === "/keys") return void res.end(JSON.stringify({ keys: [jwk] }));
    if (path === "/token") {
      const idToken = await new SignJWT({ nonce })
        .setProtectedHeader({ alg: "EdDSA", kid: "test-key" })
        .setIssuer(upstreamUrl)
        .setAudience("portal-client")
        .setSubject("idp-subject")
        .setIssuedAt()
        .setExpirationTime("2m")
        .sign(privateKey);
      return void res.end(JSON.stringify({ access_token: "test-access", id_token: idToken }));
    }
    if (path === "/userinfo") return void res.end(JSON.stringify({ sub: "idp-subject", email, email_verified: true }));
    if (path === "/v1/auth/broker/email-allowed") {
      res.statusCode = coreStatus;
      return void res.end(JSON.stringify(admission));
    }
    seen.push({ path, headers: req.headers });
    res.end(JSON.stringify({ path, headers: req.headers }));
  })().catch(() => {
    res.statusCode = 500;
    res.end();
  });
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
Object.assign(process.env, {
  NODE_ENV: "test",
  PORTAL_PUBLIC_URL: origin,
  PORTAL_SESSION_SECRET: secret,
  CORE_ORG_ID: "acme",
  CORE_SIGNING_SECRET: "app-only-core-secret",
  CORE_API_URL: upstreamUrl,
  WEB_UI_UPSTREAM: upstreamUrl,
  ADMIN_UPSTREAM: upstreamUrl,
  AUTH_BROKER_UPSTREAM: upstreamUrl,
  PORTAL_APPS_DOMAIN: "apps.example.test",
  OIDC_ISSUER: upstreamUrl,
  OIDC_AUTH_ENDPOINT: `${upstreamUrl}/authorize`,
  OIDC_TOKEN_ENDPOINT: `${upstreamUrl}/token`,
  OIDC_USERINFO_ENDPOINT: `${upstreamUrl}/userinfo`,
  OIDC_JWKS_URI: `${upstreamUrl}/keys`,
  OIDC_CLIENT_ID: "portal-client",
  OIDC_CLIENT_SECRET: "client-secret",
  OIDC_ALLOWED_EMAILS: "",
  OIDC_ALLOWED_EMAIL_DOMAIN: "",
  OIDC_PRINCIPAL_CLAIM: "email",
  PORTAL_LOCAL_AUTH_BYPASS: "0",
  PORTAL_PLAYGROUND: "0",
  PORTAL_SESSION_RENEW_AFTER_S: "1",
});
const { server } = await import("../src/index.ts");
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => {
  server.close();
  upstream.close();
});

function appCookie() {
  const now = Math.floor(Date.now() / 1000);
  return `portal_session=${seal({ k: "session", sub: email, org: "acme", appOnly: true, iat: now - 7200, exp: now + 3600 }, sessionKey)}`;
}
async function signIn(cookie = "") {
  const login = await fetch(`${base}/auth/login?returnTo=${encodeURIComponent("https://demo.apps.example.test/")}`, {
    headers: { cookie },
    redirect: "manual",
  });
  assert.equal(login.status, 302);
  const tmpCookie = login.headers
    .getSetCookie()
    .find((c) => c.startsWith("portal_oidc_tmp="))!
    .split(";")[0]!;
  const tmp = open(readCookie(tmpCookie, "portal_oidc_tmp"), tmpKey)!;
  nonce = tmp.nonce as string;
  return fetch(`${base}/auth/callback?code=test&state=${tmp.state}`, {
    headers: { cookie: `${tmpCookie}; ${cookie}` },
    redirect: "manual",
  });
}

test("core lookup preserves app-only admission and boolean broker compatibility", async () => {
  admission = { allowed: true, appOnly: true };
  assert.deepEqual(await coreEmailAdmission(upstreamUrl, undefined, email), admission);
  assert.equal(await coreEmailAllowed(upstreamUrl, undefined, email), true);
  admission = { allowed: true };
  assert.deepEqual(await coreEmailAdmission(upstreamUrl, undefined, email), admission);
  for (const invalid of [{ allowed: false, appOnly: true }, { allowed: true, appOnly: "true" }, null]) {
    admission = invalid;
    assert.deepEqual(await coreEmailAdmission(upstreamUrl, undefined, email), { allowed: false });
  }
  coreStatus = 503;
  assert.deepEqual(await coreEmailAdmission(upstreamUrl, undefined, email), { allowed: false });
  coreStatus = 200;
});

test("OIDC callback seals core app-only authority; ordinary admission stays ordinary", async () => {
  for (const appOnly of [true, false]) {
    admission = { allowed: true, ...(appOnly ? { appOnly: true } : {}) };
    const response = await signIn();
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "https://demo.apps.example.test/");
    const session = open(
      readCookie(
        response.headers.getSetCookie().find((c) => c.startsWith("portal_session=")),
        "portal_session",
      ),
      sessionKey,
    )!;
    assert.equal(session.sub, email);
    assert.equal(session.appOnly, appOnly || undefined);
  }
  admission = { allowed: false };
  const denied = await signIn(appCookie());
  assert.equal(denied.status, 400);
  assert.equal(
    denied.headers.getSetCookie().some((c) => c.startsWith("portal_session=")),
    false,
  );
});

test("app-only sessions cannot reach or renew on any ordinary portal surface", async () => {
  const paths = [
    "/",
    "/admin/",
    "/admin/api/whoami",
    "/api/whoami",
    "/api/sessions",
    "/api/deliveries/events",
    "/ws",
    "/v1/status",
    "/v1/deployments",
    "/d/demo/",
    "/app-edit/demo",
    "/auth/desktop",
    "/auth/desktop/redeem",
    "/auth/invite",
    "/auth/admin-login",
    "/auth/impersonate",
    "/auth/impersonate/stop",
    "/idp/token",
  ];
  for (const path of paths) {
    for (const method of ["GET", "POST"]) {
      const response = await fetch(`${base}${path}?appOnly=false`, {
        method,
        headers: { cookie: appCookie(), origin, "x-as-principal": "admin", "x-portal-identity": "forged" },
        redirect: "manual",
      });
      assert.equal(response.status, 403, `${method} ${path}`);
      assert.deepEqual(await response.json(), {
        error: "app_only_session",
        message: "this sign-in only permits access to shared apps",
      });
      assert.equal(response.headers.get("set-cookie"), null, "no renewal or broader session");
    }
  }
  assert.equal(
    seen.some((r) => paths.includes(r.path)),
    false,
  );
});

test("app-only websocket upgrades are refused before any upstream request", async () => {
  await new Promise<void>((resolve, reject) => {
    const req = request(
      `${base}/ws`,
      { headers: { cookie: appCookie(), connection: "Upgrade", upgrade: "websocket" } },
      (res) => {
        assert.equal(res.statusCode, 403);
        res.resume();
        res.on("end", resolve);
      },
    );
    req.on("upgrade", (_res, socket) => {
      socket.destroy();
      reject(new Error("unexpected upgrade"));
    });
    req.on("error", reject);
    req.end();
  });
});

test("app-only cookies reach only the app gateway and retain logout and reauthentication", async () => {
  const cookie = appCookie();
  const forwarded = await new Promise<{ headers: Record<string, string> }>((resolve, reject) => {
    const req = request(`${base}/api/private`, { headers: { host: "demo.apps.example.test", cookie } }, (res) => {
      assert.equal(res.statusCode, 200);
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolve(JSON.parse(body)));
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(forwarded.headers["x-qm-app-host"], "1");
  assert.equal(forwarded.headers.cookie, cookie);
  assert.equal(forwarded.headers["x-portal-identity"], undefined);
  for (const path of ["/idp/authorize", "/idp/verify"]) {
    assert.equal((await fetch(`${base}${path}`, { headers: { cookie: appCookie() } })).status, 200);
  }
  admission = { allowed: true, appOnly: true };
  assert.equal((await signIn(appCookie())).status, 302);
  const logout = await fetch(`${base}/auth/logout`, { method: "POST", headers: { cookie: appCookie(), origin } });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie")!, /portal_session=;/);
});
