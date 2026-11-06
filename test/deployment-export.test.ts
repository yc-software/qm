import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createServer } from "../src/api/server.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import type { Deployment } from "../src/deploy/deploy-store.ts";
import { scopeId } from "../src/types.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";

const sourceSecret = "source-only-secret".repeat(3);
const exportToken = "spend-export-only-token".repeat(3);

const deployment = (over: Partial<Deployment> & Pick<Deployment, "id" | "createdBy">): Deployment => ({
  ownerScopeId: scopeId("personal", over.createdBy),
  currentVersion: 1,
  status: "running",
  endpoint: { host: "10.0.0.1", port: 8080, publicUrl: `https://${over.id}.provider.example/?access=secret` },
  versions: [
    { version: 1, createdAt: 1_000, entrypoint: "node server.js", snapshotDir: "/s/1" },
    { version: 2, createdAt: 2_000, entrypoint: "node server.js", snapshotDir: "/s/2" },
  ],
  ...over,
});

const fleet: Deployment[] = [
  deployment({ id: "d1", createdBy: "alice@example.com", name: "budget", displayName: "Budget", lastAccessAt: 3_000 }),
  deployment({ id: "d2", createdBy: "bob@example.com", status: "stopped", public: true }),
  deployment({ id: "d3", createdBy: "alice@example.com", name: "old", status: "archived" }),
];

function fixture(options: { token?: string | null; appsDomain?: string } = {}) {
  const built = buildApp(testConfig({ signingSecret: sourceSecret }));
  let reads = 0;
  built.app.listDeployments = async () => {
    reads++;
    return fleet;
  };
  const token = options.token === undefined ? exportToken : options.token;
  const server = createServer(built.app, {
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    signingSecret: sourceSecret,
    portalIdentitySecret: "portal-identity-secret".repeat(3),
    capabilitySecret: "capability-only-secret".repeat(3),
    requireSignedPortalIdentity: true,
    admin: built.admin,
    auditLog: built.auditLog,
    ...(options.appsDomain ? { deployAppsDomain: options.appsDomain } : {}),
    ...(token ? { spendExportToken: token } : {}),
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const get = (path: string, headers: Record<string, string> = { authorization: `Bearer ${exportToken}` }) =>
    fetch(base + path, { headers });
  return {
    built,
    get,
    reads: () => reads,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("deployment export: absent unless a token is configured", async () => {
  const s = fixture({ token: null });
  try {
    assert.equal((await s.get("/v1/deployments/export")).status, 404);
    assert.equal(s.reads(), 0);
  } finally {
    await s.close();
  }
});

test("deployment export: missing, wrong, admin-identity and source-signed requests are refused before any read", async () => {
  const s = fixture();
  try {
    const path = "/v1/deployments/export";
    const ts = Math.floor(Date.now() / 1000);
    const refused: Record<string, string>[] = [
      {},
      { authorization: `Bearer ${exportToken}x` },
      { authorization: exportToken },
      { authorization: `Bearer ${sourceSecret}` },
      { "x-admin-actor": "admin-alice@default-org" },
      { "x-timestamp": String(ts), "x-signature": signRequest(sourceSecret, ts, `GET\n${path}\n`) },
    ];
    for (const headers of refused) {
      const res = await s.get(path, headers);
      assert.equal(res.status, 401, JSON.stringify(headers));
    }
    assert.equal(s.reads(), 0);
    assert.deepEqual(
      (await s.built.auditLog.events()).filter((e) => e.action === "deployment.export"),
      [],
    );
  } finally {
    await s.close();
  }
});

test("deployment export: lists live apps with owner and app URL, skips archived, and audits the read", async () => {
  const s = fixture({ appsDomain: "apps.example.com" });
  try {
    const res = await s.get("/v1/deployments/export");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { scopeId: string; deployments: unknown[] };
    assert.deepEqual(body.deployments, [
      {
        id: "d1",
        name: "budget",
        displayName: "Budget",
        url: "https://budget.apps.example.com/",
        createdBy: "alice@example.com",
        ownerScopeId: "personal:alice@example.com",
        status: "running",
        public: false,
        createdAt: 1_000,
        updatedAt: 2_000,
        lastAccessAt: 3_000,
      },
      {
        id: "d2",
        url: "https://d2.apps.example.com/",
        createdBy: "bob@example.com",
        ownerScopeId: "personal:bob@example.com",
        status: "stopped",
        public: true,
        createdAt: 1_000,
        updatedAt: 2_000,
      },
    ]);
    const events = (await s.built.auditLog.events()).filter((e) => e.action === "deployment.export");
    assert.equal(events.length, 1);
    assert.equal(events[0]!.principalId, "deployment-export");
    assert.equal(events[0]!.detail, "deployments=2");
  } finally {
    await s.close();
  }
});

test("deployment export: without an apps domain the URL is the provider's public URL minus its access token", async () => {
  const s = fixture();
  try {
    const body = (await (await s.get("/v1/deployments/export")).json()) as { deployments: { url: string | null }[] };
    assert.deepEqual(
      body.deployments.map((d) => d.url),
      ["https://d1.provider.example/", "https://d2.provider.example/"],
    );
  } finally {
    await s.close();
  }
});
