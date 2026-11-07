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
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/v1/personas/p1/access")) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "invalid", message: "a persona must keep at least one owner" }));
      return;
    }
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise<void>((resolve) => core.listen(0, resolve));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "personas-route-test";
process.env.WEB_UI_PRINCIPALS = "alice";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;
const headers = {
  [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, "personas-route-test"),
  "content-type": "application/json",
};

test.after(() => {
  surface.close();
  core.close();
});

function withoutNonce(url: string): string {
  const parsed = new URL(url, "http://core");
  parsed.searchParams.delete("_sourceAuthNonce");
  return `${parsed.pathname}${parsed.search}`;
}

async function send(method: string, path: string, body?: unknown): Promise<Call> {
  const before = calls.length;
  const r = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  await r.text();
  const call = calls.slice(before).find((c) => /^\/v1\/(personas|sessions)/.test(c.url));
  assert.ok(call, `${method} ${path} never reached core`);
  return { ...call, url: withoutNonce(call.url) };
}

test("persona credential writes carry the signed-in person, never one the browser names", async () => {
  const call = await send("POST", "/api/personas/p1/credentials", { principalId: "mallory", name: "Ada" });
  assert.deepEqual(
    [call.method, call.url, call.body.principalId, call.body.name],
    ["POST", "/v1/personas/p1/credentials", "alice", "Ada"],
  );
  const detached = await send("DELETE", "/api/personas/p1/credentials/g%201");
  assert.deepEqual(
    [detached.method, detached.url, detached.body],
    ["DELETE", "/v1/personas/p1/credentials/g%201", { principalId: "alice" }],
  );
});
