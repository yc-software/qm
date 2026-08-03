import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

const PUBLIC = "https://agent.qm.example.com";
process.env.PORTAL_PUBLIC_URL = PUBLIC;
process.env.PORTAL_SESSION_SECRET = "locale-cookie-domain-test-portal-secret";
process.env.CORE_SIGNING_SECRET = "locale-cookie-domain-test-core-secret";
process.env.PORTAL_COOKIE_DOMAIN = "qm.example.com";

const { server } = await import("../src/index.ts");
await new Promise<void>((resolve) => server.listen(0, resolve));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;

test.after(() => server.close());

test("the locale cookie is Secure, domain-scoped, and clears a stale host-only value", async () => {
  const response = await fetch(`${base}/locale`, {
    method: "POST",
    redirect: "manual",
    headers: { origin: PUBLIC, "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body: new URLSearchParams({ locale: "ja" }),
  });
  assert.equal(response.status, 303);
  const cookies = response.headers.getSetCookie().filter((cookie) => cookie.startsWith("qm_locale="));
  assert.ok(cookies.some((cookie) => /^qm_locale=ja;/.test(cookie) && /Domain=qm\.example\.com/.test(cookie)));
  assert.ok(cookies.some((cookie) => /^qm_locale=;/.test(cookie) && !/Domain=/.test(cookie)));
  assert.ok(cookies.every((cookie) => cookie.includes("; Secure")));
});
