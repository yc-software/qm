import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

const a = randomUUID();
const hosts: Record<string, { tenant: string; multi: boolean; sole: boolean }> = {
  "a.example.test": { tenant: a, multi: true, sole: false },
};
const seen: { path: string; headers: IncomingHttpHeaders }[] = [];
const upstream = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://core.test").pathname;
  res.setHeader("content-type", "application/json");
  const host = path.startsWith("/v1/operator/hosts/") ? decodeURIComponent(path.slice(19)) : undefined;
  if (host !== undefined)
    return void res.end(JSON.stringify(hosts[host] ?? { tenant: null, multi: true, sole: false }));
  if (path === "/v1/surface-config") return void res.end("{}");
  seen.push({ path, headers: req.headers });
  req.resume();
  res.end(JSON.stringify({ path }));
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
Object.assign(process.env, {
  NODE_ENV: "test",
  PORTAL_PUBLIC_URL: "http://portal.test",
  PORTAL_SESSION_SECRET: "shared-host-agent-api-secret",
  CORE_ORG_ID: "acme",
  CORE_SIGNING_SECRET: "shared-host-agent-api-core-secret",
  CORE_API_URL: upstreamUrl,
  WEB_UI_UPSTREAM: upstreamUrl,
  PORTAL_LOCAL_AUTH_BYPASS: "0",
  PORTAL_PLAYGROUND: "0",
});
const { server } = await import("../src/index.ts");
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
test.after(() => {
  server.close();
  upstream.close();
});

function get(host: string, path: string, headers: Record<string, string> = {}, method = "GET"): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host, ...headers } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

function lastSeen(path: string): IncomingHttpHeaders {
  const hit = seen.findLast((entry) => entry.path === path);
  assert.ok(hit, `core never received ${path}`);
  return hit.headers;
}

test("the shared deployment host passes capability-authenticated agent API calls to core", async () => {
  assert.equal(await get("portal.test", "/v1/apis", { "x-agent-capability": "token-1" }), 200);
  const headers = lastSeen("/v1/apis");
  assert.equal(headers["x-agent-capability"], "token-1");
  assert.equal(headers["x-qm-tenant"], undefined);
});

test("the shared deployment host passes bearer model gateway calls to core with their credential", async () => {
  assert.equal(await get("portal.test", "/v1/sandbox-model/v1/models", { authorization: "Bearer token-2" }), 200);
  assert.equal(lastSeen("/v1/sandbox-model/v1/models").authorization, "Bearer token-2");
  assert.equal(await get("portal.test", "/v1/sandbox-model/v1/messages", { "x-api-key": "token-3" }), 200);
  assert.equal(lastSeen("/v1/sandbox-model/v1/messages")["x-api-key"], "token-3");
});

test("the shared deployment host still refuses uncredentialed and non-agent requests", async () => {
  assert.equal(await get("portal.test", "/v1/apis"), 421);
  assert.equal(await get("portal.test", "/v1/apis", { authorization: "Bearer token-4" }), 421);
  assert.equal(await get("portal.test", "/"), 421);
});

test("a tenant host forwards its tenant so core refuses a capability from another tenant", async () => {
  assert.equal(await get("a.example.test", "/v1/apis", { "x-agent-capability": "token-5" }), 200);
  assert.equal(lastSeen("/v1/apis")["x-qm-tenant"], a);
  assert.equal(await get("a.example.test", "/v1/sandbox-model/v1/models", { authorization: "Bearer token-6" }), 200);
  const gateway = lastSeen("/v1/sandbox-model/v1/models");
  assert.equal(gateway["x-qm-tenant"], a);
  assert.equal(gateway.authorization, "Bearer token-6");
});

test("a client cannot choose the tenant header itself", async () => {
  assert.equal(
    await get("portal.test", "/v1/apis", { "x-agent-capability": "token-7", "x-qm-tenant": randomUUID() }),
    200,
  );
  assert.equal(lastSeen("/v1/apis")["x-qm-tenant"], undefined);
});

test("an agent call on a host with no tenant goes straight to core, past the portal's own routes", async () => {
  const path = "/v1/surfaces/partner-chat/events";
  assert.equal(await get("portal.test", path, { "x-agent-capability": "token-8" }, "POST"), 200);
  const headers = lastSeen(path);
  assert.equal(headers["x-agent-capability"], "token-8");
  assert.equal(headers["x-qm-tenant"], undefined);
});
