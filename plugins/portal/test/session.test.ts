import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveKey,
  seal,
  open,
  openSession,
  openImpersonation,
  openTmp,
  setCookie,
  clearCookie,
  readCookie,
  safeEqual,
  sanitizeReturnTo,
  type SessionClaims,
  type ImpersonationClaims,
  type TmpClaims,
} from "../src/session.ts";

const secret = "portal-test-secret";
const sessionKey = deriveKey(secret, "portal.session.v1");
const tmpKey = deriveKey(secret, "portal.tmp.v1");
const impersonateKey = deriveKey(secret, "portal.impersonate.v1");

test("seal/open round-trips a payload and rejects tampering", () => {
  const token = seal({ hello: "world", n: 1 }, sessionKey);
  assert.deepEqual(open(token, sessionKey), { hello: "world", n: 1 });

  const [body, sig] = token.split(".");
  const tampered = `${(body ?? "").slice(0, -1)}${(body ?? "").slice(-1) === "A" ? "B" : "A"}.${sig}`;
  assert.equal(open(tampered, sessionKey), null);

  assert.equal(open(token, deriveKey("other-secret", "portal.session.v1")), null);
  assert.equal(open("not-a-token", sessionKey), null);
  assert.equal(open(null, sessionKey), null);
});

test("domain-separated keys make session and tmp tokens non-interchangeable", () => {
  const now = Math.floor(Date.now() / 1000);
  const session: SessionClaims = { k: "session", sub: "U1", org: "acme", iat: now, exp: now + 3600 };
  const sealed = seal(session, sessionKey);
  assert.equal(open(sealed, tmpKey), null);
});

test("openSession enforces kind, sub, and expiry", () => {
  const now = Math.floor(Date.now() / 1000);
  const good = seal(
    { k: "session", sub: "U1", org: "acme", iat: now, exp: now + 60 } satisfies SessionClaims,
    sessionKey,
  );
  assert.equal(openSession(good, sessionKey, Date.now())?.sub, "U1");
  assert.equal(openSession(good, sessionKey, Date.now(), "acme")?.sub, "U1");
  assert.equal(openSession(good, sessionKey, Date.now(), "other-org"), null);

  const expired = seal(
    { k: "session", sub: "U1", org: "acme", iat: now - 120, exp: now - 60 } satisfies SessionClaims,
    sessionKey,
  );
  assert.equal(openSession(expired, sessionKey, Date.now()), null);

  const tmp = seal(
    { k: "tmp", state: "s", nonce: "n", pkceVerifier: "v", returnTo: "/", iat: now, exp: now + 60 } satisfies TmpClaims,
    sessionKey,
  );
  assert.equal(openSession(tmp, sessionKey, Date.now()), null);
});

test("openSession enforces an absolute session lifetime", () => {
  const now = Math.floor(Date.now() / 1000);
  const current = seal(
    {
      k: "session",
      sub: "U1",
      org: "acme",
      auth: now - 300,
      iat: now - 10,
      exp: now + 60,
    } satisfies SessionClaims,
    sessionKey,
  );
  assert.equal(openSession(current, sessionKey, Date.now(), "acme", 600)?.sub, "U1");

  const tooOld = seal(
    {
      k: "session",
      sub: "U1",
      org: "acme",
      auth: now - 601,
      iat: now - 10,
      exp: now + 60,
    } satisfies SessionClaims,
    sessionKey,
  );
  assert.equal(openSession(tooOld, sessionKey, Date.now(), "acme", 600), null);
});

test("openTmp enforces kind and required fields", () => {
  const now = Math.floor(Date.now() / 1000);
  const tmp = seal(
    {
      k: "tmp",
      state: "abc",
      nonce: "xyz",
      pkceVerifier: "v",
      returnTo: "/web-ui/",
      iat: now,
      exp: now + 600,
    } satisfies TmpClaims,
    tmpKey,
  );
  const opened = openTmp(tmp, tmpKey, Date.now());
  assert.equal(opened?.state, "abc");
  assert.equal(opened?.nonce, "xyz");
  const session = seal(
    { k: "session", sub: "U1", org: "acme", iat: now, exp: now + 600 } satisfies SessionClaims,
    tmpKey,
  );
  assert.equal(openTmp(session, tmpKey, Date.now()), null);
});

test("openImpersonation enforces kind, actor, target, and expiry; key is domain-separated", () => {
  const now = Math.floor(Date.now() / 1000);
  const good = seal(
    {
      k: "impersonate",
      actor: "U-admin",
      target: "alice@acme",
      org: "acme",
      iat: now,
      exp: now + 3600,
    } satisfies ImpersonationClaims,
    impersonateKey,
  );
  const opened = openImpersonation(good, impersonateKey, Date.now());
  assert.equal(opened?.actor, "U-admin");
  assert.equal(opened?.target, "alice@acme");

  const expired = seal(
    {
      k: "impersonate",
      actor: "U-admin",
      target: "alice@acme",
      org: "acme",
      iat: now - 7200,
      exp: now - 60,
    } satisfies ImpersonationClaims,
    impersonateKey,
  );
  assert.equal(openImpersonation(expired, impersonateKey, Date.now()), null);

  const session = seal(
    { k: "session", sub: "U-admin", org: "acme", iat: now, exp: now + 3600 } satisfies SessionClaims,
    impersonateKey,
  );
  assert.equal(openImpersonation(session, impersonateKey, Date.now()), null);
  assert.equal(
    openImpersonation(good, sessionKey, Date.now()),
    null,
    "the impersonation key is domain-separated from the session key",
  );

  const noTarget = seal(
    { k: "impersonate", actor: "U-admin", target: "", org: "acme", iat: now, exp: now + 3600 },
    impersonateKey,
  );
  assert.equal(openImpersonation(noTarget, impersonateKey, Date.now()), null);
});

test("cookie helpers set HttpOnly/SameSite/Path and Secure only when asked", () => {
  const secure = setCookie("portal_session", "v v", { path: "/", maxAge: 100, secure: true });
  assert.match(secure, /^portal_session=v%20v; HttpOnly; SameSite=Lax; Path=\/; Secure; Max-Age=100$/);
  const insecure = setCookie("portal_oidc_tmp", "x", { path: "/auth", maxAge: 600, secure: false });
  assert.ok(!insecure.includes("Secure"));
  assert.match(clearCookie("portal_session", "/", true), /Max-Age=0/);
});

test("readCookie extracts a named cookie and survives other pairs", () => {
  const header = "a=1; portal_session=abc.def; webuiuser=EVIL";
  assert.equal(readCookie(header, "portal_session"), "abc.def");
  assert.equal(readCookie(header, "missing"), null);
  assert.equal(readCookie(undefined, "portal_session"), null);
});

test("safeEqual is length-aware and value-correct", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
});

test("sanitizeReturnTo with an apps domain admits exactly one-label app subdomains", () => {
  const origin = "https://agent.example.com";
  const apps = "apps.agent.example.com";
  assert.equal(
    sanitizeReturnTo("https://mysite.apps.agent.example.com/consultants?x=1", origin, apps),
    "https://mysite.apps.agent.example.com/consultants?x=1",
  );
  for (const bad of [
    "https://evil.com/?u=.apps.agent.example.com",
    "https://apps.agent.example.com/",
    "https://a.b.apps.agent.example.com/",
    "https://evilapps.agent.example.com/",
    "https://mysite.apps.agent.example.evil.com/",
    "http://mysite.apps.agent.example.com/",
    "https://user:pw@mysite.apps.agent.example.com/",
  ]) {
    assert.equal(sanitizeReturnTo(bad, origin, apps), "/", `expected "/" for ${bad}`);
  }
  assert.equal(
    sanitizeReturnTo("https://mysite.apps.agent.example.com/x", origin),
    "/",
    "no apps domain configured ⇒ same-origin only",
  );
  assert.equal(sanitizeReturnTo("/web-ui/?x=1", origin, apps), "/web-ui/?x=1", "portal-relative paths still pass");
});

test("setCookie/clearCookie carry a Domain attribute only when asked", () => {
  assert.match(
    setCookie("portal_session", "v", { secure: true, domain: "agent.example.com" }),
    /; Domain=agent\.example\.com;/,
  );
  assert.doesNotMatch(setCookie("portal_session", "v", { secure: true }), /Domain=/);
  assert.match(clearCookie("portal_session", "/", true, "agent.example.com"), /; Domain=agent\.example\.com;/);
  assert.doesNotMatch(clearCookie("portal_session", "/", true), /Domain=/);
});

test("sanitizeReturnTo accepts same-origin paths and rejects redirect escapes", () => {
  const origin = "https://agent.example.com";
  assert.equal(sanitizeReturnTo("/web-ui/?x=1", origin), "/web-ui/?x=1");
  assert.equal(sanitizeReturnTo("/", origin), "/");
  for (const bad of [
    "//evil.com",
    "/\\evil.com",
    "\\\\evil.com",
    "https://evil.com",
    "https:/evil.com",
    "/%2f%2fevil.com",
    "/%5cevil",
    "/	//evil",
    "",
    "x/y",
    null,
  ]) {
    assert.equal(sanitizeReturnTo(bad, origin), "/", `expected "/" for ${JSON.stringify(bad)}`);
  }
});
