import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp, serverDeps } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

test("admin skill-pack routes return 404 for an unknown pack id", async () => {
  const config = testConfig({
    dataDir: mkdtempSync(join(tmpdir(), "skill-pack-404-")),
    ...(process.env.DATABASE_URL ? { databaseUrl: process.env.DATABASE_URL } : {}),
    adminGrants: "admin-alice:org_admin",
  });
  const built = buildApp(config);
  const server = createInsecureTestServer(built.app, serverDeps(config, built));
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const headers = { "x-admin-actor": "admin-alice@default-org", "content-type": "application/json" };
  try {
    for (const [method, path, body] of [
      ["GET", "/v1/admin/skill-packs/missing/catalog", undefined],
      ["POST", "/v1/admin/skill-packs/missing/sync", "{}"],
      ["POST", "/v1/admin/skill-packs/missing/import", '{"selected":"all","scopeIds":[]}'],
      ["PATCH", "/v1/admin/skill-packs/missing", "{}"],
    ] as const) {
      const res = await fetch(`${base}${path}?scope=org:default-org`, { method, headers, ...(body ? { body } : {}) });
      assert.equal(res.status, 404, `${method} ${path} -> ${res.status} ${await res.text()}`);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
