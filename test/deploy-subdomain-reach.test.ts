import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest, createServer as createHttpServer } from "node:http";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/api/app.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import type { DeployEndpoint, DeployProvider } from "../src/deploy/deploy-provider.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createDirectoryStore } from "../src/directory/directory-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { scopeId } from "../src/types.ts";
import type { AuditEvent } from "../src/audit/audit-log.ts";

const audits: Array<(e: AuditEvent) => void> = [];
const onceKeys = new Set<string>();
const auditLog = {
  record(e: AuditEvent) {
    for (const fn of audits) fn(e);
  },
  async recordOnce(key: string, e: AuditEvent) {
    if (onceKeys.has(key)) return;
    onceKeys.add(key);
    for (const fn of audits) fn(e);
  },
  events: async () => [],
  tail: async () => [],
};
const SESSION_SECRET = "portal-session-secret";
const SESSION_DEPS = {
  deployAppsSessionSecret: SESSION_SECRET,
  deployAppsLoginUrl: "https://portal.example.com",
} as const;

function mintPortalSession(sub: string): string {
  const key = createHmac("sha256", SESSION_SECRET).update("portal.session.v1").digest();
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({ k: "session", sub, org: "acme", iat: now, exp: now + 3600 })).toString(
    "base64url",
  );
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

function serviceWithProvider(provider: DeployProvider) {
  const deployStore = createDeployStore();
  const deploy = createDeployService({
    deployStore,
    provider,
    auditLog,
    acl: createAclStore(),
    deployDir: mkdtempSync(join(tmpdir(), "seam-")),
  });
  return { deploy, deployStore };
}

test("reachDeployment: a provider's resolveEndpoint refreshes (and persists) the live endpoint", async () => {
  let applies = 0;
  let resolved: DeployEndpoint | null = null;
  const provider: DeployProvider = {
    profile: { managedScaleToZero: true, inPlaceReconcile: true },
    apply: async () => {
      applies++;
      return { host: "stored", port: 443, tls: true };
    },
    resolveEndpoint: async () => resolved,
    destroy: async () => {},
  };
  const { deploy, deployStore } = serviceWithProvider(provider);
  const d = await deploy.deploy({
    ownerScopeId: scopeId("org", "default-org"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
  });
  assert.equal(applies, 1);

  resolved = { host: "warm", port: 443, tls: true, proxyHeaders: { "X-aws-proxy-auth": "fresh" } };
  const reach = await deploy.reachDeployment(d.id, "U-any");
  assert.equal(reach.status, "ok");
  assert.equal(reach.status === "ok" && reach.endpoint.host, "warm", "the refreshed endpoint is returned");
  assert.equal(applies, 1, "a warm refresh does not re-apply");
  assert.equal(
    (await deployStore.get(d.id))!.endpoint!.proxyHeaders!["X-aws-proxy-auth"],
    "fresh",
    "the refreshed endpoint is persisted",
  );
});

test("reachDeployment: a null resolveEndpoint re-applies the current version from source", async () => {
  let applies = 0;
  const provider: DeployProvider = {
    profile: { managedScaleToZero: true, inPlaceReconcile: true },
    apply: async () => {
      applies++;
      return { host: `body-${applies}`, port: 443, tls: true };
    },
    resolveEndpoint: async () => null,
    destroy: async () => {},
  };
  const { deploy } = serviceWithProvider(provider);
  const d = await deploy.deploy({
    ownerScopeId: scopeId("org", "default-org"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
  });
  assert.equal(applies, 1);

  const reach = await deploy.reachDeployment(d.id, "U-any");
  assert.equal(reach.status, "ok");
  assert.equal(applies, 2, "a gone body triggers a re-apply");
  assert.equal(reach.status === "ok" && reach.endpoint.host, "body-2", "the freshly re-applied endpoint is served");
});

test("reachDeployment: a provider without resolveEndpoint returns the frozen stored endpoint", async () => {
  const provider: DeployProvider = {
    profile: { managedScaleToZero: false },
    apply: async () => ({ host: "frozen", port: 9000 }),
    destroy: async () => {},
  };
  const { deploy } = serviceWithProvider(provider);
  const d = await deploy.deploy({
    ownerScopeId: scopeId("org", "default-org"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
  });
  const reach = await deploy.reachDeployment(d.id, "U-any");
  assert.equal(reach.status === "ok" && reach.endpoint.host, "frozen");
});

function appServingUpstream(upstreamPort: number) {
  const deployStore = createDeployStore();
  const deploy = createDeployService({
    deployStore,
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: upstreamPort }),
      destroy: async () => {},
    },
    auditLog,
    acl: createAclStore(),
    deployDir: mkdtempSync(join(tmpdir(), "subdomain-")),
  });
  const app = createApp({
    deploy,
    acl: createAclStore(),
    directory: createDirectoryStore(),
    sessions: createMemorySessionStore(),
    identity: createIdentityService(),
  } as unknown as Parameters<typeof createApp>[0]);
  return app;
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

test("subdomain ingress: a capability link grants nothing — reach is the ACL alone", async () => {
  const denials: AuditEvent[] = [];
  audits.push((e) => {
    if (e.action === "deployment.reach_denied") denials.push(e);
  });
  const upstream = createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("UPSTREAM OK");
  });
  upstream.listen(0);
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const app = appServingUpstream(upstreamPort);
  await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    name: "mysite",
  });
  const server = createInsecureTestServer(app, {
    deployAppsDomain: "apps.example.com",
    deployGateSecret: "gate-secret",
    auditLog,
    ...SESSION_DEPS,
  });
  server.listen(0);
  const port = (server.address() as AddressInfo).port;
  const host = "mysite.apps.example.com";

  try {
    const anon = await httpGet(port, "/", { Host: host });
    assert.equal(anon.status, 401, "anonymous ⇒ sign-in required");

    const staleLink = await httpGet(port, "/?access=any-old-token&x=1", { Host: host, Accept: "text/html" });
    assert.equal(staleLink.status, 302, "a stale ?access= link is swallowed, not honoured");
    assert.equal(staleLink.headers.location, "/?x=1", "the token leaves the URL; nothing else is lost");
    assert.ok(!String(staleLink.headers["set-cookie"] ?? "").includes("dpl_access"), "no access cookie is minted");

    const staleCookie = await httpGet(port, "/", { Host: host, Cookie: "dpl_access=any-old-token" });
    assert.equal(staleCookie.status, 401, "a dpl_access cookie from an old link grants nothing");

    const owner = await httpGet(port, "/", { Host: host, Cookie: `portal_session=${mintPortalSession("U1")}` });
    assert.equal(owner.status, 200, "a signed-in person the ACL allows is proxied");
    assert.equal(owner.body, "UPSTREAM OK");

    const stranger = await httpGet(port, "/", { Host: host, Cookie: `portal_session=${mintPortalSession("U9")}` });
    assert.equal(stranger.status, 403, "a signed-in stranger is denied by the ACL");

    await httpGet(port, "/", { Host: host, Cookie: `portal_session=${mintPortalSession("U9")}` });

    const unknownSlug = await httpGet(port, "/", {
      Host: "nope.apps.example.com",
      Cookie: `portal_session=${mintPortalSession("U1")}`,
    });
    assert.equal(unknownSlug.status, 404, "a session on a non-existent deployment is a 404");

    assert.deepEqual(
      denials.map((e) => [e.principalId, e.resource, e.status, e.scopeLabel]),
      [["U9", "mysite", "denied", scopeId("personal", "U1")]],
      "one row per person+app+hour, filed under the app's OWNER scope; not_found is never audited",
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("subdomain ingress: an upstream 429 opens a shield that stops re-dialing the throttled deployment", async () => {
  let upstreamHits = 0;
  const upstream = createHttpServer((_req, res) => {
    upstreamHits++;
    res.writeHead(429, { "retry-after": "1" });
    res.end();
  });
  upstream.listen(0);
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const app = appServingUpstream(upstreamPort);
  await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    name: "throttled",
  });
  const server = createInsecureTestServer(app, {
    deployAppsDomain: "apps.example.com",
    deployGateSecret: "gate-secret",
    ...SESSION_DEPS,
  });
  server.listen(0);
  const port = (server.address() as AddressInfo).port;
  const host = "throttled.apps.example.com";
  const cookie = `portal_session=${mintPortalSession("U1")}`;

  try {
    const first = await httpGet(port, "/", { Host: host, Cookie: cookie });
    assert.equal(first.status, 429, "the upstream throttle reaches the visitor");
    const second = await httpGet(port, "/", { Host: host, Cookie: cookie });
    assert.equal(second.status, 429, "the shield answers throttled too");
    assert.ok(second.headers["retry-after"], "the shield tells clients when to come back");
    assert.equal(upstreamHits, 1, "a throttled deployment is not re-dialed while the shield is up");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("subdomain ingress: an app's own 429 (with a body) passes through without arming the shield", async () => {
  let upstreamHits = 0;
  const upstream = createHttpServer((_req, res) => {
    upstreamHits++;
    res.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
    res.end(JSON.stringify({ error: "slow down" }));
  });
  upstream.listen(0);
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const app = appServingUpstream(upstreamPort);
  await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    name: "ratelimited",
  });
  const server = createInsecureTestServer(app, {
    deployAppsDomain: "apps.example.com",
    deployGateSecret: "gate-secret",
    ...SESSION_DEPS,
  });
  server.listen(0);
  const port = (server.address() as AddressInfo).port;
  const host = "ratelimited.apps.example.com";
  const cookie = `portal_session=${mintPortalSession("U1")}`;

  try {
    const first = await httpGet(port, "/", { Host: host, Cookie: cookie });
    assert.equal(first.status, 429);
    const second = await httpGet(port, "/", { Host: host, Cookie: cookie });
    assert.equal(second.status, 429);
    assert.equal(
      second.body,
      JSON.stringify({ error: "slow down" }),
      "the app's own rate-limit response reaches the visitor",
    );
    assert.equal(upstreamHits, 2, "an app-emitted 429 must not suppress the deployment for other visitors");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("subdomain ingress: a non-apps Host is not gated (normal routing proceeds)", async () => {
  const app = appServingUpstream(1);
  const server = createInsecureTestServer(app, {
    deployAppsDomain: "apps.example.com",
    deployGateSecret: "gate-secret",
  });
  server.listen(0);
  const port = (server.address() as AddressInfo).port;
  try {
    const r = await httpGet(port, "/nope", { Host: "agent.internal.example.com" });
    assert.notEqual(r.status, 401, "a normal host must not hit the subdomain gate");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
