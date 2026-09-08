import assert from "node:assert/strict";
import { test } from "node:test";
import { createModelOverlayStore } from "../src/model/model-overlay-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

const spec = {
  id: "verify-future",
  name: "Verify future",
  provider: "openai",
  template: "gpt-5.5",
  contextWindow: 200_000,
  maxTokens: 16_000,
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
};

test("no model can be enabled without provider verification", async () => {
  const store = createModelOverlayStore(createMemoryMap());
  await assert.rejects(store.upsert(spec, "admin"), /verification/i);
  assert.deepEqual(await store.statuses(), []);
});

import { afterEach } from "node:test";
import {
  ModelVerificationError,
  verificationFailure,
  createModelVerifier,
  type ModelVerifier,
} from "../src/model/model-verification.ts";
import { setModelOverlays, resolveModel, modelUnavailableReason } from "../src/model/pi-models.ts";
import type { StoredModelOverlay } from "../src/model/model-overlay-store.ts";

const verified: ModelVerifier = async () => ({ fingerprint: "test-context", probe: async () => {} });
afterEach(() => setModelOverlays([]));

test("legacy unverified rows remain unavailable and statuses never expose proof fingerprints", async () => {
  const backing = createMemoryMap<StoredModelOverlay>();
  const store = createModelOverlayStore(backing, undefined, verified);
  await backing.put(spec.id, { spec, disabled: false, updatedAt: 1, updatedBy: "admin" } as StoredModelOverlay);
  await store.refresh();
  assert.equal(resolveModel(spec.id), undefined);
  assert.match(modelUnavailableReason(spec.id)!, /not been verified/);
  await store.upsert(spec, "admin");
  await store.refresh();
  assert.ok(resolveModel(spec.id));
  const status = await store.statuses();
  assert.equal(status[0]?.verificationScope, "organization");
  assert.ok(status[0]?.verifiedAt);
  assert.doesNotMatch(JSON.stringify(status), /fingerprint|test-context/);
});

test("failed probes never publish new models or replace previously verified definitions", async () => {
  let fail = false;
  const store = createModelOverlayStore(createMemoryMap(), undefined, async () => ({
    fingerprint: "context",
    probe: async () => {
      if (fail) throw Error("403 secret-credential-value");
    },
  }));
  await store.upsert(spec, "admin");
  fail = true;
  await assert.rejects(store.upsert({ ...spec, name: "Unverified edit" }, "admin"), /cannot access/);
  await assert.rejects(store.upsert({ ...spec, id: "unverified-new" }, "admin"), /cannot access/);
  const statuses = await store.statuses();
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0]?.spec.name, spec.name);
  assert.doesNotMatch(JSON.stringify(statuses), /secret-credential-value/);
});

test("credential rotation invalidates availability and a successful recheck restores it", async () => {
  let fingerprint = "key-a";
  const store = createModelOverlayStore(createMemoryMap(), undefined, async () => ({
    fingerprint,
    probe: async () => {},
  }));
  await store.upsert(spec, "admin");
  await store.refresh();
  assert.ok(resolveModel(spec.id));
  fingerprint = "key-b";
  await store.refresh();
  assert.equal(resolveModel(spec.id), undefined);
  assert.match(modelUnavailableReason(spec.id)!, /credentials changed/);
  await store.upsert(spec, "admin");
  await store.refresh();
  assert.ok(resolveModel(spec.id));
});

test("a deletion while verification runs cannot be undone by its late success", async () => {
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const started = new Promise<void>((r) => {
    entered = r;
  });
  let hold = false;
  const store = createModelOverlayStore(createMemoryMap(), undefined, async () => ({
    fingerprint: "context",
    probe: async () => {
      if (hold) {
        entered();
        await new Promise<void>((r) => {
          release = r;
        });
      }
    },
  }));
  await store.upsert(spec, "admin");
  hold = true;
  const update = store.upsert({ ...spec, name: "Late edit" }, "admin");
  await started;
  await store.delete(spec.id, "admin");
  release();
  await assert.rejects(update, /changed during verification/);
  assert.equal((await store.statuses())[0]?.disabled, true);
});

test("a changed serving context during a probe is not certified", async () => {
  let fingerprint = "old";
  const store = createModelOverlayStore(createMemoryMap(), undefined, async () => ({
    fingerprint,
    probe: async () => {
      fingerprint = "new";
    },
  }));
  await assert.rejects(store.upsert(spec, "admin"), /credentials changed/);
  assert.deepEqual(await store.statuses(), []);
});

test("provider errors are actionable without exposing raw provider text", () => {
  for (const [raw, code] of [
    ["401 secret", "access_denied"],
    ["403 secret", "access_denied"],
    ["404 secret", "model_unavailable"],
    ["429 secret", "quota_or_rate_limit"],
    ["400 unsupported secret", "unsupported_configuration"],
    ["timeout secret", "timeout"],
    ["500 secret", "provider_failure"],
  ]) {
    const error = verificationFailure(new Error(raw));
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /secret/);
    assert.ok(error instanceof ModelVerificationError);
  }
});

import "./support/auto-fake-sprites.ts";
import { verificationUpstream } from "./support/model-verification-upstream.ts";
import { buildApp, serverDeps } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import type { AddressInfo } from "node:net";
import { probeModel } from "../src/harness/pi-harness.ts";
import { modelFromOverlay } from "../src/model/pi-models.ts";
import { parseModelOverlay } from "../src/model/model-overlay.ts";
import { setProviderBaseUrls } from "../src/model/provider-endpoints.ts";

test("live API verifies exact serving credentials, blocks denied models, rechecks edits, and invalidates rotated keys", async () => {
  const upstream = await verificationUpstream();
  const config = testConfig({
    openaiApiKey: "verification-test-key",
    harness: "pi",
    providerBaseUrls: { openai: upstream.url + "/v1", anthropic: upstream.url },
  });
  const built = buildApp(config, { modelCredentialFetch: async () => Response.json({ data: [] }) });
  const server = createInsecureTestServer(built.app, serverDeps(config, built));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };
  const path = base + "/v1/admin/model-registry/" + spec.id;
  const put = (body: object, actor = headers["x-admin-actor"]) =>
    fetch(path, { method: "PUT", headers: { ...headers, "x-admin-actor": actor }, body: JSON.stringify(body) });
  const runtime = async () =>
    (
      await fetch(
        base + "/v1/runtime-config?principalId=admin-alice@default-org&scopeId=personal:admin-alice@default-org",
        { headers },
      )
    ).json() as Promise<{
      effective: { modelId: string };
      modelCatalog: Record<string, unknown>;
      unavailableReason: string;
    }>;
  try {
    assert.equal((await put({ ...spec, verify: true }, "bob@default-org")).status, 403);
    assert.equal((await put(spec)).status, 400);
    assert.equal(upstream.requests.length, 0);
    upstream.behavior.status = 403;
    const denied = await put({ ...spec, verify: true });
    assert.equal(denied.status, 422);
    const deniedBody = (await denied.json()) as { error: string };
    assert.equal(deniedBody.error, "access_denied");
    assert.doesNotMatch(JSON.stringify(deniedBody), /private-provider-detail|verification-test-key/);
    assert.equal((await runtime()).modelCatalog[spec.id], undefined);
    for (const [status, code] of [
      [401, "access_denied"],
      [404, "model_unavailable"],
      [400, "unsupported_configuration"],
      [429, "quota_or_rate_limit"],
      [503, "provider_failure"],
    ] as const) {
      upstream.behavior.status = status;
      const rejected = await put({ ...spec, verify: true });
      assert.equal(rejected.status, 422);
      const result = (await rejected.json()) as { error: string };
      assert.equal(result.error, code);
      assert.doesNotMatch(JSON.stringify(result), /private-provider-detail/);
      assert.equal((await runtime()).modelCatalog[spec.id], undefined);
    }
    upstream.behavior.status = 200;
    upstream.behavior.empty = true;
    assert.equal((await put({ ...spec, verify: true })).status, 422);
    upstream.behavior.empty = false;
    const accepted = await put({ ...spec, verify: true });
    assert.equal(accepted.status, 200);
    const proof = (await accepted.json()) as { verifiedAt: number; verificationScope: string };
    assert.ok(proof.verifiedAt);
    assert.equal(proof.verificationScope, "organization");
    const request = upstream.requests.at(-1)!;
    assert.equal(request.path, "/v1/responses");
    assert.equal(request.body.model, spec.id);
    assert.equal(request.body.max_output_tokens, 128);
    assert.ok(Array.isArray(request.body.tools));
    assert.equal(request.authorization, "Bearer verification-test-key");
    assert.ok((await runtime()).modelCatalog[spec.id]);
    const beforeEdit = upstream.requests.length;
    assert.equal((await put({ ...spec, name: "Verified edit", verify: true })).status, 200);
    assert.equal(upstream.requests.length, beforeEdit + 1);
    await built.config.setRuntimeSelectionLatest("personal:admin-alice@default-org", {
      harnessId: "pi",
      modelId: spec.id,
    });
    await built.modelCredentials.set("openai", "rotated-test-key", "admin-alice");
    const stale = await runtime();
    assert.equal(stale.effective.modelId, spec.id);
    assert.equal(stale.modelCatalog[spec.id], undefined);
    assert.match(stale.unavailableReason, /credentials changed/);
    assert.equal((await put({ ...spec, verify: true })).status, 200);
    assert.equal(upstream.requests.at(-1)?.authorization, "Bearer rotated-test-key");
    await built.modelCredentials.delete("openai", "admin-alice");
    const calls = upstream.requests.length;
    const missing = await put({ ...spec, verify: true });
    assert.equal(missing.status, 422);
    assert.equal(((await missing.json()) as { error: string }).error, "missing_credential");
    assert.equal(upstream.requests.length, calls);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await upstream.close();
    setProviderBaseUrls({});
  }
});

test("Anthropic verification exercises ordinary and fast requests, and gateway uses its serving target and credential", async () => {
  const upstream = await verificationUpstream();
  const config = testConfig({ anthropicApiKey: "anthropic-test-key", providerBaseUrls: { anthropic: upstream.url } });
  const built = buildApp(config);
  try {
    upstream.behavior.rejectFast = true;
    await assert.rejects(
      built.modelRegistry.upsert(
        { ...spec, provider: "anthropic", template: "claude-opus-4-8", fastMode: true },
        "admin",
      ),
      /rejected this configuration/,
    );
    assert.equal((await built.modelRegistry.statuses()).length, 0);
    upstream.behavior.rejectFast = false;
    upstream.requests.length = 0;
    await built.modelRegistry.upsert(
      { ...spec, provider: "anthropic", template: "claude-opus-4-8", fastMode: true },
      "admin",
    );
    assert.equal(upstream.requests.length, 2);
    assert.equal(upstream.requests[0]?.body.model, spec.id);
    assert.equal(upstream.requests[0]?.body.max_tokens, 128);
    assert.equal(upstream.requests[0]?.key, "anthropic-test-key");
    assert.equal(upstream.requests[0]?.body.speed, undefined);
    assert.equal(upstream.requests[1]?.body.speed, "fast");
    assert.match(upstream.requests[1]!.beta!, /fast-mode/);
    const verifier = createModelVerifier({
      credentials: built.modelCredentials,
      keyMaterial: "test-hmac-key",
      modelGateway: {
        url: upstream.url + "/v1",
        apiKey: "gateway-test-key",
        apiKeyHeader: "x-gateway-key",
        models: { [spec.id]: "gateway-model-target" },
      },
    });
    const context = await verifier(parseModelOverlay(spec));
    await context.probe(AbortSignal.timeout(5000));
    assert.equal(upstream.requests.at(-1)?.body.model, "gateway-model-target");
    assert.equal(upstream.requests.at(-1)?.authorization, "Bearer gateway-test-key");
    assert.equal(upstream.requests.at(-1)?.gatewayKey, "gateway-test-key");
  } finally {
    await upstream.close();
    setProviderBaseUrls({});
  }
});

test("the streaming probe aborts a nonresponsive provider and never accepts an incomplete response", async () => {
  const upstream = await verificationUpstream();
  upstream.behavior.hang = true;
  setProviderBaseUrls({ openai: upstream.url + "/v1" });
  try {
    const model = modelFromOverlay(parseModelOverlay(spec))!;
    await assert.rejects(probeModel(model, { openai: "test-key" }, AbortSignal.timeout(200)));
  } finally {
    await upstream.close();
    setProviderBaseUrls({});
  }
});

test("a failed recheck of the saved definition removes its prior certification", async () => {
  let fail = false;
  const store = createModelOverlayStore(createMemoryMap(), undefined, async () => ({
    fingerprint: "context",
    probe: async () => {
      if (fail) throw Error("403");
    },
  }));
  await store.upsert(spec, "admin");
  await store.refresh();
  assert.ok(resolveModel(spec.id));
  fail = true;
  await assert.rejects(store.upsert(spec, "admin"), /cannot access/);
  await store.refresh();
  assert.equal(resolveModel(spec.id), undefined);
  assert.equal((await store.statuses())[0]?.spec.name, spec.name);
});

test("endpoint, template metadata, credential revision, and model edits change verification fingerprints", async () => {
  const built = buildApp(testConfig({ openaiApiKey: "test-key" }));
  const verifier = createModelVerifier({ credentials: built.modelCredentials, keyMaterial: "stable-test-hmac" });
  try {
    const original = (await verifier(parseModelOverlay(spec))).fingerprint;
    assert.equal((await verifier(parseModelOverlay(spec))).fingerprint, original);
    assert.notEqual((await verifier(parseModelOverlay({ ...spec, template: "gpt-5.6-sol" }))).fingerprint, original);
    assert.notEqual((await verifier(parseModelOverlay({ ...spec, maxTokens: 8000 }))).fingerprint, original);
    setProviderBaseUrls({ openai: "http://127.0.0.1:19999/v1" });
    assert.notEqual((await verifier(parseModelOverlay(spec))).fingerprint, original);
    setProviderBaseUrls({});
    await built.modelCredentials.set("openai", "test-key", "admin");
    assert.notEqual((await verifier(parseModelOverlay(spec))).fingerprint, original);
  } finally {
    setProviderBaseUrls({});
  }
});

test("corrupt persisted rows and copied proofs cannot enable a different model ID", async () => {
  const backing = createMemoryMap<StoredModelOverlay>();
  const verifier: ModelVerifier = async (value) => ({ fingerprint: JSON.stringify(value), probe: async () => {} });
  const store = createModelOverlayStore(backing, undefined, verifier);
  await store.upsert(spec, "admin");
  const saved = (await backing.get(spec.id))!;
  await backing.put("copied-model", saved);
  await backing.put("null-model", null as unknown as StoredModelOverlay);
  await store.refresh();
  assert.ok(resolveModel(spec.id));
  assert.equal(resolveModel("copied-model"), undefined);
  assert.equal(resolveModel("null-model"), undefined);
  assert.equal((await store.statuses()).length, 3);
});

test("concurrent successful probes cannot silently overwrite a newer saved definition", async () => {
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const started = new Promise<void>((r) => {
    entered = r;
  });
  let holding = false;
  const store = createModelOverlayStore(createMemoryMap(), undefined, async (value) => ({
    fingerprint: JSON.stringify(value),
    probe: async () => {
      if (holding && value.name === "Slow edit") {
        entered();
        await new Promise<void>((r) => {
          release = r;
        });
      }
    },
  }));
  await store.upsert(spec, "admin");
  holding = true;
  const slow = store.upsert({ ...spec, name: "Slow edit" }, "admin");
  await started;
  await store.upsert({ ...spec, name: "Newer edit" }, "admin");
  release();
  await assert.rejects(slow, /changed during verification/);
  assert.equal((await store.statuses())[0]?.spec.name, "Newer edit");
});

test("a model stays unavailable until its pending probe completes", async () => {
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const store = createModelOverlayStore(createMemoryMap(), undefined, async () => ({
    fingerprint: "context",
    probe: async () => {
      entered();
      await new Promise<void>((r) => {
        release = r;
      });
    },
  }));
  const pending = store.upsert(spec, "admin");
  await started;
  await store.refresh();
  assert.equal(resolveModel(spec.id), undefined);
  assert.deepEqual(await store.statuses(), []);
  release();
  await pending;
  await store.refresh();
  assert.ok(resolveModel(spec.id));
});

test("the store deadline leaves a hanging provider unverified", { timeout: 25_000 }, async () => {
  const upstream = await verificationUpstream();
  upstream.behavior.hang = true;
  const built = buildApp(testConfig({ openaiApiKey: "test-key", providerBaseUrls: { openai: upstream.url + "/v1" } }));
  try {
    const start = Date.now();
    await assert.rejects(
      built.modelRegistry.upsert(spec, "admin"),
      (error: unknown) => error instanceof ModelVerificationError && error.code === "timeout",
    );
    assert.ok(Date.now() - start < 20_000);
    assert.deepEqual(await built.modelRegistry.statuses(), []);
  } finally {
    await upstream.close();
    setProviderBaseUrls({});
  }
});

import { createHmac, scryptSync } from "node:crypto";

test("verification fingerprints use a memory-hard credential-bound MAC key", async () => {
  const built = buildApp(testConfig({ openaiApiKey: "fingerprint-test-key" }));
  const keyMaterial = "deployment-fingerprint-test-key";
  const candidate = parseModelOverlay(spec);
  const verifier = createModelVerifier({ credentials: built.modelCredentials, keyMaterial });
  const salt = createHmac("sha256", keyMaterial).update("qm:model-verification:credential:v2").digest();
  const derived = scryptSync(JSON.stringify({ key: "fingerprint-test-key" }), salt, 32, {
    N: 131_072,
    r: 8,
    p: 1,
    maxmem: 256 * 1024 * 1024,
  });
  const expected = createHmac("sha256", derived)
    .update(
      JSON.stringify({
        version: 2,
        spec: candidate,
        model: modelFromOverlay(candidate),
        credentialRevision: (await built.modelCredentials.statuses()).find(
          (status) => status.provider === candidate.provider,
        ),
      }),
    )
    .digest("hex");
  assert.equal((await verifier(candidate)).fingerprint, expected);
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => verifier(candidate)));
  assert.ok(concurrent.every((value) => value.fingerprint === expected));
  const restarted = createModelVerifier({ credentials: built.modelCredentials, keyMaterial });
  assert.equal((await restarted(candidate)).fingerprint, expected);
  const differentDeployment = createModelVerifier({
    credentials: built.modelCredentials,
    keyMaterial: "other-deployment-key",
  });
  assert.notEqual((await differentDeployment(candidate)).fingerprint, expected);
});

test("environment and gateway credential changes invalidate cached fingerprints", async () => {
  const fallback = { openai: "first-environment-test-key" };
  const credentials = createModelCredentialStore({ backing: createMemoryMap(), keyMaterial: "test-key", fallback });
  const candidate = parseModelOverlay(spec);
  const modelGateway = {
    url: "https://gateway.example.invalid/v1",
    apiKey: "first-gateway-test-key",
    apiKeyHeader: "x-gateway-key",
    models: { [spec.id]: "target" },
  };
  const direct = createModelVerifier({ credentials, keyMaterial: "test-key" });
  const gateway = createModelVerifier({ credentials, keyMaterial: "test-key", modelGateway });
  const directOriginal = (await direct(candidate)).fingerprint;
  const gatewayOriginal = (await gateway(candidate)).fingerprint;
  fallback.openai = "changed-environment-test-key";
  assert.notEqual((await direct(candidate)).fingerprint, directOriginal);
  assert.equal((await gateway(candidate)).fingerprint, gatewayOriginal);
  modelGateway.apiKey = "changed-gateway-test-key";
  const rotatedGateway = (await gateway(candidate)).fingerprint;
  assert.notEqual(rotatedGateway, gatewayOriginal);
  modelGateway.apiKeyHeader = "x-new-gateway-key";
  assert.notEqual((await gateway(candidate)).fingerprint, rotatedGateway);
});

import { createModelCredentialStore } from "../src/model/model-credential-store.ts";

test("legacy fingerprint versions stay unavailable until a successful new verification", async () => {
  const built = buildApp(testConfig({ openaiApiKey: "test-key" }));
  const candidate = parseModelOverlay(spec);
  const keyMaterial = "stable-test-key";
  const fingerprint = createHmac("sha256", keyMaterial)
    .update(
      JSON.stringify({
        version: 1,
        spec: candidate,
        model: modelFromOverlay(candidate),
        key: "test-key",
        credentialRevision: (await built.modelCredentials.statuses()).find((status) => status.provider === "openai"),
      }),
    )
    .digest("hex");
  const backing = createMemoryMap<StoredModelOverlay>();
  await backing.put(spec.id, {
    spec: candidate,
    disabled: false,
    updatedAt: 1,
    updatedBy: "admin",
    verification: { fingerprint, verifiedAt: 1, revision: "old-proof" },
  });
  let probes = 0;
  const verifier = createModelVerifier({
    credentials: built.modelCredentials,
    keyMaterial,
    probe: async () => {
      probes++;
    },
  });
  const store = createModelOverlayStore(backing, undefined, verifier);
  await store.refresh();
  assert.equal(probes, 0);
  assert.equal(resolveModel(spec.id), undefined);
  assert.match(modelUnavailableReason(spec.id)!, /verify.*again/i);
  await store.upsert(candidate, "admin");
  await store.refresh();
  assert.equal(probes, 1);
  assert.ok(resolveModel(spec.id));
});
