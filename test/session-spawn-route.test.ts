import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/api/server.ts";
import { mintSignedPayload } from "../src/auth/signed-token.ts";
import { signedRequestHeaders } from "../plugins/chassis/src/source-auth-sign.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

test("a surface can open an empty web conversation for the signed-in person, only where they may chat", async () => {
  const { app } = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "ap-spawn-")) }));
  const sourceSecret = "spawn-source-secret-for-http-tests";
  const identitySecret = "spawn-identity-secret-for-http-tests";
  const server = createServer(app, {
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    signingSecret: sourceSecret,
    capabilitySecret: "spawn-capability-secret-for-http-tests",
    portalIdentitySecret: identitySecret,
    production: true,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const spawn = async (body: Record<string, unknown>) => {
    const path = `/v1/sessions?nonce=${crypto.randomUUID()}`;
    const raw = JSON.stringify(body);
    return fetch(base + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...signedRequestHeaders(sourceSecret, "POST", path, raw),
        "x-portal-identity": await mintSignedPayload({ p: "U1", exp: Date.now() + 60_000 }, identitySecret),
      },
      body: raw,
    });
  };
  try {
    const created = await spawn({ principalId: "U1", scopeId: "personal:U1" });
    assert.equal(created.status, 201);
    const { session } = (await created.json()) as { session: { id: string; threadRef: string; scopeId: string } };
    assert.ok(session.threadRef.startsWith("web:U1:"));
    assert.equal(session.scopeId, "personal:U1");
    const viewed = await app.getSessionForViewer(session.id, { actorId: "U1" }, { tailTurns: 1 });
    assert.equal(viewed?.items.length, 0);

    assert.equal((await spawn({ principalId: "U1", scopeId: "personal:U2" })).status, 403);
    assert.equal((await spawn({ principalId: "U1" })).status, 400);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
