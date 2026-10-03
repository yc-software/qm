import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

process.env.CORE_API_URL = "http://127.0.0.1:9";
process.env.CORE_SIGNING_SECRET = "static-bad-escape-test";
process.env.WEB_UI_PRINCIPALS = "alice";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => {
  void handler(req, res).catch(() => {
    res.writeHead(502).end();
  });
});
await new Promise<void>((r) => surface.listen(0, r));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;

test.after(() => surface.close());

test("a malformed percent-escape in a static path is a 400, not a 502", async () => {
  const r = await fetch(`${base}/%E0%A4%A`);
  assert.equal(r.status, 400);
  assert.equal(((await r.json()) as { error: string }).error, "bad_request");
  assert.equal((await fetch(`${base}/assets/%ZZ.js`)).status, 400);
  assert.equal((await fetch(`${base}/deployments/%E0%A4%A/`, { headers: { cookie: "webuiuser=alice" } })).status, 400);
});
