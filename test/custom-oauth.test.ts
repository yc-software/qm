import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDeploymentLayer, emptyDeploymentLayer } from "../src/deployment/load-layer.ts";
import { parseOAuthConnector, oauthProvidersFor } from "../src/connectors/custom-oauth.ts";
import { createDeploymentLayerStore, type StoredDeploymentLayer } from "../src/deployment/deployment-layer-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createSkillStore } from "../src/skills/skill-store.ts";
import { scopeId } from "../src/types.ts";
import { descriptor, bundle } from "./support/custom-oauth.ts";
import { authorizeUrl, createSecretClientResolver, PROVIDERS } from "../src/connectors/oauth.ts";
import { createEnvSecretSource } from "../src/credentials/secret-source.ts";
import { deploymentLayerBody } from "../cli/src/deployment-layer.ts";

function customLayer(): string {
  const dir = mkdtempSync(join(tmpdir(), "custom-oauth-"));
  mkdirSync(join(dir, "connectors"));
  writeFileSync(join(dir, "connectors", "ledger.json"), JSON.stringify(descriptor));
  return dir;
}

test("filesystem and CLI preserve connector descriptors without installing them in the sandbox", () => {
  const dir = customLayer();
  const runtime = loadDeploymentLayer(dir);
  assert.deepEqual(runtime.oauthConnectors, [descriptor]);
  assert.deepEqual(runtime.installFiles, []);
  assert.deepEqual(JSON.parse(deploymentLayerBody(dir)), bundle);
  assert.equal(PROVIDERS.ledger, undefined);
});

for (const [label, overrides] of Object.entries({
  "plain HTTP": { tokenUrl: "http://login.ledger.example/token" },
  "embedded password": { tokenUrl: "https://client:secret@login.ledger.example/token" },
  "IP literal": { tokenUrl: "https://127.0.0.1/token" },
  "query token": { tokenUrl: "https://login.ledger.example/token?secret=foo" },
  "inline secret": { clientSecret: "never-inline" },
  "executable adapter": { exchange: "code" },
  "state override": { authParams: { state: "fixed" } },
  "redirect override": { authParams: { redirect_uri: "https://other.example/callback" } },
  "invalid host": { hosts: ["https://api.ledger.example"] },
  "empty scopes": { scopes: [""] },
  "invalid env reference": { clientSecretEnv: "secret" },
})) {
  test(`descriptor rejects ${label}`, () =>
    assert.throws(() => parseOAuthConnector(JSON.stringify({ ...descriptor, ...overrides }))));
}
for (const [label, overrides] of Object.entries({
  "stock provider replacement": { id: "google" },
  "prototype name": { id: "constructor" },
  "stock host collision": { hosts: ["api.github.com"], tenants: undefined },
  "stock subdomain collision": { hosts: ["sub.api.github.com"], tenants: undefined },
  "stock parent collision": { hosts: ["github.com"], tenants: undefined },
  "subscription host collision": { hosts: ["auth.openai.com"], tenants: undefined },
  "foreign tenant URL": { tenants: { ...descriptor.tenants!, url: "https://other.example/connections" } },
  "multiple tenant hosts": { hosts: ["api.ledger.example", "files.ledger.example"] },
})) {
  test(`registry rejects ${label}`, () =>
    assert.throws(() => oauthProvidersFor([parseOAuthConnector(JSON.stringify({ ...descriptor, ...overrides }))])));
}

test("durable registration hydrates on another instance and rejects invalid updates atomically", async () => {
  const backing = createMemoryMap<StoredDeploymentLayer>();
  const skills = createSkillStore({ signingSecret: "test" });
  const runtime = emptyDeploymentLayer();
  const store = createDeploymentLayerStore({ backing, runtime, skills, scopeId: scopeId("org", "default-org") });
  const first = await store.put(bundle, "test");
  const replica = emptyDeploymentLayer();
  const other = createDeploymentLayerStore({
    backing,
    runtime: replica,
    skills,
    scopeId: scopeId("org", "default-org"),
  });
  await other.hydrate();
  assert.deepEqual(replica.oauthConnectors, [descriptor]);
  assert.deepEqual(runtime.oauthConnectors, [descriptor]);
  assert.equal((await store.put(bundle, "test")).version, first.version);
  await assert.rejects(
    store.put(
      { ...bundle, connectors: [{ path: "connectors/wrong.json", content: JSON.stringify(descriptor) }] },
      "test",
    ),
  );
  await assert.rejects(
    store.put(
      {
        ...bundle,
        connectors: [{ path: "connectors/ledger.json", content: JSON.stringify({ ...descriptor, id: "google" }) }],
      },
      "test",
    ),
  );
  assert.equal((await store.get())!.version, first.version);
  assert.deepEqual(runtime.oauthConnectors, [descriptor]);
  await store.put({ contract: 1, tools: [], skills: [] }, "test");
  await other.hydrate();
  assert.equal(replica.oauthConnectors, undefined);
  assert.equal(oauthProvidersFor(replica.oauthConnectors).ledger, undefined);
});

test("the resolver follows its instance registry without mutating the stock catalog", async () => {
  let custom = [descriptor];
  const providers = () => oauthProvidersFor(custom);
  const resolver = createSecretClientResolver(
    createEnvSecretSource({ LEDGER_CLIENT_ID: "client", LEDGER_CLIENT_SECRET: "private" }),
    providers,
  );
  const client = await resolver("ledger", {});
  const url = new URL(
    authorizeUrl("ledger", {
      providers: providers(),
      client,
      state: "nonce",
      redirectUri: "https://qm.example/callback",
    }),
  );
  assert.equal(url.searchParams.get("client_id"), "client");
  assert.equal(url.searchParams.get("client_secret"), null);
  custom = [];
  await assert.rejects(resolver("ledger", {}), /unknown OAuth provider/);
  assert.equal(PROVIDERS.ledger, undefined);
});

test("tenant selection cannot apply discovery from an earlier connection", async () => {
  const { customKeychain } = await import("./support/custom-oauth.ts");
  const keychain = customKeychain(async () => {
    throw new Error("unexpected refresh");
  });
  const host = descriptor.hosts[0]!;
  await keychain.setConnectorToken(host, "alice@example.com", { accessToken: "old", tenantRequired: true });
  await keychain.setConnectorToken(host, "alice@example.com", { accessToken: "new", tenantRequired: true });
  await assert.rejects(
    keychain.selectConnectorTenant!(host, "alice@example.com", "org-old", "old"),
    /connection changed/,
  );
  assert.equal((await keychain.connectorTokenStatus(host, "alice@example.com")).needsTenantSelection, true);
  await keychain.selectConnectorTenant!(host, "alice@example.com", "org-new", "new");
  assert.equal((await keychain.connectorTokenStatus(host, "alice@example.com")).accountId, "org-new");
});

test("unselected tenants give owner and grantee an actionable selection error", async () => {
  const { customKeychain } = await import("./support/custom-oauth.ts");
  const keychain = customKeychain(async () => {
    throw new Error("unexpected refresh");
  });
  await keychain.setConnectorToken(descriptor.hosts[0]!, "alice@example.com", {
    accessToken: "access",
    tenantRequired: true,
  });
  const credentialId = (await keychain.listConnectorsByOwners(["alice@example.com"])).get("alice@example.com")![0]!
    .credentialId;
  await assert.rejects(
    keychain.materializeOwnById("alice@example.com", credentialId, scopeId("personal", "alice@example.com")),
    /choose an organization/,
  );
  const audienceScopeId = scopeId("channel", "team");
  const grant = await keychain.createGrant({
    credentialId,
    ownerId: "alice@example.com",
    audienceScopeId,
    mode: "standing",
    purpose: "accounting",
  });
  await assert.rejects(keychain.materialize(grant.id, audienceScopeId, "bob@example.com"), /choose an organization/);
  assert.deepEqual(await keychain.materializeStanding(audienceScopeId), []);
});

for (const selected of [false, true]) {
  test(`refresh racing reconnect preserves the new tenant gate: selected=${selected}`, async () => {
    const { customKeychain } = await import("./support/custom-oauth.ts");
    const host = descriptor.hosts[0]!;
    const keychain = customKeychain(async () => {
      await keychain.setConnectorToken(host, "alice@example.com", {
        accessToken: "new-account-token",
        tenantRequired: true,
        ...(selected ? { accountId: "new-org" } : {}),
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: "refreshed-old-account", refresh_token: "rotated", expires_in: 3600 }),
      };
    });
    const seed = () =>
      keychain.setConnectorToken(host, "alice@example.com", {
        accessToken: "old-account-token",
        refreshToken: "refresh",
        expiresAt: Date.now() - 1000,
        tenantRequired: true,
        accountId: "old-org",
      });
    await seed();
    const credentialId = (await keychain.listConnectorsByOwners(["alice@example.com"])).get("alice@example.com")![0]!
      .credentialId;
    const materialized = keychain.materializeOwnById(
      "alice@example.com",
      credentialId,
      scopeId("personal", "alice@example.com"),
    );
    if (!selected) await assert.rejects(materialized);
    else {
      const result = await materialized;
      assert.equal(result.kind, "env");
      if (result.kind !== "env") throw new Error("expected env");
      assert.deepEqual(result.env, [
        { key: "VAULT_TOKEN_API_LEDGER_EXAMPLE", value: "new-account-token" },
        { key: "VAULT_TENANT_API_LEDGER_EXAMPLE", value: "new-org" },
      ]);
    }
    await seed();
    assert.equal(await keychain.connectorAccessToken(host, "alice@example.com"), selected ? "new-account-token" : null);
    await seed();
    const derived = await keychain.connectorDerivedAuth(host, "alice@example.com");
    if (!selected) assert.equal(derived, null);
    else assert.equal(derived?.accountId, "new-org");
    const audienceScopeId = scopeId("channel", "team");
    await keychain.createGrant({
      credentialId,
      ownerId: "alice@example.com",
      audienceScopeId,
      mode: "standing",
      purpose: "accounting",
    });
    await seed();
    const standing = await keychain.materializeStanding(audienceScopeId);
    if (!selected) assert.deepEqual(standing, []);
    else
      assert.deepEqual(standing[0]?.env, [
        { key: "VAULT_TOKEN_API_LEDGER_EXAMPLE", value: "new-account-token" },
        { key: "VAULT_TENANT_API_LEDGER_EXAMPLE", value: "new-org" },
      ]);
  });
}
