import test from "node:test";
import assert from "node:assert/strict";
import { startWithFakeCore, type CoreHit } from "./fake-core.ts";

process.env.PUBLIC_WEB_URL = "http://localhost:18197";
process.env.PORTAL_SESSION_SECRET = "share-test-portal-secret";
process.env.CORE_SIGNING_SECRET = "share-test-core-secret";
process.env.PORTAL_LOCAL_AUTH_BYPASS = "0";
const { base, hits, close } = await startWithFakeCore((method, pathname) => pathname.startsWith("/share/external/"));
test.after(close);

test("anonymous public shares and app assets reach core without a session and do not open private routes", async () => {
  const token = "11111111-1111-4111-8111-111111111111";
  for (const [path, lane] of [
    [`/share/external/${token}`, "handle"],
    [`/share/external/${token}/files/${token}?inline=1`, "handle"],
    ["/assets/shared-Abc123.js", "shell"],
  ] as const) {
    const response = await fetch(`${base}${path}`, {
      redirect: "manual",
      headers: { "x-portal-identity": "forged", "x-qm-app-host": "1", "x-qm-client-ip": "10.0.0.1" },
    });
    assert.equal(response.status, 200);
    const hit = (await response.json()) as CoreHit;
    assert.equal(hit.lane, lane);
    assert.equal(hit.method, "GET");
    assert.equal(hit.url, path);
    assert.deepEqual(
      ["x-portal-identity", "x-qm-app-host", "x-qm-client-ip"].filter((name) => name in hit.headers),
      [],
    );
  }
  const before = hits.length;
  for (const path of [
    `/share/internal/${token}`,
    "/api/sessions",
    "/src/shared-session.ts",
    "/@fs/etc/passwd",
    `/share/external/${token}/other`,
    "/assets/nested/x.js",
  ]) {
    assert.equal((await fetch(`${base}${path}`, { redirect: "manual" })).status, 401, path);
  }
  assert.equal((await fetch(`${base}/share/external/${token}`, { method: "POST", redirect: "manual" })).status, 401);
  assert.equal(hits.length, before);
});
