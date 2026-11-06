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
let admitted = true;
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
      return void res.end(
        JSON.stringify(host === "alpha-dash.apps.test" ? { tenant: alpha, app: true } : { tenant: null }),
      );
    }
    if (path === "/v1/auth/broker/workspace") {
      const handle = new URL(req.url!, origin).searchParams.get("handle");
      const workspaces: Record<string, unknown> = {
        beta7: {
          tenant: beta,
          trustedClient: { clientId: "company-client", clientSecret: "company-client-secret-0123456789abcdef" },
        },
        alpha1: { tenant: alpha },
      };
      return void res.end(JSON.stringify(workspaces[handle ?? ""] ?? { tenant: null }));
    }
    if (path === "/v1/auth/broker/email-allowed") {
      admissions.push(identityTenant(req.headers["x-portal-identity"]));
      return void res.end(JSON.stringify({ allowed: admitted }));
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
  PUBLIC_WEB_URL: origin,
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

test("on a shared host, an email no workspace admits gets the no-workspace page instead of a sign-in failure", async () => {
  tenants = [];
  admitted = false;
  email = "moved@company.test";
  try {
    const response = await callback();
    assert.equal(response.status, 403);
    assert.equal(sessionOf(response), null);
    const html = await response.text();
    assert.match(html, /<h1 id="t">No QM workspace for this account yet<\/h1>/);
    assert.match(html, /Signed in as<\/strong>moved@company\.test/);
    shared = false;
    const single = await callback();
    assert.equal(single.status, 400);
    assert.match(await single.text(), /account is not permitted/);
  } finally {
    admitted = true;
    shared = true;
    email = "founder@company.test";
  }
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
  const nobodyHtml = await nobody.text();
  assert.match(nobodyHtml, /<h1 id="t">No QM workspace for this account yet<\/h1>/);
  assert.match(nobodyHtml, /<p class="account"><strong>Signed in as<\/strong>stranger@nowhere\.test<\/p>/);
  assert.match(nobodyHtml, /<p class="msg">This account isn&#39;t in a QM workspace yet\.<\/p>/);
  assert.match(
    nobodyHtml,
    /<div class="actions">\s*<a class="btn ghost workspace" href="\/auth\/login">Sign in with a different account<\/a>\s*<\/div>/,
  );
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
  assert.match(
    await unlinked.text(),
    /No QM workspace for this account yet[\s\S]*Signed in as<\/strong>an account without an email address/,
  );
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

function onHost(host: string, path: string, cookie = ""): Promise<HostResponse> {
  return new Promise((resolve, reject) => {
    const { port } = new URL(base);
    const req = request(
      { host: "127.0.0.1", port, path, headers: { host, accept: "text/html", ...(cookie ? { cookie } : {}) } },
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

const pair = (cookies: string[], name: string) =>
  cookies.find((c) => c.startsWith(`${name}=`) && !c.startsWith(`${name}=;`))?.split(";")[0];

async function signInForApp(to: string): Promise<HostResponse> {
  const start = await onHost("portal.test", `/auth/host?to=${encodeURIComponent(to)}`);
  assert.equal(start.status, 302);
  assert.match(start.location, /^\/auth\/login\?returnTo=%2Fauth%2Fhost/);
  const login = await onHost("portal.test", start.location);
  const tmpCookie = pair(login.cookies, "portal_oidc_tmp")!;
  const tmp = open(readCookie(tmpCookie, "portal_oidc_tmp"), tmpKey)!;
  nonce = tmp.nonce as string;
  return onHost("portal.test", `/auth/callback?code=test&state=${tmp.state as string}`, tmpCookie);
}

test("signing in for a company's app binds that company with no chooser, then hands off to the app host", async () => {
  tenants = [{ id: alpha }, { id: beta }];
  const signedIn = await signInForApp("http://alpha-dash.apps.test/inbox?x=1");
  assert.equal(signedIn.status, 302);
  const session = pair(signedIn.cookies, "portal_session")!;
  assert.equal(open(readCookie(session, "portal_session"), sessionKey)?.t, alpha);
  const out = await onHost("portal.test", signedIn.location, session);
  assert.equal(out.status, 302);
  assert.match(out.location, /^http:\/\/alpha-dash\.apps\.test\/auth\/handoff\?token=/);
});

test("signing in for a company's app with an account outside it shows no access and starts no session", async () => {
  tenants = [{ id: beta }];
  const denied = await signInForApp("http://alpha-dash.apps.test/");
  assert.equal(denied.status, 403);
  assert.match(denied.body, /No access to this workspace/);
  assert.equal(pair(denied.cookies, "portal_session"), undefined);
});

async function workspaceSignIn(handle: string, audienceFor: string): Promise<HostResponse & { client: string | null }> {
  const start = await onHost("portal.test", `/auth/trusted/login?workspace=${handle}&returnTo=%2Finbox`);
  const authorize = new URL(start.location);
  assert.equal(authorize.searchParams.get("redirect_uri"), `${origin}/auth/trusted/callback`);
  const tmpCookie = pair(start.cookies, "portal_trusted_tmp")!;
  const tmp = open(readCookie(tmpCookie, "portal_trusted_tmp"), deriveKey(secret, "trusted-entry-tmp"))!;
  nonce = tmp.nonce as string;
  audience = audienceFor;
  email = null;
  try {
    const done = await onHost(
      "portal.test",
      `/auth/trusted/callback?code=test&state=${tmp.state as string}`,
      tmpCookie,
    );
    return { ...done, client: authorize.searchParams.get("client_id") };
  } finally {
    audience = "portal-client";
    email = "founder@company.test";
  }
}

test("a workspace link signs in through that company's own trusted client on the shared callback and binds it with no chooser", async () => {
  shared = true;
  principalTenants = [
    { id: alpha, brandName: "Alpha" },
    { id: beta, brandName: "Beta" },
  ];
  const done = await workspaceSignIn("beta7", "company-client");
  assert.equal(done.client, "company-client");
  assert.equal(done.status, 302);
  assert.equal(done.location, "/inbox");
  const session = open(readCookie(pair(done.cookies, "portal_session")!, "portal_session"), sessionKey);
  assert.deepEqual([session?.sub, session?.t], [trustedPrincipal(upstreamUrl, "idp-subject"), beta]);

  const plain = await workspaceSignIn("alpha1", "trusted-client");
  assert.equal(plain.client, "trusted-client");
  assert.equal(open(readCookie(pair(plain.cookies, "portal_session")!, "portal_session"), sessionKey)?.t, alpha);
  principalTenants = [];
});

test("a workspace link refuses an identity that company has not admitted, and an unknown workspace before any redirect", async () => {
  shared = true;
  principalTenants = [{ id: alpha, brandName: "Alpha" }];
  const denied = await workspaceSignIn("beta7", "company-client");
  principalTenants = [];
  assert.equal(denied.status, 403);
  assert.match(denied.body, /No access to this workspace/);
  assert.equal(pair(denied.cookies, "portal_session"), undefined);
  for (const handle of ["nosuch", "Bad!"]) {
    const unknown = await onHost("portal.test", `/auth/trusted/login?workspace=${encodeURIComponent(handle)}`);
    assert.equal(unknown.status, 404);
    assert.equal(pair(unknown.cookies, "portal_trusted_tmp"), undefined);
  }
});

test("a staff account in hundreds of workspaces gets a searchable picker, a small cookie, and its recent choice first", async () => {
  shared = true;
  principalTenants = [];
  const many = Array.from({ length: 250 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(1000 + i).padStart(12, "0")}`,
    brandName: `Company ${String(i).padStart(3, "0")}`,
    handle: `company${i}`,
  }));
  tenants = many;
  const page = await trustedCallback("partner@staff.test");
  assert.equal(page.status, 200);
  const choice = cookieFrom(page, "portal_tenant_choice")!;
  assert.ok(choice.length < 2048, `choice cookie is ${choice.length} bytes`);
  assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'sha256-/);
  const html = await page.text();
  assert.match(html, /id="workspace-search"/);
  const visible = [...html.matchAll(/<form method="post" action="\/auth\/tenant" data-workspace/g)].length;
  assert.equal(visible, 8);
  assert.match(html, /Showing 8 of 250\. Type to narrow the list\./);
  assert.match(html, /<img src="\/auth\/assets\/becalmed-off-halfway-rock\.webp"/);
  assert.match(html, /<button class="btn ghost workspace" type="submit">/);

  const searched = await fetch(`${base}/auth/tenant?q=company%20249`, { headers: { cookie: choice } });
  const found = await searched.text();
  assert.match(found, /<form method="post" action="\/auth\/tenant" data-workspace="company 249 company249">/);
  assert.equal([...found.matchAll(/<form method="post" action="\/auth\/tenant" data-workspace/g)].length, 1);
  const none = await (await fetch(`${base}/auth/tenant?q=zzz`, { headers: { cookie: choice } })).text();
  assert.match(none, /No workspace matches that search\./);

  const chosen = await choose(choice, many[249]!.id);
  assert.equal(chosen.status, 302);
  assert.equal(sessionOf(chosen)?.t, many[249]!.id);
  const recent = cookieFrom(chosen, "portal_recent_workspaces")!;
  assert.ok(recent);

  tenants = many.slice(0, 249);
  const gone = await choose(choice, many[249]!.id);
  assert.equal(gone.status, 400);
  assert.equal(cookieFrom(gone, "portal_session"), undefined);

  tenants = many;
  const again = await fetch(`${base}/auth/tenant`, { headers: { cookie: `${choice}; ${recent}` } });
  const first = (await again.text()).match(/data-workspace="([^"]+)"/)?.[1];
  assert.equal(first, "company 249 company249");
});

test("six or fewer workspaces stay plain buttons, labelled by handle when unnamed", async () => {
  shared = true;
  principalTenants = [];
  tenants = Array.from({ length: 6 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(2000 + i).padStart(12, "0")}`,
    ...(i === 0 ? { handle: "unnamedco" } : { brandName: `Small ${i}` }),
  }));
  const page = await trustedCallback("partner@staff.test");
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.headers.get("content-security-policy") ?? "", /script-src/);
  const html = await page.text();
  assert.doesNotMatch(html, /workspace-search|<script/);
  assert.equal([...html.matchAll(/<form method="post" action="\/auth\/tenant"/g)].length, 6);
  assert.match(html, />unnamedco<\/button>/);
});
