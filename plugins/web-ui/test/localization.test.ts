import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { JSDOM } from "jsdom";
import { catalogProblems } from "../../chassis/src/locale.ts";
import { locale, t } from "../src/i18n.ts";
import { WEB_MESSAGES, webMessage } from "../src/messages.ts";

const core = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
});
await new Promise<void>((resolve) => core.listen(0, resolve));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "web-ui-localization-test";
process.env.WEB_UI_PRINCIPALS = "alice";
delete process.env.QM_DEFAULT_LOCALE;

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;

test.after(() => {
  surface.close();
  core.close();
});

test("web catalogs have identical keys and variables", () => {
  assert.deepEqual(catalogProblems(WEB_MESSAGES.en, WEB_MESSAGES.ja), []);
});

test("browser translation reads the normalized page locale", () => {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: new JSDOM('<meta name="qm-locale" content="ja-JP">').window.document,
  });
  try {
    assert.equal(locale(), "ja");
    assert.equal(t("signOut"), "サインアウト");
    assert.equal(webMessage("en", "loading"), "Loading…");
  } finally {
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
    else delete (globalThis as { document?: Document }).document;
  }
});

test("server emits English metadata by default", async () => {
  const response = await fetch(`${base}/`, { headers: { cookie: "webuiuser=alice" } });
  const body = await response.text();
  assert.match(body, /<html lang="en">/);
  assert.match(body, /<meta name="qm-locale" content="en"/);
  assert.equal(response.headers.get("vary"), "x-qm-locale, accept-language");
});

test("server emits Japanese metadata from the trusted locale", async () => {
  const response = await fetch(`${base}/`, {
    headers: { cookie: "webuiuser=alice", "x-qm-locale": "ja" },
  });
  const body = await response.text();
  assert.match(body, /<html lang="ja">/);
  assert.match(body, /<meta name="qm-locale" content="ja"/);
});

test("server ignores an invalid trusted locale and falls back to Accept-Language", async () => {
  const response = await fetch(`${base}/`, {
    headers: { cookie: "webuiuser=alice", "x-qm-locale": "fr", "accept-language": "ja-JP" },
  });
  assert.match(await response.text(), /<html lang="ja">/);
});

test("static assets do not vary by locale", async () => {
  const response = await fetch(`${base}/favicon.svg`, { headers: { "x-qm-locale": "ja" } });
  assert.equal(response.headers.get("vary"), null);
});

test("language selection posts the current route to the portal locale endpoint", () => {
  const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
  assert.match(shell, /<form class="language-form" action="\/locale" method="post">/);
  assert.match(shell, /name="locale"[^>]*@change=\$\{[^}]*requestSubmit\(\)/);
  assert.match(shell, /name="returnTo"[^>]*location\.pathname\}\$\{location\.search\}\$\{location\.hash/);
});

test("mobile language selection leaves room for footer controls", () => {
  const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8").replace(/\s+/g, " ");
  assert.match(css, /@media \(max-width: 860px\)[\s\S]*\.language-form \{ flex-basis: 72px; \}/);
  assert.match(css, /@media \(max-width: 860px\)[\s\S]*\.sidebar-footer \.user-name \{ display: none; \}/);
});
