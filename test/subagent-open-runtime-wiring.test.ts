import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { stopAtEnd } from "./support/build-app.ts";
import { scopeId, type Principal } from "../src/types.ts";
import type { RuntimeChoice } from "../src/agent/agent.ts";
import type { SessionSyscallBinding } from "../src/sessions/session-syscalls.ts";
import { openRuntime } from "../src/sessions/subagent-runtime.ts";

const actor: Principal = { id: "U1", type: "internal" };
const scope = scopeId("personal", "U1");

async function opener(
  parent: Partial<SessionSyscallBinding["request"]> = {},
  switched?: RuntimeChoice,
  scopeDefault?: string,
  defaultScope = scope,
) {
  const built = stopAtEnd(buildApp(testConfig({ openaiApiKey: "sk-test" })));
  if (scopeDefault) await built.config.setRuntimeSelection(defaultScope, { modelId: scopeDefault });
  const room = await built.sessions.getOrCreateByThread("web:room", "dm", scope, undefined, "web");
  await built.sessions.addParticipant(room.id, actor.id);
  const syscalls = built.sessionSyscalls.forTurn({
    session: room,
    scopeId: scope,
    request: {
      surface: "web",
      conversation: { kind: "dm", threadRef: "web:room", audience: [actor] },
      actor,
      ...parent,
    },
    switchedRuntime: () => switched,
  });
  return {
    open: syscalls.open,
    async spawned(sessionId: string) {
      const meta = (await built.sessions.get(sessionId))?.spawnMeta;
      return { model: meta?.model, thinkingLevel: meta?.thinkingLevel, fastMode: meta?.fastMode };
    },
  };
}

test("subagent open refuses a known model this deployment does not serve", async () => {
  const out = await (await opener()).open({ task: "draft one article", model: "claude-opus-4-1" });
  assert.ok(!out.ok);
  assert.match(out.message, /^claude-opus-4-1 can't run here/);
  assert.match(out.message, /one of: .*gpt-6\.1-sol/);
  assert.doesNotMatch(out.message.split("one of:")[1]!, /claude-/);
});

test("subagent open refuses an unknown model ID with the same usable list", async () => {
  const out = await (await opener()).open({ task: "draft one article", model: "claude-opus-5.5" });
  assert.ok(!out.ok);
  assert.match(out.message, /^claude-opus-5\.5 can't run here \(.*unknown model ID\)/);
  assert.match(out.message, /one of: .*gpt-6\.1-sol/);
});

test("subagent open accepts a model this deployment serves", async () => {
  const out = await (await opener()).open({ task: "draft one article", model: "gpt-6.1-sol" });
  assert.ok(out.ok, out.ok ? "" : out.message);
});

test("subagent open without overrides inherits the default", async () => {
  const out = await (await opener()).open({ task: "draft one article" });
  assert.ok(out.ok, out.ok ? "" : out.message);
});

test("a child opened without a model runs on the parent's task-switched runtime", async () => {
  const parent = await opener({}, { modelId: "gpt-6.1-sol", effortLevel: "high", fastMode: false });
  const out = await parent.open({ task: "draft one article" });
  assert.ok(out.ok, out.ok ? "" : out.message);
  assert.deepEqual(await parent.spawned(out.sessionId), {
    model: "gpt-6.1-sol",
    thinkingLevel: "high",
    fastMode: false,
  });
});

test("a child opened without a model runs on the parent's explicitly requested model", async () => {
  const parent = await opener({ model: "gpt-6.1-sol", thinkingLevel: "medium" });
  const out = await parent.open({ task: "draft one article", fastMode: true });
  assert.ok(out.ok, out.ok ? "" : out.message);
  assert.deepEqual(await parent.spawned(out.sessionId), {
    model: "gpt-6.1-sol",
    thinkingLevel: "medium",
    fastMode: true,
  });
});

test("an explicit open model wins over the parent's runtime and drops its effort", async () => {
  const parent = await opener({}, { modelId: "claude-opus-4-1", effortLevel: "high", fastMode: true });
  const out = await parent.open({ task: "draft one article", model: "gpt-6.1-sol" });
  assert.ok(out.ok, out.ok ? "" : out.message);
  assert.deepEqual(await parent.spawned(out.sessionId), {
    model: "gpt-6.1-sol",
    thinkingLevel: undefined,
    fastMode: undefined,
  });
});

test("a child of a parent on the default keeps the configured subagent default", async () => {
  const parent = await opener({ thinkingLevel: "low", fastMode: true });
  const out = await parent.open({ task: "draft one article" });
  assert.ok(out.ok, out.ok ? "" : out.message);
  assert.deepEqual(await parent.spawned(out.sessionId), {
    model: undefined,
    thinkingLevel: undefined,
    fastMode: undefined,
  });
});

test("a parent runtime the subagent purpose cannot serve falls back to the subagent default", async () => {
  const parent = await opener({}, { modelId: "claude-opus-4-1", effortLevel: "high" });
  const out = await parent.open({ task: "draft one article" });
  assert.ok(out.ok, out.ok ? "" : out.message);
  assert.deepEqual(await parent.spawned(out.sessionId), {
    model: undefined,
    thinkingLevel: undefined,
    fastMode: undefined,
  });
});

test("a parent that only tunes effort on the default model leaves the child on the subagent default", async () => {
  const parent = await opener({ model: "gpt-6.1-sol", thinkingLevel: "high" }, undefined, "gpt-6.1-sol");
  const out = await parent.open({ task: "draft one article" });
  assert.ok(out.ok, out.ok ? "" : out.message);
  assert.deepEqual(await parent.spawned(out.sessionId), {
    model: undefined,
    thinkingLevel: undefined,
    fastMode: undefined,
  });
});

test("a parent on the org's default model leaves the child on the subagent default", async () => {
  const parent = await opener(
    { model: "gpt-6.1-sol", thinkingLevel: "high" },
    undefined,
    "gpt-6.1-sol",
    scopeId("org", "default-org"),
  );
  const out = await parent.open({ task: "draft one article" });
  assert.ok(out.ok, out.ok ? "" : out.message);
  assert.deepEqual(await parent.spawned(out.sessionId), {
    model: undefined,
    thinkingLevel: undefined,
    fastMode: undefined,
  });
});

test("a parent that switched back to its default leaves the child on the subagent default", async () => {
  const parent = await opener({}, { modelId: "gpt-6.1-sol", effortLevel: "medium" }, "gpt-6.1-sol");
  const out = await parent.open({ task: "draft one article" });
  assert.ok(out.ok, out.ok ? "" : out.message);
  assert.deepEqual(await parent.spawned(out.sessionId), {
    model: undefined,
    thinkingLevel: undefined,
    fastMode: undefined,
  });
});

test("a parent that left a default which no longer resolves still passes its runtime on", async () => {
  const inherited = await openRuntime(
    { task: "draft one article" },
    { model: "gpt-6.1-sol", thinkingLevel: "high" },
    async () => {},
    async () => {
      throw new Error("stored default is unavailable");
    },
  );
  assert.deepEqual(inherited, { model: "gpt-6.1-sol", thinkingLevel: "high", fastMode: undefined });
});
