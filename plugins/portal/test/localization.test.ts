import test from "node:test";
import assert from "node:assert/strict";
import { catalogProblems } from "../../chassis/src/locale.ts";
import {
  adminUnavailableHtml,
  connectErrorHtml,
  connectWrongRecipientHtml,
  localePicker,
  nonAdminDeniedHtml,
  notConfiguredHtml,
  playgroundBusyHtml,
  playgroundRestrictedHtml,
  secretDropUnavailableHtml,
  signInErrorHtml,
} from "../src/index.ts";
import { PORTAL_MESSAGES } from "../src/messages.ts";

test("Portal catalogs have matching keys and contain text rather than HTML", () => {
  assert.deepEqual(catalogProblems(PORTAL_MESSAGES.en, PORTAL_MESSAGES.ja), []);
  for (const catalog of Object.values(PORTAL_MESSAGES)) {
    for (const message of Object.values(catalog)) assert.doesNotMatch(message, /[<>]/);
  }
  for (const message of Object.values(PORTAL_MESSAGES.ja)) assert.doesNotMatch(message, /領域/);
});

test("sign-in, admin, and setup cards render their English and Japanese copy", () => {
  const signInEn = signInErrorHtml("en", "login session expired");
  const signInJa = signInErrorHtml("ja", "ログインセッションの有効期限が切れました");
  assert.match(signInEn, /<html lang="en">/);
  assert.match(signInEn, /We couldn&#39;t sign you in/);
  assert.match(signInJa, /<html lang="ja">/);
  assert.match(signInJa, /サインインできませんでした/);

  const deniedEn = nonAdminDeniedHtml("en", { sub: "alice@example.test", org: "acme" });
  const deniedJa = nonAdminDeniedHtml("ja", { sub: "alice@example.test", org: "acme" });
  assert.match(deniedEn, /You don&#39;t have admin access/);
  assert.match(deniedJa, /管理画面を利用できません/);
  assert.match(deniedJa, /alice@example\.test/);
  assert.match(deniedJa, /acme/);

  assert.match(notConfiguredHtml("en"), /This deployment isn&#39;t set up yet/);
  assert.match(notConfiguredHtml("ja"), /初期設定が完了していません/);
  assert.match(adminUnavailableHtml("en"), /Admin is temporarily unavailable/);
  assert.match(adminUnavailableHtml("ja"), /管理画面を一時的に利用できません/);
});

test("Portal cards escape caller-owned detail, user, and organization values", () => {
  const signIn = signInErrorHtml("ja", '<img src=x onerror="alert(1)">');
  assert.doesNotMatch(signIn, /<img/);
  assert.match(signIn, /&lt;img/);

  const denied = nonAdminDeniedHtml("ja", { sub: '<script id="user">', org: '<img id="org">' });
  assert.doesNotMatch(denied, /<script|<img/);
  assert.match(denied, /&lt;script/);
  assert.match(denied, /&lt;img/);
});

test("connector pages localize known states without trusting provider or detail HTML", () => {
  const expired = connectErrorHtml("ja", "接続リンクの有効期限が切れています");
  assert.match(expired, /<html lang="ja">/);
  assert.match(expired, /接続できません/);
  assert.match(expired, /接続リンクの有効期限が切れています/);

  const wrong = connectWrongRecipientHtml("ja", { provider: "google", alreadyConnected: false });
  assert.match(wrong, /このリンクは別の利用者向けです/);
  assert.match(wrong, /Googleを接続/);

  const connected = connectWrongRecipientHtml("en", { provider: "google", alreadyConnected: true });
  assert.match(connected, /You&#39;ve already connected Google/);

  const hostileProvider = connectWrongRecipientHtml("ja", {
    provider: '"><img src=x onerror=alert(1)>',
    alreadyConnected: false,
  });
  assert.doesNotMatch(hostileProvider, /<img/);
  assert.match(hostileProvider, /%22%3E%3Cimg/);
});

test("playground and credential-service failure pages render in both locales", () => {
  assert.match(playgroundBusyHtml("en"), /The playground is busy/);
  assert.match(playgroundBusyHtml("ja"), /Playgroundは混み合っています/);
  assert.match(playgroundRestrictedHtml("en"), /Not available in the playground/);
  assert.match(playgroundRestrictedHtml("ja"), /Playgroundでは利用できません/);
  assert.match(secretDropUnavailableHtml("en"), /Credential service unavailable/);
  assert.match(secretDropUnavailableHtml("ja"), /認証情報サービスを利用できません/);
});

test("language picker posts only a sanitized same-origin current path", () => {
  const picker = localePicker("ja", "/connect/redeem/link-1?provider=google&step=2#review");
  assert.match(picker, /action="\/locale"/);
  assert.match(picker, /method="post"/);
  assert.match(picker, /name="locale" value="en"/);
  assert.match(picker, /name="locale" value="ja"/);
  assert.match(picker, /name="returnTo" value="\/connect\/redeem\/link-1\?provider=google&amp;step=2#review"/);
  assert.match(picker, /aria-current="true"[^>]*>日本語</);
  assert.match(picker, />English</);

  const contained = localePicker("en", "https://evil.example/steal");
  assert.match(contained, /name="returnTo" value="\/"/);
  assert.doesNotMatch(contained, /evil\.example/);
});
