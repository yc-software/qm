import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import * as piHarness from "../src/harness/pi-harness.ts";
import * as mockHarness from "../src/harness/mock-harness.ts";
import type { HarnessTurnInput, HarnessTurnResult } from "../src/harness/harness.ts";
import { resolveModel } from "../src/model/pi-models.ts";
import { testConfig } from "./support/test-config.ts";

const turns: HarnessTurnInput[] = [];
let onTurn: ((turn: HarnessTurnInput) => Promise<HarnessTurnResult | void>) | undefined;
function observedHarness() {
  const harness = mockHarness.createMockHarness();
  const runTurn = harness.turns.runTurn;
  harness.turns.runTurn = async (turn) => {
    turns.push(turn);
    const result = await onTurn?.(turn);
    return result ?? runTurn(turn);
  };
  return harness;
}

mock.module("../src/harness/pi-harness.ts", {
  namedExports: { ...piHarness, createPiHarness: observedHarness },
});
mock.module("../src/harness/mock-harness.ts", {
  namedExports: { ...mockHarness, createMockHarness: observedHarness },
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
      assert.equal(turns[0]!.runtime!.harnessId, "pi");
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
    built.config.setApprovedHarnesses(["pi"]);
    await built.config.flushScope("org:default-org");
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
      harness: "pi",
      thinkingLevel: "high",
      fastMode: true,
    });
    assert.ok(submitted.runId, JSON.stringify(submitted));
    const queued = await built.runs.get(submitted.runId!);
    assert.equal(queued?.request.model, model);
    assert.equal(queued?.request.harness, "pi");
    built.runtime.start();
    try {
      const finished = await built.runs.waitFor(submitted.runId!, 5_000);
      assert.equal(finished.status, "done", JSON.stringify(finished.result));
      assert.equal(turns.length, 1);
      assert.deepEqual(turns[0]!.providerKeys, { [provider]: `personal-${provider}` });
      assert.deepEqual(turns[0]!.runtime, {
        harnessId: "pi",
        modelId: model,
        effortLevel: "high",
        fastMode: true,
      });
    } finally {
      await built.runtime.stop();
    }
  });
}

test("personal web selections reject wrong providers, harnesses, policy exclusions and disconnected keys", async () => {
  const built = buildApp(testConfig({ openaiApiKey: "company-openai", anthropicApiKey: "company-anthropic" }));
  built.config.setApprovedHarnesses(["pi", "claude"]);
  await built.config.flushScope("org:default-org");
  await built.userModelCredentials.setApiKey("U1", "openai", "personal-openai");
  await built.config.setPersonalModelAuth("U1", true, "openai");
  const submit = (model: string, harness = "pi") =>
    built.app.turn({
      surface: "web",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: `web:U1:invalid-${crypto.randomUUID()}` },
      text: "hello",
      liveActor: true,
      async: true,
      model,
      harness,
    });
  for (const [model, harness] of [
    ["claude-sonnet-5", "pi"],
    ["gpt-5.6-terra", "claude"],
    ["unknown", "pi"],
  ])
    assert.equal((await submit(model!, harness!)).status, "refused");
  built.config.setWebuiModels("org:default-org", ["gpt-5.6-sol"]);
  await built.config.flushScope("org:default-org");
  assert.equal((await submit("gpt-5.6-terra")).status, "refused");
  await built.userModelCredentials.delete("U1", "openai");
  assert.equal((await submit("gpt-5.6-sol")).status, "refused");
});

test("a queued web selection cannot fall back to another personal provider after disconnect", async () => {
  turns.length = 0;
  const built = buildApp(testConfig());
  built.config.setApprovedHarnesses(["pi"]);
  await built.config.flushScope("org:default-org");
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
    harness: "pi",
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
  built.config.setApprovedHarnesses(["pi"]);
  await built.config.flushScope("org:default-org");
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
    harness: "pi",
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
      harnessId: "pi",
      modelId: "codex/gpt-5.6-terra",
      effortLevel: "high",
      fastMode: false,
    });
  } finally {
    await built.runtime.stop();
  }
});

test("partial personal web choices queue the complete validated scoped runtime", async () => {
  const built = buildApp(testConfig());
  built.config.setApprovedHarnesses(["pi", "codex"]);
  await built.config.setRuntimeSelectionLatest("org:default-org", { harnessId: "pi", modelId: "gpt-5.6-sol" });
  await built.config.setRuntimeSelectionLatest("personal:U1", { harnessId: "pi", modelId: "gpt-5.6-terra" });
  await built.userModelCredentials.setApiKey("U1", "openai", "personal-openai");
  await built.config.setPersonalModelAuth("U1", true, "openai");
  const submit = (choice: { harness?: string; model?: string }) =>
    built.app.turn({
      surface: "web",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: `web:U1:partial-${crypto.randomUUID()}` },
      text: "hello",
      liveActor: true,
      async: true,
      ...choice,
    });
  const first = await submit({ harness: "pi" });
  assert.ok(first.runId, JSON.stringify(first));
  const queued = await built.runs.get(first.runId!);
  assert.equal(queued?.request.harness, "pi");
  assert.equal(queued?.request.model, "gpt-5.6-terra");
  await built.userModelCredentials.delete("U1", "openai");
  await built.userModelCredentials.setOAuth("U1", "openai", {
    accessToken: "personal-oauth",
    expiresAt: Date.now() + 3_600_000,
  });
  await built.config.setRuntimeSelectionLatest("personal:U1", { harnessId: "codex", modelId: "gpt-5.6-sol" });
  const second = await submit({ model: "gpt-5.6-terra" });
  assert.ok(second.runId, JSON.stringify(second));
  const oauth = await built.runs.get(second.runId!);
  assert.equal(oauth?.request.harness, "codex");
  assert.equal(oauth?.request.model, "gpt-5.6-terra");
});

for (const model of [undefined, "inherit", { modelId: "gpt-5.6-luna", effortLevel: "low", fastMode: false }] as const) {
  test(`subagent ${JSON.stringify(model)} persists effective runtime and personal billing`, async () => {
    turns.length = 0;
    const built = buildApp(testConfig({ openaiApiKey: "company-openai" }));
    built.config.setApprovedHarnesses(["pi"]);
    await built.config.flushScope("org:default-org");
    await built.userModelCredentials.setApiKey("U1", "openai", "personal-openai");
    await built.config.setPersonalModelAuth("U1", true, "openai");
    await built.featureFlags.setEnabled("persistent_subagents", "personal:U1", true, "test");
    let childId: string | undefined;
    onTurn = async (turn) => {
      if (turn.session.threadRef.startsWith("agent:main:subagent:") || childId) return;
      const result = await turn.tools.sessionSyscalls!.open({ task: "inspect one thing", ...(model ? { model } : {}) });
      assert.ok(result.ok, JSON.stringify(result));
      childId = result.sessionId;
    };
    try {
      const submitted = await built.app.turn({
        surface: "web",
        actor: { externalId: "U1" },
        conversation: { kind: "dm", threadRef: `web:U1:delegate-${crypto.randomUUID()}` },
        text: "delegate",
        liveActor: true,
        async: true,
        model: "gpt-5.6-terra",
        harness: "pi",
        thinkingLevel: "high",
        fastMode: true,
      });
      built.runtime.start();
      const parentRun = await built.runs.waitFor(submitted.runId!, 5_000);
      assert.equal(parentRun.status, "done", JSON.stringify(parentRun.result));
      assert.ok(childId);
      const child = (await built.sessions.get(childId))!;
      const childRun = (await built.runs.latestForThread(child.threadRef))!;
      const finished = await built.runs.waitFor(childRun.id, 5_000);
      assert.equal(finished.status, "done", JSON.stringify(finished.result));
      const childTurn = turns.find((turn) => turn.session.id === childId)!;
      assert.ok(childTurn);
      assert.deepEqual(
        childTurn.runtime,
        typeof model === "object"
          ? { harnessId: "pi", ...model }
          : { harnessId: "pi", modelId: "gpt-5.6-terra", effortLevel: "high", fastMode: true },
      );
      assert.deepEqual(childTurn.providerKeys, { openai: "personal-openai" });
      assert.equal(childRun.request.modelAccount, "openai");
      assert.equal(child.spawnMeta?.modelAccount, "openai");
      assert.equal(childRun.request.origin.kind, "automation");
      assert.equal(JSON.stringify(child.spawnMeta).includes("personal-openai"), false);
    } finally {
      onTurn = undefined;
      await built.runtime.stop();
    }
  });
}

test("subagent unavailable choices fail closed and a revoked inherited account never bills the company", async () => {
  turns.length = 0;
  const built = buildApp(testConfig({ openaiApiKey: "company-openai", anthropicApiKey: "company-anthropic" }));
  built.config.setApprovedHarnesses(["pi"]);
  await built.config.flushScope("org:default-org");
  await built.userModelCredentials.setApiKey("U1", "openai", "personal-openai");
  await built.config.setPersonalModelAuth("U1", true, "openai");
  await built.featureFlags.setEnabled("persistent_subagents", "personal:U1", true, "test");
  let childId: string | undefined;
  onTurn = async (turn) => {
    if (turn.session.threadRef.startsWith("agent:main:subagent:") || childId) return;
    for (const model of [
      "missing-model",
      { modelId: "claude-sonnet-5", fastMode: false },
      { modelId: "gpt-5.6-terra", effortLevel: "invalid" },
    ]) {
      const rejected = await turn.tools.sessionSyscalls!.open({ task: "must not run", model });
      assert.equal(rejected.ok, false, JSON.stringify(rejected));
    }
    assert.equal((await built.sessions.childrenOf(turn.session.id)).length, 0);
    const result = await turn.tools.sessionSyscalls!.open({ task: "revoked before execution" });
    assert.ok(result.ok, JSON.stringify(result));
    childId = result.sessionId;
    await built.userModelCredentials.delete("U1", "openai");
  };
  try {
    const submitted = await built.app.turn({
      surface: "web",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "web:U1:revoke-child" },
      text: "delegate",
      liveActor: true,
      async: true,
      model: "gpt-5.6-terra",
      harness: "pi",
    });
    built.runtime.start();
    await built.runs.waitFor(submitted.runId!, 5_000);
    assert.ok(childId);
    const child = (await built.sessions.get(childId))!;
    const childRun = (await built.runs.latestForThread(child.threadRef))!;
    const finished = await built.runs.waitFor(childRun.id, 5_000);
    assert.equal(finished.status, "failed");
    assert.match(JSON.stringify(finished.result), /personal AI account is unavailable/);
    assert.equal(
      turns.some((turn) => turn.session.id === childId),
      false,
    );
  } finally {
    onTurn = undefined;
    await built.runtime.stop();
  }
});

test("Slack personal parent completion executes its selected nondefault runtime, not the child's", async () => {
  turns.length = 0;
  const built = buildApp(testConfig({ openaiApiKey: "company-openai" }));
  built.config.setApprovedHarnesses(["pi"]);
  await built.config.flushScope("org:default-org");
  await built.userModelCredentials.setApiKey("U1", "openai", "personal-openai");
  await built.config.setPersonalModelAuth("U1", true, "openai");
  await built.featureFlags.setEnabled("responsive_spine", "personal:U1", true, "test");
  let selected = false;
  let spawned = false;
  let wake: HarnessTurnInput | undefined;
  onTurn = async (turn) => {
    if (turn.session.threadRef.startsWith("agent:main:subagent:")) return { reply: "child complete" };
    if (!selected) {
      selected = true;
      const switched = await turn.tools.runtime!({
        action: "set",
        model: "gpt-5.6-terra",
        effort: "high",
        fastMode: true,
      });
      assert.ok(switched.ok && switched.handoff, JSON.stringify(switched));
      await turn.emit({
        type: "tool_result",
        scopeLabel: turn.scopeLabel,
        payload: { tool: "runtime", runId: turn.runId, actorId: "U1", runtimeHandoff: switched.handoff },
      });
      return { reply: "", runtimeHandoff: switched.handoff };
    }
    if (!spawned) {
      spawned = true;
      const child = await turn.tools.sessionSyscalls!.open({
        task: "inspect",
        model: { modelId: "gpt-5.6-luna", effortLevel: "low", fastMode: false },
      });
      assert.ok(child.ok, JSON.stringify(child));
      return { reply: "" };
    }
    wake = turn;
    return { reply: "reported" };
  };
  try {
    const submitted = await built.app.turn({
      surface: "slack",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "slack:dm:parent-personal-wake" },
      text: "delegate",
      liveActor: true,
      async: true,
    });
    built.runtime.start();
    assert.equal((await built.runs.waitFor(submitted.runId!, 5000)).status, "done");
    const deadline = Date.now() + 5000;
    while (!wake && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(wake, JSON.stringify(turns.map((turn) => ({ run: turn.runId, model: turn.runtime }))));
    assert.deepEqual(wake.runtime, { harnessId: "pi", modelId: "gpt-5.6-terra", effortLevel: "high", fastMode: true });
    assert.deepEqual(wake.providerKeys, { openai: "personal-openai" });
  } finally {
    onTurn = undefined;
    await built.runtime.stop();
  }
});

test("inherited omitted effort and fast defaults cannot be replaced by later scope settings", async () => {
  turns.length = 0;
  const built = buildApp(testConfig({ harness: "pi", openaiApiKey: "company-openai" }));
  built.config.setApprovedHarnesses(["pi"]);
  await built.config.setRuntimeSelectionLatest("org:default-org", { harnessId: "pi", modelId: "gpt-5.6-terra" });
  await built.config.flushScope("org:default-org");
  await built.featureFlags.setEnabled("persistent_subagents", "personal:U1", true, "test");
  let childId: string | undefined;
  let parentRuntime: HarnessTurnInput["runtime"];
  onTurn = async (turn) => {
    if (childId || turn.session.threadRef.startsWith("agent:main:subagent:")) return;
    parentRuntime = turn.runtime;
    assert.notEqual(parentRuntime?.effortLevel, undefined);
    assert.equal(parentRuntime?.fastMode, false);
    const child = await turn.tools.sessionSyscalls!.open({ task: "preserve defaults" });
    assert.ok(child.ok, JSON.stringify(child));
    childId = child.sessionId;
    await built.config.setRuntimeSelectionLatest("personal:U1", {
      harnessId: "pi",
      modelId: "gpt-5.6-terra",
      effortLevel: "low",
      fastMode: true,
    });
  };
  try {
    const submitted = await built.app.turn({
      surface: "web",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "web:U1:default-drift" },
      text: "delegate",
      liveActor: true,
      async: true,
    });
    built.runtime.start();
    assert.equal((await built.runs.waitFor(submitted.runId!, 5000)).status, "done");
    assert.ok(childId);
    const child = (await built.sessions.get(childId))!;
    const run = (await built.runs.latestForThread(child.threadRef))!;
    assert.equal((await built.runs.waitFor(run.id, 5000)).status, "done");
    assert.deepEqual(turns.find((turn) => turn.session.id === childId)?.runtime, parentRuntime);
  } finally {
    onTurn = undefined;
    await built.runtime.stop();
  }
});
