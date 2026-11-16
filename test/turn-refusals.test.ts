import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import type { TurnRequest } from "../src/types.ts";
import { refusalNote } from "../src/surfaces/refusals.ts";

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

test("a web turn starts new threads only under the caller's own IDs and refuses an unknown subagent thread or channel", async () => {
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
  await built.principalLinks.link({ principalId: "sso:a", canonicalId: "alice", evidence: "x", linkedBy: "t" });
  assert.notEqual((await built.app.turn(webTurn("sso:a"))).status, "refused");
  await built.principalLinks.link({ principalId: "B0BOT", canonicalId: "alice", evidence: "x", linkedBy: "t" });
  await built.principalLinks.link({ principalId: "sso:b", canonicalId: "B1BOT", evidence: "x", linkedBy: "t" });
  await built.principalLinks.link({ principalId: "sso:c", canonicalId: "B2BOT", evidence: "x", linkedBy: "t" });
  await built.users.markApps(["B1BOT"]);
  await built.directory.replace([{ principalId: "B2BOT", displayName: "Bot", type: "internal", isBot: true }]);
  const bot = (id: string) => webTurn(id, { botActor: true, actor: { externalId: id, isBot: true } });
  for (const turn of [bot("B0BOT"), bot("B1BOT"), webTurn("sso:b"), webTurn("sso:c")]) {
    const refused = await built.app.turn(turn);
    assert.equal(refusalNote(refused, "channel"), refused.reason);
    assert.match(refused.reason ?? "", /^I can't run this: a sign-in in this principal link is marked as a bot/);
  }
  assert.notEqual((await built.app.turn(webTurn("sso:a", { botActor: true }))).status, "refused");
});
