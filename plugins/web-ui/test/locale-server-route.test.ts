import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

const core = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
});
await new Promise<void>((resolve) => core.listen(0, resolve));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "web-ui-locale-route-test";
process.env.WEB_UI_PUBLIC_URL = "https://web.test";

const { handler } = await import(new URL("../server/index.ts?locale-route", import.meta.url).href);
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;

process.env.WEB_UI_PUBLIC_URL = "http://web.test";
const { handler: httpHandler } = await import(new URL("../server/index.ts?locale-route-http", import.meta.url).href);
const httpSurface = createServer((req, res) => void httpHandler(req, res));
await new Promise<void>((resolve) => httpSurface.listen(0, resolve));
const httpBase = `http://localhost:${(httpSurface.address() as AddressInfo).port}`;

test.after(() => {
  surface.close();
  httpSurface.close();
  core.close();
});

function changeLocale(locale: string, returnTo = "/", headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/locale`, {
    method: "POST",
    redirect: "manual",
    headers: {
      origin: "https://web.test",
      "sec-fetch-site": "same-origin",
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      ...headers,
    },
    body: new URLSearchParams({ locale, returnTo }),
  });
}

test("POST /locale persists each supported locale and returns to a safe local URL", async () => {
  for (const locale of ["en", "ja"]) {
    const response = await changeLocale(locale, "/files?scope=mine#recent");
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/files?scope=mine#recent");
    const setCookie = response.headers.get("set-cookie") ?? "";
    assert.match(setCookie, new RegExp(`^qm_locale=${locale};`));
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Path=\//);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /Max-Age=31536000/);
    if (locale === "ja") {
      const cookie = setCookie.split(";", 1)[0] ?? "";
      const page = await fetch(`${base}/`, { headers: { cookie } });
      assert.match(await page.text(), /<html lang="ja">/);
    }
  }
});

test("POST /locale leaves the cookie usable on an HTTP development surface", async () => {
  const response = await fetch(`${httpBase}/locale`, {
    method: "POST",
    redirect: "manual",
    headers: {
      origin: "http://web.test",
      "sec-fetch-site": "same-origin",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ locale: "ja", returnTo: "/" }),
  });
  assert.equal(response.status, 303);
  assert.doesNotMatch(response.headers.get("set-cookie") ?? "", /Secure/);
});

test("POST /locale rejects cross-origin and cross-site writes", async () => {
  const foreign = await changeLocale("ja", "/", { origin: "https://evil.test" });
  assert.equal(foreign.status, 403);

  const crossSite = await changeLocale("ja", "/", { "sec-fetch-site": "cross-site" });
  assert.equal(crossSite.status, 403);
});

test("POST /locale requires form content and an accepted locale", async () => {
  for (const contentType of ["text/plain", "application/json"]) {
    const response = await changeLocale("ja", "/", { "content-type": contentType });
    assert.equal(response.status, 415, contentType);
  }

  const invalid = await changeLocale("fr");
  assert.equal(invalid.status, 400);
});

test("POST /locale contains unsafe redirects and oversized bodies", async () => {
  for (const returnTo of [
    "https://evil.test/steal",
    "//evil.test/steal",
    "/%2f%2fevil.test/steal",
    "/a\\b",
    "/a/..//evil.test/x",
    "/%2e%2e//evil.test/x",
  ]) {
    const response = await changeLocale("ja", returnTo);
    assert.equal(response.status, 303, returnTo);
    assert.equal(response.headers.get("location"), "/", returnTo);
  }

  const oversized = await fetch(`${base}/locale`, {
    method: "POST",
    headers: {
      origin: "https://web.test",
      "sec-fetch-site": "same-origin",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: `locale=ja&returnTo=/${"x".repeat(1024)}`,
  });
  assert.equal(oversized.status, 413);
});

test("/locale rejects unsupported methods", async () => {
  const response = await fetch(`${base}/locale`, { redirect: "manual" });
  assert.equal(response.status, 405);
});
