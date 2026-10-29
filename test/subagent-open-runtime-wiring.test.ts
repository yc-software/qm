import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { stopAtEnd } from "./support/build-app.ts";
import { scopeId, type Principal } from "../src/types.ts";

const actor: Principal = { id: "U1", type: "internal" };
const scope = scopeId("personal", "U1");

async function opener() {
  const built = stopAtEnd(buildApp(testConfig({ openaiApiKey: "sk-test" })));
  await built.featureFlags.setEnabled("persistent_subagents", scope, true, "admin");
  const room = await built.sessions.getOrCreateByThread("web:room", "dm", scope, undefined, "web");
  await built.sessions.addParticipant(room.id, actor.id);
  return built.sessionSyscalls.forTurn({
    session: room,
    scopeId: scope,
    request: { surface: "web", conversation: { kind: "dm", threadRef: "web:room", audience: [actor] }, actor },
  });
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
