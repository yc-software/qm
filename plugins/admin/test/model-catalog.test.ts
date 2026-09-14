import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

const calls: { method: string; url: string; actor: string | null; signed: boolean; body: string }[] = [];
const core = createServer((req: IncomingMessage, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    calls.push({
      method: req.method ?? "",
      url: req.url ?? "",
      actor: (req.headers["x-admin-actor"] as string) ?? null,
      signed: Boolean(req.headers["x-timestamp"] && req.headers["x-signature"]),
      body,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise<void>((r) => core.listen(0, r));
const corePort = (core.address() as AddressInfo).port;

process.env.CORE_API_URL = `http://localhost:${corePort}`;
process.env.CORE_SIGNING_SECRET = "admin-model-catalog-proxy-secret";

const { server } = await import("../src/index.ts");
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
test.after(() => {
  server.close();
  if (core.listening) core.close();
});

const ADMIN = "admin=U-admin";

test("the Model catalog card renders in the onboarding view", () => {
  assert.match(html, /<h2>Model catalog<\/h2>/);
  assert.match(html, /id="model-catalog-rows"/);
  assert.match(html, /data-discover="anthropic"/);
});

test("GET /api/model-providers/<provider>/models forwards to the discovery route signed + attributed", async () => {
  const r = await fetch(`${base}/api/model-providers/anthropic/models`, { headers: { cookie: ADMIN } });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "GET");
  assert.equal(c.url, "/v1/admin/model-providers/anthropic/models");
  assert.equal(c.actor, "U-admin@acme");
  assert.equal(c.signed, true);
});

test("PUT /api/scopes/<id>/model-classifications forwards to the scope resource with the body intact", async () => {
  const r = await fetch(`${base}/api/scopes/${encodeURIComponent("org:acme")}/model-classifications`, {
    method: "PUT",
    headers: { cookie: ADMIN, "content-type": "application/json" },
    body: JSON.stringify({ modelId: "claude-opus-5", status: "legacy" }),
  });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "PUT");
  assert.equal(c.url, "/v1/admin/scopes/org%3Aacme/model-classifications");
  assert.equal(c.actor, "U-admin@acme");
  assert.equal(c.signed, true);
  assert.deepEqual(JSON.parse(c.body), { modelId: "claude-opus-5", status: "legacy" });
});
