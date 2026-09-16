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

test("one organization config is installed independently of personal OAuth tokens", () => {
  const dir = customLayer();
  const toolDir = join(dir, "tools", "ledger");
  mkdirSync(toolDir, { recursive: true });
  const content = JSON.stringify({ tenantId: "org-a" });
  writeFileSync(join(toolDir, "organization.json"), content);
  writeFileSync(
    join(toolDir, "tool.json"),
    JSON.stringify({
      id: "ledger",
      install: { files: [{ from: "organization.json", to: "/usr/local/lib/ledger/organization.json" }] },
    }),
  );
  const runtime = loadDeploymentLayer(dir);
  assert.deepEqual(runtime.oauthConnectors, [descriptor]);
  assert.deepEqual(runtime.installFiles, [{ to: "/usr/local/lib/ledger/organization.json", mode: "0644", content }]);
  assert.ok(deploymentLayerBody(dir).includes("organization.json"));
});

for (const [label, overrides] of Object.entries({
  "plain HTTP": { tokenUrl: "http://login.ledger.example/token" },
  "embedded password": { tokenUrl: "https://client:secret@login.ledger.example/token" },
  "IP literal": { tokenUrl: "https://127.0.0.1/token" },
  "query token": { tokenUrl: "https://login.ledger.example/token?secret=foo" },
  "inline secret": { clientSecret: "never-inline" },
  "executable adapter": { exchange: "code" },
  "removed tenant discovery": { tenants: { url: "https://api.ledger.example/connections" } },
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
  "stock host collision": { hosts: ["api.github.com"] },
  "stock subdomain collision": { hosts: ["sub.api.github.com"] },
  "stock parent collision": { hosts: ["github.com"] },
  "subscription host collision": { hosts: ["auth.openai.com"] },
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
