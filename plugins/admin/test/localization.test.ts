import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import test from "node:test";
import { catalogProblems } from "../../chassis/src/locale.ts";
import { ADMIN_MESSAGES, adminMessage } from "../src/messages.ts";
import { localizeAdminShell } from "../src/localization.ts";

const core = createServer((req: IncomingMessage, res) => {
  if ((req.url ?? "").startsWith("/v1/surface-config")) {
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ branding: { accent: "#2357d9", mark: "Q", selfLabel: "QM" } }));
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});
await new Promise<void>((resolve) => core.listen(0, resolve));

process.env.QM_DEFAULT_LOCALE = "ja";
process.env.NODE_ENV = "test";
process.env.ALLOW_UNSIGNED_TEST_IDENTITY = "1";
process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "admin-localization-test-secret";

const { server } = await import("../src/index.ts");
await new Promise<void>((resolve) => server.listen(0, resolve));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;

test.after(() => {
  server.close();
  core.close();
});

test("Admin catalogs have the same keys and named variables without HTML", () => {
  assert.deepEqual(catalogProblems(ADMIN_MESSAGES.en, ADMIN_MESSAGES.ja), []);
  for (const messages of Object.values(ADMIN_MESSAGES)) {
    for (const message of Object.values(messages)) assert.doesNotMatch(message, /<\/?[A-Za-z][^>]*>/);
  }
  assert.equal(
    adminMessage("ja", "auth.signedInAs", { principal: "alice@example.com" }),
    "alice@example.com としてログイン中",
  );
});

test("Japanese Admin workflow terms use the operator vocabulary", () => {
  assert.equal(adminMessage("ja", "navigation.onboarding"), "初期設定");
  assert.equal(adminMessage("ja", "navigation.users"), "利用者");
  assert.equal(adminMessage("ja", "navigation.crons"), "定期実行");
  assert.equal(adminMessage("ja", "navigation.keychain"), "認証情報");
  assert.equal(adminMessage("ja", "action.save"), "保存");
  assert.equal(adminMessage("ja", "action.cancel"), "キャンセル");
});

test("Japanese Admin operational messages render dynamic values without interpreting them as markup", () => {
  assert.equal(adminMessage("ja", "transcript.thinking"), "思考");
  assert.equal(adminMessage("ja", "retention.newVsReturning"), "新規利用者と継続利用者");
  assert.equal(adminMessage("ja", "history.contextRequestCount", { count: 3 }), "モデルへ送信したリクエスト 3件");
  assert.equal(
    adminMessage("ja", "users.resolveFailed", { message: '<img src=x onerror="alert(1)">' }),
    '利用者を特定できませんでした（<img src=x onerror="alert(1)">）。',
  );
});

test("Japanese Admin shell renders localized onboarding and governance copy", async () => {
  const html = await (await fetch(`${base}/onboarding`, { headers: { "x-qm-locale": "ja" } })).text();
  assert.match(html, /<h1>初期設定<\/h1>/);
  assert.match(html, /実際の会話に使えるよう、このQM環境を設定します。/);
  assert.match(html, /<h2>コマンドポリシー<\/h2>/);
  assert.match(html, /<button class="primary" data-save="command-policy">保存<\/button/);
});

test("static tokens are HTML escaped and locale JSON cannot close its inert template", () => {
  const mutable = ADMIN_MESSAGES.en as Record<string, string>;
  const original = mutable.language;
  mutable.language = '</template><script>alert("x")</script>&\u2028\u2029';
  try {
    const html = localizeAdminShell(
      '<html lang="ja"><body>{{t:language}}<template id="locale-messages">__ADMIN_MESSAGES__</template></body></html>',
      "en",
    );
    assert.match(html, /<html lang="en">/);
    assert.match(html, /&lt;\/template&gt;&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;&amp;/);
    const payload = html.match(/<template id="locale-messages">([\s\S]*?)<\/template>/)?.[1];
    assert.ok(payload);
    assert.doesNotMatch(payload, /[<&\u2028\u2029]/u);
    assert.equal((JSON.parse(payload) as Record<string, string>).language, mutable.language);
  } finally {
    mutable.language = original;
  }
});

test("Admin shell locale priority is trusted header, deployment default, then browser", async () => {
  const fallback = await fetch(`${base}/`);
  assert.match(await fallback.text(), /<html lang="ja">/);

  const browser = await fetch(`${base}/`, { headers: { "accept-language": "en-US, ja;q=0.5" } });
  assert.match(await browser.text(), /<html lang="ja">/);

  const trusted = await fetch(`${base}/`, {
    headers: { "x-qm-locale": "en", "accept-language": "ja-JP" },
  });
  assert.match(await trusted.text(), /<html lang="en">/);

  const invalidTrusted = await fetch(`${base}/`, {
    headers: { "x-qm-locale": "fr", "accept-language": "en-US" },
  });
  assert.match(await invalidTrusted.text(), /<html lang="ja">/);
});

test("Admin shell cache is isolated by locale across every HTML route", async () => {
  const en = await fetch(`${base}/`, { headers: { "x-qm-locale": "en" } });
  const ja = await fetch(`${base}/users?scope=org%3Ademo`, { headers: { "x-qm-locale": "ja" } });
  const enAgain = await fetch(`${base}/audit`, { headers: { "x-qm-locale": "en" } });
  const enHtml = await en.text();
  const jaHtml = await ja.text();

  assert.equal(en.headers.get("vary"), "x-qm-locale, accept-language, accept-encoding");
  assert.equal(ja.headers.get("vary"), "x-qm-locale, accept-language, accept-encoding");
  assert.notEqual(en.headers.get("etag"), ja.headers.get("etag"));
  assert.equal(en.headers.get("etag"), enAgain.headers.get("etag"));
  assert.match(enHtml, /<html lang="en">/);
  assert.match(jaHtml, /<html lang="ja">/);
  assert.match(enHtml, />Dashboard</);
  assert.match(jaHtml, />ダッシュボード</);
});

test("locale payload drives browser translation without changing the inline script hash", async () => {
  const en = await fetch(`${base}/`, { headers: { "x-qm-locale": "en" } });
  const ja = await fetch(`${base}/`, { headers: { "x-qm-locale": "ja" } });
  const enHtml = await en.text();
  const jaHtml = await ja.text();
  const enScript = enHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  const jaScript = jaHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(enScript);
  assert.equal(jaScript, enScript);
  const hash = createHash("sha256").update(enScript).digest("base64");
  assert.ok(en.headers.get("content-security-policy")?.includes(`script-src 'sha256-${hash}'`));
  assert.equal(ja.headers.get("content-security-policy"), en.headers.get("content-security-policy"));

  const jaPayload = jaHtml.match(/<template id="locale-messages">([\s\S]*?)<\/template>/)?.[1];
  assert.ok(jaPayload);
  assert.equal((JSON.parse(jaPayload) as Record<string, string>).dashboard, "ダッシュボード");
});

test("language form is accessible and preserves the current path, query, and hash", async () => {
  const html = await (await fetch(`${base}/users?scope=mine`, { headers: { "x-qm-locale": "ja" } })).text();
  assert.match(html, /<form[^>]+id="language-form"[^>]+action="\/locale"[^>]+method="post"/);
  assert.match(html, /<label[^>]+for="language-select"[^>]*>言語<\/label>/);
  assert.match(html, /<select[^>]+id="language-select"[^>]+name="locale"/);
  assert.match(html, /<input[^>]+type="hidden"[^>]+name="returnTo"/);
  assert.match(html, /location\.pathname \+ location\.search \+ location\.hash/);
  assert.match(html, /document\.documentElement\.lang/);
});

test("an Admin base path containing the locale JSON marker remains literal", async () => {
  const original = process.env.ADMIN_BASE_PATH;
  process.env.ADMIN_BASE_PATH = "/__ADMIN_MESSAGES__";
  const loaded = (await import(new URL("../src/index.ts?admin-base-marker", import.meta.url).href)) as unknown as {
    server: typeof server;
  };
  await new Promise<void>((resolve) => loaded.server.listen(0, resolve));
  try {
    const markerBase = `http://localhost:${(loaded.server.address() as AddressInfo).port}`;
    const response = await fetch(`${markerBase}/`, { headers: { "x-qm-locale": "en" } });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /const API_BASE = "\/__ADMIN_MESSAGES__";/);
  } finally {
    await new Promise<void>((resolve, reject) => loaded.server.close((error) => (error ? reject(error) : resolve())));
    if (original === undefined) delete process.env.ADMIN_BASE_PATH;
    else process.env.ADMIN_BASE_PATH = original;
  }
});
