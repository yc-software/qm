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

test("an encoded NUL in a path or query parameter is a 400, not a Postgres 500", { skip: !URL }, async () => {
  const config = testConfig({ dataDir: mkdtempSync(join(tmpdir(), "url-nul-")), databaseUrl: URL });
  const built = buildApp(config);
  const server = createInsecureTestServer(built.app, serverDeps(config, built));
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const cap = await mintCapabilityToken(
    { actorId: "U1", scopeId: scopeId("personal", "U1"), aud: CONTROL_PLANE_AUD, exp: Date.now() + CAPABILITY_TTL_MS },
    TEST_CAPABILITY_SECRET,
  );
  try {
    for (const [method, path] of [
      ["GET", "/v1/loops/%00"],
      ["GET", "/v1/skills/a%00b"],
      ["POST", "/v1/webhooks/incoming/%00"],
      ["GET", "/v1/files?cursor=%00"],
    ] as const) {
      const res = await fetch(base + path, {
        method,
        headers: { "x-agent-capability": cap, "content-type": "application/json" },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      assert.equal(res.status, 400, `${method} ${path} -> ${res.status} ${await res.text()}`);
    }
    const proxied = await fetch(`${base}/d/some-app/a%00b?q=%00`, { headers: { "x-agent-capability": cap } });
    assert.notEqual(proxied.status, 400, "path-proxied apps still receive their own %00 paths");
    assert.equal((await fetch(`${base}/v1/loops/ok`, { headers: { "x-agent-capability": cap } })).status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
