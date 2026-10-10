import "./support/auto-fake-sprites.ts";

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { json } from "../plugins/chassis/src/http.ts";
import { reportBackendError } from "../plugins/chassis/src/error-reporting.ts";

delete process.env.CORE_SIGNING_SECRET;
delete process.env.PORTAL_IDENTITY_SECRET;
process.env.WEB_UI_PRINCIPALS = "";
const { handler } = await import("../plugins/web-ui/server/index.ts");

function productionListener(req: IncomingMessage, res: ServerResponse): void {
  void handler(req, res).catch((err: unknown) => {
    reportBackendError(err);
    if (!res.headersSent) json(res, 502, { error: "bad_gateway", message: "upstream error" });
    else res.end();
  });
}

const web = createHttpServer(productionListener);
web.listen(0);
const webBase = `http://localhost:${(web.address() as AddressInfo).port}`;
const TEST_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 2_000;

after(async () => {
  await new Promise<void>((resolve, reject) => {
    web.close((err) => (err ? reject(err) : resolve()));
  });
});

function get(path: string): Promise<Response> {
  return fetch(`${webBase}${path}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

function getWithCookie(path: string, cookieHeader: string): Promise<Response> {
  return fetch(`${webBase}${path}`, {
    headers: { cookie: cookieHeader },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

test("the dev cookie-auth fixture is actually running in dev mode", { timeout: TEST_TIMEOUT_MS }, async () => {
  const res = await get("/me");
  assert.equal(res.status, 401);
  assert.equal(((await res.json()) as { mode?: string }).mode, "dev");
});

test(
  "a missing session cookie is rejected as unauthenticated, not a server error",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const res = await get("/api/does-not-exist");
    assert.equal(res.status, 401);
  },
);

test("a malformed session cookie is rejected with 401, never 500 or 502", { timeout: TEST_TIMEOUT_MS }, async () => {
  const res = await getWithCookie("/api/does-not-exist", "webuiuser=%");
  assert.equal(res.status, 401);
  assert.equal(((await res.json()) as { error?: string }).error, "sign in");
});

test(
  "a malformed session cookie does not take down the process for the next request",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const broken = await getWithCookie("/api/does-not-exist", "webuiuser=%");
    assert.equal(broken.status, 401);
    const healthy = await getWithCookie("/api/does-not-exist", `webuiuser=${encodeURIComponent("alice")}`);
    assert.equal(healthy.status, 404);
  },
);

test("a malformed duplicate cookie does not shadow a later valid one", { timeout: TEST_TIMEOUT_MS }, async () => {
  const res = await getWithCookie("/api/does-not-exist", "webuiuser=%; webuiuser=alice");
  assert.equal(res.status, 404);
});

test("a valid, percent-encoded session cookie authenticates end to end", { timeout: TEST_TIMEOUT_MS }, async () => {
  const encoded = encodeURIComponent("alice@example.com");
  const res = await getWithCookie("/api/does-not-exist", `webuiuser=${encoded}`);
  assert.equal(res.status, 404);
});

test("an invalid duplicate before a valid one still authenticates", { timeout: TEST_TIMEOUT_MS }, async () => {
  const res = await getWithCookie("/api/does-not-exist", `webuiuser=%E0%A4%A; webuiuser=${encodeURIComponent("bob")}`);
  assert.equal(res.status, 404);
});

test("every duplicate malformed still fails closed as unauthenticated", { timeout: TEST_TIMEOUT_MS }, async () => {
  const res = await getWithCookie("/api/does-not-exist", "webuiuser=%; webuiuser=%E0%A4%A");
  assert.equal(res.status, 401);
});
