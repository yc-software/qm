import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

interface CoreCall {
  path: string;
  body: Record<string, unknown>;
}

const calls: CoreCall[] = [];
const core = createServer((req: IncomingMessage, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    calls.push({ path: req.url ?? "", body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url?.endsWith("/start") ? { deviceAuthId: "device-1" } : { status: "pending" }));
  });
});
await new Promise<void>((resolve) => core.listen(0, resolve));

const secret = "model-auth-relay-secret";
process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = secret;
process.env.WEB_UI_PRINCIPALS = "alice";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;
const headers = {
  [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, secret),
  "content-type": "application/json",
};

test.after(() => {
  surface.close();
  core.close();
});

test("Grok auth relays bind the portal principal and discard caller-supplied identity or token fields", async () => {
  const started = await fetch(`${base}/api/user-model-auth/grok/start`, {
    method: "POST",
    headers,
    body: JSON.stringify({ principalId: "mallory", accessToken: "caller-token" }),
  });
  assert.equal(started.status, 200);
  assert.equal(new URL(calls.at(-1)!.path, "http://core.test").pathname, "/v1/user-model-auth/grok/start");
  assert.deepEqual(calls.at(-1)?.body, { principalId: "alice" });

  const polled = await fetch(`${base}/api/user-model-auth/grok/poll`, {
    method: "POST",
    headers,
    body: JSON.stringify({ principalId: "mallory", deviceAuthId: "device-1", refreshToken: "caller-token" }),
  });
  assert.equal(polled.status, 200);
  assert.equal(new URL(calls.at(-1)!.path, "http://core.test").pathname, "/v1/user-model-auth/grok/poll");
  assert.deepEqual(calls.at(-1)?.body, { principalId: "alice", deviceAuthId: "device-1" });
});
