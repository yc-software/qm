import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { deriveKey, seal } from "../src/session.ts";

let idpRequests = 0;
const idp = createServer((_req, res) => {
  idpRequests++;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ issuer, end_session_endpoint: `${issuer}/logout` }));
});
await new Promise<void>((resolve) => idp.listen(0, "127.0.0.1", resolve));
const issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
const core = createServer((_req, res) => res.end("{}"));
await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:19996";
const secret = "logout-route-fixture-secret-at-least-32-characters";
Object.assign(process.env, {
  NODE_ENV: "test",
  PORTAL_PUBLIC_URL: origin,
  PORTAL_SESSION_SECRET: secret,
  CORE_ORG_ID: "logout",
  CORE_API_URL: `http://127.0.0.1:${(core.address() as AddressInfo).port}`,
  OIDC_ISSUER: issuer,
  OIDC_AUTH_ENDPOINT: `${issuer}/authorize`,
  OIDC_CLIENT_ID: "primary-client",
  PORTAL_LOCAL_AUTH_BYPASS: "0",
  AUTH_BROKER_UPSTREAM: "",
});
const { server } = await import("../src/index.ts");
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => {
  server.close();
  idp.close();
  core.close();
});
function cookie(extra: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return `portal_session=${seal({ k: "session", prov: "oidc", sub: "fixture", org: "logout", iat: now, exp: now + 3600, ...extra }, deriveKey(secret, "portal.session.v1"))}`;
}
async function logout(extra: Record<string, unknown> = {}, html = false) {
  return fetch(`${base}/auth/logout?returnTo=https://evil.example`, {
    method: "POST",
    redirect: "manual",
    headers: { origin, cookie: cookie(extra), accept: html ? "text/html" : "application/json" },
  });
}
test("external OIDC sign-out is local: it never contacts the provider and stays signed out until Sign in", async () => {
  const before = idpRequests;
  const response = await logout();
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { redirectTo: string }).redirectTo, "/auth/signed-out");
  for (const name of [
    "portal_session",
    "portal_session_x",
    "portal_oidc_tmp",
    "portal_trusted_tmp",
    "portal_impersonate",
  ])
    assert.ok(
      response.headers.getSetCookie().some((value) => value.startsWith(`${name}=;`) && value.includes("Max-Age=0")),
    );
  const html = await logout({}, true);
  assert.equal(html.status, 303);
  assert.equal(html.headers.get("location"), "/auth/signed-out");
  const landing = await fetch(`${base}/auth/signed-out`, { redirect: "manual", headers: { accept: "text/html" } });
  assert.equal(landing.status, 200);
  const body = await landing.text();
  assert.match(body, /You have signed out of this portal/);
  assert.match(body, /href="\/auth\/login"/);
  assert.equal(idpRequests, before);
});
test("anonymous sessions keep the existing root redirect", async () => {
  const result = (await (await logout({ anon: true })).json()) as { redirectTo: string };
  assert.equal(result.redirectTo, "/");
});
test("signed-out landing does not falsely claim an authenticated session ended", async () => {
  const signedIn = await fetch(`${base}/auth/signed-out`, { headers: { cookie: cookie() } });
  assert.equal(signedIn.status, 409);
  assert.match(await signedIn.text(), /Still signed in/);
});
