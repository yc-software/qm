import test from "node:test";
import assert from "node:assert/strict";
import { createLocalJWKSet, jwtVerify, type JWK } from "jose";
import { hashPassword } from "../src/password.ts";
import {
  authorizeQuery,
  basicAuth,
  CLIENT_ID,
  CLIENT_SECRET,
  hiddenRequestToken,
  ISSUER,
  pkcePair,
  REDIRECT_URI,
  refusingClaimStore,
  startHarness,
  type Harness,
} from "./helpers.ts";

const PASSWORD = "correct horse battery staple";
const HASH = await hashPassword(PASSWORD);
const USERS = `admin@example.com:${HASH}`;

const form = (entries: Record<string, string>, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
  body: new URLSearchParams(entries).toString(),
  redirect: "manual",
});

async function signInPage(h: Harness, challenge: string): Promise<{ html: string; request: string; state: string }> {
  const query = authorizeQuery({ code_challenge: challenge });
  const page = await fetch(`${h.base}/authorize?${query}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  return { html, request: hiddenRequestToken(html), state: query.get("state")! };
}

async function submitPassword(
  h: Harness,
  fields: { email: string; password: string; ip?: string },
): Promise<{ response: Response; verifier: string; state: string }> {
  const { verifier, challenge } = pkcePair();
  const { request, state } = await signInPage(h, challenge);
  const response = await fetch(
    `${h.base}/authorize`,
    form(
      { request, method: "password", email: fields.email, password: fields.password },
      fields.ip ? { "x-qm-client-ip": fields.ip } : {},
    ),
  );
  return { response, verifier, state };
}

async function exchange(h: Harness, code: string, verifier: string): Promise<Response> {
  return fetch(`${h.base}/token`, {
    ...form({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: verifier }),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: basicAuth(CLIENT_ID, CLIENT_SECRET),
    },
  });
}

test("password sign-in completes the same authorization-code flow and mints the same tokens", async (t) => {
  const h = await startHarness({ env: { AUTH_PASSWORD_USERS: USERS, RESEND_API_KEY: undefined } });
  t.after(() => h.close());

  const { response, verifier, state } = await submitPassword(h, { email: "Admin@Example.com", password: PASSWORD });
  assert.equal(response.status, 302, await response.text());
  const location = new URL(response.headers.get("location")!);
  assert.equal(`${location.origin}${location.pathname}`, REDIRECT_URI);
  assert.equal(location.searchParams.get("state"), state);
  assert.match(
    response.headers.get("set-cookie") ?? "",
    /^qm_idp_session=.*HttpOnly; Secure; SameSite=Lax; Path=\/idp/,
  );
  assert.equal(h.remembered.size, 1);

  const tokens = await exchange(h, location.searchParams.get("code")!, verifier);
  assert.equal(tokens.status, 200);
  const body = (await tokens.json()) as { id_token: string; access_token: string };
  const jwks = (await (await fetch(`${h.base}/.well-known/jwks.json`)).json()) as { keys: JWK[] };
  const { payload } = await jwtVerify(body.id_token, createLocalJWKSet(jwks), { issuer: ISSUER, audience: CLIENT_ID });
  assert.equal(payload.email, "admin@example.com");
  assert.equal(payload.email_verified, true);
  assert.equal(payload.auth_time, Math.floor(h.now.ms / 1000));
  const info = await fetch(`${h.base}/userinfo`, { headers: { authorization: `Bearer ${body.access_token}` } });
  assert.equal(((await info.json()) as { email: string }).email, "admin@example.com");
  assert.deepEqual(h.mailer.sent, []);
});

test("the sign-in page offers only the configured methods", async (t) => {
  const both = await startHarness({ env: { AUTH_PASSWORD_USERS: USERS } });
  t.after(() => both.close());
  const bothHtml = (await signInPage(both, pkcePair().challenge)).html;
  assert.match(bothHtml, /type="password"/);
  assert.match(bothHtml, /Email me a sign-in link/);
  assert.match(bothHtml, /meant for getting started/);
  assert.doesNotMatch(bothHtml, /scrypt\$/);

  const passwordOnly = await startHarness({ env: { AUTH_PASSWORD_USERS: USERS, RESEND_API_KEY: undefined } });
  t.after(() => passwordOnly.close());
  const passwordHtml = (await signInPage(passwordOnly, pkcePair().challenge)).html;
  assert.match(passwordHtml, /type="password"/);
  assert.doesNotMatch(passwordHtml, /Email me a sign-in link/);

  const emailOnly = await startHarness();
  t.after(() => emailOnly.close());
  const emailHtml = (await signInPage(emailOnly, pkcePair().challenge)).html;
  assert.doesNotMatch(emailHtml, /type="password"/);
  assert.match(emailHtml, /Email me a sign-in link/);
  const { request } = await signInPage(emailOnly, pkcePair().challenge);
  const refused = await fetch(
    `${emailOnly.base}/authorize`,
    form({ request, method: "password", email: "admin@example.com", password: PASSWORD }),
  );
  assert.equal(refused.status, 503);
  assert.match(await refused.text(), /Password sign-in isn&#39;t configured/);
  assert.equal(emailOnly.remembered.size, 0);
});

test("a wrong password, an unknown account, and an unlisted email all fail the same way", async (t) => {
  const h = await startHarness({
    env: { AUTH_PASSWORD_USERS: `${USERS},outsider@else.com:${HASH}`, RESEND_API_KEY: undefined },
  });
  t.after(() => h.close());
  const attempts = [
    { email: "admin@example.com", password: `${PASSWORD}!` },
    { email: "nobody@example.com", password: PASSWORD },
    { email: "outsider@else.com", password: PASSWORD },
  ];
  const bodies: string[] = [];
  for (const attempt of attempts) {
    const { response } = await submitPassword(h, attempt);
    assert.equal(response.status, 401);
    const html = await response.text();
    assert.match(html, /email address or password is incorrect/);
    assert.match(html, /name="request" value="/);
    bodies.push(html.replace(/name="request" value="[^"]+"/g, "").replace(/value="[^"]*@[^"]*"/g, ""));
  }
  assert.equal(new Set(bodies).size, 1, "responses must not reveal which accounts exist");
  assert.equal(h.remembered.size, 0);
  assert.deepEqual(h.claims.calls.length, 6, "every attempt consumes an ip slot and an account slot");
});

test("password attempts are rate limited per account and per client address", async (t) => {
  const h = await startHarness({
    env: {
      AUTH_PASSWORD_USERS: USERS,
      RESEND_API_KEY: undefined,
      AUTH_PASSWORD_LIMIT_PER_EMAIL: "2",
      AUTH_PASSWORD_LIMIT_PER_IP: "3",
    },
  });
  t.after(() => h.close());
  const wrong = { email: "admin@example.com", password: "not the password" };
  assert.equal((await submitPassword(h, { ...wrong, ip: "10.0.0.1" })).response.status, 401);
  assert.equal((await submitPassword(h, { ...wrong, ip: "10.0.0.2" })).response.status, 401);
  const locked = await submitPassword(h, { email: "admin@example.com", password: PASSWORD, ip: "10.0.0.3" });
  assert.equal(locked.response.status, 429, "the right password no longer helps once the account budget is spent");
  assert.match(await locked.response.text(), /Too many sign-in attempts/);
  assert.equal(h.remembered.size, 0);

  for (let i = 0; i < 3; i++) {
    await submitPassword(h, { email: `user${i}@example.com`, password: "whatever it is", ip: "10.0.0.9" });
  }
  const perIp = await submitPassword(h, { email: "user9@example.com", password: "whatever it is", ip: "10.0.0.9" });
  assert.equal(perIp.response.status, 429);

  h.now.ms += h.cfg.sendWindowS * 1000 + 1;
  const fresh = await submitPassword(h, { email: "admin@example.com", password: PASSWORD, ip: "10.0.0.3" });
  assert.equal(fresh.response.status, 302);
});

test("password sign-in fails closed when core cannot record attempt claims", async (t) => {
  const h = await startHarness({
    env: { AUTH_PASSWORD_USERS: USERS, RESEND_API_KEY: undefined },
    claims: Object.assign(refusingClaimStore(), {
      calls: [] as string[][],
      async claimFirst(): Promise<string | null> {
        throw new (await import("../../chassis/src/claims.ts")).ClaimStoreUnavailableError("down");
      },
    }),
  });
  t.after(() => h.close());
  const { response } = await submitPassword(h, { email: "admin@example.com", password: PASSWORD });
  assert.equal(response.status, 503);
  assert.equal(h.remembered.size, 0);
});

test("missing fields and a stale form are refused without touching the rate limits", async (t) => {
  const h = await startHarness({ env: { AUTH_PASSWORD_USERS: USERS, RESEND_API_KEY: undefined } });
  t.after(() => h.close());
  const { request } = await signInPage(h, pkcePair().challenge);
  const blank = await fetch(
    `${h.base}/authorize`,
    form({ request, method: "password", email: "admin@example.com", password: "" }),
  );
  assert.equal(blank.status, 400);
  const badEmail = await fetch(
    `${h.base}/authorize`,
    form({ request, method: "password", email: "admin", password: PASSWORD }),
  );
  assert.equal(badEmail.status, 400);
  assert.deepEqual(h.claims.calls, []);
  const stale = await fetch(
    `${h.base}/authorize`,
    form({ request: "nope", method: "password", email: "admin@example.com", password: PASSWORD }),
  );
  assert.equal(stale.status, 400);
  assert.match(await stale.text(), /sign-in page expired/);
});

test("a remembered browser from a password sign-in silently reauthorizes like an email one", async (t) => {
  const h = await startHarness({ env: { AUTH_PASSWORD_USERS: USERS, RESEND_API_KEY: undefined } });
  t.after(() => h.close());
  const { response } = await submitPassword(h, { email: "admin@example.com", password: PASSWORD });
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  h.now.ms += 60000;
  const again = await fetch(`${h.base}/authorize?${authorizeQuery({ state: "again" })}`, {
    headers: { cookie },
    redirect: "manual",
  });
  assert.equal(again.status, 302);
  assert.equal(new URL(again.headers.get("location")!).searchParams.get("state"), "again");
});
