import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

const calls: { method: string; url: string; body: string; identity: boolean }[] = [];
const core = createServer((req: IncomingMessage, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    calls.push({
      method: req.method ?? "GET",
      url: req.url ?? "",
      body: raw,
      identity: Boolean(req.headers[PORTAL_IDENTITY_HEADER.toLowerCase()]),
    });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise<void>((resolve) => core.listen(0, resolve));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "swarm-route-test";
process.env.WEB_UI_PRINCIPALS = "alice";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;
const headers = {
  [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, "swarm-route-test"),
  "content-type": "application/json",
};

test.after(() => {
  surface.close();
  core.close();
});

test("swarm inspect and controls relay to core as the signed-in person", async () => {
  const before = calls.length;
  assert.equal((await fetch(`${base}/api/sessions/root-1/swarm`, { headers })).status, 200);
  const control = { action: "control", memberId: "worker-1", state: "paused" };
  const r = await fetch(`${base}/api/sessions/root-1/swarm`, {
    method: "POST",
    headers,
    body: JSON.stringify(control),
  });
  assert.equal(r.status, 200);
  const relayed = calls.slice(before).filter((call) => call.url.includes("/swarm"));
  assert.deepEqual(
    relayed.map(({ method, url, identity }) => ({ method, url: url.split("?")[0], identity })),
    [
      { method: "GET", url: "/v1/sessions/root-1/swarm", identity: true },
      { method: "POST", url: "/v1/sessions/root-1/swarm", identity: true },
    ],
  );
  assert.deepEqual(JSON.parse(relayed[1]!.body), control);
});

test("the web proxy exposes only swarm controls, not spawn or send", async () => {
  const before = calls.length;
  for (const action of ["spawn", "send", "context"]) {
    const r = await fetch(`${base}/api/sessions/root-1/swarm`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action, requestId: "r", text: "hi" }),
    });
    assert.equal(r.status, 400);
  }
  assert.equal(calls.slice(before).filter((call) => call.url.includes("/swarm")).length, 0);
});

const relayedQuery = (url: string) => {
  const parsed = new URL(url, "http://core.invalid");
  const params = parsed.searchParams;
  return {
    path: parsed.pathname,
    read: params.get("read"),
    after: params.get("after"),
  };
};

test("a board read loses read=1 and its after cursor on the way to core", async () => {
  const before = calls.length;
  assert.equal((await fetch(`${base}/api/sessions/root-1/swarm?read=1&after=7&waitMs=5000`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/api/sessions/root-1/swarm?read=1`, { headers })).status, 200);
  assert.deepEqual(
    calls.slice(before).map((call) => relayedQuery(call.url)),
    [
      { path: "/v1/sessions/root-1/swarm", read: "1", after: "7" },
      { path: "/v1/sessions/root-1/swarm", read: "1", after: null },
    ],
  );
});

test("the relay hands waitMs to core, so every open panel parks a core connection", async () => {
  const before = calls.length;
  assert.equal((await fetch(`${base}/api/sessions/root-1/swarm?read=1&waitMs=30000`, { headers })).status, 200);
  assert.deepEqual(
    calls.slice(before).map((call) => new URL(call.url, "http://core").searchParams.get("waitMs")),
    [null],
  );
});

test("a tree read forwards a stray after cursor and stops being a tree read", async () => {
  const before = calls.length;
  assert.equal((await fetch(`${base}/api/sessions/root-1/swarm?after=7&waitMs=5000`, { headers })).status, 200);
  assert.deepEqual(
    calls.slice(before).map((call) => relayedQuery(call.url)),
    [{ path: "/v1/sessions/root-1/swarm", read: null, after: null }],
  );
});
