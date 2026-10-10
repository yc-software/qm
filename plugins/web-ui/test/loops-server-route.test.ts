import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

let loopRequests = 0;
let autopilotRequests = 0;
let autopilotBody: unknown;
let previewPrincipal: string | null = null;
let previewRequests = 0;
let previewBody: unknown;
const core = createServer((req: IncomingMessage, res) => {
  const path = new URL(req.url ?? "/", "http://core").pathname;
  res.setHeader("content-type", "application/json");
  if (path === "/v1/inbox/access") return void res.end(JSON.stringify({ enabled: true }));
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
  if (path === "/v1/loops/loop-1/triage/preview" && req.method === "POST") {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      previewBody = JSON.parse(raw);
      res.statusCode = 202;
      res.end(JSON.stringify({ preview: { id: "preview-1", status: "running", items: [], total: 2, completed: 0 } }));
    });
    return;
  }
  if (path === "/v1/loops/loop-1/triage/preview/preview-1" && req.method === "GET") {
    previewRequests++;
    previewPrincipal = new URL(req.url!, "http://core").searchParams.get("principalId");
    return void res.end(
      JSON.stringify({
        preview: {
          id: "preview-1",
          status: "running",
          items: [{ id: "item-1", priority: "high" }],
          total: 2,
          completed: 1,
        },
      }),
    );
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
process.env.WEB_UI_PRINCIPALS = "Alice@example.com,bob@example.com";
process.env.LOOPS_USERS = " other@example.com, ALICE@EXAMPLE.COM ";

const { handler, isLoopsUser } = await import("../server/index.ts");
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

test("allowlisted user gets loops permission and loop routes pass through", async () => {
  const headers = identity("Alice@example.com");
  const me = await fetch(`${base}/me`, { headers });
  assert.equal(me.status, 200);
  assert.deepEqual((await me.json()).permissions, ["member", "loops"]);

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

test("user outside the allowlist lacks permission and loop routes return 403", async () => {
  const headers = identity("bob@example.com");
  const me = await fetch(`${base}/me`, { headers });
  assert.equal(me.status, 200);
  assert.deepEqual((await me.json()).permissions, ["member"]);

  const loops = await fetch(`${base}/api/loops`, { headers });
  assert.equal(loops.status, 403);
  assert.deepEqual(await loops.json(), { error: "forbidden" });
  assert.equal(loopRequests, 1);

  const autopilot = await fetch(`${base}/api/loops/loop-1/autopilot`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(autopilot.status, 403);
  assert.equal(autopilotRequests, 1);
});

test("unset or empty LOOPS_USERS denies everyone", () => {
  const configured = process.env.LOOPS_USERS;
  delete process.env.LOOPS_USERS;
  assert.equal(isLoopsUser("Alice@example.com"), false);
  process.env.LOOPS_USERS = configured;
  assert.equal(isLoopsUser("Alice@example.com", ""), false);
  assert.equal(isLoopsUser(" alice@example.com ", " ALICE@EXAMPLE.COM "), true);
});

test("triage preview creation and polling relay status, results, and signed-in principal", async () => {
  const headers = identity("Alice@example.com");
  const body = { triage: { prioritize: { enabled: true, instructions: "Outages first" } } };
  const started = await fetch(`${base}/api/loops/loop-1/triage/preview`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(started.status, 202);
  assert.equal((await started.json()).preview.status, "running");
  assert.deepEqual(previewBody, body);
  const polled = await fetch(`${base}/api/loops/loop-1/triage/preview/preview-1`, { headers });
  assert.equal(polled.status, 200);
  const result = (await polled.json()).preview;
  assert.equal(result.completed, 1);
  assert.deepEqual(result.items, [{ id: "item-1", priority: "high" }]);
  assert.equal(previewPrincipal, "Alice@example.com");
  assert.equal(previewRequests, 1);
  const denied = await fetch(`${base}/api/loops/loop-1/triage/preview/preview-1`, {
    headers: identity("bob@example.com"),
  });
  assert.equal(denied.status, 403);
  assert.equal(previewRequests, 1);
});
