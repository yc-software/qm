import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
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
let canonicalStatus = 200;
const principalLookups: string[] = [];
const claimed = new Set<string>();
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
    if (path.startsWith("/v1/principals/") && canonicalStatus !== 200) {
      res.statusCode = canonicalStatus;
      return void res.end(JSON.stringify({ error: "unauthorized" }));
    }
    if (path === "/v1/auth/broker/principal-tenants") {
      principalLookups.push(new URL(req.url!, origin).searchParams.get("principal") ?? "");
      return void res.end(JSON.stringify({ tenants: principalTenants, shared }));
    }
    if (path === "/v1/auth/broker/claim") {
      let raw = "";
      for await (const chunk of req) raw += String(chunk);
      const id = (JSON.parse(raw) as { ids: string[] }).ids[0]!;
      const fresh = !claimed.has(id);
      claimed.add(id);
      return void res.end(JSON.stringify({ claimed: fresh ? id : null }));
    }
    if (path === "/v1/auth/broker/email-tenants") return void res.end(JSON.stringify({ tenants, shared }));
    if (path === "/v1/auth/broker/host-tenant") {
      const host = new URL(req.url!, origin).searchParams.get("host");
      if (host === "company.test")
        return void res.end(
          JSON.stringify({
            tenant: beta,
            trustedClient: { clientId: "company-client", clientSecret: "company-client-secret-0123456789abcdef" },
          }),
        );
      return void res.end(
        JSON.stringify({ tenant: ({ "a.test": alpha, "b.test": beta } as Record<string, string>)[host!] ?? null }),
      );
    }
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
  principalTenants = [];
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
  assert.equal(nobody.status, 403);
  assert.match(await nobody.text(), /No access to this workspace/);
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
  assert.equal(unlinked.status, 403);
  assert.match(await unlinked.text(), /No access to this workspace/);
  assert.equal(sessionOf(unlinked), null);

  shared = false;
  const solo = await trustedCallback(null);
  shared = true;
  assert.equal(solo.status, 302);
  assert.equal(sessionOf(solo)?.t, undefined);
  assert.deepEqual([...new Set(principalLookups)], [principal]);
});

test("a trusted sign-in with an email also counts the companies that know its principal, each listed once", async () => {
  shared = true;
  const principal = trustedPrincipal(upstreamUrl, "idp-subject");
  principalLookups.length = 0;

  tenants = [];
  principalTenants = [{ id: beta, brandName: "Beta" }];
  const copied = await trustedCallback("founder@copied.test");
  assert.equal(copied.status, 302);
  assert.deepEqual([sessionOf(copied)?.sub, sessionOf(copied)?.t], [principal, beta]);

  tenants = [{ id: alpha, brandName: "Alpha" }];
  principalTenants = [
    { id: beta, brandName: "Beta" },
    { id: alpha, brandName: "Alpha" },
  ];
  const both = await trustedCallback("founder@copied.test");
  assert.equal(both.status, 200);
  const page = await both.text();
  assert.equal(page.match(/>Alpha</g)?.length, 1);
  assert.equal(page.match(/>Beta</g)?.length, 1);
  assert.deepEqual([...new Set(principalLookups)], [principal]);
  principalTenants = [];
});

test("a session core no longer recognises is signed out, while a core outage still says try again", async () => {
  const now = Math.floor(Date.now() / 1000);
  const stale = (sub: string) =>
    `portal_session=${seal({ k: "session", sub, org: "acme", auth: now, iat: now, exp: now + 600 }, sessionKey)}`;
  try {
    canonicalStatus = 401;
    const signedOut = await fetch(`${base}/`, {
      headers: { cookie: stale("untenanted@company.test"), accept: "text/html" },
      redirect: "manual",
    });
    assert.equal(signedOut.status, 302);
    assert.match(signedOut.headers.get("location") ?? "", /^\/auth\/login/);
    assert.ok(signedOut.headers.getSetCookie().some((c) => c.startsWith("portal_session=;")));
    canonicalStatus = 502;
    const outage = await fetch(`${base}/`, {
      headers: { cookie: stale("outage@company.test"), accept: "text/html" },
      redirect: "manual",
    });
    assert.equal(outage.status, 503);
  } finally {
    canonicalStatus = 200;
  }
});

test("a trusted callback with a stale login cookie fails, and its retry link starts a fresh login", async () => {
  const leftover = `portal_trusted_tmp=${seal({ k: "tmp", state: "old", nonce: "n", pkceVerifier: "v", returnTo: "/", iat: 0, exp: 1 }, deriveKey(secret, "trusted-entry-tmp"))}`;
  const failed = await fetch(`${base}/auth/trusted/callback?code=test&state=old`, {
    headers: { cookie: leftover },
    redirect: "manual",
  });
  assert.equal(failed.status, 400);
  assert.ok(failed.headers.getSetCookie().some((c) => c.startsWith("portal_trusted_tmp=;")));
  const retry = /href="(\/auth\/trusted\/login)"/.exec(await failed.text())?.[1];
  assert.equal(retry, "/auth/trusted/login");
  const restarted = await fetch(`${base}${retry}`, { redirect: "manual" });
  assert.equal(restarted.status, 302);
  assert.match(restarted.headers.get("location") ?? "", /\/authorize\?/);
  assert.ok(cookieFrom(restarted, "portal_trusted_tmp"));
});

interface HostResponse {
  status: number;
  location: string;
  cookies: string[];
  body: string;
}

function onHost(host: string, path: string, cookie = "", accept = "text/html"): Promise<HostResponse> {
  return new Promise((resolve, reject) => {
    const { port } = new URL(base);
    const req = request(
      { host: "127.0.0.1", port, path, headers: { host, accept, ...(cookie ? { cookie } : {}) } },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += String(chunk)));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            location: String(res.headers.location ?? ""),
            cookies: res.headers["set-cookie"] ?? [],
            body,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function sessionCookie(tenant: string, sub = "founder@company.test", host?: string): string {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    k: "session",
    sub,
    org: "acme",
    auth: now,
    iat: now,
    exp: now + 600,
    t: tenant,
    ...(host ? { h: host } : {}),
  };
  return `portal_session=${seal(claims, sessionKey)}`;
}

const pair = (cookies: string[], name: string) =>
  cookies.find((c) => c.startsWith(`${name}=`) && !c.startsWith(`${name}=;`))?.split(";")[0];

async function signInThroughSharedHost(to: string): Promise<HostResponse> {
  const start = await onHost("portal.test", `/auth/host?to=${encodeURIComponent(to)}`);
  assert.equal(start.status, 302);
  assert.match(start.location, /^\/auth\/login\?returnTo=%2Fauth%2Fhost/);
  const login = await onHost("portal.test", start.location);
  const tmpCookie = pair(login.cookies, "portal_oidc_tmp")!;
  const tmp = open(readCookie(tmpCookie, "portal_oidc_tmp"), tmpKey)!;
  nonce = tmp.nonce as string;
  return onHost("portal.test", `/auth/callback?code=test&state=${tmp.state as string}`, tmpCookie);
}

test("a company's own hostname signs in to that company only, with no chooser, through a one-time handoff", async () => {
  tenants = [{ id: alpha }, { id: beta }];
  const anon = await onHost("a.test", "/");
  assert.equal(anon.status, 302);
  const login = await onHost("a.test", anon.location);
  assert.equal(login.location, `${origin}/auth/host?to=${encodeURIComponent("http://a.test/")}`);
  const signedIn = await signInThroughSharedHost("http://a.test/inbox?x=1");
  assert.equal(signedIn.status, 302);
  const shared = pair(signedIn.cookies, "portal_session")!;
  assert.equal(open(readCookie(shared, "portal_session"), sessionKey)?.t, alpha);
  const out = await onHost("portal.test", signedIn.location, shared);
  assert.equal(out.status, 302);
  assert.match(out.location, /^http:\/\/a\.test\/auth\/handoff\?token=/);
  const handoffPath = out.location.slice("http://a.test".length);
  const elsewhere = await onHost("b.test", handoffPath);
  assert.equal(elsewhere.status, 400);
  const landed = await onHost("a.test", handoffPath);
  assert.equal(landed.status, 302);
  assert.equal(landed.location, "/inbox?x=1");
  const hostCookie = landed.cookies.find((c) => c.startsWith("portal_session=") && !c.startsWith("portal_session=;"))!;
  assert.doesNotMatch(hostCookie, /domain=/i);
  const minted = open(readCookie(hostCookie.split(";")[0], "portal_session"), sessionKey);
  assert.deepEqual([minted?.t, minted?.h], [alpha, "a.test"]);
  assert.equal((await onHost("a.test", handoffPath)).status, 400);
  surface.length = 0;
  const home = await onHost("a.test", "/", hostCookie.split(";")[0]);
  assert.notEqual(home.status, 302);
  assert.equal(surface.at(-1), alpha);
});

test("a company's hostname never accepts another company's session, even alongside its own", async () => {
  const refused = await onHost("a.test", "/", sessionCookie(beta, undefined, "b.test"));
  assert.equal(refused.status, 302);
  assert.match(refused.location, /^\/auth\/login/);
  const api = await onHost("a.test", "/api/sessions", sessionCookie(beta, undefined, "b.test"), "application/json");
  assert.equal(api.status, 401);
  surface.length = 0;
  const both = await onHost(
    "b.test",
    "/",
    `${sessionCookie(alpha, undefined, "a.test")}; ${sessionCookie(beta, undefined, "b.test")}`,
  );
  assert.notEqual(both.status, 302);
  assert.equal(surface.at(-1), beta);
  for (const path of ["/auth/callback?code=x&state=y", "/auth/trusted/callback?code=x&state=y", "/auth/invite"])
    assert.equal((await onHost("a.test", path)).status, 404);
});

test("a session works only on the host it was minted for, in both directions", async () => {
  const json = "application/json";
  const companyHost = sessionCookie(alpha, undefined, "a.test");
  assert.notEqual((await onHost("a.test", "/api/sessions", companyHost, json)).status, 401);
  assert.equal((await onHost("portal.test", "/api/sessions", companyHost, json)).status, 401);
  const sharedHost = sessionCookie(alpha);
  assert.notEqual((await onHost("portal.test", "/api/sessions", sharedHost, json)).status, 401);
  assert.equal((await onHost("a.test", "/api/sessions", sharedHost, json)).status, 401);
  assert.equal((await onHost("a.test", "/api/sessions", sessionCookie(alpha, undefined, "b.test"), json)).status, 401);
});

test("a company's published app opens on its own hostname with that company's session, and nowhere else with it", async () => {
  const companyHost = sessionCookie(alpha, undefined, "a.test");
  surface.length = 0;
  const own = await onHost("a.test", "/d/demo-app/", companyHost);
  assert.equal(own.status, 200);
  assert.deepEqual(JSON.parse(own.body), { path: "/d/demo-app/" });
  assert.equal(surface.at(-1), alpha);
  surface.length = 0;
  for (const host of ["portal.test", "b.test"]) {
    const refused = await onHost(host, "/d/demo-app/", companyHost);
    assert.equal(refused.status, 302);
    assert.match(refused.location, /\/auth\/login/);
  }
  assert.deepEqual(surface, []);
});

test("signing in for a company's hostname with an account outside it shows no access and starts no session", async () => {
  tenants = [{ id: beta }];
  const denied = await signInThroughSharedHost("http://a.test/");
  assert.equal(denied.status, 403);
  assert.match(denied.body, /No access to this workspace/);
  assert.equal(pair(denied.cookies, "portal_session"), undefined);
});

test("a company hostname with its own trusted client signs in on that hostname and binds that company without a lookup", async () => {
  tenants = [{ id: alpha }];
  const login = await onHost("company.test", "/auth/login?returnTo=%2Finbox");
  assert.equal(login.location, "/auth/trusted/login?returnTo=%2Finbox");
  const start = await onHost("company.test", login.location);
  const authorize = new URL(start.location);
  assert.equal(authorize.searchParams.get("client_id"), "company-client");
  assert.equal(authorize.searchParams.get("redirect_uri"), "http://company.test/auth/trusted/callback");
  const tmpCookie = pair(start.cookies, "portal_trusted_tmp")!;
  assert.doesNotMatch(
    start.cookies.find((c) => c.startsWith("portal_trusted_tmp="))!,
    /domain=/i,
  );
  const tmp = open(readCookie(tmpCookie, "portal_trusted_tmp"), deriveKey(secret, "trusted-entry-tmp"))!;
  nonce = tmp.nonce as string;
  audience = "company-client";
  email = null;
  try {
    const done = await onHost(
      "company.test",
      `/auth/trusted/callback?code=test&state=${tmp.state as string}`,
      tmpCookie,
    );
    assert.equal(done.status, 302);
    assert.equal(done.location, "/inbox");
    const session = open(readCookie(pair(done.cookies, "portal_session")!, "portal_session"), sessionKey);
    assert.deepEqual([session?.sub, session?.t], [trustedPrincipal(upstreamUrl, "idp-subject"), beta]);
  } finally {
    audience = "portal-client";
    email = "founder@company.test";
  }
  assert.equal((await onHost("a.test", "/auth/trusted/callback?code=x&state=y")).status, 404);
});
