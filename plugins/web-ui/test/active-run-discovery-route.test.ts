import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

// The scenario Bugbot caught on this feature: a surface instance that saw only the QUEUE
// submission holds the pending run in its local index and nothing else. Core's durable answer
// names the actual head. Discovery must report core's head as the live run — a pending turn
// queued behind a running one is never "active", however this instance learned of it.
const THREAD = "web:alice:t-disc";
const runStatus = new Map<string, string>([
  ["run-live", "running"],
  ["run-queued", "pending"],
]);
let durableHead: string | null = "run-live";
let queued: Array<{ runId: string; text: string }> = [{ runId: "run-queued", text: "after this" }];

const core = createServer((req: IncomingMessage, res) => {
  const u = new URL(req.url ?? "", "http://core");
  const reply = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "POST" && u.pathname === "/v1/turns") {
    let body = "";
    req.on("data", (c) => (body += c));
    return void req.on("end", () => reply(200, { status: "queued", runId: "run-queued" }));
  }
  if (req.method === "GET" && u.pathname === "/v1/runs")
    return reply(200, { runId: durableHead, ...(queued.length ? { queued } : {}) });
  const m = /^\/v1\/runs\/([^/]+)$/.exec(u.pathname);
  if (req.method === "GET" && m) {
    const status = runStatus.get(decodeURIComponent(m[1]!));
    return status ? reply(200, { status }) : reply(404, { error: "not_found" });
  }
  reply(404, { error: "not_found" });
});
await new Promise<void>((r) => core.listen(0, r));

const SECRET = "active-run-discovery-test";
process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = SECRET;
process.env.WEB_UI_PRINCIPALS = "alice";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((r) => surface.listen(0, r));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;
const IDENTITY = {
  cookie: "webuiuser=alice",
  [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, SECRET),
  "content-type": "application/json",
};

test.after(() => {
  surface.close();
  core.close();
});

test("a pending run this instance remembered never masks core's running head", async () => {
  // Seed the instance-local index with ONLY the queued (pending) run — exactly what an instance
  // that handled the queue submission but not the original send looks like.
  const seed = await fetch(`${base}/api/turn`, {
    method: "POST",
    headers: IDENTITY,
    body: JSON.stringify({ text: "after this", threadRef: THREAD }),
  });
  assert.equal(seed.status, 200);
  assert.equal(((await seed.json()) as { runId?: string }).runId, "run-queued");

  const r = await fetch(`${base}/api/runs/active?threadRef=${encodeURIComponent(THREAD)}`, { headers: IDENTITY });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { runId: string | null; queued?: Array<{ runId: string }> };
  assert.equal(body.runId, "run-live", "core's durable head is the live run, not the remembered pending one");
  assert.deepEqual(
    body.queued?.map((q) => q.runId),
    ["run-queued"],
    "the pending turn stays reported as queued",
  );
});

test("when core's head IS the remembered run, it reports live once and never doubles as queued", async () => {
  durableHead = "run-queued";
  runStatus.set("run-queued", "running");
  queued = [{ runId: "run-queued", text: "after this" }];
  const r = await fetch(`${base}/api/runs/active?threadRef=${encodeURIComponent(THREAD)}`, { headers: IDENTITY });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { runId: string | null; queued?: Array<{ runId: string }> };
  assert.equal(body.runId, "run-queued");
  assert.equal(body.queued, undefined, "the followed run is filtered out of the queue");
});

test("nothing in flight answers null with whatever core still holds queued", async () => {
  durableHead = null;
  // Both remembered runs are terminal now: the walk prunes them instead of reporting one.
  runStatus.set("run-queued", "done");
  runStatus.set("run-live", "done");
  queued = [{ runId: "run-later", text: "still waiting" }];
  const r = await fetch(`${base}/api/runs/active?threadRef=${encodeURIComponent(THREAD)}`, { headers: IDENTITY });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { runId: string | null; queued?: Array<{ runId: string }> };
  assert.equal(body.runId, null);
  assert.deepEqual(
    body.queued?.map((q) => q.runId),
    ["run-later"],
  );
});
