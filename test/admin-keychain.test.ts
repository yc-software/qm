import "./support/auto-fake-sprites.ts";
import { testTenant } from "./support/test-tenant.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "./support/build-app.ts";
import { createKeychain } from "../src/credentials/keychain.ts";
import {
  createCredentialCatalog,
  registerConnectorCredentials,
  registerKeychainCredentials,
} from "../src/core/orchestrator/credential-catalog.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { scopeId, type TurnRequest } from "../src/types.ts";
import { hashId } from "../src/util/crypto.ts";
import { testConfig } from "./support/test-config.ts";
import { testAdvisoryLock, testMap } from "./support/test-database.ts";

function start() {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "admin-keychain-")) }));
  const keychain = createKeychain({
    lock: testAdvisoryLock(),
    creds: testMap(),
    grants: testMap(),
    asks: testMap(),
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
    assert.ok((await s.built.auditLog.events(testTenant)).some((e) => e.action === "keychain.read"));
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
  t.mock.method(s.built.admin.users, "list", fail);
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
  t.mock.method(s.built.admin.users, "list", fail);
  t.mock.method(s.built.app, "directoryMembers", fail);
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

test("/v1/admin/keychain: a person's sign-ins are one row under their primary sign-in, named from the directory", async () => {
  const s = start();
  try {
    await s.built.app.turn({
      surface: "test",
      actor: { externalId: "U-PAT" },
      conversation: { kind: "dm", threadRef: "dm:U-PAT:t1" },
      text: "hello",
    });
    await s.built.admin.users.link({
      principalId: "U-PAT",
      canonicalId: "pat@example.com",
      evidence: "qa",
      linkedBy: "",
      createdAt: Date.now(),
    });
    await s.built.app.upsertDirectory([{ principalId: "U-PAT", displayName: "Pat", type: "internal" }]);
    await s.keychain.save({ ownerId: "U-PAT", service: "github", secret: "s1", envKey: "GITHUB_TOKEN" });
    await s.keychain.save({ ownerId: "pat@example.com", service: "linear", secret: "s2", envKey: "LINEAR_KEY" });
    const user = (await s.built.admin.users.get("pat@example.com"))!;

    const d: any = await (
      await fetch(`${s.base}/v1/admin/keychain`, { headers: { "x-admin-actor": "admin-alice@default-org" } })
    ).json();
    const pat = d.people.filter((p: any) => p.userId === user.id || /pat/i.test(p.principalId));
    assert.deepEqual(
      pat.map((p: any) => [p.userId, p.principalId, p.displayName, p.credentialCount]),
      [[user.id, "pat@example.com", "Pat", 2]],
    );
  } finally {
    await s.close();
  }
});

test("admin keychain lists OAuth connectors without secrets, grants them for execute.credentials, and revokes/deletes", async (t) => {
  const s = start();
  t.after(s.close);
  const [admin, member, bob] = ["admin-alice@default-org", "user-uma@default-org", "bob@example.com"];
  const [org, adminScope, exp] = [scopeId("org", "default-org"), scopeId("personal", admin), Date.now() + 3_600_000];
  const call = (method: string, path: string, actor = admin, body?: unknown) =>
    fetch(`${s.base}${path}`, {
      method,
      headers: { "x-admin-actor": actor, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const del = (path: string, actor = admin) => call("DELETE", path, actor).then((r) => r.status);
  await s.keychain.setConnectorToken(
    "gmail.googleapis.com",
    bob,
    { accessToken: "ya29.bob", refreshToken: "1//bob-ref", idToken: "bob-id", expiresAt: exp },
    "personal",
  );
  await s.keychain.setConnectorToken("mcp.example.com", bob, { accessToken: "mcp-bob", expiresAt: exp });
  await s.keychain.setConnectorToken("gmail.googleapis.com", admin, { accessToken: "ya29.admin", expiresAt: exp });
  await s.keychain.setServiceCredential(org, { slug: "serp", name: "SERP", secret: "serp-s", host: "api.serper.dev" });
  const saved = await s.keychain.save({ ownerId: bob, service: "linear", secret: "lin-s" });

  let gmail: any;
  for (const path of ["/v1/admin/keychain", `/v1/admin/keychain?principal=${encodeURIComponent(bob)}`]) {
    const body: any = await (await call("GET", path)).json();
    const raw = JSON.stringify(body);
    for (const bad of [
      "ya29.bob",
      "1//bob-ref",
      "bob-id",
      "mcp-bob",
      "serp-s",
      "refreshTokenEnc",
      "idTokenEnc",
      "secretEnc",
    ])
      assert.equal(raw.includes(bad), false, bad);
    gmail = body.credentials.find((c: any) => c.ownerId === bob && c.host === "gmail.googleapis.com");
    const mcp = body.credentials.find((c: any) => c.ownerId === bob && c.host === "mcp.example.com");
    assert.deepEqual(
      [gmail?.managed, gmail?.envKey, gmail?.refresh?.hasRefreshToken, mcp?.managed],
      ["connector", "VAULT_TOKEN_GMAIL_GOOGLEAPIS_COM", true, "connector"],
    );
    assert.equal(
      body.credentials.some((c: any) => c.kind === "broker"),
      false,
    );
  }

  const granted = await call("POST", "/v1/admin/keychain/grants", admin, {
    credentialId: gmail.id,
    scope: adminScope,
    purpose: "debug",
  });
  const { grant, credentialHandle } = (await granted.json()) as any;
  assert.deepEqual([granted.status, credentialHandle], [200, gmail.credentialHandle]);

  const scopeKeychainGrants = async () =>
    (await s.keychain.grantsForScope(adminScope, { includePersonGrants: true })).map((r) => ({
      ...r,
      grantScope: adminScope,
    }));
  const catalog = await createCredentialCatalog({
    deps: { keychain: s.keychain, connectorTokens: s.keychain },
    input: { origin: { kind: "user" } },
    actor: { id: admin, type: "internal" },
    conversation: { kind: "dm", audience: [] },
    scopeId: adminScope,
    environmentId: adminScope,
    sharingSources: [],
    scopeKeychainGrants,
  } as any);
  await registerKeychainCredentials(catalog, catalog.addCredentialToCatalog);
  await registerConnectorCredentials(catalog, catalog.addCredentialToCatalog);
  const resolved = await catalog.commandCredentials.find((c) => c.handle === credentialHandle)!.resolve!();
  assert.deepEqual(resolved.env, [{ key: "VAULT_TOKEN_GMAIL_GOOGLEAPIS_COM", value: "ya29.bob" }]);

  assert.equal(await del(`/v1/admin/keychain/grants/${grant.id}`, member), 403);
  assert.equal(await del(`/v1/admin/keychain/grants/${grant.id}`), 200);
  assert.equal((await s.keychain.getGrant(grant.id))?.status, "revoked");
  assert.equal(await del("/v1/admin/keychain/grants/missing"), 404);

  const g2 = await s.keychain.createGrant({
    credentialId: saved.id,
    ownerId: bob,
    audienceScopeId: scopeId("channel", "C1"),
    mode: "standing",
    purpose: "ops",
  });
  assert.equal(await del(`/v1/admin/keychain/credentials/${saved.id}`, member), 403);
  assert.equal(await del(`/v1/admin/keychain/credentials/${saved.id}`), 200);
  assert.deepEqual(
    [await s.keychain.getCredential(saved.id), (await s.keychain.getGrant(g2.id))?.status],
    [null, "revoked"],
  );
  assert.equal(await del(`/v1/admin/keychain/credentials/${gmail.id}`), 200);
  assert.equal((await s.keychain.connectorTokenStatus("gmail.googleapis.com", bob, "personal")).connected, false);
  assert.equal(await del(`/v1/admin/keychain/credentials/${hashId([org, "serp", "broker"])}`), 404);
  const actions = (await s.built.auditLog.events(testTenant)).map((e) => e.action);
  assert.ok(actions.includes("keychain.admin_revoke") && actions.includes("keychain.admin_delete"));
});
