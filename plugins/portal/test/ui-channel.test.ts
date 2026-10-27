import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const upstream = createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify(
      req.url?.endsWith("/canonical")
        ? { canonicalId: "local-user" }
        : { cookie: req.headers.cookie ?? null, version: req.headers["x-qm-ui-version"] ?? null },
    ),
  );
});
await new Promise<void>((r) => upstream.listen(0, r));
const upstreamUrl = `http://localhost:${(upstream.address() as AddressInfo).port}`;

process.env.PORTAL_PUBLIC_URL = "http://localhost:18198";
process.env.PORTAL_SESSION_SECRET = "ui-channel-test-portal-secret";
process.env.CORE_SIGNING_SECRET = "ui-channel-test-core-secret";
process.env.WEB_UI_UPSTREAM = upstreamUrl;
process.env.CORE_API_URL = upstreamUrl;
process.env.PORTAL_LOCAL_AUTH_BYPASS = "1";
process.env.PORTAL_DEV_PRINCIPAL = "local-user";

const { server } = await import("../src/index.ts");
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;

test.after(() => {
  server.close();
  upstream.close();
});

const session = async (): Promise<string> => {
  const login = await fetch(`${base}/auth/login?returnTo=/`, { redirect: "manual" });
  return login.headers
    .getSetCookie()
    .find((c) => c.startsWith("portal_session="))!
    .split(";")[0]!;
};

test("?ui=<channel> on a page load pins the browser to that web UI channel and the surface sees it", async () => {
  const cookie = await session();
  const pick = await fetch(`${base}/s/abc?ui=pr-12&seq=4`, {
    headers: { cookie, accept: "text/html" },
    redirect: "manual",
  });
  assert.equal(pick.status, 302);
  assert.equal(pick.headers.get("location"), "/s/abc?seq=4");
  const channel = pick.headers.getSetCookie().find((c) => c.startsWith("qm_ui_channel="))!;
  assert.match(channel, /^qm_ui_channel=pr-12; HttpOnly/);
  const page = await fetch(`${base}/api/me`, {
    headers: { cookie: `${cookie}; qm_ui_channel=pr-12`, "x-qm-ui-version": "1+abc" },
  });
  const seen = (await page.json()) as { cookie: string; version: string };
  assert.match(seen.cookie, /; qm_ui_channel=pr-12$/);
  assert.equal(seen.version, "1+abc");
  const leave = await fetch(`${base}/?ui=live`, { headers: { cookie, accept: "text/html" }, redirect: "manual" });
  assert.match(
    leave.headers.getSetCookie().find((c) => c.startsWith("qm_ui_channel="))!,
    /Max-Age=0/,
  );
  const bad = await fetch(`${base}/?ui=..%2Fx`, { headers: { cookie, accept: "text/html" }, redirect: "manual" });
  assert.equal(bad.status, 400);
});
