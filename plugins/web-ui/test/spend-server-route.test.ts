import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

const calls: string[] = [];
const core = createServer((req, res) => {
  calls.push(req.url ?? "");
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ scopeId: "personal:alice" }));
});
await new Promise<void>((resolve) => core.listen(0, resolve));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "spend-web-route-test";
process.env.WEB_UI_PRINCIPALS = "alice";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;
const headers = {
  [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, "spend-web-route-test"),
};

test.after(() => {
  surface.close();
  core.close();
});

test("spend asks core for the signed-in person's spend and passes only the window through", async () => {
  const response = await fetch(
    `${base}/api/spend?from=2026-10-01&to=2026-10-22&bucket=week&principalId=mallory&format=csv`,
    { headers },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { scopeId: "personal:alice" });
  const url = new URL(calls.at(-1)!, "http://core");
  assert.equal(url.pathname, "/v1/spend");
  url.searchParams.delete("_sourceAuthNonce");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    principalId: "alice",
    from: "2026-10-01",
    to: "2026-10-22",
    bucket: "week",
  });
});
