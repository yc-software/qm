import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS, CONTROL_PLANE_AUD } from "../src/auth/capability-token.ts";

const SECRET = "test-capability-secret";

function start(): { base: string; built: BuiltApp; close: () => Promise<void> } {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "runtime-config-live-author-")),
      orgId: "default-org",
      capabilitySecret: SECRET,
      seedSkills: false,
    }),
  );
  const server = createInsecureTestServer(built.app, { capabilitySecret: SECRET, config: built.config });
  server.listen(0);
  return {
    base: `http://localhost:${(server.address() as AddressInfo).port}`,
    built,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const token = (claims: Record<string, unknown>): Promise<string> =>
  mintCapabilityToken(
    {
      actorId: "alice@default-org",
      scopeId: "group:C123",
      aud: CONTROL_PLANE_AUD,
      exp: Date.now() + CAPABILITY_TTL_MS,
      ...claims,
    } as never,
    SECRET,
  );

async function put(base: string, cap: string): Promise<Response> {
  return fetch(`${base}/v1/runtime-config`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-agent-capability": cap },
    body: JSON.stringify({ harnessId: "pi", modelId: "claude-sonnet-5" }),
  });
}

test("runtime-config accepts a liveAuthor capability (a human replying in a thread)", async () => {
  const srv = start();
  try {
    await srv.built.directory.replaceGroups([{ groupId: "C123", principalId: "alice@default-org" }]);
    srv.built.config.setApprovedHarnesses(["pi"]);
    await srv.built.config.flushScope("org:default-org");
    const res = await put(srv.base, await token({ liveAuthor: true }));
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      effective: { harnessId: string; modelId: string; effortLevel: string; fastMode: boolean };
    };
    assert.deepEqual(body.effective, {
      harnessId: "pi",
      modelId: "claude-sonnet-5",
      effortLevel: "auto",
      fastMode: false,
    });
  } finally {
    await srv.close();
  }
});

test("runtime-config still refuses an automated trigger with neither liveActor nor liveAuthor", async () => {
  const srv = start();
  try {
    await srv.built.directory.replaceGroups([{ groupId: "C123", principalId: "alice@default-org" }]);
    srv.built.config.setApprovedHarnesses(["pi"]);
    await srv.built.config.flushScope("org:default-org");
    const res = await put(srv.base, await token({ triggered: true }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: "live_actor_required" });
  } finally {
    await srv.close();
  }
});
