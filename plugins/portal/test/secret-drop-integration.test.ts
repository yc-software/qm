import "../../../test/support/auto-fake-sprites.ts";

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { buildApp, type BuiltApp } from "../../../src/wiring.ts";
import { createServer as createCoreServer } from "../../../src/api/server.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS } from "../../../src/auth/capability-token.ts";
import { scopeId } from "../../../src/types.ts";
import { testConfig } from "../../../test/support/test-config.ts";
import { deriveKey, seal } from "../src/session.ts";

const SIGNING_SECRET = "portal-core-secret-drop-integration".repeat(2);
const PORTAL_SECRET = "portal-secret-drop-session-secret";
const PUBLIC_URL = "http://portal.test";

let coreServer: Server;
let portalServer: Server;
let coreBase: string;
let portalBase: string;
let built: BuiltApp;

function sessionCookie(sub: string, locale: "en" | "ja"): string {
  const now = Math.floor(Date.now() / 1000);
  const key = deriveKey(PORTAL_SECRET, "portal.session.v1");
  const session = seal({ k: "session", sub, org: "acme", iat: now, exp: now + 28_800 }, key);
  return `portal_session=${encodeURIComponent(session)}; qm_locale=${locale}`;
}

async function mintDrop(owner: string, service: string): Promise<{ dropId: string; token: string }> {
  const capability = await mintCapabilityToken(
    { actorId: owner, scopeId: scopeId("personal", owner), exp: Date.now() + CAPABILITY_TTL_MS },
    SIGNING_SECRET,
  );
  const response = await fetch(`${coreBase}/v1/keychain/drops`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agent-capability": capability },
    body: JSON.stringify({ service, purpose: "complete the requested task" }),
  });
  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  const body = JSON.parse(responseText) as { dropId: string; formPath: string };
  return { dropId: body.dropId, token: new URL(body.formPath, "http://core.test").searchParams.get("t")! };
}

function formUrl(drop: { dropId: string; token: string }): string {
  return `${portalBase}/drop/${drop.dropId}/form?t=${encodeURIComponent(drop.token)}`;
}

test.before(async () => {
  built = buildApp(
    testConfig({ dataDir: mkdtempSync(join(tmpdir(), "portal-core-secret-drop-")), signingSecret: SIGNING_SECRET }),
  );
  coreServer = createCoreServer(built.app, {
    signingSecret: SIGNING_SECRET,
    keychain: built.keychain,
    secretDrops: built.secretDrops,
    deliveries: built.deliveries,
    workspace: built.workspace,
    auditLog: built.auditLog,
  });
  await new Promise<void>((resolve) => coreServer.listen(0, resolve));
  coreBase = `http://localhost:${(coreServer.address() as AddressInfo).port}`;

  process.env.PORTAL_PUBLIC_URL = PUBLIC_URL;
  process.env.PORTAL_SESSION_SECRET = PORTAL_SECRET;
  process.env.CORE_SIGNING_SECRET = SIGNING_SECRET;
  process.env.CORE_API_URL = coreBase;
  process.env.WEB_UI_UPSTREAM = coreBase;
  process.env.ADMIN_UPSTREAM = coreBase;
  process.env.NODE_ENV = "test";
  delete process.env.QM_DEFAULT_LOCALE;
  const portal = await import("../src/index.ts");
  portalServer = portal.server;
  await new Promise<void>((resolve) => portalServer.listen(0, resolve));
  portalBase = `http://localhost:${(portalServer.address() as AddressInfo).port}`;
});

test.after(async () => {
  await Promise.all([
    new Promise<void>((resolve) => portalServer.close(() => resolve())),
    new Promise<void>((resolve) => coreServer.close(() => resolve())),
  ]);
});

for (const expected of [
  {
    locale: "en" as const,
    heading: "Provide your stripe credential",
    placeholder: "Paste the secret here",
    submit: "Submit securely",
    success: "Received — you can close this tab and return to the conversation.",
    error: "Could not save (the link may have expired, been used, or was missing a field).",
  },
  {
    locale: "ja" as const,
    heading: "stripeの認証情報を入力",
    placeholder: "認証情報を貼り付けてください",
    submit: "安全に送信",
    success: "受け取りました。このタブを閉じて会話に戻れます。",
    error: "保存できませんでした。リンクが期限切れ、使用済み、または入力不足の可能性があります。",
  },
]) {
  test(`Portal and Core render the ${expected.locale} secret-drop form and result messages`, async () => {
    const drop = await mintDrop("U_A", "stripe");
    const response = await fetch(formUrl(drop), {
      headers: { cookie: sessionCookie("U_A", expected.locale), accept: "text/html" },
    });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, new RegExp(`<html lang="${expected.locale}">`));
    assert.match(html, new RegExp(expected.heading));
    assert.match(html, new RegExp(expected.placeholder));
    assert.match(html, new RegExp(expected.submit));
    assert.match(html, new RegExp(expected.success));
    assert.match(html, new RegExp(expected.error.replace(/[()]/g, "\\$&")));
    assert.doesNotMatch(html, new RegExp(drop.token));
  });
}

test("Portal and Core render localized expired and wrong-recipient pages", async () => {
  const expired = await mintDrop("U_A", "expired-service");
  const redeem = await fetch(`${portalBase}/drop/${expired.dropId}?t=${encodeURIComponent(expired.token)}`, {
    method: "POST",
    headers: {
      origin: PUBLIC_URL,
      cookie: sessionCookie("U_A", "ja"),
      "content-type": "application/json",
    },
    body: JSON.stringify({ secret: "redeemed-secret" }),
  });
  assert.equal(redeem.status, 200);
  const expiredPage = await fetch(formUrl(expired), {
    headers: { cookie: sessionCookie("U_A", "ja"), accept: "text/html" },
  });
  assert.equal(expiredPage.status, 404);
  const expiredHtml = await expiredPage.text();
  assert.match(expiredHtml, /<html lang="ja">/);
  assert.match(expiredHtml, /このリンクは期限切れです/);

  const wrong = await mintDrop("U_A", "wrong-recipient-service");
  const wrongPage = await fetch(formUrl(wrong), {
    headers: { cookie: sessionCookie("U_B", "ja"), accept: "text/html" },
  });
  assert.equal(wrongPage.status, 403);
  const wrongHtml = await wrongPage.text();
  assert.match(wrongHtml, /<html lang="ja">/);
  assert.match(wrongHtml, /このリンクは別の利用者向けです/);
  assert.doesNotMatch(wrongHtml, new RegExp(wrong.token));
});
