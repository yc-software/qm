import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp, serverDeps } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { getRequiredModel } from "../src/model/pi-models.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };
const MODEL_ID = "overlay-future-model";

test("unknown builtin-provider model fails resolution and a live runtime selection request", async () => {
  assert.throws(() => getRequiredModel(MODEL_ID), /Unsupported model/);
  const config = testConfig({ harness: "pi" });
  const built = buildApp(config, {
    modelCredentialFetch: async () => Response.json({ data: [] }),
    modelVerificationProbe: async () => {},
  });
  const server = createInsecureTestServer(built.app, serverDeps(config, built));
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const response = await fetch(`${base}/v1/runtime-config`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({
        principalId: "admin-alice@default-org",
        scopeId: "personal:admin-alice@default-org",
        harnessId: "pi",
        modelId: MODEL_ID,
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.match(JSON.stringify(body), /model|supported/);
    console.log(`Baseline: unknown model resolution throws; live runtime selection HTTP ${response.status}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

import { afterEach } from "node:test";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createModelOverlayStore as createStore, type StoredModelOverlay } from "../src/model/model-overlay-store.ts";
import {
  setModelOverlays,
  validateModelOverlay,
  resolveModel,
  contextTokenBudgetForModel,
  safeModelMetadata,
  modelSupportedByHarness,
  modelSupportsFastMode,
  fastModeModelIds,
  defaultWebuiModelIds,
} from "../src/model/pi-models.ts";
import { setCustomProviders, validateCustomProviderSpec } from "../src/model/custom-providers.ts";
import { selectableModelCatalog } from "../src/model/model-catalog.ts";
import { resolveIndividualAuthRouting } from "../src/core/individual-auth-routing.ts";
import { validateWebTurnModelOptions } from "../src/core/turn-options.ts";

const createModelOverlayStore: typeof createStore = (backing, write) =>
  createStore(backing, write, async () => ({ fingerprint: "fixture", probe: async () => {} }));

const spec = {
  id: MODEL_ID,
  name: "Future API model",
  provider: "openai",
  template: "gpt-5.5",
  contextWindow: 400_000,
  maxTokens: 20_000,
  cost: {
    input: 7,
    output: 21,
    cacheRead: 0.3,
    cacheWrite: 8,
    tiers: [{ inputTokensAbove: 200_000, input: 14, output: 42, cacheRead: 0.6, cacheWrite: 16 }],
  },
};

afterEach(() => {
  setModelOverlays([]);
  setCustomProviders([]);
});

test("strict overlay validation rejects malformed fields, prices, bounds, reserved ids and incompatible templates", () => {
  for (const invalid of [
    null,
    [],
    { ...spec, provider: "openrouter" },
    { ...spec, provider: "anthropic" },
    { ...spec, template: MODEL_ID },
    { ...spec, name: 3 },
    { ...spec, id: "codex/gpt-new" },
    { ...spec, id: "vendor/new" },
    { ...spec, id: "gpt-5.5" },
    { ...spec, id: "gpt-6-astra" },
    { ...spec, baseUrl: "https://example.invalid" },
    { ...spec, headers: {} },
    { ...spec, apiKey: "invalid" },
    { ...spec, base: "true" },
    { ...spec, fastMode: "true" },
    { ...spec, fastMode: true },
    { ...spec, maxTokens: 400_000 },
    { ...spec, contextWindow: 1.2 },
    { ...spec, cost: { ...spec.cost, input: Infinity } },
    { ...spec, cost: { ...spec.cost, output: -1 } },
    { ...spec, cost: { input: 1, output: 2 } },
    { ...spec, cost: { ...spec.cost, tiers: [{ ...spec.cost.tiers[0], inputTokensAbove: 400_000 }] } },
  ]) {
    assert.throws(() => validateModelOverlay(invalid));
  }
  assert.equal(validateModelOverlay(spec).base, true);
  assert.equal(validateModelOverlay(spec).webui, true);
  assert.equal(validateModelOverlay(spec).auxiliary, false);
});

test("store reload and independent readers observe edits and soft deletion without mutating in-flight models", async () => {
  const backing = createMemoryMap<StoredModelOverlay>();
  const writer = createModelOverlayStore(backing);
  const reader = createModelOverlayStore(backing);
  await writer.upsert(spec, "admin");
  assert.equal(resolveModel(MODEL_ID), undefined);
  await reader.refresh();
  const inFlight = getRequiredModel(MODEL_ID);
  assert.equal(contextTokenBudgetForModel(MODEL_ID), 150_000);
  assert.deepEqual(inFlight.cost, spec.cost);
  assert.ok(defaultWebuiModelIds().includes(MODEL_ID));
  assert.equal(validateWebTurnModelOptions({ model: MODEL_ID }, null), null);
  for (const harness of ["pi", "mock"]) assert.equal(modelSupportedByHarness(MODEL_ID, harness), true);
  for (const harness of ["codex", "claude", "opencode"])
    assert.equal(modelSupportedByHarness(MODEL_ID, harness), false);
  assert.equal(resolveModel(`codex/${MODEL_ID}`), undefined);
  await writer.upsert(
    { ...spec, contextWindow: 600_000, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
    "editor",
  );
  await reader.refresh();
  assert.equal(getRequiredModel(MODEL_ID).contextWindow, 600_000);
  assert.equal(getRequiredModel(MODEL_ID).cost.input, 1);
  assert.equal(getRequiredModel(MODEL_ID).cost.tiers, undefined);
  assert.equal(inFlight.contextWindow, 400_000);
  assert.deepEqual(inFlight.cost, spec.cost);
  setModelOverlays([]);
  await createModelOverlayStore(backing).refresh();
  assert.equal(getRequiredModel(MODEL_ID).contextWindow, 600_000);
  assert.equal(await writer.delete(MODEL_ID, "admin"), true);
  await reader.refresh();
  assert.equal(resolveModel(MODEL_ID), undefined);
  assert.equal(modelSupportedByHarness(MODEL_ID, "codex"), false);
  assert.equal(await writer.delete(MODEL_ID, "admin"), false);
  const row = (await reader.statuses())[0]!;
  assert.equal(row.disabled, true);
  assert.equal(row.updatedBy, "admin");
});

test("template capabilities are inherited and overlay API models cannot silently use subscription routing", () => {
  setModelOverlays([validateModelOverlay({ ...spec, provider: "anthropic", template: "claude-opus-4-8" })]);
  assert.equal(modelSupportsFastMode(MODEL_ID), false);
  assert.equal(wantsFastMode(true, MODEL_ID), false);
  assert.equal(safeModelMetadata(MODEL_ID)?.fastMode, false);
  assert.ok(!fastModeModelIds().includes(MODEL_ID));
  setModelOverlays([
    validateModelOverlay({ ...spec, provider: "anthropic", template: "claude-opus-4-8", fastMode: true }),
  ]);
  assert.equal(modelSupportsFastMode(MODEL_ID), true);
  assert.equal(wantsFastMode(true, MODEL_ID), true);
  assert.equal(safeModelMetadata(MODEL_ID)?.fastMode, true);
  assert.ok(fastModeModelIds().includes(MODEL_ID));
  assert.deepEqual(getRequiredModel(MODEL_ID).input, getRequiredModel("claude-opus-4-8").input);
  assert.equal(getRequiredModel(MODEL_ID).reasoning, getRequiredModel("claude-opus-4-8").reasoning);
  assert.equal(
    resolveIndividualAuthRouting(
      { provider: "anthropic", kind: "oauth", oauth: {}, updatedAt: 1 },
      null,
      MODEL_ID,
      "pi",
    ),
    null,
  );
});

test("collisions are rejected in both registration orders and OpenRouter failure rebuilds local choices", async () => {
  const custom = {
    id: "gateway",
    name: "Gateway",
    protocol: "openai" as const,
    baseUrl: "https://example.invalid/v1",
    models: [{ id: MODEL_ID }],
  };
  setCustomProviders([custom]);
  assert.throws(() => validateModelOverlay(spec), /already registered/);
  setCustomProviders([]);
  let fail = false;
  const fetcher: typeof fetch = async () => {
    if (fail) throw new Error("offline");
    return Response.json({ data: [] });
  };
  await selectableModelCatalog(fetcher);
  setModelOverlays([validateModelOverlay(spec)]);
  assert.throws(() => validateCustomProviderSpec(custom), /already registered/);
  fail = true;
  assert.ok((await selectableModelCatalog(fetcher)).some((m) => m.id === MODEL_ID));
  setModelOverlays([], [MODEL_ID]);
  assert.ok(!(await selectableModelCatalog(fetcher)).some((m) => m.id === MODEL_ID));
  assert.throws(() => validateCustomProviderSpec(custom), /already registered/);
});

test("live admin lifecycle is authorized, audited, immediately selectable and removed on delete", async () => {
  const config = testConfig({ harness: "pi", openaiApiKey: "local-test-key" });
  const built = buildApp(config, {
    modelCredentialFetch: async () => Response.json({ data: [] }),
    modelVerificationProbe: async () => {},
  });
  const server = createInsecureTestServer(built.app, serverDeps(config, built));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = (path: string, method = "GET", body?: unknown, headers = ADMIN) =>
    fetch(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(
              method === "PUT" && path.includes("model-registry") ? { ...(body as object), verify: true } : body,
            ),
          }),
    });
  const path = `/v1/admin/model-registry/${MODEL_ID}`;
  const runtime = {
    principalId: "admin-alice@default-org",
    scopeId: "personal:admin-alice@default-org",
    harnessId: "pi",
    modelId: MODEL_ID,
  };
  try {
    for (const method of ["PUT", "DELETE"])
      assert.equal(
        (await api(path, method, method === "PUT" ? spec : undefined, { ...ADMIN, "x-admin-actor": "bob@default-org" }))
          .status,
        403,
      );
    assert.equal(
      (await api("/v1/admin/model-registry", "GET", undefined, { ...ADMIN, "x-admin-actor": "bob@default-org" }))
        .status,
      403,
    );
    assert.equal((await api(path, "PUT", { ...spec, contextWindow: "400000" })).status, 400);
    assert.equal((await api(path, "PUT", spec)).status, 200);
    const response = await api("/v1/runtime-config", "PUT", runtime);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      modelCatalog: Record<string, ReturnType<typeof safeModelMetadata>>;
      modelsByHarness: Record<string, string[]>;
    };
    assert.equal(body.modelCatalog[MODEL_ID]?.contextWindow, 400_000);
    assert.deepEqual(body.modelCatalog[MODEL_ID]?.cost, spec.cost);
    assert.ok(body.modelsByHarness.pi?.includes(MODEL_ID));
    const wire = JSON.stringify(body.modelCatalog);
    assert.doesNotMatch(wire, /baseUrl|headers|apiKey|local-test-key/);
    const turn = await built.app.turn({
      surface: "web",
      actor: { externalId: "alice" },
      conversation: { kind: "dm", threadRef: "overlay-live-test" },
      text: "hello",
      model: MODEL_ID,
      async: true,
    });
    assert.equal(turn.status, "queued");
    assert.equal((await api(path, "PUT", { ...spec, name: "Renamed", maxTokens: 30_000 })).status, 200);
    assert.equal(getRequiredModel(MODEL_ID).name, "Renamed");
    await built.config.setRuntimeSelectionLatest("org:default-org", { harnessId: "pi", modelId: MODEL_ID });
    assert.equal((await api(path, "DELETE")).status, 200);
    const afterDelete = await api(
      "/v1/runtime-config?principalId=admin-alice@default-org&scopeId=personal:admin-alice@default-org",
    );
    const unavailable = (await afterDelete.json()) as {
      effective: { modelId: string };
      scopeOverride: { modelId: string };
      unavailableReason: string;
      modelsByHarness: { pi: string[] };
    };
    assert.equal(unavailable.effective.modelId, MODEL_ID);
    assert.equal(unavailable.scopeOverride.modelId, MODEL_ID);
    assert.match(unavailable.unavailableReason, /deleted/);
    assert.ok(unavailable.modelsByHarness.pi.includes("gpt-5.6-sol"));
    assert.equal((await api("/v1/runtime-config", "PUT", runtime)).status, 400);
    const deletedTurn = await built.app.turn({
      surface: "web",
      actor: { externalId: "alice" },
      conversation: { kind: "dm", threadRef: "overlay-deleted-test" },
      text: "hello",
      model: MODEL_ID,
      async: true,
    });
    assert.equal(deletedTurn.status, "refused");
    assert.match(JSON.stringify(deletedTurn), /couldn.t set up that runtime choice/);
    const recovered = await api("/v1/runtime-config", "PUT", { ...runtime, modelId: "gpt-5.6-sol" });
    assert.equal(recovered.status, 200);
    assert.equal(((await recovered.json()) as { effective: { modelId: string } }).effective.modelId, "gpt-5.6-sol");
    for (const model of [undefined, "gpt-5.6-sol"]) {
      const recoveredTurn = await built.app.turn({
        surface: "web",
        actor: { externalId: runtime.principalId },
        conversation: { kind: "dm", threadRef: `overlay-recovered-${model ?? "saved-selection"}` },
        text: "Continue with the replacement I selected",
        ...(model ? { model } : {}),
        async: true,
      });
      assert.equal(recoveredTurn.status, "queued", JSON.stringify(recoveredTurn));
    }
    const events = await built.auditLog.events();
    assert.equal(events.filter((e) => e.action === "model-registry.update").length, 2);
    assert.equal(events.filter((e) => e.action === "model-registry.delete").length, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

import { createServer } from "node:http";
import { oneShot, createPiHarness, wantsFastMode } from "../src/harness/pi-harness.ts";
import { setProviderBaseUrls } from "../src/model/provider-endpoints.ts";
import { calculateCost } from "@earendil-works/pi-ai";

test("Pi serves an overlay via the inherited provider endpoint and metadata drives request limits and pricing", async () => {
  let received: { model?: string; max_tokens?: number } | undefined;
  let authorized = false;
  const upstream = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      received = JSON.parse(raw);
      authorized = req.headers["x-api-key"] === "local-test-key";
      assert.equal(req.url, "/v1/messages");
      res.writeHead(200, { "content-type": "text/event-stream" });
      const event = (type: string, data: object) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      event("message_start", {
        message: {
          id: "msg_overlay",
          type: "message",
          role: "assistant",
          content: [],
          model: MODEL_ID,
          stop_reason: null,
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      });
      event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Overlay works" } });
      event("content_block_stop", { index: 0 });
      event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } });
      event("message_stop", {});
      res.end();
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  setProviderBaseUrls({ anthropic: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` });
  try {
    setModelOverlays([
      validateModelOverlay({ ...spec, provider: "anthropic", template: "claude-opus-4-8", maxTokens: 10_000 }),
    ]);
    const model = getRequiredModel(MODEL_ID);
    assert.equal(
      await oneShot("overlay-local", model, { anthropic: "local-test-key" }, "Be brief", "Hello"),
      "Overlay works",
    );
    assert.equal(received?.model, MODEL_ID);
    assert.equal(received?.max_tokens, 10_000);
    assert.equal(authorized, true);
    const harness = createPiHarness({ apiKey: "local-test-key", captureRequests: false });
    const turn = {
      session: { id: "overlay-runtime" } as import("../src/harness/harness.ts").HarnessTurnInput["session"],
      input: "Hello",
      systemPrompt: "Be brief",
      history: [],
      runtime: { harnessId: "pi" as const, modelId: MODEL_ID },
      recordModelCall: () => {},
      tools: {} as import("../src/harness/harness.ts").HarnessTurnInput["tools"],
      scopeLabel: "personal:alice" as const,
      orgScopeId: "org:default-org" as const,
      emit: async (entry: Parameters<import("../src/harness/harness.ts").HarnessTurnInput["emit"]>[0]) => ({
        ...entry,
        seq: 1,
        sessionId: "overlay-runtime",
        parentSeq: null,
        createdAt: Date.now(),
      }),
    };
    await harness.turns.runTurn(turn);
    assert.equal(received?.model, MODEL_ID);
    assert.equal(received?.max_tokens, 10_000);
    setModelOverlays([
      validateModelOverlay({ ...spec, provider: "anthropic", template: "claude-opus-4-8", maxTokens: 16_000 }),
    ]);
    await harness.turns.runTurn(turn);
    assert.equal(received?.max_tokens, 16_000);
    setModelOverlays([], [MODEL_ID]);
    await assert.rejects(harness.turns.runTurn(turn), /Unsupported model/);
    const usage = {
      input: 210_000,
      output: 100,
      cacheRead: 200,
      cacheWrite: 100,
      totalTokens: 210_400,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    calculateCost(model, usage);
    assert.equal(usage.cost.input, 2.94);
    assert.equal(usage.cost.output, 0.0042);
    assert.ok(Math.abs(usage.cost.cacheRead - 0.00012) < 1e-12);
    assert.equal(usage.cost.cacheWrite, 0.0016);
  } finally {
    setProviderBaseUrls({});
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("hydration isolates promoted builtins, incompatible providers, missing templates and malformed rows", async () => {
  const backing = createMemoryMap<StoredModelOverlay>();
  const store = createModelOverlayStore(backing);
  const builtin = getRequiredModel("gpt-5.5");
  const row = (value: unknown) =>
    ({ spec: value, disabled: false, updatedAt: 1, updatedBy: "admin" }) as StoredModelOverlay;
  await backing.put("gpt-5.5", row({ ...spec, id: "gpt-5.5" }));
  await backing.put("missing-template", row({ ...spec, id: "missing-template", template: "removed-sdk-template" }));
  await backing.put("corrupt-model", row(null));
  await store.refresh();
  assert.equal(getRequiredModel("gpt-5.5").contextWindow, builtin.contextWindow);
  assert.deepEqual(getRequiredModel("gpt-5.5").cost, builtin.cost);
  assert.equal(resolveModel("missing-template"), undefined);
  assert.equal(resolveModel("corrupt-model"), undefined);
  assert.equal((await store.statuses()).length, 3);
  assert.throws(() => validateModelOverlay({ ...spec, id: "gpt-5.5" }), /already registered/);
  await backing.put("gpt-5.5", row({ ...spec, id: "gpt-5.5", provider: "anthropic" }));
  await store.refresh();
  assert.equal(resolveModel("gpt-5.5"), undefined);
  assert.ok(resolveModel("claude-opus-5"));
  await store.upsert({ ...spec, id: "missing-template" }, "admin");
  await store.refresh();
  assert.ok(resolveModel("missing-template"));
  assert.equal(await store.delete("corrupt-model", "admin"), true);
});

test("model refresh is limited to dependent routes and admin repair survives stale persisted definitions", async () => {
  const config = testConfig({ harness: "pi" });
  const built = buildApp(config, {
    modelCredentialFetch: async () => Response.json({ data: [] }),
    modelVerificationProbe: async () => {},
  });
  const backing = createMemoryMap<StoredModelOverlay>();
  await backing.put("stale", {
    spec: { ...spec, id: "stale", template: "missing" },
    disabled: false,
    updatedAt: 1,
    updatedBy: "admin",
  } as StoredModelOverlay);
  const registry = createModelOverlayStore(backing);
  let refreshes = 0;
  const deps = {
    ...serverDeps(config, built),
    modelRegistry: registry,
    refreshModels: async () => {
      refreshes++;
      await registry.refresh();
    },
  };
  const server = createInsecureTestServer(built.app, deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(base + "/v1/admin/whoami", { headers: ADMIN })).status, 200);
    assert.equal(refreshes, 0);
    assert.equal(
      (await fetch(base + "/v1/admin/model-registry", { headers: { ...ADMIN, "x-admin-actor": "bob@default-org" } }))
        .status,
      403,
    );
    assert.equal(refreshes, 0);
    const list = await fetch(base + "/v1/admin/model-registry", { headers: ADMIN });
    assert.equal(list.status, 200);
    assert.equal(refreshes, 1);
    assert.match(JSON.stringify(await list.json()), /template is unavailable/);
    assert.equal(
      (await fetch(base + "/v1/admin/model-registry/stale", { method: "DELETE", headers: ADMIN })).status,
      200,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("overlay resolution preserves canonical personal endpoints and upstream builtin metadata", () => {
  setModelOverlays([validateModelOverlay(spec)]);
  const canonical = getRequiredModel(MODEL_ID, false).baseUrl;
  setProviderBaseUrls({ openai: "http://127.0.0.1:19999/v1" });
  try {
    assert.equal(getRequiredModel(MODEL_ID).baseUrl, "http://127.0.0.1:19999/v1");
    assert.equal(getRequiredModel(MODEL_ID, false).baseUrl, canonical);
    assert.equal(safeModelMetadata("claude-fable-5-1")?.label, "Fable 5.1");
    assert.equal(safeModelMetadata("gpt-5.6-sol")?.cost.input, 4);
    assert.equal(safeModelMetadata("gpt-5.6-sol")?.fastMode, true);
  } finally {
    setProviderBaseUrls({});
  }
});

import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import { resolveRuntimeChoice } from "../src/harness/harness-router.ts";

test("runtime normalization preserves native capabilities and reflects overlay capability edits", () => {
  const config = createMemoryConfigStore("default-org");
  config.setApprovedHarnesses(["pi", "codex", "claude"]);
  const org = "org:default-org" as const;
  const scope = "personal:alice" as const;
  const fallback = { harnessId: "pi" as const, modelId: "gpt-5.6-sol" };
  const overlay = validateModelOverlay({ ...spec, provider: "anthropic", template: "claude-opus-4-8", fastMode: true });
  setModelOverlays([overlay]);
  const requested = { harnessId: "pi" as const, modelId: MODEL_ID, effortLevel: "max", fastMode: true };
  assert.deepEqual(resolveRuntimeChoice(config, org, scope, fallback, requested), requested);
  setModelOverlays([{ ...overlay, fastMode: false }]);
  assert.equal(resolveRuntimeChoice(config, org, scope, fallback, requested).fastMode, false);
  assert.throws(
    () => resolveRuntimeChoice(config, org, scope, fallback, { ...requested, harnessId: "codex" }),
    /not approved/,
  );
  const native = resolveRuntimeChoice(config, org, scope, fallback, {
    harnessId: "codex",
    modelId: "gpt-5.6-sol",
    effortLevel: "xhigh",
    fastMode: true,
  });
  assert.equal(native.fastMode, true);
  assert.equal(native.effortLevel, "xhigh");
});
