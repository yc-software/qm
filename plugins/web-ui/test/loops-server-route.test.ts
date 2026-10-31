import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

let loopRequests = 0;
let autopilotRequests = 0;
let autopilotBody: unknown;
const core = createServer((req: IncomingMessage, res) => {
  const url = new URL(req.url ?? "/", "http://core");
  const path = url.pathname;
  res.setHeader("content-type", "application/json");
  if (path === "/v1/inbox/access")
    return void res.end(JSON.stringify({ enabled: url.searchParams.get("principalId") === "Alice@example.com" }));
  if (req.method === "POST" && path === "/v1/session-cap") {
    return void res.end(JSON.stringify({ token: "loops-test-cap" }));
  }
  if (req.method === "GET" && path === "/v1/admin/whoami") {
    return void res.end(JSON.stringify({ permissions: ["member", "loops"] }));
  }
  if (req.method === "GET" && path === "/v1/loops") {
    loopRequests++;
    return void res.end(JSON.stringify({ loops: [] }));
  }
  if (req.method === "POST" && path.endsWith("/autopilot")) {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      autopilotRequests++;
      autopilotBody = JSON.parse(raw);
      res.end(JSON.stringify({ loop: {}, grants: [] }));
    });
    return;
  }
  res.end("{}");
});
await new Promise<void>((resolve) => core.listen(0, resolve));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_ORG_ID = "acme";
process.env.CORE_SIGNING_SECRET = "loops-web-route-test";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;

function identity(principalId: string): Record<string, string> {
  return {
    [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: principalId, exp: Date.now() + 60_000 }, "loops-web-route-test"),
  };
}

test.after(() => {
  surface.close();
  core.close();
});

test("a user with inbox_loops gets loops and inbox and loop routes pass through", async () => {
  const headers = identity("Alice@example.com");
  const me = await fetch(`${base}/me`, { headers });
  assert.equal(me.status, 200);
  assert.deepEqual((await me.json()).permissions, ["member", "loops", "inbox"]);

  const loops = await fetch(`${base}/api/loops`, { headers });
  assert.equal(loops.status, 200);
  assert.equal(loopRequests, 1);

  const autopilot = await fetch(`${base}/api/loops/loop-1/autopilot`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(autopilot.status, 200);
  assert.equal(autopilotRequests, 1);
  assert.deepEqual(autopilotBody, { enabled: true });
});

test("a user without inbox_loops lacks both and loop routes return 403", async () => {
  const headers = identity("bob@example.com");
  const me = await fetch(`${base}/me`, { headers });
  assert.equal(me.status, 200);
  assert.deepEqual((await me.json()).permissions, ["member"]);

  const loops = await fetch(`${base}/api/loops`, { headers });
  assert.equal(loops.status, 403);
  assert.deepEqual(await loops.json(), { error: "feature_disabled" });
  assert.equal(loopRequests, 1);

  const autopilot = await fetch(`${base}/api/loops/loop-1/autopilot`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(autopilot.status, 403);
  assert.equal(autopilotRequests, 1);
});
