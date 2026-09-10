import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest, createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/api/app.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createDirectoryStore } from "../src/directory/directory-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { mintDeployOwnerToken } from "../src/deploy/access-token.ts";
import { mintAppSession } from "../src/deploy/app-session.ts";
import { scopeId } from "../src/types.ts";

const auditLog = { record() {}, events: async () => [], tail: async () => [] };
const GATE_SECRET = "gate-secret";
const PORTAL = "https://portal.example.com";

function appServingUpstream(upstreamPort: number) {
  const deployStore = createDeployStore();
  const acl = createAclStore();
  const deploy = createDeployService({
    deployStore,
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: upstreamPort }),
      destroy: async () => {},
    },
    auditLog,
    acl,
    deployDir: mkdtempSync(join(tmpdir(), "app-shell-")),
  });
  return createApp({
    deploy,
    acl,
    directory: createDirectoryStore(),
    sessions: createMemorySessionStore(),
    identity: createIdentityService(),
    orgId: "acme",
  } as unknown as Parameters<typeof createApp>[0]);
}

function httpGet(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "localhost", port, path, method: "GET", headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function widgetFixture(upstreamHandler?: Parameters<typeof createHttpServer>[1]) {
  const upstream = createHttpServer(
    upstreamHandler ??
      ((_req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<html><body>APP</body></html>");
      }),
  );
  upstream.listen(0);
  await new Promise((r) => upstream.once("listening", r));
  const upstreamPort = (upstream.address() as AddressInfo).port;
  const app = appServingUpstream(upstreamPort);
  const d = await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    name: "mysite",
  });
  await app.shareDeployment(d.id, scopeId("personal", "U-viewer"), "read", { createdBy: "U1" });
  const server = createInsecureTestServer(app, {
    identity: createIdentityService(),
    deployAppsDomain: "apps.example.com",
    deployGateSecret: GATE_SECRET,
    deployAppsLoginUrl: PORTAL,
  });
  server.listen(0);
  const port = (server.address() as AddressInfo).port;
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  };
  return { app, port, close, id: d.id, host: `${d.id}.apps.example.com` };
}

async function scopedCookie(id: string, sub = "U1"): Promise<string> {
  return `__Host-qm_app_session=${await mintAppSession(GATE_SECRET, { type: "session", orgId: "default-org", deploymentId: id, origin: `https://${id}.apps.example.com`, sub, iat: Date.now(), exp: Date.now() + 60_000 })}`;
}
const ownerToken = (slug: string, sub: string, expInMs = 60_000) =>
  mintDeployOwnerToken(GATE_SECRET, { slug, sub, exp: Date.now() + expInMs });

test("retired owner link and cookie cannot independently authorize runtime or create an owner shell", async () => {
  const f = await widgetFixture();
  try {
    const token = await ownerToken(f.id, "U1");
    const swallow = await httpGet(f.port, `/?owner=${token}`, { Host: f.host });
    assert.equal(swallow.status, 401);
    assert.equal(swallow.headers["set-cookie"], undefined);
    assert.equal((await httpGet(f.port, "/", { Host: f.host, Cookie: `dpl_owner=${token}` })).status, 401);
  } finally {
    await f.close();
  }
});

for (const dest of ["document", "iframe", "empty", ""]) {
  test(`scoped owner runtime is unwrapped app HTML for fetch destination ${dest || "absent"}`, async () => {
    const f = await widgetFixture();
    try {
      const page = await httpGet(f.port, "/reports?q=2", {
        Host: f.host,
        Cookie: await scopedCookie(f.id),
        ...(dest ? { "sec-fetch-dest": dest } : {}),
      });
      assert.equal(page.status, 200);
      assert.equal(page.body, "<html><body>APP</body></html>");
      assert.doesNotMatch(page.body, /__qmAppShell/);
    } finally {
      await f.close();
    }
  });
}

test("scoped shared viewer receives untouched app HTML; owner cookies never borrow another principal's authority", async () => {
  const f = await widgetFixture();
  try {
    const owner = await ownerToken(f.id, "U1");
    const cookie = `${await scopedCookie(f.id, "U-viewer")}; dpl_owner=${owner}`;
    assert.equal((await httpGet(f.port, "/", { Host: f.host, Cookie: cookie })).status, 200);
    await f.app.shareDeployment(f.id, scopeId("personal", "U-viewer"), null, { createdBy: "U1" });
    assert.equal((await httpGet(f.port, "/", { Host: f.host, Cookie: cookie })).status, 403);
  } finally {
    await f.close();
  }
});

test("retired owner version endpoint and control namespace are reserved for all roles", async () => {
  const f = await widgetFixture();
  try {
    for (const sub of ["U1", "U-viewer"])
      assert.equal(
        (await httpGet(f.port, "/__claw__/version", { Host: f.host, Cookie: await scopedCookie(f.id, sub) })).status,
        404,
      );
  } finally {
    await f.close();
  }
});

test("a 206 partial HTML response remains byte-exact without the old owner wrapper", async () => {
  const f = await widgetFixture((_req, res) => {
    res.writeHead(206, { "content-type": "text/html", "content-range": "bytes 0-9/32" });
    res.end("<html></h");
  });
  try {
    const r = await httpGet(f.port, "/", {
      Host: f.host,
      Cookie: await scopedCookie(f.id),
      "sec-fetch-dest": "document",
    });
    assert.equal(r.status, 206);
    assert.equal(r.body, "<html></h");
    assert.equal(r.headers["content-range"], "bytes 0-9/32");
  } finally {
    await f.close();
  }
});

test("expired legacy owner token grants no app authority", async () => {
  const f = await widgetFixture();
  try {
    assert.equal(
      (await httpGet(f.port, "/api", { Host: f.host, Cookie: `dpl_owner=${await ownerToken(f.id, "U1", -1)}` })).status,
      401,
    );
  } finally {
    await f.close();
  }
});

test("non-HTML owner responses stream untouched including content length", async () => {
  const f = await widgetFixture((_req, res) => {
    res.writeHead(200, { "content-type": "application/json", "content-length": "13" });
    res.end('{"data":true}');
  });
  try {
    const r = await httpGet(f.port, "/api", { Host: f.host, Cookie: await scopedCookie(f.id) });
    assert.equal(r.status, 200);
    assert.equal(r.body, '{"data":true}');
    assert.equal(r.headers["content-length"], "13");
  } finally {
    await f.close();
  }
});

test("upstream cannot plant any app or owner authority cookie", async () => {
  const f = await widgetFixture((_req, res) => {
    res.writeHead(200, {
      "set-cookie": ["dpl_owner=forged; Path=/", "__Host-qm_app_session=forged; Path=/; Secure", "app_pref=ok; Path=/"],
    });
    res.end("ok");
  });
  try {
    const r = await httpGet(f.port, "/", { Host: f.host, Cookie: await scopedCookie(f.id, "U-viewer") });
    assert.deepEqual(r.headers["set-cookie"], ["app_pref=ok; Path=/"]);
  } finally {
    await f.close();
  }
});

test("owner-url is current-manager-only trusted editor navigation, not runtime bearer issuance", async () => {
  const f = await widgetFixture();
  try {
    const ok = await httpGet(f.port, "/v1/deployments/mysite/owner-url?principalId=U1", {});
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.body).url, `${PORTAL}/app-edit?slug=${f.id}`);
    const denied = await httpGet(f.port, "/v1/deployments/mysite/owner-url?principalId=U-stranger", {});
    assert.equal(denied.status, 403);
  } finally {
    await f.close();
  }
});
