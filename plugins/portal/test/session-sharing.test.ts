import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const calls: Array<{ url: string; cookie: unknown; identity: unknown }> = [];
const upstream = createServer((req, res) => {
  calls.push({ url: req.url!, cookie: req.headers.cookie, identity: req.headers["x-portal-identity"] });
  res.end("public content");
});
await new Promise<void>((resolve) => upstream.listen(0, resolve));
process.env.PORTAL_PUBLIC_URL = "http://localhost:18197";
process.env.PORTAL_SESSION_SECRET = "share-test-portal-secret";
process.env.CORE_SIGNING_SECRET = "share-test-core-secret";
process.env.WEB_UI_UPSTREAM = `http://localhost:${(upstream.address() as AddressInfo).port}`;
process.env.PORTAL_LOCAL_AUTH_BYPASS = "0";
const { server } = await import("../src/index.ts");
await new Promise<void>((resolve) => server.listen(0, resolve));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
test.after(() => {
  server.close();
  upstream.close();
});

test("anonymous public shares forward no identity and do not open private routes", async () => {
  const token = "11111111-1111-4111-8111-111111111111";
  for (const path of [
    `/share/external/${token}`,
    `/share/external/${token}/files/${token}?inline=1`,
    "/assets/shared-Abc123.js",
  ]) {
    const response = await fetch(`${base}${path}`, {
      headers: { cookie: "webuiuser=alice", "x-portal-identity": "forged" },
      redirect: "manual",
    });
    assert.equal(response.status, 200);
    assert.equal(calls.at(-1)!.url, path);
    assert.equal(calls.at(-1)!.cookie, undefined);
    assert.equal(calls.at(-1)!.identity, undefined);
  }
  const before = calls.length;
  for (const path of [
    `/share/internal/${token}`,
    "/api/sessions",
    "/src/shared-session.ts",
    "/@fs/etc/passwd",
    `/share/external/${token}/other`,
  ]) {
    assert.equal((await fetch(`${base}${path}`, { redirect: "manual" })).status, 401);
  }
  assert.equal((await fetch(`${base}/share/external/${token}`, { method: "POST", redirect: "manual" })).status, 401);
  assert.equal(calls.length, before);
});
