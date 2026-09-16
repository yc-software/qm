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
  capability?: string;
}

const calls: Call[] = [];
const deployment = {
  id: "d1",
  ownerScopeId: "personal:alice",
  createdBy: "alice",
  name: "status-page",
  currentVersion: 2,
  status: "archived",
  permission: "write",
  versions: [{ version: 2, createdAt: 123, commit: "abc123" }],
};
const core = createServer((req: IncomingMessage, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (!(req.url ?? "").startsWith("/v1/surface-config")) {
      calls.push({
        method: req.method ?? "GET",
        url: req.url ?? "",
        body,
        capability: req.headers["x-agent-capability"] as string | undefined,
      });
    }
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url?.startsWith("/v1/session-cap")) {
      res.end(JSON.stringify({ token: "signed-in-user-capability" }));
    } else if (req.url?.startsWith("/v1/deployments/d1/share")) {
      res.end(JSON.stringify({ grantees: [] }));
    } else if (req.method === "GET" && req.url?.startsWith("/v1/deployments?")) {
      res.end(JSON.stringify({ deployments: [deployment] }));
    } else if (req.method === "GET") {
      res.end(JSON.stringify({ deployment }));
    } else {
      res.end(JSON.stringify({ deployment: { ...deployment, status: "running" } }));
    }
  });
});
await new Promise<void>((resolve) => core.listen(0, resolve));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "deployments-web-route-test";
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

test("deployment detail and restore bridge bind the signed-in principal", async () => {
  let before = calls.length;
  const detail = await fetch(`${base}/api/deployments/d1`, { headers });
  assert.equal(detail.status, 200);
  const detailBody = (await detail.json()) as { deployment: typeof deployment & { webUrl: string } };
  assert.equal(detailBody.deployment.permission, "write");
  assert.equal(detailBody.deployment.webUrl, "/deployments/d1/");
  const detailCall = new URL(calls.slice(before).find((call) => call.method === "GET")?.url ?? "", "http://core");
  assert.equal(detailCall.pathname, "/v1/deployments/d1");
  assert.equal(detailCall.searchParams.get("principalId"), "alice");

  before = calls.length;
  const restored = await fetch(`${base}/api/deployments/d1/restore`, { method: "POST", headers });
  assert.equal(restored.status, 200);
  const restoreCall = calls
    .slice(before)
    .find((call) => call.method === "POST" && isNoncedCoreCall(call.url, "/v1/deployments/d1/restore"));
  assert.deepEqual(restoreCall?.body, { principalId: "alice" });

  before = calls.length;
  const restoredBySlug = await fetch(`${base}/api/deployments/status-page/restore`, { method: "POST", headers });
  assert.equal(restoredBySlug.status, 200);
  const slugRestoreCall = calls
    .slice(before)
    .find((call) => call.method === "POST" && isNoncedCoreCall(call.url, "/v1/deployments/status-page/restore"));
  assert.deepEqual(slugRestoreCall?.body, { principalId: "alice" });
});

test("deployment sharing uses the signed-in capability and drops caller identity fields", async () => {
  const before = calls.length;
  assert.equal((await fetch(`${base}/api/deployments/d1/share`, { headers })).status, 200);
  assert.equal(
    (
      await fetch(`${base}/api/deployments/d1/share`, {
        method: "POST",
        headers,
        body: JSON.stringify({ scope: "personal:bob", access: "view", actorId: "mallory", principalId: "mallory" }),
      })
    ).status,
    200,
  );
  const requests = calls.slice(before).filter((call) => call.url === "/v1/deployments/d1/share");
  assert.equal(requests.length, 2);
  assert.ok(requests.every((call) => call.capability === "signed-in-user-capability"));
  assert.deepEqual(requests[1]?.body, { scope: "personal:bob", access: "view" });
});
