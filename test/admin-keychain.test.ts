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

test("credentials-page summary avoids unrelated history and exposes counts only", async (t) => {
  const s = start();
  t.after(s.close);
  const credential = await s.keychain.save({
    ownerId: "U1",
    service: "github",
    secret: "summary-test-secret",
    envKey: "GITHUB_TOKEN",
    accountLabel: "test",
  });
  await s.keychain.createGrant({
    credentialId: credential.id,
    ownerId: "U1",
    audienceScopeId: scopeId("channel", "C1"),
    mode: "standing",
    purpose: "test",
  });
  const fail = () => {
    throw new Error("Summary must not scan unrelated data");
  };
  t.mock.method(s.keychain, "listAsks", fail);
  t.mock.method(s.built.sessions, "distinctParticipants", fail);
  t.mock.method(s.built.app, "directoryMembers", fail);
  const response = await fetch(s.base + "/v1/admin/keychain?summary=1", {
    headers: { "x-admin-actor": "admin-alice@default-org" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { users: 1, standing: 1 });
  const denied = await fetch(s.base + "/v1/admin/keychain?summary=1", {
    headers: { "x-admin-actor": "nobody@default-org" },
  });
  assert.equal(denied.status, 403);
});

test("user keychain reads only the selected owner's metadata and grants", async (t) => {
  const s = start();
  t.after(s.close);
  const credential = await s.keychain.save({
    ownerId: "alice@example.com",
    service: "github",
    secret: "private-user-secret",
    envKey: "GITHUB_TOKEN",
  });
  await s.keychain.save({
    ownerId: "bob@example.com",
    service: "github",
    secret: "other-user-secret",
    envKey: "GITHUB_TOKEN",
  });
  const grant = await s.keychain.createGrant({
    credentialId: credential.id,
    ownerId: "alice@example.com",
    audienceScopeId: scopeId("channel", "C1"),
    mode: "standing",
    purpose: "test",
  });
  const fail = () => {
    throw new Error("User keychain must not load unrelated org data");
  };
  t.mock.method(s.keychain, "listAllMetadata", fail);
  t.mock.method(s.keychain, "listAsks", fail);
  t.mock.method(s.built.sessions, "distinctParticipants", fail);
  t.mock.method(s.built.app, "directoryMembers", fail);
  if (s.built.auditLog.tallyByResource)
    t.mock.method(s.built.auditLog as Required<typeof s.built.auditLog>, "tallyByResource", fail);
  const response = await fetch(s.base + "/v1/admin/keychain?principal=Alice%40example.com", {
    headers: { "x-admin-actor": "admin-alice@default-org" },
  });
  assert.equal(response.status, 200);
  const data = (await response.json()) as any;
  assert.deepEqual(
    data.credentials.map((c: { id: string }) => c.id),
    [credential.id],
  );
  assert.deepEqual(
    data.grants.map((g: { id: string }) => g.id),
    [grant.id],
  );
  assert.equal(JSON.stringify(data).includes("private-user-secret"), false);
  assert.equal(JSON.stringify(data).includes("bob@example.com"), false);
  const denied = await fetch(s.base + "/v1/admin/keychain?principal=alice%40example.com", {
    headers: { "x-admin-actor": "nobody@default-org" },
  });
  assert.equal(denied.status, 403);
});
