import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { CLIENT_ID, CLIENT_SECRET, hiddenRequestToken, linkFrom, startHarness } from "../../auth/test/helpers.ts";

const PUBLIC = "http://portal.test";
const destination = "/admin/?tab=users";
const auth = await startHarness({
  env: { AUTH_ISSUER: `${PUBLIC}/idp`, AUTH_REDIRECT_URI: `${PUBLIC}/auth/callback` },
});
const surface = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
});
await new Promise<void>((resolve) => surface.listen(0, "127.0.0.1", resolve));
const surfaceBase = `http://127.0.0.1:${(surface.address() as AddressInfo).port}`;

process.env.PORTAL_PUBLIC_URL = PUBLIC;
process.env.PORTAL_SESSION_SECRET = "auth-locale-continuation-portal-secret";
process.env.CORE_SIGNING_SECRET = "auth-locale-continuation-core-secret";
process.env.CORE_ORG_ID = "acme";
process.env.WEB_UI_UPSTREAM = surfaceBase;
process.env.ADMIN_UPSTREAM = surfaceBase;
process.env.CORE_API_URL = surfaceBase;
process.env.AUTH_BROKER_UPSTREAM = auth.base;
process.env.OIDC_ISSUER = `${PUBLIC}/idp`;
process.env.OIDC_AUTH_ENDPOINT = `${PUBLIC}/idp/authorize`;
process.env.OIDC_TOKEN_ENDPOINT = `${auth.base}/token`;
process.env.OIDC_USERINFO_ENDPOINT = `${auth.base}/userinfo`;
process.env.OIDC_JWKS_URI = `${auth.base}/.well-known/jwks.json`;
process.env.OIDC_CLIENT_ID = CLIENT_ID;
process.env.OIDC_CLIENT_SECRET = CLIENT_SECRET;
process.env.OIDC_ALLOWED_EMAILS = "admin@example.com";
delete process.env.QM_DEFAULT_LOCALE;
delete process.env.PORTAL_LOCAL_AUTH_BYPASS;
delete process.env.PORTAL_PLAYGROUND;
delete process.env.PORTAL_COOKIE_DOMAIN;
delete process.env.PORTAL_APPS_DOMAIN;

const { server } = await import("../src/index.ts");
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

test.after(async () => {
  await auth.close();
  await Promise.all(
    [server, surface].map(
      (running) =>
        new Promise<void>((resolve, reject) => running.close((error) => (error ? reject(error) : resolve()))),
    ),
  );
});

const cookie = (response: Response, name: string): string => {
  const value = response.headers
    .getSetCookie()
    .map((entry) => entry.split(";", 1)[0] ?? "")
    .find((entry) => entry.startsWith(`${name}=`));
  assert.ok(value, `${name} cookie missing`);
  return value;
};

const publicPath = (raw: string): string => {
  const parsed = new URL(raw, PUBLIC);
  assert.equal(parsed.origin, PUBLIC);
  return `${parsed.pathname}${parsed.search}`;
};

const languageContinuation = (html: string): string => {
  const form = /<form[^>]+id="language-form"[\s\S]*?<\/form>/.exec(html)?.[0];
  assert.ok(form);
  assert.doesNotMatch(form, /name="(?:email|request)"/);
  const encoded = /name="returnTo" value="([^"]+)"/.exec(form)?.[1];
  assert.ok(encoded);
  return encoded.replaceAll("&amp;", "&");
};

test("changing the broker language preserves the portal destination and active OIDC protections", async () => {
  const login = await fetch(`${base}/auth/login?returnTo=${encodeURIComponent(destination)}`, { redirect: "manual" });
  assert.equal(login.status, 302);
  const temporary = cookie(login, "portal_oidc_tmp");
  const authorization = new URL(login.headers.get("location") ?? "", PUBLIC);
  const protectedParams = ["state", "nonce", "code_challenge"] as const;
  for (const name of protectedParams) assert.ok(authorization.searchParams.get(name), name);
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");

  const english = await fetch(`${base}${publicPath(authorization.href)}`, { headers: { cookie: temporary } });
  const englishHtml = await english.text();
  assert.match(englishHtml, /<html lang="en">/);
  const continuation = languageContinuation(englishHtml);
  assert.equal(continuation, "/auth/login?continue=1");
  assert.doesNotMatch(continuation, /state|nonce|code_challenge|redirect_uri/);

  const changed = await fetch(`${base}/locale`, {
    method: "POST",
    redirect: "manual",
    headers: {
      origin: PUBLIC,
      cookie: temporary,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ locale: "ja", returnTo: continuation }),
  });
  assert.equal(changed.status, 303);
  assert.equal(changed.headers.get("location"), continuation);
  const locale = cookie(changed, "qm_locale");
  const continued = await fetch(`${base}${continuation}`, {
    redirect: "manual",
    headers: { cookie: `${temporary}; ${locale}` },
  });
  assert.equal(continued.status, 302);
  const continuedLocation = new URL(continued.headers.get("location") ?? "", PUBLIC);
  for (const name of protectedParams) {
    assert.ok(continuedLocation.searchParams.get(name), name);
    assert.notEqual(continuedLocation.searchParams.get(name), authorization.searchParams.get(name), name);
  }
  assert.equal(continuedLocation.searchParams.get("code_challenge_method"), "S256");
  const browserCookies = `${cookie(continued, "portal_oidc_tmp")}; ${locale}`;

  const japanese = await fetch(`${base}${publicPath(continuedLocation.href)}`, { headers: { cookie: browserCookies } });
  const japaneseHtml = await japanese.text();
  assert.match(japaneseHtml, /<html lang="ja">/);
  assert.match(japaneseHtml, /メールアドレス/);

  const request = hiddenRequestToken(japaneseHtml);
  await fetch(`${base}/idp/authorize`, {
    method: "POST",
    headers: {
      origin: PUBLIC,
      cookie: browserCookies,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ request, email: "admin@example.com" }),
  });
  await auth.settle();
  const mailed = new URL(linkFrom(auth.mailer));
  assert.equal(mailed.searchParams.get("locale"), "ja");
  const linkToken = decodeURIComponent(mailed.hash.replace(/^#token=/, ""));

  const verified = await fetch(`${base}/idp/verify`, {
    method: "POST",
    redirect: "manual",
    headers: {
      origin: PUBLIC,
      cookie: browserCookies,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ token: linkToken }),
  });
  assert.equal(verified.status, 302);

  const callback = await fetch(`${base}${publicPath(verified.headers.get("location") ?? "")}`, {
    redirect: "manual",
    headers: { cookie: browserCookies },
  });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("location"), destination);
  assert.match(callback.headers.get("set-cookie") ?? "", /portal_session=/);
});
