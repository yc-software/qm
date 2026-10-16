import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp, serverDeps } from "../src/wiring.ts";
import { CAPABILITY_TTL_MS, CONTROL_PLANE_AUD, mintCapabilityToken } from "../src/auth/capability-token.ts";
import { scopeId } from "../src/types.ts";
import { TEST_CAPABILITY_SECRET, testConfig } from "./support/test-config.ts";

const URL = process.env.DATABASE_URL;

test("a JSON null body is a 400, not a TypeError 500", { skip: !URL }, async () => {
  const config = testConfig({
    dataDir: mkdtempSync(join(tmpdir(), "null-body-")),
    databaseUrl: URL,
    adminGrants: "admin-alice:org_admin",
  });
  const built = buildApp(config);
  const server = createInsecureTestServer(built.app, serverDeps(config, built));
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const cap = await mintCapabilityToken(
    { actorId: "U1", scopeId: scopeId("personal", "U1"), aud: CONTROL_PLANE_AUD, exp: Date.now() + CAPABILITY_TTL_MS },
    TEST_CAPABILITY_SECRET,
  );
  try {
    for (const path of ["/v1/soul", "/v1/crons", "/v1/webhooks", "/v1/keychain/drops", "/v1/memory/restore"]) {
      const res = await fetch(base + path, {
        method: "POST",
        headers: { "x-agent-capability": cap, "content-type": "application/json" },
        body: "null",
      });
      assert.equal(res.status, 400, `${path} -> ${res.status} ${await res.text()}`);
    }
    const cleared = await fetch(`${base}/v1/admin/scopes/org:default-org/cron-runtime`, {
      method: "PUT",
      headers: { "x-admin-actor": "admin-alice@default-org", "content-type": "application/json" },
      body: "null",
    });
    assert.equal(cleared.status, 200, `null still clears an admin resource: ${await cleared.text()}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
