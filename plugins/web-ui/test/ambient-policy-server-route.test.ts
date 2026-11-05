import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

function isNoncedCoreCall(url: string, pathname: string): boolean {
  const u = new URL(url, "http://core");
  if (u.pathname !== pathname) return false;
  const keys = [...u.searchParams.keys()];
  return (
    keys.length === 1 && keys[0] === "_sourceAuthNonce" && (u.searchParams.get("_sourceAuthNonce") ?? "").length > 0
  );
}

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

const calls: Call[] = [];
const policy = { orders: "flag launches", bots: { "General Agent": { mode: "ignore" } }, updatedAt: 42 };
const core = createServer((req: IncomingMessage, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (!(req.url ?? "").startsWith("/v1/surface-config")) {
      calls.push({ method: req.method ?? "GET", url: req.url ?? "", body });
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ policy }));
  });
});
await new Promise<void>((resolve) => core.listen(0, resolve));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "ambient-policy-web-route-test";
process.env.WEB_UI_PRINCIPALS = "alice";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;
const headers = { cookie: "webuiuser=alice", "content-type": "application/json" };

test.after(() => {
  surface.close();
  core.close();
});

test("GET pins the principal and scope onto the core policy read", async () => {
  const before = calls.length;
  const r = await fetch(`${base}/api/contexts/${encodeURIComponent("channel:C1")}/ambient-policy`, { headers });
  assert.equal(r.status, 200);
  assert.deepEqual(((await r.json()) as { policy: unknown }).policy, policy);
  const call = calls[before]!;
  assert.equal(call.method, "GET");
  assert.match(call.url, /^\/v1\/contexts\/policy\?/);
  assert.match(call.url, /principalId=alice/);
  assert.match(call.url, /scope=channel%3AC1/);
});

test("PUT relays orders, bots, and the conflict snapshot under the signed-in principal", async () => {
  const before = calls.length;
  const r = await fetch(`${base}/api/contexts/${encodeURIComponent("channel:C1")}/ambient-policy`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      orders: "watch deploys",
      bots: { "General Agent": { mode: "rollup", rollupHours: 4 } },
      baseUpdatedAt: 42,
    }),
  });
  assert.equal(r.status, 200);
  const call = calls[before]!;
  assert.equal(call.method, "PUT");
  assert.ok(
    isNoncedCoreCall(call.url, "/v1/contexts/policy"),
    `PUT must land on the policy route with only the nonce query: ${call.url}`,
  );
  assert.equal(call.body.principalId, "alice");
  assert.equal(call.body.scope, "channel:C1");
  assert.equal(call.body.orders, "watch deploys");
  assert.deepEqual(call.body.bots, { "General Agent": { mode: "rollup", rollupHours: 4 } });
  assert.equal(call.body.baseUpdatedAt, 42);
});
