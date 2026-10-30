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

const URL = process.env.DATABASE_URL;

test("admin judgment and ack-pick lookups return 404 for a non-integer id", { skip: !URL }, async () => {
  const config = testConfig({
    dataDir: mkdtempSync(join(tmpdir(), "admin-feed-id-")),
    databaseUrl: URL,
    adminGrants: "admin-alice:org_admin",
  });
  const built = buildApp(config);
  const server = createInsecureTestServer(built.app, serverDeps(config, built));
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    for (const path of ["/v1/admin/ambient-judgments", "/v1/admin/ack-emoji-picks"]) {
      const res = await fetch(`${base}${path}?scope=org:default-org&id=1.5`, {
        headers: { "x-admin-actor": "admin-alice@default-org" },
      });
      assert.equal(res.status, 404, `${path} -> ${res.status} ${await res.text()}`);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
