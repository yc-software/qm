import assert from "node:assert/strict";
import { test } from "node:test";
import { createRuntimeService } from "../src/harness/runtime-control.ts";
import { recoveredRuntime } from "../src/harness/runtime-recovery.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import type { CapabilityClaims } from "../src/auth/capability-token.ts";
import type { RuntimeChoice } from "../src/harness/harness.ts";
import type { SessionEntry } from "../src/types.ts";

const active: RuntimeChoice = { harnessId: "pi", modelId: "claude-opus-5", effortLevel: "high", fastMode: false };
const claims: CapabilityClaims = {
  actorId: "alice",
  scopeId: "personal:alice",
  liveActor: true,
  exp: Date.now() + 60000,
};
async function setup(allowed = true) {
  const config = createMemoryConfigStore("default-org");
  config.setApprovedHarnesses(["pi", "claude", "codex", "opencode"]);
  await config.flushScope("org:default-org");
  await config.setRuntimeSelectionLatest("org:default-org", active);
  const service = createRuntimeService(
    { config, harnessId: "pi", baseModelDefault: active.modelId },
    {
      authorizesCapabilityScope: async () => allowed,
    },
  );
  return { config, service };
}

test("runtime exposes actual dispatch separately from saved defaults and resolves Astra without losing settings", async () => {
  const { config, service } = await setup();
  const running = { ...active, modelId: "claude-sonnet-5" };
  const state = await service(claims, running, { action: "get" });
  assert.equal(state.ok, true);
  assert.deepEqual(state.active, running);
  assert.equal((state.effective as RuntimeChoice).modelId, active.modelId);
  const result = await service(claims, running, { action: "set", model: "Astra" });
  assert.deepEqual(result, { ok: true, handoff: { lifetime: "task", choice: { ...running, modelId: "gpt-6-astra" } } });
  assert.equal(await config.getRuntimeSelectionDurable(claims.scopeId), null);
});

test("scope defaults persist and inherit clears them", async () => {
  const { config, service } = await setup();
  const result = await service(claims, active, { action: "set", model: "Astra", lifetime: "scope" });
  assert.equal(result.ok, true);
  assert.equal((await config.getRuntimeSelectionDurable(claims.scopeId))?.modelId, "gpt-6-astra");
  const inherited = await service(claims, active, { action: "inherit", lifetime: "scope" });
  assert.equal(inherited.ok, true);
  assert.equal(await config.getRuntimeSelectionDurable(claims.scopeId), null);
});

test("runtime changes reject revoked access, bots, triggers and foreign personal scopes", async () => {
  const denied = await setup(false);
  assert.deepEqual(await denied.service(claims, active, { action: "get" }), { ok: false, error: "forbidden" });
  const { service } = await setup();
  for (const extra of [{ botActor: true }, { triggered: true }, { liveActor: false }]) {
    assert.deepEqual(await service({ ...claims, ...extra }, active, { action: "set", model: "Astra" }), {
      ok: false,
      error: "live_actor_required",
    });
  }
  assert.deepEqual(await service({ ...claims, scopeId: "personal:bob" }, active, { action: "set", model: "Astra" }), {
    ok: false,
    error: "forbidden",
  });
});

test("runtime rejects unsupported effort and fast mode instead of silently dropping them", async () => {
  const { service } = await setup();
  assert.deepEqual(await service(claims, active, { action: "set", harness: "opencode" }), {
    ok: false,
    error: "effort_not_supported",
  });
  assert.deepEqual(await service(claims, active, { action: "set", model: "claude-sonnet-5", fastMode: true }), {
    ok: false,
    error: "fast_mode_not_supported",
  });
});

test("account preflight failure cannot change a scope default", async () => {
  const { service, config } = await setup();
  const result = await service(
    claims,
    active,
    { action: "set", model: "Astra", lifetime: "scope" },
    async () => "account does not support this runtime",
  );
  assert.equal(result.ok, false);
  assert.equal(await config.getRuntimeSelectionDurable(claims.scopeId), null);
});

test("runtime recovery uses only durable decisions belonging to the same run and actor", () => {
  const entry = (runId: string, actorId: string, modelId: string): SessionEntry => ({
    sessionId: "s",
    seq: 1,
    parentSeq: null,
    type: "tool_result",
    scopeLabel: claims.scopeId,
    createdAt: 1,
    payload: { tool: "runtime", runId, actorId, runtimeHandoff: { choice: { ...active, modelId }, lifetime: "task" } },
  });
  const entries = [
    entry("run", "alice", "gpt-6-astra"),
    entry("other", "alice", "claude-sonnet-5"),
    entry("run", "bob", "claude-opus-5"),
  ];
  assert.equal(recoveredRuntime(entries, "run", "alice")?.modelId, "gpt-6-astra");
  assert.equal(recoveredRuntime(entries, "new", "alice"), undefined);
});

test("individual-account availability does not depend on organization provider keys", async () => {
  const { config } = await setup();
  const service = createRuntimeService(
    { config, harnessId: "pi", providerKeys: { anthropic: false, openai: false, openrouter: false } },
    { authorizesCapabilityScope: async () => true },
  );
  const ownRuntime = { ...active, modelId: "gpt-6-astra" };
  const result = await service(
    claims,
    ownRuntime,
    { action: "set", effort: "xhigh" },
    async (choice) => (choice.harnessId === "pi" && choice.modelId === "gpt-6-astra" ? null : "no account"),
    true,
  );
  assert.deepEqual(result, {
    ok: true,
    handoff: { lifetime: "task", choice: { ...ownRuntime, effortLevel: "xhigh" } },
  });
});

test("a saved override removed from the model picker cannot be newly selected", async () => {
  const { config, service } = await setup();
  await config.setRuntimeSelectionLatest(claims.scopeId, { ...active, modelId: "gpt-6-astra" });
  config.setWebuiModels("org:default-org", ["claude-sonnet-5"]);
  await config.flushScope("org:default-org");
  assert.deepEqual(await service(claims, active, { action: "set", model: "Astra" }), {
    ok: false,
    error: "model_not_enabled",
  });
});

test("cancellation during validation prevents a scope write", async () => {
  const { config, service } = await setup();
  const controller = new AbortController();
  const result = await service(
    claims,
    active,
    { action: "set", model: "Astra", lifetime: "scope" },
    async () => {
      controller.abort();
      return null;
    },
    false,
    controller.signal,
  );
  assert.deepEqual(result, { ok: false, error: "cancelled" });
  assert.equal(await config.getRuntimeSelectionDurable(claims.scopeId), null);
});
