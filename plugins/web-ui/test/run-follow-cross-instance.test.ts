import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

interface Call {
  method: string;
  url: string;
  portalIdentity?: string;
}
const calls: Call[] = [];
const core = createServer((req: IncomingMessage, res) => {
  req.resume();
  req.on("end", () => {
    const pid = req.headers["x-portal-identity"];
    calls.push({ method: req.method ?? "GET", url: req.url ?? "", portalIdentity: Array.isArray(pid) ? pid[0] : pid });
    const url = req.url ?? "";
    if (url.includes("/v1/runs/r-forbidden")) {
      res.writeHead(404, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: "not_found" }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    if (req.method === "POST") return void res.end(JSON.stringify({ accepted: true }));
    res.end(JSON.stringify({ status: "running", alive: true, partial: "", activity: [] }));
  });
});
await new Promise<void>((resolve) => core.listen(0, resolve));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "run-follow-cross-instance-test";
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

const consulted = (needle: string, method: string) =>
  calls.some((c) => c.method === method && c.url.startsWith(needle));

test("one-shot run fetch defers to core for a run absent from the instance-local index", async () => {
  const r = await fetch(`${base}/api/runs/r-visible`, { headers });
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { status?: string }).status, "running");
  assert.ok(consulted("/v1/runs/r-visible", "GET"), "core must be consulted, not short-circuited by the local index");
});

test("run signal defers to core for a run absent from the instance-local index", async () => {
  const r = await fetch(`${base}/api/runs/r-visible/signal`, {
    method: "POST",
    headers,
    body: JSON.stringify({ kind: "abort" }),
  });
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { accepted?: boolean }).accepted, true);
  assert.ok(consulted("/v1/runs/r-visible/signal", "POST"), "signal must reach core");
});

test("run events stream opens for a run absent from the instance-local index", async () => {
  const controller = new AbortController();
  const r = await fetch(`${base}/api/runs/r-visible/events`, { headers, signal: controller.signal });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /text\/event-stream/);
  controller.abort();
  await r.body?.cancel().catch(() => {});
});

test("core's viewer gate still fails closed — a run core denies is relayed as not_found", async () => {
  const r = await fetch(`${base}/api/runs/r-forbidden`, { headers });
  assert.equal(r.status, 404);
  assert.ok(
    consulted("/v1/runs/r-forbidden", "GET"),
    "denial must come from core, proving the surface defers rather than guessing",
  );
});

test("the portal identity is forwarded to core, so its viewer gate is meaningful", async () => {
  const before = calls.length;
  await fetch(`${base}/api/runs/r-visible`, { headers: { ...headers, "x-portal-identity": "tok-forward-check" } });
  const coreCall = calls.slice(before).find((c) => c.method === "GET" && c.url.startsWith("/v1/runs/r-visible"));
  assert.ok(coreCall, "web-ui must call core");
  assert.equal(
    coreCall?.portalIdentity,
    "tok-forward-check",
    "web-ui must forward x-portal-identity — dropping it would silently disable core's viewer gate",
  );
});
