import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

const calls: Call[] = [];
const core = createServer((req: IncomingMessage, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    calls.push({
      method: req.method ?? "GET",
      url: req.url ?? "",
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
    });
    res.writeHead(200, { "content-type": "application/json" });
    if ((req.url ?? "").startsWith("/v1/deployments?")) {
      res.end(JSON.stringify({ deployments: [{ id: "d1", permission: "write" }] }));
      return;
    }
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise<void>((resolve) => core.listen(0, resolve));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "body-parsing-test";
process.env.WEB_UI_PRINCIPALS = "alice";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;
const headers = {
  [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, "body-parsing-test"),
  "content-type": "application/json",
};

test.after(() => {
  surface.close();
  core.close();
});

test("a body that parses to a JSON primitive answers 400 — it never hangs the request", async () => {
  for (const raw of ["null", "false", "0", '""', "42"]) {
    const r = await fetch(`${base}/api/ui-state`, { method: "PUT", headers, body: raw });
    assert.equal(r.status, 400, `body ${raw} must answer, not hang`);
    assert.equal(((await r.json()) as { error?: string }).error, "bad_request");
  }
});

test("an empty body on a strict route is refused, not read as a field-clearing object", async () => {
  const before = calls.length;
  for (const [method, path] of [
    ["POST", "/api/deployments/d1/display-name"],
    ["POST", "/api/deployments/d1/name"],
    ["POST", "/api/memory/restore"],
    ["PUT", "/api/memory"],
    ["POST", "/api/sessions/s1"],
    ["POST", "/api/connectors/revoke"],
    ["POST", "/api/keychain/drops"],
    ["POST", "/api/runs/r1/signal"],
  ] as const) {
    const r = await fetch(`${base}${path}`, { method, headers });
    assert.equal(r.status, 400, `${method} ${path} with no body must refuse`);
  }
  const reached = calls.slice(before).filter((c) => !c.url.startsWith("/v1/deployments?"));
  assert.equal(reached.length, 0, "no empty-body request may reach core (only the manage gate's list fetch may)");
});

test("routes that historically tolerated an empty body still do", async () => {
  const r = await fetch(`${base}/api/sessions/s1/fork`, { method: "POST", headers });
  assert.equal(r.status, 200, "fork with no body still forks from the tail");
  const forked = calls.at(-1);
  assert.deepEqual(forked?.body, { principalId: "alice" });
});
