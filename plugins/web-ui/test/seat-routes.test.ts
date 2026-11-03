import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

const seen: Array<{ method: string; url: string; body: string }> = [];
const core = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const url = new URL(req.url ?? "", "http://core");
  url.searchParams.delete("_sourceAuthNonce");
  seen.push({ method: req.method ?? "", url: `${url.pathname}${url.search}`, body });
  if (req.url?.startsWith("/v1/seat/steps/gone/move")) {
    res.writeHead(409, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "step_closed", message: "That step already closed." }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(req.url?.startsWith("/v1/seat/steps?") ? { steps: [{ id: "st1" }] } : { ok: true }));
});
await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
const secret = "seat-route-test-secret";
process.env.CORE_API_URL = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
process.env.CORE_ORG_ID = "acme";
process.env.CORE_SIGNING_SECRET = secret;
process.env.PORTAL_IDENTITY_SECRET = secret;
process.env.ALLOW_UNSIGNED_TEST_IDENTITY = "0";
const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(surface.address() as AddressInfo).port}`;
const headers = (imp?: string) => ({
  "content-type": "application/json",
  [PORTAL_IDENTITY_HEADER]: mintPortalIdentity(
    { p: "alice@example.com", exp: Date.now() + 60_000, ...(imp ? { imp } : {}) },
    secret,
  ),
});

test.after(() => {
  surface.closeAllConnections();
  surface.close();
  core.closeAllConnections();
  core.close();
});

test("steps are read as the signed-in person", async () => {
  seen.length = 0;
  const list = await fetch(`${base}/api/seat/steps?principalId=mallory`, { headers: headers() });
  assert.deepEqual(await list.json(), { steps: [{ id: "st1" }] });
  await fetch(`${base}/api/seat/steps/st%201`, { headers: headers() });
  assert.deepEqual(
    seen.filter((s) => s.url.startsWith("/v1/seat/")).map((s) => `${s.method} ${s.url}`),
    ["GET /v1/seat/steps?principalId=alice%40example.com", "GET /v1/seat/steps/st%201?principalId=alice%40example.com"],
  );
});

test("moves and asks are sent as the signed-in person, and core refusals pass through", async () => {
  seen.length = 0;
  const content = [{ type: "tool_use", name: "execute", input: { command: "ls" } }];
  const move = await fetch(`${base}/api/seat/steps/st1/move`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ content, principalId: "mallory" }),
  });
  assert.equal(move.status, 200);
  await fetch(`${base}/api/seat/steps/st1/ask`, { method: "POST", headers: headers(), body: "{}" });
  assert.deepEqual(
    seen.filter((s) => s.url.startsWith("/v1/seat/")).map((s) => [s.method, s.url, JSON.parse(s.body)]),
    [
      ["POST", "/v1/seat/steps/st1/move", { content, principalId: "alice@example.com" }],
      ["POST", "/v1/seat/steps/st1/ask", { principalId: "alice@example.com" }],
    ],
  );
  const closed = await fetch(`${base}/api/seat/steps/gone/move`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ content }),
  });
  assert.equal(closed.status, 409);
  assert.equal(((await closed.json()) as { message: string }).message, "That step already closed.");
});

test("seat routes refuse an admin viewing as someone else", async () => {
  seen.length = 0;
  const imp = headers("admin@example.com");
  const replies = await Promise.all([
    fetch(`${base}/api/seat/steps`, { headers: imp }),
    fetch(`${base}/api/seat/steps/st1`, { headers: imp }),
    fetch(`${base}/api/seat/steps/st1/move`, { method: "POST", headers: imp, body: JSON.stringify({ content: [] }) }),
    fetch(`${base}/api/seat/steps/st1/ask`, { method: "POST", headers: imp, body: "{}" }),
  ]);
  assert.deepEqual(
    replies.map((r) => r.status),
    [403, 403, 403, 403],
  );
  assert.equal(seen.filter((s) => s.url.startsWith("/v1/seat/")).length, 0);
});
