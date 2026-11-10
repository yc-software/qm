import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac, randomUUID } from "node:crypto";
import { request as httpRequest, createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/api/app.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { scopeId } from "../src/types.ts";
import type { FeatureFlagStore } from "../src/feature-flags.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { createPostgresDirectoryStore } from "../src/directory/postgres-directory-store.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { testDatabaseUrl, testDeployBackings, testMap } from "./support/test-database.ts";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { loadTenant, onTenantLoad } from "../src/tenants/cache.ts";
import { loadTenantSettings } from "../src/tenants/settings.ts";
import { ownerUrl, TEST_TENANT } from "./support/test-tenant.ts";

const SESSION_SECRET = "portal-session-secret";
const LOGIN_URL = "https://portal.example.com";
const auditLog = { record() {}, events: async () => [], tail: async () => [] };

function portalSession(claims: { t?: string }): string {
  const key = createHmac("sha256", SESSION_SECRET).update("portal.session.v1").digest();
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(
    JSON.stringify({ k: "session", sub: "alice@example.com", org: "acme", iat: now, exp: now + 3600, ...claims }),
  ).toString("base64url");
  return `portal_session=${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

function get(port: number, host: string, path: string, cookie?: string) {
  return new Promise<{ status: number; location: string; body: string }>((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, headers: { host, accept: "text/html", ...(cookie ? { cookie } : {}) } },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += String(chunk)));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, location: String(res.headers.location ?? ""), body }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("a <handle>-<app> host serves the handle's own app, refuses other companies' sessions, and signs in through a handoff", async () => {
  const upstream = createHttpServer((_req, res) => res.end("UPSTREAM OK"));
  upstream.listen(0);
  const upstreamPort = (upstream.address() as AddressInfo).port;
  const handle = `gw${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const backings = testDeployBackings();
  const owner = createPgPool(ownerUrl(backings.databaseUrl).toString());
  const appPool = createPgPool(backings.databaseUrl);
  const stopLoad = onTenantLoad(() => loadTenantSettings(appPool));
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()));
  const deploy = createDeployService({
    ...singleProcessDeps(),
    externalSharingAllowed: async () => true,
    deployStore: createDeployStore(backings),
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: upstreamPort }),
      destroy: async () => {},
    },
    auditLog,
    acl,
    deployDir: mkdtempSync(join(tmpdir(), "handles-")),
  });
  const app = createApp({
    deploy,
    acl,
    directory: createPostgresDirectoryStore(testDatabaseUrl()),
    sessions: createPostgresSessionStore(backings.databaseUrl),
    identity: createIdentityService(testMap(), { externalMembers: testMap() }),
  } as unknown as Parameters<typeof createApp>[0]);
  const server = createInsecureTestServer(app, {
    featureFlags: { enabled: async () => true } as unknown as FeatureFlagStore,
    deployAppsDomain: "apps.example.com",
    deployGateSecret: "gate-secret",
    deployAppsSessionSecret: SESSION_SECRET,
    deployAppsLoginUrl: LOGIN_URL,
  });
  try {
    await owner.q(`UPDATE tenants SET settings = settings || jsonb_build_object('handle', $2::text) WHERE id = $1`, [
      TEST_TENANT,
      handle,
    ]);
    await app.deploy({
      ownerScopeId: scopeId("personal", "alice@example.com"),
      createdBy: "alice@example.com",
      entrypoint: "x",
      files: [],
      name: "sales-board",
    });
    await loadTenant();
    for (const name of ["sales-board-q2", undefined])
      await assert.rejects(
        app.deploy({
          ownerScopeId: scopeId("personal", "alice@example.com"),
          createdBy: "alice@example.com",
          entrypoint: "x",
          files: [],
          ...(name ? { name } : {}),
        }),
        /over the 63-character DNS label limit/,
      );
    server.listen(0);
    const port = (server.address() as AddressInfo).port;
    const host = `${handle}-sales-board.apps.example.com`;

    const signedOut = await get(port, host, "/reports?x=1");
    assert.equal(signedOut.status, 302);
    assert.equal(
      signedOut.location,
      `${LOGIN_URL}/auth/host?to=${encodeURIComponent(`https://${host}/reports?x=1&dpl_signin=1`)}`,
    );
    const own = await get(port, host, "/reports", portalSession({ t: TEST_TENANT }));
    assert.equal(own.status, 200);
    assert.equal(own.body, "UPSTREAM OK");
    assert.equal((await get(port, host, "/reports", portalSession({ t: randomUUID() }))).status, 404);
    assert.equal((await get(port, "sales-board.apps.example.com", "/", portalSession({ t: TEST_TENANT }))).status, 200);
  } finally {
    server.close();
    upstream.close();
    stopLoad();
    await owner.q(`UPDATE tenants SET settings = settings - 'handle' WHERE id = $1`, [TEST_TENANT]);
    await owner.close();
    await appPool.close();
  }
});
