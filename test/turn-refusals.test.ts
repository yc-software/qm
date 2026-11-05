import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import type { TurnRequest } from "../src/types.ts";

const webTurn = (actor: string, extra: Partial<TurnRequest> = {}): TurnRequest => ({
  surface: "web",
  actor: { externalId: actor },
  conversation: { kind: "dm", threadRef: `web:${actor}:${crypto.randomUUID()}` },
  text: "hello",
  origin: { kind: "human" },
  async: true,
  ...extra,
});

test("a company web turn refuses a model the deployment cannot resolve", async () => {
  const built = buildApp(testConfig({}));
  const result = await built.app.turn(webTurn("alice", { model: "no-such-model" }));
  assert.equal(result.status, "refused");
  assert.match(result.reason ?? "", /^I couldn't set up that runtime choice/);
});

test("a company web turn refuses when its stored runtime's provider has no key", async () => {
  const built = buildApp(testConfig({}));
  await built.config.setRuntimeSelection("personal:alice", { modelId: "gpt-5.6-sol" });
  const result = await built.app.turn(webTurn("alice"));
  assert.equal(result.status, "refused");
  assert.equal(result.reason, "that model isn't available on this deployment (its provider isn't configured)");
});

test("a web turn refuses another person's new thread, an unknown subagent thread and a channel the actor isn't in", async () => {
  const built = buildApp(testConfig({}));
  const foreign = await built.app.turn(
    webTurn("alice", { conversation: { kind: "dm", threadRef: `web:bob:${crypto.randomUUID()}` } }),
  );
  assert.deepEqual(
    [foreign.status, foreign.reason],
    ["refused", "you can only start a new conversation on your own thread"],
  );
  const subagent = await built.app.turn(
    webTurn("alice", { conversation: { kind: "dm", threadRef: `agent:main:subagent:${crypto.randomUUID()}` } }),
  );
  assert.deepEqual([subagent.status, subagent.reason], ["refused", "you cannot continue that subagent session"]);
  const channel = await built.app.turn(
    webTurn("alice", { conversation: { kind: "channel", channelRef: "C-NOT-JOINED", threadRef: "web:alice:channel" } }),
  );
  assert.deepEqual([channel.status, channel.reason], ["refused", "you're not a member of that context"]);
});
