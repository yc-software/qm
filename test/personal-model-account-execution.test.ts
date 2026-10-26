import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { hashId } from "../src/util/crypto.ts";
import { mock, test } from "node:test";
import * as piHarness from "../src/harness/pi-harness.ts";
import * as mockHarness from "./support/mock-harness.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import { resolveModel } from "../src/model/pi-models.ts";
import { testConfig } from "./support/test-config.ts";

const turns: HarnessTurnInput[] = [];
let piOptions: Parameters<typeof piHarness.createPiHarness>[0];
function observedPiHarness(opts: Parameters<typeof piHarness.createPiHarness>[0]) {
  piOptions = opts;
  return observedHarness();
}
function observedHarness() {
  const harness = mockHarness.createMockHarness();
  const runTurn = harness.turns.runTurn;
  harness.turns.runTurn = async (turn) => {
    turns.push(turn);
    return runTurn(turn);
  };
  return harness;
}

mock.module("../src/harness/pi-harness.ts", {
  namedExports: { ...piHarness, createPiHarness: observedPiHarness },
});
const { buildApp } = await import("../src/wiring.ts");

for (const provider of ["anthropic", "openai"] as const) {
  test(`queued personal ${provider} turns use only that provider's credentials after switching to company`, async () => {
    turns.length = 0;
    const built = buildApp(testConfig({ anthropicApiKey: "company-anthropic", openaiApiKey: "company-openai" }));
    await built.userModelCredentials.setApiKey("U1", "anthropic", "personal-anthropic");
    await built.userModelCredentials.setApiKey("U1", "openai", "personal-openai");
    await built.config.setPersonalModelAuth("U1", true, provider);
    const submitted = await built.app.turn({
      surface: "slack",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: `execute-personal-${provider}` },
      text: "hello",
      liveActor: true,
      async: true,
    });
    await built.config.setPersonalModelAuth("U1", false);
    built.runtime.start();
    try {
      const finished = await built.runs.waitFor(submitted.runId!, 5_000);
      assert.equal(finished.status, "done", JSON.stringify(finished.result));
      assert.equal(turns.length, 1);
      assert.deepEqual(turns[0]!.providerKeys, { [provider]: `personal-${provider}` });
      assert.equal(resolveModel(turns[0]!.runtime!.modelId!)?.provider, provider);
    } finally {
      await built.runtime.stop();
    }
  });
}

test("disconnecting a queued personal account fails without invoking any main harness or another connected provider", async () => {
  turns.length = 0;
  const built = buildApp(testConfig({ anthropicApiKey: "company-anthropic", openaiApiKey: "company-openai" }));
  await built.userModelCredentials.setApiKey("U1", "anthropic", "personal-anthropic");
  await built.userModelCredentials.setApiKey("U1", "openai", "personal-openai");
  await built.config.setPersonalModelAuth("U1", true, "openai");
  const submitted = await built.app.turn({
    surface: "slack",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "execute-disconnected-personal" },
    text: "hello",
    liveActor: true,
    async: true,
  });
  await built.userModelCredentials.delete("U1", "openai");
  await built.config.setPersonalModelAuth("U1", false);
  built.runtime.start();
  try {
    const finished = await built.runs.waitFor(submitted.runId!, 5_000);
    assert.equal(finished.status, "failed");
    assert.match(JSON.stringify(finished), /personal AI account is unavailable/);
    assert.equal(turns.length, 0);
  } finally {
    await built.runtime.stop();
  }
});

for (const account of ["personal", "openai", "anthropic"] as const) {
  test(`web ${account} account honors the chosen model, effort and fast mode`, async () => {
    turns.length = 0;
    const provider = account === "anthropic" ? "anthropic" : "openai";
    const model = provider === "anthropic" ? "claude-sonnet-5" : "gpt-5.6-terra";
    const built = buildApp(testConfig({ openaiApiKey: "company-openai" }));
    await built.userModelCredentials.setApiKey("U1", provider, `personal-${provider}`);
    await built.config.setPersonalModelAuth("U1", true, account === "personal" ? undefined : account);
    const submitted = await built.app.turn({
      surface: "web",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: `web:U1:picker-${account}` },
      text: "hello",
      liveActor: true,
      async: true,
      model,
      thinkingLevel: "high",
      fastMode: true,
    });
    assert.ok(submitted.runId, JSON.stringify(submitted));
    const queued = await built.runs.get(submitted.runId!);
    assert.equal(queued?.request.model, model);
    built.runtime.start();
    try {
      const finished = await built.runs.waitFor(submitted.runId!, 5_000);
      assert.equal(finished.status, "done", JSON.stringify(finished.result));
      assert.equal(turns.length, 1);
      assert.deepEqual(turns[0]!.providerKeys, { [provider]: `personal-${provider}` });
      assert.deepEqual(turns[0]!.runtime, {
        modelId: model,
        effortLevel: "high",
        fastMode: true,
      });
    } finally {
      await built.runtime.stop();
    }
  });
}

test("personal web selections reject wrong providers, policy exclusions and disconnected keys", async () => {
  const built = buildApp(testConfig({ openaiApiKey: "company-openai", anthropicApiKey: "company-anthropic" }));
  await built.userModelCredentials.setApiKey("U1", "openai", "personal-openai");
  await built.config.setPersonalModelAuth("U1", true, "openai");
  const submit = (model: string) =>
    built.app.turn({
      surface: "web",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: `web:U1:invalid-${crypto.randomUUID()}` },
      text: "hello",
      liveActor: true,
      async: true,
      model,
    });
  for (const model of ["claude-sonnet-5", "unknown"]) assert.equal((await submit(model)).status, "refused");
  await built.config.setWebuiModels("org:default-org", ["gpt-5.6-sol"]);
  assert.equal((await submit("gpt-5.6-terra")).status, "refused");
  await built.userModelCredentials.delete("U1", "openai");
  assert.equal((await submit("gpt-5.6-sol")).status, "refused");
});

test("a queued web selection cannot fall back to another personal provider after disconnect", async () => {
  turns.length = 0;
  const built = buildApp(testConfig());
  await built.userModelCredentials.setApiKey("U1", "anthropic", "personal-anthropic");
  await built.userModelCredentials.setApiKey("U1", "openai", "personal-openai");
  await built.config.setPersonalModelAuth("U1", true);
  const submitted = await built.app.turn({
    surface: "web",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "web:U1:disconnect-after-pick" },
    text: "hello",
    liveActor: true,
    async: true,
    model: "gpt-5.6-terra",
  });
  assert.ok(submitted.runId, JSON.stringify(submitted));
  await built.userModelCredentials.delete("U1", "openai");
  built.runtime.start();
  try {
    const finished = await built.runs.waitFor(submitted.runId!, 5_000);
    assert.equal(finished.status, "failed");
    assert.match(JSON.stringify(finished), /cannot serve this model/);
    assert.equal(turns.length, 0);
  } finally {
    await built.runtime.stop();
  }
});

test("web subscription selections use the namespaced model and personal OAuth on Pi", async () => {
  turns.length = 0;
  const built = buildApp(testConfig());
  await built.userModelCredentials.setOAuth("U1", "openai", {
    accessToken: "personal-oauth",
    expiresAt: Date.now() + 3_600_000,
  });
  await built.config.setPersonalModelAuth("U1", true, "openai");
  const submitted = await built.app.turn({
    surface: "web",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "web:U1:oauth-picker" },
    text: "hello",
    liveActor: true,
    async: true,
    model: "codex/gpt-5.6-terra",
    thinkingLevel: "high",
    fastMode: false,
  });
  assert.ok(submitted.runId, JSON.stringify(submitted));
  built.runtime.start();
  try {
    const finished = await built.runs.waitFor(submitted.runId!, 5_000);
    assert.equal(finished.status, "done", JSON.stringify(finished.result));
    assert.equal(turns.length, 1);
    assert.deepEqual(turns[0]!.providerKeys, { "openai-codex": "personal-oauth" });
    assert.deepEqual(turns[0]!.runtime, {
      modelId: "codex/gpt-5.6-terra",
      effortLevel: "high",
      fastMode: false,
    });
  } finally {
    await built.runtime.stop();
  }
});

test("a personal Claude subscription login runs on Pi with its OAuth token as the Anthropic key", async () => {
  turns.length = 0;
  const built = buildApp(testConfig({ anthropicApiKey: "company-anthropic" }));
  await built.userModelCredentials.setOAuth("U1", "anthropic", {
    accessToken: "sk-ant-oat01-personal",
    expiresAt: Date.now() + 3_600_000,
  });
  await built.config.setPersonalModelAuth("U1", true, "anthropic");
  const submitted = await built.app.turn({
    surface: "slack",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "personal-claude-oauth" },
    text: "hello",
    liveActor: true,
    async: true,
  });
  assert.ok(submitted.runId, JSON.stringify(submitted));
  built.runtime.start();
  try {
    const finished = await built.runs.waitFor(submitted.runId!, 5_000);
    assert.equal(finished.status, "done", JSON.stringify(finished.result));
    assert.equal(turns.length, 1);
    assert.deepEqual(turns[0]!.providerKeys, { anthropic: "sk-ant-oat01-personal" });
    assert.equal(resolveModel(turns[0]!.runtime!.modelId!)?.provider, "anthropic");
  } finally {
    await built.runtime.stop();
  }
});

test("a company ChatGPT login feeds pi's subscription provider while personal ChatGPT OAuth turns use their own token", async () => {
  const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } }));
  const companyToken = `e30.${claims.toString("base64url")}.sig`;
  turns.length = 0;
  const credentialId = hashId(["company-admin", "codex", "file"]);
  const built = buildApp(testConfig({ codexAuthCredential: credentialId }));
  const saved = await built.keychain!.save({
    ownerId: "company-admin",
    service: "codex",
    files: [
      {
        path: ".codex/auth.json",
        contentBase64: Buffer.from(
          JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: companyToken, refresh_token: "r" } }),
        ).toString("base64"),
      },
    ],
  });
  assert.equal(saved.id, credentialId);
  assert.deepEqual(await piOptions?.resolveProviderKeys?.(), { "openai-codex": companyToken });
  assert.equal(piOptions?.companyModelId?.("gpt-5.6-sol"), "codex/gpt-5.6-sol");
  assert.equal(piOptions?.companyModelId?.("gpt-6-astra-ultrafast"), "gpt-6-astra-ultrafast");
  assert.equal(piOptions?.companyModelId?.("claude-opus-5"), "claude-opus-5");
  await built.userModelCredentials.setOAuth("U1", "openai", {
    accessToken: "personal-oauth",
    expiresAt: Date.now() + 3_600_000,
  });
  await built.config.setPersonalModelAuth("U1", true, "openai");
  const submitted = await built.app.turn({
    surface: "slack",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "legacy-bare-pin" },
    text: "hello",
    liveActor: true,
    async: true,
  });
  assert.ok(submitted.runId, JSON.stringify(submitted));
  built.runtime.start();
  try {
    const finished = await built.runs.waitFor(submitted.runId!, 5_000);
    assert.equal(finished.status, "done", JSON.stringify(finished.result));
    assert.deepEqual(turns[0]!.providerKeys, { "openai-codex": "personal-oauth" });
    assert.equal(turns[0]!.runtime!.modelId, "codex/gpt-5.6-sol");
  } finally {
    await built.runtime.stop();
  }
});

test("a configured company subscription without a keychain cannot fall back to the metered key", async (t) => {
  buildApp(
    testConfig({
      connectorSecretKey: undefined,
      codexAuthCredential: "unavailable",
      openaiApiKey: "metered",
      modelId: "gpt-5.6-sol",
    }),
  );
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response("unexpected provider request", { status: 400 });
  });
  const harness = piHarness.createPiHarness({ ...piOptions, captureRequests: false });
  try {
    assert.equal(await harness.models.oneShot?.("system", "hello"), undefined);
    assert.deepEqual(urls, []);
  } finally {
    await harness.turns.close?.();
  }
});
