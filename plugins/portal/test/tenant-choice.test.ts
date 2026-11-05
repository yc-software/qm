import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { deriveKey, open, seal, readCookie } from "../src/session.ts";
import { verifyPortalIdentity } from "../../chassis/src/portal-identity.ts";
import { trustedPrincipal } from "../src/trusted-entry.ts";

const secret = "tenant-choice-session-test-secret";
const identitySecret = "tenant-choice-identity-secret-0123456789";
const origin = "http://portal.test";
const sessionKey = deriveKey(secret, "portal.session.v1");
const tmpKey = deriveKey(secret, "portal.tmp.v1");
const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const jwk = { ...(await exportJWK(publicKey)), kid: "test-key" };
const alpha = "00000000-0000-4000-8000-00000000000a";
const beta = "00000000-0000-4000-8000-00000000000b";
let tenants: unknown[] = [];
let nonce = "";
let audience = "portal-client";
let shared = true;
let email: string | null = "founder@company.test";
let principalTenants: unknown[] = [];
const principalLookups: string[] = [];
const admissions: Array<string | undefined> = [];
const surface: Array<string | undefined> = [];
const coreCalls: Array<{ path: string; tenant: string | undefined }> = [];

function identityTenant(header: unknown): string | undefined {
  return typeof header === "string" ? verifyPortalIdentity(header, identitySecret, Date.now())?.t : undefined;
}

const upstream = createServer((req, res) => {
  void (async () => {
    const path = new URL(req.url!, origin).pathname;
    coreCalls.push({ path, tenant: identityTenant(req.headers["x-portal-identity"]) });
    res.setHeader("content-type", "application/json");
    if (path === "/keys") return void res.end(JSON.stringify({ keys: [jwk] }));
    if (path === "/token") {
      const idToken = await new SignJWT({ nonce })
        .setProtectedHeader({ alg: "EdDSA", kid: "test-key" })
        .setIssuer(upstreamUrl)
        .setAudience(audience)
        .setSubject("idp-subject")
        .setIssuedAt()
        .setExpirationTime("2m")
        .sign(privateKey);
      return void res.end(JSON.stringify({ access_token: "test-access", id_token: idToken }));
    }
    if (path === "/userinfo")
      return void res.end(JSON.stringify({ sub: "idp-subject", ...(email ? { email, email_verified: true } : {}) }));
    if (path === "/v1/auth/broker/principal-tenants") {
      principalLookups.push(new URL(req.url!, origin).searchParams.get("principal") ?? "");
      return void res.end(JSON.stringify({ tenants: principalTenants, shared }));
    }
    if (path === "/v1/auth/broker/claim") {
      let raw = "";
      for await (const chunk of req) raw += String(chunk);
      return void res.end(JSON.stringify({ claimed: (JSON.parse(raw) as { ids: string[] }).ids[0] }));
    }
    if (path === "/v1/auth/broker/email-tenants") return void res.end(JSON.stringify({ tenants, shared }));
    if (path === "/v1/auth/broker/email-allowed") {
      admissions.push(identityTenant(req.headers["x-portal-identity"]));
      return void res.end(JSON.stringify({ allowed: true }));
    }
    surface.push(identityTenant(req.headers["x-portal-identity"]));
    res.end(JSON.stringify({ path }));
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
  PORTAL_IDENTITY_SECRET: identitySecret,
  CORE_ORG_ID: "acme",
  CORE_SIGNING_SECRET: "tenant-choice-core-secret",
  CORE_API_URL: upstreamUrl,
  WEB_UI_UPSTREAM: upstreamUrl,
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
  AUTH_BROKER_UPSTREAM: upstreamUrl,
  PORTAL_LOCAL_AUTH_BYPASS: "0",
  PORTAL_PLAYGROUND: "0",
  PORTAL_TRUSTED_OIDC: JSON.stringify({
    issuer: upstreamUrl,
    authEndpoint: `${upstreamUrl}/authorize`,
    tokenEndpoint: `${upstreamUrl}/token`,
    userinfoEndpoint: `${upstreamUrl}/userinfo`,
    jwksUri: `${upstreamUrl}/keys`,
    clientId: "trusted-client",
  }),
  PORTAL_TRUSTED_OIDC_CLIENT_SECRET: "trusted-client-secret-0123456789abcdef",
});
const { server } = await import("../src/index.ts");
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => {
  server.close();
  upstream.close();
});

function cookieFrom(response: Response, name: string): string | undefined {
  return response.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`) && !c.startsWith(`${name}=;`))
    ?.split(";")[0];
}

function sessionOf(response: Response): Record<string, unknown> | null {
  return open(readCookie(cookieFrom(response, "portal_session") ?? "", "portal_session"), sessionKey);
}

async function callback(): Promise<Response> {
  const login = await fetch(`${base}/auth/login?returnTo=%2F`, { redirect: "manual" });
  const tmpCookie = cookieFrom(login, "portal_oidc_tmp")!;
  const tmp = open(readCookie(tmpCookie, "portal_oidc_tmp"), tmpKey)!;
  nonce = tmp.nonce as string;
  return fetch(`${base}/auth/callback?code=test&state=${tmp.state as string}`, {
    headers: { cookie: tmpCookie },
    redirect: "manual",
  });
}

function choose(choiceCookie: string, tenant: string): Promise<Response> {
  return fetch(`${base}/auth/tenant`, {
    method: "POST",
    headers: { cookie: choiceCookie, origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ tenant }).toString(),
    redirect: "manual",
  });
}

test("an email in one tenant signs in bound to it and every proxied request names it", async () => {
  tenants = [{ id: alpha, brandName: "Alpha" }];
  admissions.length = 0;
  const response = await callback();
  assert.equal(response.status, 302);
  assert.equal(sessionOf(response)?.t, alpha);
  assert.deepEqual(admissions, [alpha]);
  surface.length = 0;
  await fetch(`${base}/`, { headers: { cookie: cookieFrom(response, "portal_session")! }, redirect: "manual" });
  assert.equal(surface.at(-1), alpha);
});

test("an email in no tenant keeps today's untenanted sign-in", async () => {
  tenants = [];
  admissions.length = 0;
  const response = await callback();
  assert.equal(response.status, 302);
  assert.equal(sessionOf(response)?.t, undefined);
  assert.deepEqual(admissions, [undefined]);
});

test("an email in two tenants picks one on the chooser and signs in under it", async () => {
  tenants = [{ id: alpha, brandName: "Alpha <Co>" }, { id: beta }];
  admissions.length = 0;
  const page = await callback();
  assert.equal(page.status, 200);
  assert.equal(cookieFrom(page, "portal_session"), undefined);
  const html = await page.text();
  assert.match(html, /Choose a workspace/);
  assert.match(html, /Alpha &lt;Co&gt;/);
  assert.match(html, />00000000</);
  assert.deepEqual(admissions, []);
  const choice = cookieFrom(page, "portal_tenant_choice")!;
  const outsider = await choose(choice, "00000000-0000-4000-8000-00000000000c");
  assert.equal(outsider.status, 400);
  assert.equal(cookieFrom(outsider, "portal_session"), undefined);
  const chosen = await choose(choice, beta);
  assert.equal(chosen.status, 302);
  assert.equal(sessionOf(chosen)?.t, beta);
  assert.deepEqual(admissions, [beta]);
});

test("a tampered session tenant is refused", () => {
  const now = Math.floor(Date.now() / 1000);
  const forged = seal(
    { k: "session", sub: email, org: "acme", t: "not-a-tenant", iat: now, exp: now + 60 },
    sessionKey,
  );
  return fetch(`${base}/`, { headers: { cookie: `portal_session=${forged}` }, redirect: "manual" }).then((r) =>
    assert.notEqual(r.status, 200),
  );
});

test("a signed-in person's admin, connect, drop, desktop and branding calls all name their tenant", async () => {
  const now = Math.floor(Date.now() / 1000);
  const cookie = `portal_session=${seal({ k: "session", sub: email, org: "acme", t: beta, auth: now, iat: now, exp: now + 600 }, sessionKey)}`;
  coreCalls.length = 0;
  for (const path of ["/connect/redeem/abc", "/drop/abc/form", "/connect/google/self-connect", "/"])
    await fetch(`${base}${path}`, { headers: { cookie, accept: "text/html" }, redirect: "manual" });
  await fetch(`${base}/auth/impersonate?target=other%40company.test`, {
    method: "POST",
    headers: { cookie, origin },
    redirect: "manual",
  });
  const named = (prefix: string) => coreCalls.filter((c) => c.path.startsWith(prefix)).map((c) => c.tenant);
  assert.deepEqual(named("/v1/connectors/oauth/consent/redeem/"), [beta]);
  assert.deepEqual(named("/v1/keychain/drops/"), [beta]);
  assert.deepEqual(named("/v1/connectors/oauth/google/start"), [beta]);
  assert.ok(named("/v1/surface-config").includes(beta));
  assert.deepEqual([...new Set(named("/v1/admin/whoami"))], [beta]);
  const verifier = "v".repeat(43);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = "s".repeat(43);
  const page = await fetch(`${base}/auth/desktop?challenge=${challenge}&state=${state}`, {
    method: "POST",
    headers: { cookie, origin },
  });
  const code = new URL(/href="([^"]+)"/.exec(await page.text())![1]!.replaceAll("&amp;", "&")).searchParams.get(
    "code",
  )!;
  const redeemed = await fetch(`${base}/auth/desktop/redeem`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, verifier, state }).toString(),
  });
  assert.equal(redeemed.status, 200);
  assert.equal(sessionOf(redeemed)?.t, beta);
});

async function trustedCallback(as: string | null): Promise<Response> {
  email = as;
  audience = "trusted-client";
  const login = await fetch(`${base}/auth/trusted/login?returnTo=%2F`, { redirect: "manual" });
  const tmpCookie = cookieFrom(login, "portal_trusted_tmp")!;
  const tmp = open(readCookie(tmpCookie, "portal_trusted_tmp"), deriveKey(secret, "trusted-entry-tmp"))!;
  nonce = tmp.nonce as string;
  try {
    return await fetch(`${base}/auth/trusted/callback?code=test&state=${tmp.state as string}`, {
      headers: { cookie: tmpCookie },
      redirect: "manual",
    });
  } finally {
    audience = "portal-client";
    email = "founder@company.test";
  }
}

test("a trusted sign-in on a shared host picks the tenant by the provider's email but keeps its own principal", async () => {
  shared = true;
  const principal = trustedPrincipal(upstreamUrl, "idp-subject");

  tenants = [{ id: alpha, brandName: "Alpha" }];
  const one = await trustedCallback("founder@alpha.test");
  assert.equal(one.status, 302);
  assert.deepEqual([sessionOf(one)?.sub, sessionOf(one)?.t], [principal, alpha]);

  tenants = [
    { id: alpha, brandName: "Alpha" },
    { id: beta, brandName: "Beta" },
  ];
  const both = await trustedCallback("partner@both.test");
  assert.equal(both.status, 200);
  assert.match(await both.text(), /Choose a workspace[\s\S]*Alpha[\s\S]*Beta/);
  const chosen = await choose(cookieFrom(both, "portal_tenant_choice")!, beta);
  assert.equal(chosen.status, 302);
  assert.deepEqual([sessionOf(chosen)?.sub, sessionOf(chosen)?.t], [principal, beta]);
  surface.length = 0;
  await fetch(`${base}/`, { headers: { cookie: cookieFrom(chosen, "portal_session")! }, redirect: "manual" });
  assert.equal(surface.at(-1), beta);

  tenants = [];
  const nobody = await trustedCallback("stranger@nowhere.test");
  assert.equal(nobody.status, 400);
  assert.match(await nobody.text(), /account is not permitted/);
  assert.equal(sessionOf(nobody), null);
});

test("a trusted sign-in on a single-tenant install stays untenanted when the directory does not list the email", async () => {
  shared = false;
  tenants = [];
  const response = await trustedCallback("founder@solo.test");
  shared = true;
  assert.equal(response.status, 302);
  assert.equal(sessionOf(response)?.t, undefined);
});

test("a trusted provider that sends no email picks the tenant from the principal's links", async () => {
  shared = true;
  const principal = trustedPrincipal(upstreamUrl, "idp-subject");
  principalLookups.length = 0;

  principalTenants = [
    { id: alpha, brandName: "Alpha" },
    { id: beta, brandName: "Beta" },
  ];
  const both = await trustedCallback(null);
  assert.equal(both.status, 200);
  assert.match(await both.text(), /Choose a workspace[\s\S]*Alpha[\s\S]*Beta/);
  const chosen = await choose(cookieFrom(both, "portal_tenant_choice")!, alpha);
  assert.deepEqual([sessionOf(chosen)?.sub, sessionOf(chosen)?.t], [principal, alpha]);

  principalTenants = [{ id: beta, brandName: "Beta" }];
  const one = await trustedCallback(null);
  assert.equal(one.status, 302);
  assert.deepEqual([sessionOf(one)?.sub, sessionOf(one)?.t], [principal, beta]);

  principalTenants = [];
  const unlinked = await trustedCallback(null);
  assert.equal(unlinked.status, 400);
  assert.match(await unlinked.text(), /account is not permitted/);
  assert.equal(sessionOf(unlinked), null);

  shared = false;
  const solo = await trustedCallback(null);
  shared = true;
  assert.equal(solo.status, 302);
  assert.equal(sessionOf(solo)?.t, undefined);
  assert.deepEqual([...new Set(principalLookups)], [principal]);
});
