import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInsecureTestServer } from "../src/api/server.ts";
import { createApp } from "../src/api/app.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createDirectoryStore } from "../src/directory/directory-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { mintAppSession } from "../src/deploy/app-session.ts";
import { scopeId } from "../src/types.ts";

async function gateway(t: TestContext, upstreamPort: number, timeout = 200) {
  const identity = createIdentityService();
  const acl = createAclStore();
  const dir = mkdtempSync(join(tmpdir(), "warming-origin-"));
  const deploy = createDeployService({
    deployStore: createDeployStore(),
    acl,
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    deployDir: dir,
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: upstreamPort }),
      destroy: async () => {},
    },
  });
  const app = createApp({
    deploy,
    acl,
    identity,
    directory: createDirectoryStore(),
    sessions: createMemorySessionStore(),
  } as unknown as Parameters<typeof createApp>[0]);
  const d = await app.deploy({
    name: "warming",
    ownerScopeId: scopeId("personal", "viewer"),
    createdBy: "viewer",
    entrypoint: "x",
    files: [],
  });
  const secret = "warming-gateway-secret";
  const origin = `https://${d.id}.apps.example.test`;
  const cookie = `__Host-qm_app_session=${await mintAppSession(secret, { type: "session", orgId: "default-org", iat: Date.now(), deploymentId: d.id, origin, sub: "viewer", exp: Date.now() + 60_000 })}`;
  const server = createInsecureTestServer(app, {
    identity,
    deployAppsDomain: "apps.example.test",
    deployGateSecret: secret,
    deployDialTimeoutMs: timeout,
  });
  server.listen(0);
  const port = (server.address() as AddressInfo).port;
  t.after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { force: true, recursive: true });
  });
  return (init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          host: "localhost",
          port,
          path: "/",
          method: init.method ?? "GET",
          headers: { host: new URL(origin).host, cookie, origin, ...init.headers },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(Buffer.from(c)));
          res.on("end", () =>
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode,
                headers: res.headers as Record<string, string>,
              }),
            ),
          );
        },
      );
      req.on("error", reject);
      req.end(init.body);
    });
}

test("isolated app origin serves the warming page to a browser navigation when the deployment hangs", async (t) => {
  const upstream = createHttpServer(() => {});
  upstream.listen(0);
  const get = await gateway(t, (upstream.address() as AddressInfo).port);
  try {
    const res = await get({ headers: { accept: "text/html,application/xhtml+xml", "sec-fetch-dest": "document" } });
    assert.equal(res.status, 503);
    assert.match(String(res.headers.get("content-type")), /text\/html/);
    assert.equal(res.headers.get("retry-after"), "2");
    const body = await res.text();
    assert.match(body, /starting up/i);
    assert.match(body, /location\.reload/);
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});

test("isolated app origin serves the warming page when the deployment refuses connections", async (t) => {
  const upstream = createHttpServer(() => {});
  upstream.listen(0);
  const upstreamPort = (upstream.address() as AddressInfo).port;
  await new Promise<void>((r) => upstream.close(() => r()));
  const get = await gateway(t, upstreamPort);
  const res = await get({ headers: { accept: "text/html" } });
  assert.equal(res.status, 503);
  assert.match(await res.text(), /starting up/i);
});

test("isolated app origin keeps JSON gateway errors for non-document requests", async (t) => {
  const upstream = createHttpServer(() => {});
  upstream.listen(0);
  const get = await gateway(t, (upstream.address() as AddressInfo).port);
  try {
    const apiRes = await get({ headers: { accept: "application/json" } });
    assert.equal(apiRes.status, 504);
    assert.equal(((await apiRes.json()) as { error?: string }).error, "gateway_timeout");
    const postRes = await get({
      method: "POST",
      headers: { accept: "text/html", "content-type": "text/plain" },
      body: "hi",
    });
    assert.equal(postRes.status, 504);
    assert.equal(((await postRes.json()) as { error?: string }).error, "gateway_timeout");
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});

test("a recently-healthy app upstream keeps the full dial timeout for slow pages", async (t) => {
  let slow = false;
  const upstream = createHttpServer((_req, res) => {
    if (slow) setTimeout(() => res.end("slow-ok"), 300);
    else res.end("fast-ok");
  });
  upstream.listen(0);
  const get = await gateway(t, (upstream.address() as AddressInfo).port, 1000);
  try {
    const first = await get({ headers: { accept: "text/html" } });
    assert.equal(await first.text(), "fast-ok");
    slow = true;
    const second = await get({ headers: { accept: "text/html" } });
    assert.equal(second.status, 200);
    assert.equal(await second.text(), "slow-ok");
  } finally {
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});
