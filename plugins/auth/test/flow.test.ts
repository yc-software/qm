import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ClaimStoreUnavailableError } from "../../chassis/src/claims.ts";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JWK } from "jose";
import {
  authorizeQuery,
  basicAuth,
  CLIENT_ID,
  CLIENT_SECRET,
  hiddenRequestToken,
  ISSUER,
  linkFrom,
  memoryClaimStore,
  pkcePair,
  REDIRECT_URI,
  refusingClaimStore,
  startHarness,
  type Harness,
} from "./helpers.ts";

const form = (entries: Record<string, string>): { method: string; headers: Record<string, string>; body: string } => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(entries).toString(),
});

async function requestLink(
  h: Harness,
  over: Record<string, string> = {},
): Promise<{ verifier: string; state: string }> {
  const { email, clientIp, ...params } = over;
  const { verifier, challenge } = pkcePair();
  const query = authorizeQuery({ code_challenge: challenge, ...params });
  const page = await fetch(`${h.base}/authorize?${query}`);
  assert.equal(page.status, 200, "authorize should render the email form");
  const request = hiddenRequestToken(await page.text());
  const submit = form({ request, email: email ?? "admin@example.com" });
  const submitted = await fetch(`${h.base}/authorize`, {
    ...submit,
    headers: { ...submit.headers, ...(clientIp ? { "x-qm-client-ip": clientIp } : {}) },
  });
  assert.equal(submitted.status, 200);
  await h.settle();
  return { verifier, state: query.get("state")! };
}

function localLink(h: Harness, link: string): string {
  const url = new URL(link);
  return `${h.base}/verify${url.search}`;
}

function tokenOf(link: string): string {
  return new URLSearchParams(new URL(link).hash.slice(1)).get("token")!;
}

async function openLink(h: Harness, link: string): Promise<Response> {
  const confirm = await fetch(localLink(h, link));
  if (confirm.status !== 200) return confirm;
  return fetch(`${h.base}/verify`, { ...form({ token: tokenOf(link) }), redirect: "manual" });
}

async function redeem(h: Harness): Promise<string> {
  const response = await fetch(`${h.base}/verify`, {
    ...form({ token: tokenOf(linkFrom(h.mailer)) }),
    redirect: "manual",
  });
  assert.equal(response.status, 302, await response.text());
  return response.headers.get("location")!;
}

async function exchange(
  h: Harness,
  code: string,
  verifier: string,
  over: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${h.base}/token`, {
    ...form({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: verifier, ...over }),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: over.authorization ?? basicAuth(CLIENT_ID, CLIENT_SECRET),
    },
  });
}

async function verifyIdTokenLikePortal(h: Harness, idToken: string, nonce: string): Promise<Record<string, unknown>> {
  const jwks = (await (await fetch(`${h.base}/.well-known/jwks.json`)).json()) as { keys: JWK[] };
  const { payload } = await jwtVerify(idToken, createLocalJWKSet(jwks), {
    issuer: ISSUER,
    audience: CLIENT_ID,
    algorithms: ["RS256", "ES256", "EdDSA"],
    requiredClaims: ["sub", "iat", "exp", "nonce"],
    clockTolerance: 5,
  });
  assert.equal(payload.nonce, nonce);
  assert.equal(payload.azp, CLIENT_ID);
  return payload as Record<string, unknown>;
}

test("the whole authorization-code flow the portal drives succeeds", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());

  const { verifier, state } = await requestLink(h);
  assert.equal(h.mailer.sent.length, 1);
  assert.equal(h.mailer.sent[0]!.to, "admin@example.com");

  const location = new URL(await redeem(h));
  assert.equal(`${location.origin}${location.pathname}`, REDIRECT_URI);
  assert.equal(location.searchParams.get("state"), state);
  const code = location.searchParams.get("code")!;

  const tokens = await exchange(h, code, verifier);
  assert.equal(tokens.status, 200);
  const body = (await tokens.json()) as {
    id_token: string;
    access_token: string;
    token_type: string;
    expires_in: number;
  };
  assert.equal(body.token_type, "Bearer");
  assert.equal(decodeProtectedHeader(body.id_token).alg, "ES256");

  const claims = await verifyIdTokenLikePortal(h, body.id_token, "nonce-value");
  assert.equal(claims.email, "admin@example.com");
  assert.equal(claims.email_verified, true);

  const info = await fetch(`${h.base}/userinfo`, { headers: { authorization: `Bearer ${body.access_token}` } });
  assert.equal(info.status, 200);
  const userinfo = (await info.json()) as { sub: string; email: string; email_verified: boolean };
  assert.equal(userinfo.sub, claims.sub, "userinfo sub must equal the id_token sub — the portal rejects a mismatch");
  assert.equal(userinfo.email, "admin@example.com");
  assert.equal(userinfo.email_verified, true);
});

test("without email delivery, sign-in pages explain the configuration instead of claiming to send a link", async (t) => {
  const h = await startHarness({ env: { RESEND_API_KEY: undefined } });
  t.after(() => h.close());

  const page = await fetch(`${h.base}/authorize?${authorizeQuery()}`);
  const submitted = await fetch(`${h.base}/authorize`, form({ email: "admin@example.com" }));
  for (const response of [page, submitted]) {
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const html = await response.text();
    assert.match(html, /Email delivery isn&#39;t configured/);
    assert.doesNotMatch(html, /<form|Check your email|link is on its way/);
  }
  await h.settle();
  assert.deepEqual(h.mailer.sent, []);
  assert.deepEqual(h.claims.calls, []);
  assert.equal((await fetch(`${h.base}/healthz`)).status, 200);
});

test("removing email delivery does not invalidate already issued sign-in links", async (t) => {
  const configured = await startHarness();
  t.after(() => configured.close());
  const { verifier } = await requestLink(configured);
  const link = linkFrom(configured.mailer);
  const h = await startHarness({
    env: { AUTH_EMAIL_FROM: undefined, RESEND_API_KEY: undefined },
    claims: configured.claims,
  });
  t.after(() => h.close());

  const verified = await openLink(h, link);
  assert.equal(verified.status, 302);
  const code = new URL(verified.headers.get("location")!).searchParams.get("code")!;
  const exchanged = await exchange(h, code, verifier);
  assert.equal(exchanged.status, 200);
  const tokens = (await exchanged.json()) as { id_token: string; access_token: string };
  const claims = await verifyIdTokenLikePortal(h, tokens.id_token, "nonce-value");
  assert.equal(claims.email, "admin@example.com");
  const info = await fetch(`${h.base}/userinfo`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
  assert.equal(info.status, 200);
  assert.equal((await openLink(h, link)).status, 400);
});

test("a replayed magic link is refused", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  await requestLink(h);
  const link = linkFrom(h.mailer);
  assert.equal((await fetch(localLink(h, link))).status, 200, "opening the link only offers to finish sign-in");
  assert.equal(
    h.claims.calls.some((ids) => ids[0]?.startsWith("link:")),
    false,
    "a mail scanner following the link must not spend it",
  );
  assert.equal((await openLink(h, link)).status, 302);
  const replay = await openLink(h, link);
  assert.equal(replay.status, 400);
  const stale = await replay.text();
  assert.match(stale, /no longer works/);
  assert.match(stale, /href="https:\/\/agent\.example\.test\/auth\/login"/);
});

test("a replayed authorization code is refused", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const { verifier } = await requestLink(h);
  const code = new URL(await redeem(h)).searchParams.get("code")!;
  assert.equal((await exchange(h, code, verifier)).status, 200);
  const replay = await exchange(h, code, verifier);
  assert.equal(replay.status, 400);
  assert.deepEqual(await replay.json(), { error: "invalid_grant" });
});

test("an expired magic link is refused", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  await requestLink(h);
  const link = linkFrom(h.mailer);
  h.now.ms += (h.cfg.linkTtlS + 60) * 1000;
  const late = await openLink(h, link);
  assert.equal(late.status, 400);
  assert.match(await late.text(), /href="https:\/\/agent\.example\.test\/auth\/login"/);
  assert.equal(
    h.claims.calls.some((ids) => ids[0]?.startsWith("link:")),
    false,
    "an expired link must not consume a claim",
  );
});

test("an expired authorization code is refused", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const { verifier } = await requestLink(h);
  const code = new URL(await redeem(h)).searchParams.get("code")!;
  h.now.ms += (h.cfg.codeTtlS + 60) * 1000;
  assert.equal((await exchange(h, code, verifier)).status, 400);
});

test("a mismatched PKCE verifier is refused and the code is still burned", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const { verifier } = await requestLink(h);
  const code = new URL(await redeem(h)).searchParams.get("code")!;
  const wrong = await exchange(h, code, pkcePair().verifier);
  assert.equal(wrong.status, 400);
  assert.deepEqual(await wrong.json(), { error: "invalid_grant" });
  assert.equal(
    (await exchange(h, code, verifier)).status,
    400,
    "a code offered with a bad verifier must not be reusable",
  );
});

test("a missing PKCE verifier is refused", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  await requestLink(h);
  const code = new URL(await redeem(h)).searchParams.get("code")!;
  const response = await fetch(`${h.base}/token`, {
    ...form({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI }),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: basicAuth(CLIENT_ID, CLIENT_SECRET),
    },
  });
  assert.equal(response.status, 400);
});

test("authorize refuses plain PKCE, an unknown client, and a foreign redirect_uri", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const cases: Array<[Record<string, string>, RegExp]> = [
    [{ code_challenge_method: "plain" }, /PKCE with S256/],
    [{ client_id: "someone-else" }, /unknown application/],
    [{ redirect_uri: "https://evil.example.com/auth/callback" }, /not registered/],
    [{ response_type: "token" }, /authorization-code flow/],
    [{ scope: "email" }, /openid scope/],
    [{ state: "" }, /missing its state/],
    [{ nonce: "" }, /missing its nonce/],
  ];
  for (const [over, expected] of cases) {
    const response = await fetch(`${h.base}/authorize?${authorizeQuery(over)}`);
    assert.equal(response.status, 400, JSON.stringify(over));
    assert.match(await response.text(), expected, JSON.stringify(over));
  }
});

test("the token endpoint refuses a wrong client secret and a wrong redirect_uri", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const { verifier } = await requestLink(h);
  const code = new URL(await redeem(h)).searchParams.get("code")!;

  const badSecret = await exchange(h, code, verifier, { authorization: basicAuth(CLIENT_ID, "not-the-secret") });
  assert.equal(badSecret.status, 401);
  assert.deepEqual(await badSecret.json(), { error: "invalid_client" });

  const noCredentials = await fetch(
    `${h.base}/token`,
    form({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: verifier }),
  );
  assert.equal(noCredentials.status, 401);

  const badRedirect = await exchange(h, code, verifier, { redirect_uri: "https://evil.example.com/auth/callback" });
  assert.equal(badRedirect.status, 400);

  assert.equal(
    (await exchange(h, code, verifier)).status,
    200,
    "rejected attempts must not burn the code before it is honoured",
  );
});

test("a tampered id_token signature does not verify", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const { verifier } = await requestLink(h);
  const code = new URL(await redeem(h)).searchParams.get("code")!;
  const body = (await (await exchange(h, code, verifier)).json()) as { id_token: string };
  const [header, payload, signature] = body.id_token.split(".");
  const flipped = `${signature!.slice(0, -2)}${signature!.endsWith("AA") ? "BB" : "AA"}`;
  await assert.rejects(() => verifyIdTokenLikePortal(h, `${header}.${payload}.${flipped}`, "nonce-value"));

  const decoded = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as Record<string, unknown>;
  const forged = `${header}.${Buffer.from(JSON.stringify({ ...decoded, email: "attacker@example.com" })).toString("base64url")}.${signature}`;
  await assert.rejects(() => verifyIdTokenLikePortal(h, forged, "nonce-value"));
});

test("a tampered authorization code does not open", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const { verifier } = await requestLink(h);
  const code = new URL(await redeem(h)).searchParams.get("code")!;
  const [header, payload, signature] = code.split(".");
  const decoded = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as Record<string, unknown>;
  const forged = `${header}.${Buffer.from(JSON.stringify({ ...decoded, em: "attacker@example.com" })).toString("base64url")}.${signature}`;
  assert.equal((await exchange(h, forged, verifier)).status, 400);
});

test("an address outside the allowlist is never emailed and never redeemed", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  await requestLink(h, { email: "stranger@example.org" });
  assert.equal(h.mailer.sent.length, 0, "a disallowed address must not receive a link");

  const permitted = await startHarness({ env: { AUTH_ALLOWED_EMAILS: "stranger@example.org" } });
  t.after(() => permitted.close());
  await requestLink(permitted, { email: "stranger@example.org" });
  const link = linkFrom(permitted.mailer);

  const narrowed = await startHarness({ env: { AUTH_ALLOWED_EMAILS: "admin@example.com" } });
  t.after(() => narrowed.close());
  const refused = await openLink(narrowed, link);
  assert.notEqual(refused.status, 302, "a link minted for an address that is no longer allowed must not redeem");
});

test("an invited external address signs in through core's answer and an uninvited one does not", async (t) => {
  const invited = new Set(["guest@partner.test"]);
  const asked: string[] = [];
  const h = await startHarness({
    emailAllowed: async (email) => {
      asked.push(email);
      return invited.has(email);
    },
  });
  t.after(() => h.close());

  await requestLink(h, { email: "admin@example.com" });
  assert.deepEqual(asked, [], "an address on the env allow-list never consults core");

  const { verifier } = await requestLink(h, { email: "guest@partner.test" });
  assert.equal(h.mailer.sent.length, 2);
  assert.equal(h.mailer.sent[1]!.to, "guest@partner.test");
  assert.deepEqual(asked, ["guest@partner.test"]);
  const code = new URL(await redeem(h)).searchParams.get("code")!;
  const tokens = await exchange(h, code, verifier);
  assert.equal(tokens.status, 200);
  const claims = await verifyIdTokenLikePortal(
    h,
    ((await tokens.json()) as { id_token: string }).id_token,
    "nonce-value",
  );
  assert.equal(claims.email, "guest@partner.test");

  await requestLink(h, { email: "stranger@partner.test" });
  assert.equal(h.mailer.sent.length, 2, "an address core does not know must not receive a link");

  await requestLink(h, { email: "guest@partner.test" });
  invited.clear();
  const revoked = await fetch(`${h.base}/verify`, {
    ...form({ token: tokenOf(linkFrom(h.mailer)) }),
    redirect: "manual",
  });
  assert.equal(revoked.status, 403, "a link minted before the invitation was revoked must not redeem");
});

test("the confirmation page is identical for permitted and unknown addresses", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const bodyFor = async (email: string): Promise<string> => {
    const page = await fetch(`${h.base}/authorize?${authorizeQuery()}`);
    const request = hiddenRequestToken(await page.text());
    const submitted = await fetch(`${h.base}/authorize`, form({ request, email }));
    await h.settle();
    return (await submitted.text()).replace(email, "<address>");
  };
  assert.equal(await bodyFor("admin@example.com"), await bodyFor("nobody@elsewhere.test"));
});

test("an email domain allowlist admits the domain and nothing else", async (t) => {
  const h = await startHarness({ env: { AUTH_ALLOWED_EMAILS: undefined, AUTH_ALLOWED_EMAIL_DOMAIN: "example.com" } });
  t.after(() => h.close());
  await requestLink(h, { email: "anyone@example.com" });
  assert.equal(h.mailer.sent.length, 1);
  await requestLink(h, { email: "anyone@notexample.com" });
  assert.equal(h.mailer.sent.length, 1, "a lookalike domain must not be admitted");
});

test("link sends are rate limited per mailbox and per client address", async (t) => {
  const h = await startHarness({ env: { AUTH_SEND_LIMIT_PER_EMAIL: "2", AUTH_SEND_LIMIT_PER_IP: "50" } });
  t.after(() => h.close());
  for (let attempt = 0; attempt < 4; attempt++) await requestLink(h);
  assert.equal(h.mailer.sent.length, 2, "the third and fourth link for one mailbox must be dropped");
  h.now.ms += (h.cfg.sendWindowS + 1) * 1000;
  await requestLink(h);
  assert.equal(h.mailer.sent.length, 3, "a fresh window lets sending resume");

  const perIp = await startHarness({
    env: { AUTH_SEND_LIMIT_PER_IP: "1", AUTH_ALLOWED_EMAIL_DOMAIN: "example.com", AUTH_ALLOWED_EMAILS: undefined },
  });
  t.after(() => perIp.close());
  await requestLink(perIp, { email: "one@example.com" });
  await requestLink(perIp, { email: "two@example.com" });
  assert.equal(perIp.mailer.sent.length, 1, "a single client address cannot fan out across mailboxes");
});

test("rate-limit slot ids are unguessable to another holder of the core signing secret", async (t) => {
  const claims = memoryClaimStore();
  const h = await startHarness({ claims });
  t.after(() => h.close());
  await requestLink(h);
  const ids = claims.calls.flat();
  assert.ok(
    ids.some((id) => id.startsWith("rate:")),
    "rate limiting goes through the durable claim store",
  );
  for (const id of ids) {
    assert.ok(!id.includes("admin@example.com"), id);
    assert.ok(
      !id.includes(createHash("sha256").update("admin@example.com").digest("base64url").slice(0, 22)),
      "a plain digest of the address would be computable offline",
    );
  }
});

test("the broker fails closed when core cannot record a single-use claim", async (t) => {
  const claims = { ...refusingClaimStore(), calls: [] as string[][] };
  const h = await startHarness({ claims });
  t.after(() => h.close());
  const { verifier: _verifier } = await requestLink(h);
  assert.equal(h.mailer.sent.length, 0, "with no durable rate-limit slot the send is suppressed");

  const permissive = await startHarness();
  t.after(() => permissive.close());
  await requestLink(permissive);
  const link = linkFrom(permissive.mailer);
  const failing = await startHarness({ claims: { ...refusingClaimStore(), calls: [] } });
  t.after(() => failing.close());
  const response = await openLink(failing, link);
  assert.notEqual(response.status, 302, "an unrecordable link claim must not mint a code");
});

test("a core outage reads as an outage, never as a rate limit or a stale link", async (t) => {
  const unavailable = {
    calls: [] as string[][],
    async claimFirst(): Promise<string | null> {
      throw new ClaimStoreUnavailableError("core claim store unreachable: fetch failed");
    },
  };
  const h = await startHarness({ claims: unavailable });
  t.after(() => h.close());
  await requestLink(h);
  assert.equal(h.mailer.sent.length, 0, "sign-in fails closed while core is down");

  const healthy = await startHarness();
  t.after(() => healthy.close());
  await requestLink(healthy);
  const link = linkFrom(healthy.mailer);
  const downMidVerify = await startHarness({
    claims: unavailable,
    env: { AUTH_SIGNING_JWK: healthy.cfg.signingJwk ? JSON.stringify(healthy.cfg.signingJwk) : undefined },
  });
  t.after(() => downMidVerify.close());
  const response = await openLink(downMidVerify, link);
  assert.equal(response.status, 503, "an outage is a retryable 503, not the dead-end stale-link page");
  assert.match(await response.text(), /temporarily unavailable/i);
});

test("the sign-in link is single-use across broker instances that share the claim store", async (t) => {
  const claims = memoryClaimStore();
  const first = await startHarness({ claims });
  const second = await startHarness({
    claims,
    env: { AUTH_SIGNING_JWK: first.cfg.signingJwk ? JSON.stringify(first.cfg.signingJwk) : undefined },
  });
  t.after(() => first.close());
  t.after(() => second.close());
  await requestLink(first);
  const link = linkFrom(first.mailer);
  assert.equal((await openLink(first, link)).status, 302);
  assert.equal((await openLink(second, link)).status, 400, "a second instance must see the link as spent");
});

test("discovery, JWKS, and health answer without credentials", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  assert.deepEqual(await (await fetch(`${h.base}/healthz`)).json(), { ok: true });
  const jwks = (await (await fetch(`${h.base}/.well-known/jwks.json`)).json()) as {
    keys: Array<Record<string, unknown>>;
  };
  assert.equal(jwks.keys.length, 1);
  assert.equal(jwks.keys[0]!.d, undefined, "the private component must never be published");
  assert.equal(jwks.keys[0]!.alg, "ES256");
  const discovery = (await (await fetch(`${h.base}/.well-known/openid-configuration`)).json()) as Record<
    string,
    unknown
  >;
  assert.equal(discovery.issuer, ISSUER);
  assert.deepEqual(discovery.code_challenge_methods_supported, ["S256"]);
});

test("sign-in pages never cache and never leak a referrer", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const page = await fetch(`${h.base}/authorize?${authorizeQuery()}`);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.match(page.headers.get("content-security-policy") ?? "", /form-action 'self'/);
  await requestLink(h);
  const redirect = await fetch(`${h.base}/verify`, {
    ...form({ token: tokenOf(linkFrom(h.mailer)) }),
    redirect: "manual",
  });
  assert.equal(redirect.headers.get("cache-control"), "no-store");
  assert.equal(redirect.headers.get("referrer-policy"), "no-referrer");
});

test("userinfo refuses a missing, malformed, or expired access token", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  assert.equal((await fetch(`${h.base}/userinfo`)).status, 401);
  assert.equal((await fetch(`${h.base}/userinfo`, { headers: { authorization: "Bearer nope" } })).status, 401);
  const { verifier } = await requestLink(h);
  const code = new URL(await redeem(h)).searchParams.get("code")!;
  const body = (await (await exchange(h, code, verifier)).json()) as { access_token: string };
  h.now.ms += (h.cfg.accessTtlS + 60) * 1000;
  assert.equal(
    (await fetch(`${h.base}/userinfo`, { headers: { authorization: `Bearer ${body.access_token}` } })).status,
    401,
  );
});

test("a stale sign-in form is refused rather than silently reissued", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const page = await fetch(`${h.base}/authorize?${authorizeQuery()}`);
  const request = hiddenRequestToken(await page.text());
  h.now.ms += (h.cfg.requestTtlS + 60) * 1000;
  const submitted = await fetch(`${h.base}/authorize`, form({ request, email: "admin@example.com" }));
  assert.equal(submitted.status, 400);
  assert.match(await submitted.text(), /expired/);
});

test("the sign-in link never puts its token anywhere a server or proxy logs it", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  await requestLink(h);
  const link = new URL(linkFrom(h.mailer));

  assert.equal(link.search, "", "no query string — the request target is what lands in an access log");
  assert.match(link.hash, /^#token=/, "the token rides in the fragment, which browsers never send to a server");
  const token = tokenOf(link.href);
  assert.ok(token.length > 0);

  const confirm = await fetch(`${h.base}/verify`);
  assert.equal(confirm.status, 200, "the query-less URL a scanner or proxy sees still renders the confirmation");
  const page = await confirm.text();
  assert.ok(!page.includes(token), "the page the server renders cannot contain a token it was never sent");
  assert.match(page, /location\.hash/, "the browser moves the token from the fragment into the form");
  assert.match(page, /history\.replaceState/, "and drops it out of the address bar and history entry");
  assert.match(confirm.headers.get("content-security-policy") ?? "", /script-src 'sha256-/);
  assert.equal(
    h.claims.calls.some((ids) => ids[0]?.startsWith("link:")),
    false,
    "and none of that spends the link",
  );

  const spent = await fetch(`${h.base}/verify`, { ...form({ token }), redirect: "manual" });
  assert.equal(spent.status, 302);
  const replay = await fetch(`${h.base}/verify`, { ...form({ token }), redirect: "manual" });
  assert.equal(replay.status, 400, "a token recovered after the fact is already spent");
});

test("a confirmation page reached without a fragment cannot mint anything", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  await requestLink(h);
  const empty = await fetch(`${h.base}/verify`, { ...form({ token: "" }), redirect: "manual" });
  assert.equal(empty.status, 400);
  assert.equal(
    h.claims.calls.some((ids) => ids[0]?.startsWith("link:")),
    false,
    "an empty confirmation must not spend the outstanding link",
  );
});

test("the per-mailbox send limit holds when the client address changes", async (t) => {
  const h = await startHarness({ env: { AUTH_SEND_LIMIT_PER_EMAIL: "2", AUTH_SEND_LIMIT_PER_IP: "50" } });
  t.after(() => h.close());
  for (const clientIp of ["203.0.113.1", "203.0.113.2", "203.0.113.3", "203.0.113.4"]) {
    await requestLink(h, { clientIp });
  }
  assert.equal(h.mailer.sent.length, 2, "rotating the source address must not reset a per-mailbox budget");
});

test("a live brandName accessor overrides the env default on pages and emails", async (t) => {
  let live = "";
  const h = await startHarness({ brandName: () => live || "qm" });
  t.after(() => h.close());

  const { challenge } = pkcePair();
  const query = authorizeQuery({ code_challenge: challenge });
  const before = await (await fetch(`${h.base}/authorize?${query}`)).text();
  assert.match(before, /Sign in to qm/);

  live = "straylight";
  const after = await (
    await fetch(`${h.base}/authorize?${authorizeQuery({ code_challenge: pkcePair().challenge })}`)
  ).text();
  assert.match(after, /Sign in to straylight/);
  assert.doesNotMatch(after, /Sign in to qm/);

  await requestLink(h);
  assert.match(h.mailer.sent[0]!.subject, /straylight/);
});
