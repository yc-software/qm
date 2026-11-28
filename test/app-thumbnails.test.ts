import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { createApp } from "../src/api/app.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createPostgresAppThumbnailStore } from "../src/deploy/app-thumbnails.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { scopeId } from "../src/types.ts";
import type { FeatureFlagStore } from "../src/feature-flags.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { createPostgresDirectoryStore } from "../src/directory/postgres-directory-store.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { testDatabaseUrl, testDeployBackings, testMap } from "./support/test-database.ts";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";
import { testCore } from "./support/build-app.ts";

const SESSION_SECRET = "portal-session-secret";

function session(sub: string): string {
  const key = createHmac("sha256", SESSION_SECRET).update("portal.session.v1").digest();
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({ k: "session", sub, org: "acme", iat: now, exp: now + 3600 })).toString(
    "base64url",
  );
  return `portal_session=${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

test("the owner's shell captures a thumbnail per version and viewers with access can load it", async () => {
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()));
  const backings = testDeployBackings();
  const deploy = createDeployService({
    ...singleProcessDeps(),
    externalSharingAllowed: async () => true,
    deployStore: createDeployStore(backings),
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: 9 }),
      destroy: async () => {},
    },
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl,
    deployDir: mkdtempSync(join(tmpdir(), "thumbnails-")),
  });
  const app = createApp({
    deploy,
    acl,
    directory: createPostgresDirectoryStore(testDatabaseUrl()),
    sessions: createPostgresSessionStore(backings.databaseUrl),
    identity: createIdentityService(testMap(), { externalMembers: testMap() }),
  } as unknown as Parameters<typeof createApp>[0]);
  const deployed = (await app.deploy({
    ownerScopeId: scopeId("personal", "alice@example.com"),
    createdBy: "alice@example.com",
    entrypoint: "x",
    files: [],
    name: "mysite",
  })) as { id: string; currentVersion: number };
  const server = createInsecureTestServer(app, {
    ...testCore(),
    featureFlags: { enabled: async () => false } as unknown as FeatureFlagStore,
    deployAppsDomain: "apps.example.com",
    deployGateSecret: "gate-secret",
    deployAppsSessionSecret: SESSION_SECRET,
    deployAppsLoginUrl: "https://portal.example.com",
    appThumbnails: createPostgresAppThumbnailStore(backings.databaseUrl),
  });
  server.listen(0);
  const port = (server.address() as AddressInfo).port;
  const onApp = (path: string, opts: { method?: string; headers?: Record<string, string>; body?: Buffer } = {}) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          port,
          path,
          method: opts.method ?? "GET",
          headers: { Host: "mysite.apps.example.com", Cookie: session("alice@example.com"), ...opts.headers },
        },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      req.end(opts.body);
    });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  try {
    const shell = await onApp("/", { headers: { Accept: "text/html", "Sec-Fetch-Dest": "document" } });
    assert.match(shell.body, /const thumbnailVersion = 0;/);
    const capture = await onApp("/__claw__/thumbnail.js");
    assert.match(capture.body, /htmlToImage/);

    const post = (version: number) =>
      onApp(`/__claw__/thumbnail?version=${version}`, {
        method: "POST",
        headers: { "content-type": "image/jpeg" },
        body: jpeg,
      });
    assert.equal((await post(deployed.currentVersion + 1)).status, 409);
    assert.equal((await post(deployed.currentVersion)).status, 204);

    const base = `http://localhost:${port}`;
    const listed = (await (await fetch(`${base}/v1/apps?principalId=alice@example.com`)).json()) as {
      apps: Array<{ id: string; thumbnailVersion?: number }>;
    };
    assert.equal(listed.apps.find((d) => d.id === deployed.id)?.thumbnailVersion, deployed.currentVersion);
    const image = await fetch(`${base}/v1/apps/${deployed.id}/thumbnail?principalId=alice@example.com`);
    assert.equal(image.headers.get("content-type"), "image/jpeg");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), jpeg);
    const outsider = await fetch(`${base}/v1/apps/${deployed.id}/thumbnail?principalId=mallory@example.com`);
    assert.equal(outsider.status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
