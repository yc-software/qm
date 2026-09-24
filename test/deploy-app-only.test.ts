import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api/app.ts";
import { createServer as createApiServer } from "../src/api/server.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createDirectoryStore } from "../src/directory/directory-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { portalSession } from "../src/deploy/viewer-session.ts";
import { deriveKey, seal } from "../plugins/portal/src/session.ts";
import { scopeId } from "../src/types.ts";
import { deployRef, encodeRef } from "../src/acl/resource-ref.ts";

const secret = "app-only-gateway-test-secret-long-enough";
const guest = "guest@partner.test";
const key = deriveKey(secret, "portal.session.v1");
function token(appOnly: unknown = true) {
  const now = Math.floor(Date.now() / 1000);
  return seal({ k: "session", sub: guest, org: "acme", iat: now, exp: now + 3600, appOnly }, key);
}
test("gateway parser keeps app-only authority and rejects malformed signed markers", () => {
  assert.deepEqual(portalSession(`portal_session=${token()}`, secret), { sub: guest, appOnly: true });
  for (const marker of ["false", null, 0, {}])
    assert.equal(portalSession(`portal_session=${token(marker)}`, secret), null);
});

test("app-only gateway checks exact current personal read grants without inherited or management authority", async () => {
  const dir = mkdtempSync(join(tmpdir(), "app-only-gateway-"));
  let upstreamHits = 0;
  const upstream = createServer((req, res) => {
    upstreamHits++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.headers));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const acl = createAclStore();
  const deploy = createDeployService({
    deployStore: createDeployStore({ git: { repoRoot: join(dir, "repos") } }),
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: (upstream.address() as AddressInfo).port }),
      destroy: async () => {},
    },
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl,
    deployDir: join(dir, "deploy"),
  });
  const identity = createIdentityService();
  const app = createApp({
    deploy,
    acl,
    directory: createDirectoryStore(),
    sessions: createMemorySessionStore(),
    identity,
  } as unknown as Parameters<typeof createApp>[0]);
  const ownerScopeId = scopeId("personal", "owner@example.test");
  const shared = await app.deploy({
    ownerScopeId,
    createdBy: "owner@example.test",
    entrypoint: "node app.js",
    files: [],
    name: "shared",
  });
  await app.deploy({
    ownerScopeId: scopeId("org", "acme"),
    createdBy: "owner@example.test",
    entrypoint: "node app.js",
    files: [],
    name: "org-app",
  });
  app.canManageDeployment = async () => {
    throw new Error("app-only must not consult management authority");
  };
  app.effectiveDeploymentPermission = async () => {
    throw new Error("app-only must not consult inherited permission");
  };
  const server = createApiServer(app, {
    identity,
    signingSecret: secret,
    deployAppsDomain: "apps.example.test",
    deployGateSecret: "gate",
    deployAppsSessionSecret: secret,
    deployAppsLoginUrl: "https://portal.example.test",
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const cookie = `portal_session=${token()}`;
  const get = (name: string, path = "/", method = "GET") =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path,
          method,
          headers: {
            host: `${name}.apps.example.test`,
            cookie,
            "sec-fetch-dest": "document",
            accept: "application/json",
            "x-portal-identity": "forged",
          },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () => resolve({ status: res.statusCode!, body }));
        },
      );
      req.on("error", reject);
      req.end();
    });
  try {
    assert.equal((await get("shared")).status, 403);
    assert.equal((await get("org-app")).status, 403, "org ownership is not an app-only entitlement");
    for (const granteeScopeId of [scopeId("org", "acme"), scopeId("channel", "C1")]) {
      await acl.grant({
        ownerScopeId,
        ref: encodeRef(deployRef(shared.id)),
        granteeScopeId,
        permission: "read",
        grantedBy: "owner@example.test",
      });
    }
    assert.equal((await get("shared")).status, 403, "scope grants never admit app-only sessions");
    await app.shareDeployment(shared.id, scopeId("personal", guest), "write", { createdBy: "owner@example.test" });
    assert.equal((await get("shared")).status, 403, "a write grant cannot confer app-only management access");
    assert.equal(upstreamHits, 0);
    await app.shareDeployment(shared.id, scopeId("personal", guest), "read", { createdBy: "owner@example.test" });
    const granted = await get("shared", "/api/data", "POST");
    assert.equal(granted.status, 200, "read grants allow using the app, including its POST API");
    assert.equal(JSON.parse(granted.body).cookie, undefined, "gateway cookie never reaches app");
    assert.notEqual(JSON.parse(granted.body)["x-portal-identity"], "forged");
    assert.equal((await get("shared", "/__claw__/version")).status, 200, "request goes to app, never management shell");
    assert.equal((await get("org-app")).status, 403, "grant is for one deployment only");
    await identity.deactivate(guest, "manual");
    assert.equal((await get("shared")).status, 403, "manual deactivation overrides the current direct grant");
    await identity.reactivate(guest);
    await app.shareDeployment(shared.id, scopeId("personal", guest), null, { createdBy: "owner@example.test" });
    assert.equal((await get("shared")).status, 403, "same session is refused immediately after revoke");
    await app.shareDeployment(shared.id, scopeId("personal", guest), "read", { createdBy: "owner@example.test" });
    await app.renameDeployment(shared.id, "renamed");
    await app.deploy({
      ownerScopeId,
      createdBy: "owner@example.test",
      entrypoint: "node app.js",
      files: [],
      name: "shared",
    });
    assert.equal((await get("shared")).status, 403, "reused name does not inherit old immutable-ID grant");
    assert.equal((await get("renamed")).status, 200, "same immutable app retains its grant after rename");
    await app.archiveDeployment(shared.id);
    assert.equal((await get("renamed")).status, 404, "archived app cannot be reached even with its grant");
    await app.setDeploymentPublic("shared", true, { createdBy: "owner@example.test" });
    const publicVisit = await get("shared");
    assert.equal(publicVisit.status, 200);
    assert.equal(JSON.parse(publicVisit.body)["x-portal-identity"], undefined, "public link access remains anonymous");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
