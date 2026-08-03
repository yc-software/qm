import test from "node:test";
import assert from "node:assert/strict";
import { TokenSigner } from "../src/tokens.ts";
import { catalogProblems } from "../../chassis/src/locale.ts";
import { AUTH_MESSAGES } from "../src/messages.ts";
import { problemPage } from "../src/pages.ts";
import { authorizeQuery, CLIENT_ID, hiddenRequestToken, pkcePair, REDIRECT_URI, startHarness } from "./helpers.ts";

const form = (entries: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(entries),
});

async function requestToken(h: Awaited<ReturnType<typeof startHarness>>, locale: string): Promise<string> {
  const page = await fetch(`${h.base}/authorize?${authorizeQuery()}`, {
    headers: { "x-qm-locale": locale },
  });
  assert.equal(page.status, 200);
  return hiddenRequestToken(await page.text());
}

test("a Japanese authorize request keeps Japanese through the signed request, page, and email", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const { challenge } = pkcePair();
  const query = authorizeQuery({ code_challenge: challenge });
  const page = await fetch(`${h.base}/authorize?${query}`, {
    headers: { "x-qm-locale": "ja" },
  });
  const html = await page.text();
  assert.match(html, /<html lang="ja">/);
  assert.match(html, /サインイン/);
  const request = hiddenRequestToken(html);
  await fetch(`${h.base}/authorize`, {
    ...form({ request, email: "admin@example.com" }),
    headers: { "content-type": "application/x-www-form-urlencoded", "x-qm-locale": "en" },
  });
  await h.settle();
  assert.match(h.mailer.sent[0]!.subject, /サインイン/);
  assert.match(h.mailer.sent[0]!.text, /サインイン/);
  assert.match(h.mailer.sent[0]!.html, /<html lang="ja">/);
});

test("the English start page offers only a safe locale restart without email or request secrets", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const page = await fetch(`${h.base}/authorize?${authorizeQuery()}`);
  const html = await page.text();
  assert.match(html, /<html lang="en">/);
  const picker = /<form[^>]+id="language-form"[\s\S]*?<\/form>/.exec(html)?.[0];
  assert.ok(picker, "the safe authorization start page should carry a language form");
  assert.match(picker, /action="\/locale"/);
  assert.match(picker, /method="post"/);
  assert.match(picker, /name="returnTo" value="\/auth\/login"/);
  assert.doesNotMatch(picker, /name="(?:email|request)"/);
  assert.doesNotMatch(picker, /admin@example\.com|eyJ/);
});

test("an invalid trusted locale header falls back to the configured locale before Accept-Language", async (t) => {
  const h = await startHarness({ env: { QM_DEFAULT_LOCALE: "ja" } });
  t.after(() => h.close());
  const page = await fetch(`${h.base}/authorize?${authorizeQuery()}`, {
    headers: { "x-qm-locale": "not-a-locale", "accept-language": "en-US" },
  });
  const html = await page.text();
  assert.match(html, /<html lang="ja">/);
  assert.match(html, /サインイン/);
});

test("Accept-Language selects Japanese when no deployment default is configured", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const page = await fetch(`${h.base}/authorize?${authorizeQuery()}`, {
    headers: { "accept-language": "ja-JP, en;q=0.8" },
  });
  assert.match(await page.text(), /<html lang="ja">/);
});

test("a legacy signed request without locale safely uses the configured default", async (t) => {
  const h = await startHarness({ env: { QM_DEFAULT_LOCALE: "ja" } });
  t.after(() => h.close());
  const { challenge } = pkcePair();
  const legacy = await new TokenSigner(h.cfg.tokenSecret, h.cfg.issuer).seal(
    "request",
    {
      cid: CLIENT_ID,
      ru: REDIRECT_URI,
      st: "legacy-state",
      no: "legacy-nonce",
      cc: challenge,
      sc: "openid email",
    },
    h.cfg.requestTtlS,
    h.now.ms,
  );
  const response = await fetch(`${h.base}/authorize`, form({ request: legacy.token, email: "admin@example.com" }));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<html lang="ja">/);
  await h.settle();
  assert.match(h.mailer.sent[0]!.subject, /サインイン/);
});

test("a signed invalid locale is ignored without changing the authorization request", async (t) => {
  const h = await startHarness({ env: { QM_DEFAULT_LOCALE: "ja" } });
  t.after(() => h.close());
  const { challenge } = pkcePair();
  const invalid = await new TokenSigner(h.cfg.tokenSecret, h.cfg.issuer).seal(
    "request",
    {
      cid: CLIENT_ID,
      ru: REDIRECT_URI,
      st: "state-value",
      no: "nonce-value",
      cc: challenge,
      sc: "openid email",
      lo: "fr",
    },
    h.cfg.requestTtlS,
    h.now.ms,
  );
  const response = await fetch(`${h.base}/authorize`, form({ request: invalid.token, email: "not-an-email" }));
  assert.equal(response.status, 400);
  const html = await response.text();
  assert.match(html, /<html lang="ja">/);
  assert.match(html, /メールアドレス/);
});

test("a Japanese signed link keeps Japanese on a replayed verification error", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const request = await requestToken(h, "ja");
  await fetch(`${h.base}/authorize`, form({ request, email: "admin@example.com" }));
  await h.settle();
  const link = /#token=([^\s]+)/.exec(h.mailer.sent[0]!.text)?.[1];
  assert.ok(link);
  const verify = (): Promise<Response> =>
    fetch(`${h.base}/verify`, {
      ...form({ token: decodeURIComponent(link) }),
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-qm-locale": "en" },
    });
  assert.equal((await verify()).status, 302);
  const replay = await verify();
  assert.equal(replay.status, 400);
  const html = await replay.text();
  assert.match(html, /<html lang="ja">/);
  assert.match(html, /サインインリンク/);
});

test("Japanese authorization errors translate stable details without weakening request validation", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const response = await fetch(`${h.base}/authorize?${authorizeQuery({ client_id: "unknown" })}`, {
    headers: { "x-qm-locale": "ja" },
  });
  assert.equal(response.status, 400);
  const html = await response.text();
  assert.match(html, /<html lang="ja">/);
  assert.match(html, /アプリケーションは認識されていません/);
  assert.doesNotMatch(html, /unknown application/);
});

test("the fragment confirmation page translates without adding a locale form or embedding a token", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const japanese = await fetch(`${h.base}/verify`, { headers: { "x-qm-locale": "ja" } });
  const english = await fetch(`${h.base}/verify`, { headers: { "x-qm-locale": "en" } });
  const html = await japanese.text();
  assert.match(html, /<html lang="ja">/);
  assert.match(html, /サインインを完了/);
  assert.doesNotMatch(html, /id="language-form"/);
  assert.match(html, /name="token" id="token" value=""/);
  assert.doesNotMatch(html, /eyJ[A-Za-z0-9_-]+\./);
  assert.equal(japanese.headers.get("content-security-policy"), english.headers.get("content-security-policy"));
});

test("raw problem details stay escaped and untranslated inside a localized page", () => {
  const html = problemPage({
    locale: "ja",
    brandName: "qm",
    heading: "認証プロバイダーで問題が発生しました",
    msg: "もう一度お試しください。",
    detail: 'provider <raw> & "stable"',
  });
  assert.match(html, /provider &lt;raw&gt; &amp; &quot;stable&quot;/);
  assert.doesNotMatch(html, /provider <raw>/);
  assert.match(html, /<strong>詳細<\/strong>/);
});

test("the Auth message catalogs keep identical keys and placeholders", () => {
  assert.deepEqual(catalogProblems(AUTH_MESSAGES.en, AUTH_MESSAGES.ja), []);
});
