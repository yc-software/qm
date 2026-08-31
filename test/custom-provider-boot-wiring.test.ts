import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, afterEach } from "node:test";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp, serverDeps } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { defaultModelForHarness } from "../src/model/pi-models.ts";
import { setCustomProviders } from "../src/model/custom-providers.ts";
import { DEV_GEMINI_BASE_URL, DEV_GEMINI_MODEL, devGeminiProviderFromEnv } from "../src/model/dev-gemini-provider.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };

afterEach(() => setCustomProviders([]));

function openAiCompletion(model: string, text: string): Response {
  const chunk = (delta: object, finish: string | null) =>
    `data: ${JSON.stringify({
      id: "cmpl-test",
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
      usage: finish ? { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } : undefined,
    })}\n\n`;
  return new Response(`${chunk({ role: "assistant", content: text }, null)}${chunk({}, "stop")}data: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function anthropicCompletion(model: string, text: string): Response {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg-test",
        type: "message",
        role: "assistant",
        content: [],
        model,
        stop_reason: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

test("serverDeps wires the custom-provider store and resolves a custom boot default lazily", async () => {
  const config = testConfig({
    dataDir: mkdtempSync(join(tmpdir(), "custom-provider-boot-")),
    harness: "pi",
    modelId: "acme-large",
  });
  const built = buildApp(config, { modelCredentialFetch: async () => new Response(null, { status: 200 }) });
  const deps = serverDeps(config, built);
  assert.equal(deps.customProviders, built.customProviders);
  assert.equal(deps.refreshCustomProviders, built.refreshCustomProviders);
  assert.equal(deps.baseModelDefault, "acme-large");

  const server = createInsecureTestServer(built.app, deps);
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    assert.notEqual(defaultModelForHarness("pi", deps.baseModelDefault), "acme-large");

    const list = await fetch(`${base}/v1/admin/custom-providers`, { headers: ADMIN });
    assert.equal(list.status, 200);

    const put = await fetch(`${base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({
        name: "Acme Gateway",
        protocol: "openai",
        baseUrl: "https://llm.acme.internal/v1",
        models: [{ id: "acme-large", name: "Acme Large" }],
        apiKey: "sk-acme-secret",
        validate: false,
      }),
    });
    assert.equal(put.status, 200);

    assert.equal(defaultModelForHarness("pi", deps.baseModelDefault), "acme-large");

    const runtime = await fetch(
      `${base}/v1/runtime-config?principalId=admin-alice@default-org&scopeId=personal:admin-alice@default-org`,
      { headers: ADMIN },
    );
    assert.equal(runtime.status, 200);
    const body = (await runtime.json()) as {
      effective: { modelId: string };
      modelsByHarness: Record<string, string[]>;
      modelCatalog: Record<string, { name: string; provider: string }>;
    };
    assert.equal(body.effective.modelId, "acme-large");
    assert.ok(body.modelsByHarness.pi?.includes("acme-large"));
    assert.equal(body.modelCatalog["acme-large"]?.provider, "acme-gateway");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("the transient dev provider pins both runtime APIs despite durable or requested drift", async () => {
  const devGeminiProvider = devGeminiProviderFromEnv({
    DEV_INSTANCE_GEMINI_PROVIDER: "1",
    GEMINI_API_KEY: "transient-test-key",
    HARNESS: "pi",
  });
  assert.ok(devGeminiProvider);
  const config = testConfig({
    dataDir: mkdtempSync(join(tmpdir(), "gemini-provider-boot-")),
    harness: "pi",
    modelId: DEV_GEMINI_MODEL,
    devGeminiProvider,
  });
  const built = buildApp(config);
  await built.refreshCustomProviders();
  built.config.setApprovedHarnesses(["codex"]);
  built.config.setRuntimeSelection("org:default-org", { harnessId: "codex", modelId: "gpt-5.5" });
  built.config.setRuntimeSelection("personal:admin-alice@default-org", {
    harnessId: "claude",
    modelId: "claude-opus-5",
  });
  await built.config.flushScope("org:default-org");
  await built.config.flushScope("personal:admin-alice@default-org");
  const deps = serverDeps(config, built);
  assert.deepEqual(deps.runtimeChoiceOverride, { harnessId: "pi", modelId: DEV_GEMINI_MODEL });

  const server = createInsecureTestServer(built.app, deps);
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const target = "principalId=admin-alice@default-org&scopeId=personal:admin-alice@default-org";
  try {
    const runtime = await fetch(`${base}/v1/runtime-config?${target}`);
    const body = (await runtime.json()) as {
      approvedHarnesses: string[];
      modelsByHarness: Record<string, string[]>;
      effective: { harnessId: string; modelId: string };
    };
    assert.equal(runtime.status, 200);
    assert.deepEqual(body.approvedHarnesses, ["pi"]);
    assert.deepEqual(body.modelsByHarness, { pi: [DEV_GEMINI_MODEL] });
    assert.deepEqual(body.effective, { harnessId: "pi", modelId: DEV_GEMINI_MODEL });

    const admitted = await built.app.turn({
      surface: "web",
      actor: { externalId: "admin-alice@default-org" },
      conversation: { kind: "dm", threadRef: "web:admin-alice@default-org:gemini-admission" },
      text: "admission only",
      harness: "pi",
      model: DEV_GEMINI_MODEL,
      async: true,
    });
    assert.notEqual(admitted.status, "refused", JSON.stringify(admitted));
    assert.equal(
      (await built.slackCore.surfaceHeaderFacts("personal:admin-alice@default-org")).modelName,
      "Gemini 3.7 Flash",
    );

    const surface = await fetch(`${base}/v1/surface-config`);
    const surfaceBody = (await surface.json()) as { harnessId: string; baseModel: string; webuiModels: string[] };
    assert.equal(surface.status, 200);
    assert.equal(surfaceBody.harnessId, "pi");
    assert.equal(surfaceBody.baseModel, DEV_GEMINI_MODEL);
    assert.deepEqual(surfaceBody.webuiModels, [DEV_GEMINI_MODEL]);

    const drift = await fetch(`${base}/v1/runtime-config`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({
        principalId: "admin-alice@default-org",
        scopeId: "personal:admin-alice@default-org",
        harnessId: "codex",
        modelId: "gpt-5.5",
      }),
    });
    assert.equal(drift.status, 400);
    assert.equal(((await drift.json()) as { error: string }).error, "runtime_fixed");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("transient Gemini bypasses individual model auth while ordinary individual auth still routes", async () => {
  const actorId = "admin-alice@default-org";
  const transientKey = "transient-gemini-key";
  const personalAnthropicKey = "personal-anthropic-key";
  const personalOpenAiKey = "personal-openai-key";
  const seen: Array<{ url: string; authorization: string | null; apiKey: string | null; body: string }> = [];
  const originalFetch = globalThis.fetch;
  const fakeFetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = await request.clone().text();
    seen.push({
      url: request.url,
      authorization: request.headers.get("authorization"),
      apiKey: request.headers.get("x-api-key"),
      body,
    });
    if (request.url.startsWith(DEV_GEMINI_BASE_URL)) {
      return openAiCompletion(DEV_GEMINI_MODEL, "FORCED GEMINI REPLY");
    }
    if (request.url.startsWith("https://api.anthropic.com/")) {
      return anthropicCompletion("claude-opus-4-8", "INDIVIDUAL ANTHROPIC REPLY");
    }
    throw new Error(`unexpected provider request ${request.url}`);
  };
  globalThis.fetch = fakeFetch;
  try {
    const devGeminiProvider = devGeminiProviderFromEnv({
      DEV_INSTANCE_GEMINI_PROVIDER: "1",
      GEMINI_API_KEY: transientKey,
      HARNESS: "pi",
    });
    assert.ok(devGeminiProvider);
    const forced = buildApp(
      testConfig({
        dataDir: mkdtempSync(join(tmpdir(), "gemini-individual-auth-")),
        harness: "pi",
        modelId: DEV_GEMINI_MODEL,
        devGeminiProvider,
      }),
    );
    await forced.refreshCustomProviders();
    await forced.userModelCredentials.setApiKey(actorId, "anthropic", personalAnthropicKey);
    await forced.userModelCredentials.setApiKey(actorId, "openai", personalOpenAiKey);
    forced.config.setIndividualModelAuth(true);
    forced.config.setApprovedHarnesses(["codex"]);
    forced.config.setRuntimeSelection("org:default-org", { harnessId: "codex", modelId: "gpt-5.5" });
    forced.config.setRuntimeSelection(`personal:${actorId}`, { harnessId: "claude", modelId: "claude-opus-5" });
    await forced.config.flushScope("org:default-org");
    await forced.config.flushScope(`personal:${actorId}`);

    let individualCredentialReads = 0;
    const readUserCredential = forced.userModelCredentials.get.bind(forced.userModelCredentials);
    forced.userModelCredentials.get = async (...args) => {
      individualCredentialReads += 1;
      return readUserCredential(...args);
    };

    const drift = await forced.app.turn({
      surface: "web",
      actor: { externalId: actorId },
      conversation: { kind: "dm", threadRef: `web:${actorId}:gemini-drift` },
      text: "must not drift",
      harness: "codex",
      model: "gpt-5.5",
      liveActor: true,
    });
    assert.equal(drift.status, "refused");
    assert.match(drift.reason ?? "", /runtime is fixed to pi\/gemini-3\.7-flash/);

    const forcedResult = await forced.app.turn({
      surface: "web",
      actor: { externalId: actorId },
      conversation: { kind: "dm", threadRef: `web:${actorId}:gemini-forced` },
      text: "use the forced runtime",
      harness: "pi",
      model: DEV_GEMINI_MODEL,
      liveActor: true,
      skipMemory: true,
    });
    assert.equal(forcedResult.status, "ok", forcedResult.reason);
    assert.equal(forcedResult.reply, "FORCED GEMINI REPLY");
    assert.equal(individualCredentialReads, 0);
    const forcedRequests = seen.splice(0);
    assert.ok(forcedRequests.length > 0);
    assert.ok(forcedRequests.every((request) => request.url.startsWith(DEV_GEMINI_BASE_URL)));
    assert.ok(forcedRequests.every((request) => request.authorization === `Bearer ${transientKey}`));
    assert.ok(forcedRequests.every((request) => JSON.parse(request.body).model === DEV_GEMINI_MODEL));
    assert.doesNotMatch(JSON.stringify(forcedRequests), new RegExp(`${personalAnthropicKey}|${personalOpenAiKey}`));
    const bypassAudit = (await forced.auditLog.events()).find(
      (event) => event.action === "individual-model-auth.bypassed",
    );
    assert.equal(bypassAudit?.status, "forced-runtime");
    assert.deepEqual(JSON.parse(bypassAudit?.detail ?? "null"), {
      harnessId: "pi",
      modelId: DEV_GEMINI_MODEL,
    });
    assert.doesNotMatch(
      JSON.stringify(bypassAudit),
      new RegExp(`${transientKey}|${personalAnthropicKey}|${personalOpenAiKey}`),
    );

    setCustomProviders([]);
    const ordinary = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "individual-auth-ordinary-")) }));
    await ordinary.userModelCredentials.setApiKey(actorId, "anthropic", personalAnthropicKey);
    ordinary.config.setIndividualModelAuth(true);
    await ordinary.config.flushScope("org:default-org");
    const ordinaryResult = await ordinary.app.turn({
      surface: "test",
      actor: { externalId: actorId },
      conversation: { kind: "dm", threadRef: "dm:individual-auth-ordinary" },
      text: "use my connected account",
      liveActor: true,
      skipMemory: true,
    });
    assert.equal(ordinaryResult.status, "ok", ordinaryResult.reason);
    assert.equal(ordinaryResult.reply, "INDIVIDUAL ANTHROPIC REPLY");
    assert.ok(seen.length > 0);
    assert.ok(seen.every((request) => request.url.startsWith("https://api.anthropic.com/")));
    assert.ok(seen.every((request) => request.apiKey === personalAnthropicKey));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
