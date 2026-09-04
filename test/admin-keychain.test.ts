import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { createKeychain } from "../src/credentials/keychain.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { scopeId, type TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

function start() {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "admin-keychain-")) }));
  const keychain = createKeychain({
    creds: createMemoryMap(),
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key: deriveConnectorKey("admin-keychain-test-key"),
  });
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    sessions: built.sessions,
    auditLog: built.auditLog,
    keychain,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, keychain, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("/v1/admin/keychain returns metadata, grants, and asks without secrets; non-admin denied; audited", async () => {
  const s = start();
  try {
    const dm: TurnRequest = {
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "dm:U1:t1" },
      text: "hello",
    };
    assert.equal((await s.built.app.turn(dm)).status, "ok");

    const cred = await s.keychain.save({
      ownerId: "U1",
      service: "github",
      secret: "ghp_secret",
      envKey: "GITHUB_TOKEN",
      accountLabel: "alice",
    });
    const grant = await s.keychain.createGrant({
      credentialId: cred.id,
      ownerId: "U1",
      audienceScopeId: scopeId("channel", "C1"),
      mode: "standing",
      purpose: "use github for deploys",
    });
    const { ask } = await s.keychain.createAsk({
      credentialId: cred.id,
      requesterId: "U2",
      requesterScopeId: scopeId("channel", "C2"),
      purpose: "need github for CI",
    });

    const r = await fetch(`${s.base}/v1/admin/keychain`, { headers: { "x-admin-actor": "admin-alice@default-org" } });
    assert.equal(r.status, 200);
    const d: any = await r.json();
    assert.equal(d.enabled, true);
    assert.ok(
      d.people.some(
        (p: { principalId: string; credentialCount: number }) => p.principalId === "U1" && p.credentialCount === 1,
      ),
    );
    assert.ok(
      d.people.some((p: { principalId: string }) => p.principalId === "U2"),
      "ask requester appears even without sessions",
    );
    assert.deepEqual(
      d.credentials.map((c: { id: string }) => c.id),
      [cred.id],
    );
    assert.equal(d.grants[0].id, grant.id);
    assert.equal(d.asks[0].id, ask.id);
    assert.ok(!JSON.stringify(d).includes("ghp_secret"), "admin projection must not include secret material");

    const denied = await fetch(`${s.base}/v1/admin/keychain`, { headers: { "x-admin-actor": "user-uma@default-org" } });
    assert.equal(denied.status, 403);
    assert.ok((await s.built.auditLog.events()).some((e) => e.action === "keychain.read"));
  } finally {
    await s.close();
  }
});
