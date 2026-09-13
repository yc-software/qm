import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { DEPLOY_RELEASE_AUD, mintCapabilityToken } from "../src/auth/capability-token.ts";
import { CAPABILITY_HEADER } from "../src/api/contract.ts";
import { scopeId } from "../src/types.ts";

const SECRET = "deploy-release-secret".repeat(3);

test("deploy release endpoint serves only the release pinned by its capability", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "deploy-release-")) }));
  const stored = await built.deployReleaseTransfer.put(Buffer.from("release payload"));
  const token = await mintCapabilityToken(
    {
      actorId: "publisher",
      scopeId: scopeId("group", "project-that-may-change"),
      aud: DEPLOY_RELEASE_AUD,
      blob: { dir: "read", id: stored.blobId },
      exp: Date.now() + 60_000,
    },
    SECRET,
  );
  const server = createServer(built.app, {
    signingSecret: SECRET,
    deployReleaseTransfer: built.deployReleaseTransfer,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const ok = await fetch(`${base}/v1/deploy-releases/${stored.blobId}`, {
      headers: { [CAPABILITY_HEADER]: token },
    });
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "release payload");
    const wrong = "f".repeat(32);
    const denied = await fetch(`${base}/v1/deploy-releases/${wrong}`, {
      headers: { [CAPABILITY_HEADER]: token },
    });
    assert.equal(denied.status, 403);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
