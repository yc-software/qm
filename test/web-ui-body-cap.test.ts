import "./support/auto-fake-sprites.ts";

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";

process.env.CORE_API_URL = "http://localhost:1";
process.env.WEB_UI_PRINCIPALS = "";
const { handler } = await import("../plugins/web-ui/server/index.ts");
const web = createHttpServer(handler);
web.listen(0);
const webBase = `http://localhost:${(web.address() as AddressInfo).port}`;

after(async () => {
  await new Promise<void>((r) => web.close(() => r()));
});

test("an over-cap request body is rejected with 413 (not buffered unbounded, not a 502)", async () => {
  const huge = "x".repeat(1_000_001);
  const res = await fetch(`${webBase}/signin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user: "alice", pad: huge }),
  });
  assert.equal(res.status, 413);
  const body = (await res.json()) as { error?: string };
  assert.equal(body.error, "payload_too_large");
});

test("a normal-sized body is unaffected by the cap (well under the limit succeeds)", async () => {
  const res = await fetch(`${webBase}/signin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user: "alice" }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok?: boolean; user?: string };
  assert.equal(body.ok, true);
  assert.equal(body.user, "alice");
});
