import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mintDesktopLogin, openDesktopLogin } from "../src/desktop-login.ts";
import { deriveKey, openSession, seal, type SessionClaims } from "../src/session.ts";

const secret = "desktop-login-test-session-secret-long-enough";
const origin = "http://127.0.0.1:19997";
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomBytes(32).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const browser: SessionClaims = {
  k: "session",
  sub: "person@example.test",
  org: "desktop-test",
  auth: now - 60,
  iat: now - 30,
  exp: now + 3600,
};
const cookie = `portal_session=${seal(browser, deriveKey(secret, "portal.session.v1"))}`;
const claims = new Set<string>();
let claimsUnavailable = false;
const core = createServer((req, res) => {
  void (async () => {
    if (new URL(req.url!, origin).pathname !== "/v1/auth/broker/claim") return void res.end("{}");
    if (claimsUnavailable) {
      res.statusCode = 503;
      return void res.end("{}");
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const key = body.ids[0];
    const claimed = claims.has(key) ? null : key;
    claims.add(key);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ claimed }));
  })().catch(() => {
    res.statusCode = 500;
    res.end();
  });
});
await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
const coreUrl = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
Object.assign(process.env, {
  NODE_ENV: "test",
  PORTAL_PUBLIC_URL: origin,
  PORTAL_SESSION_SECRET: secret,
  CORE_SIGNING_SECRET: "desktop-core-secret",
  CORE_ORG_ID: browser.org,
  CORE_API_URL: coreUrl,
  WEB_UI_UPSTREAM: coreUrl,
  ADMIN_UPSTREAM: coreUrl,
  PORTAL_LOCAL_AUTH_BYPASS: "0",
  PORTAL_PLAYGROUND: "0",
});
const { server } = await import("../src/index.ts");
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => {
  server.close();
  core.close();
});
const requestPath = `/auth/desktop?challenge=${challenge}&state=${state}`;

async function issue(sessionCookie = cookie) {
  const response = await fetch(`${base}${requestPath}`, { method: "POST", headers: { origin, cookie: sessionCookie } });
  assert.equal(response.status, 200);
  const html = await response.text();
  const match = html.match(/href="(qm-desktop:[^"]+)"/);
  assert.ok(match);
  const callback = new URL(match[1]!.replaceAll("&amp;", "&"));
  assert.equal(callback.searchParams.get("state"), state);
  return callback.searchParams.get("code")!;
}
function redeem(code: string, proof = verifier, requestOrigin = origin) {
  return fetch(`${base}/auth/desktop/redeem`, {
    method: "POST",
    headers: { origin: requestOrigin },
    body: new URLSearchParams({ code, verifier: proof, state }),
  });
}

test("unauthenticated desktop requests preserve their proof across normal login", async () => {
  const response = await fetch(`${base}${requestPath}`, { redirect: "manual" });
  assert.equal(response.status, 303);
  assert.equal(new URL(response.headers.get("location")!, origin).searchParams.get("returnTo"), requestPath);
});

test("GET requires explicit confirmation and cannot mint a code", async () => {
  const response = await fetch(`${base}${requestPath}`, { headers: { cookie } });
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /person@example.test/);
  assert.match(html, /method="post"/);
  assert.doesNotMatch(html, /qm-desktop:\/\//);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("cross-origin authorization and anonymous sessions cannot mint a desktop identity", async () => {
  const response = await fetch(`${base}${requestPath}`, {
    method: "POST",
    headers: { origin: "https://attacker.test", cookie },
  });
  assert.equal(response.status, 403);
  const anonymous = seal({ ...browser, anon: true }, deriveKey(secret, "portal.session.v1"));
  const anonResponse = await fetch(`${base}${requestPath}`, {
    redirect: "manual",
    headers: { cookie: `portal_session=${anonymous}` },
  });
  assert.equal(anonResponse.status, 303);
});

test("wrong proof cannot consume a code and one of concurrent valid redemptions succeeds", async () => {
  const code = await issue();
  assert.equal((await redeem(code, randomBytes(32).toString("base64url"))).status, 400);
  assert.equal((await redeem(code, verifier, "https://attacker.test")).status, 403);
  const results = await Promise.all([redeem(code), redeem(code)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
  const success = results.find((r) => r.status === 200)!;
  const sessionCookie = success.headers.getSetCookie().find((c) => c.startsWith("portal_session="))!;
  const token = sessionCookie.split(";")[0]!.slice("portal_session=".length);
  const session = openSession(token, deriveKey(secret, "portal.session.v1"), Date.now(), browser.org);
  assert.equal(session?.sub, browser.sub);
  assert.equal(session?.auth, browser.auth);
  assert.equal(session?.exp, browser.exp);
  assert.match(sessionCookie, /HttpOnly/);
});

test("claim store outages fail closed without issuing a session", async () => {
  const code = await issue();
  claimsUnavailable = true;
  try {
    const response = await redeem(code);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("set-cookie"), null);
  } finally {
    claimsUnavailable = false;
  }
});

test("codes are bounded by signature, audience, organization, state, and browser lifetime", () => {
  const code = mintDesktopLogin(browser, secret, origin, challenge, state);
  const verify = (value = code, target = origin, org = browser.org, when = Date.now(), expectedState = state) =>
    openDesktopLogin(value, verifier, expectedState, secret, target, org, 86400, when);
  assert.ok(verify());
  assert.equal(verify(`${code}x`), null);
  assert.equal(verify(code, "https://other.test"), null);
  assert.equal(verify(code, origin, "other-org"), null);
  assert.equal(verify(code, origin, browser.org, Date.now() + 121_000), null);
  assert.equal(verify(code, origin, browser.org, Date.now(), randomBytes(32).toString("base64url")), null);
  const old = mintDesktopLogin({ ...browser, auth: now - 86401 }, secret, origin, challenge, state);
  assert.equal(verify(old), null);
});

test("desktop handoff renews a browser session near expiry without resetting its original authentication", async () => {
  const testNow = Math.floor(Date.now() / 1000);
  const oldBrowser = { ...browser, auth: testNow - 900_000, iat: testNow - 604_770, exp: testNow + 30 };
  const oldCookie = `portal_session=${seal(oldBrowser, deriveKey(secret, "portal.session.v1"))}`;
  const page = await fetch(`${base}${requestPath}`, { headers: { cookie: oldCookie } });
  assert.equal(page.status, 200);
  assert.ok(page.headers.getSetCookie().some((value) => value.startsWith("portal_session=")));
  const code = await issue(oldCookie);
  const effective = openDesktopLogin(
    code,
    verifier,
    state,
    secret,
    origin,
    browser.org,
    2_592_000,
    (testNow + 31) * 1000,
  );
  assert.equal(effective?.session.auth, oldBrowser.auth);
  assert.ok(effective && effective.session.exp >= testNow + 604_800);
});

test("app-only sessions cannot mint desktop sessions", async () => {
  assert.throws(() => mintDesktopLogin({ ...browser, appOnly: true }, secret, origin, challenge, state), /app-only/);
  const appCookie = `portal_session=${seal({ ...browser, appOnly: true }, deriveKey(secret, "portal.session.v1"))}`;
  for (const method of ["GET", "POST"]) {
    const response = await fetch(`${base}${requestPath}`, { method, headers: { origin, cookie: appCookie } });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("set-cookie"), null);
  }
});
