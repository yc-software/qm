import assert from "node:assert/strict";
import test from "node:test";
import { createSuggestedActivityService, type SuggestedActivityCache } from "../src/suggestions/activities.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import type { Session } from "../src/types.ts";

const activities = ["app", "brief", "deck"].map((id) => ({
  id,
  title: `Build my ${id}`,
  prompt: `Help with my ${id}.`,
  icon: "🛠️",
}));
const session = (scopeId: string, title: string, archived = false): Session => ({
  id: title,
  type: "dm",
  scopeId: scopeId as Session["scopeId"],
  title,
  archived,
  threadRef: title,
  createdAt: 0,
});

test("generation isolates personal context, uses a system prompt, and caches per principal", async () => {
  const inputs: string[] = [];
  let title = "Review my deck";
  let time = 1000;
  const service = createSuggestedActivityService({
    store: createMemoryMap<SuggestedActivityCache>(),
    sessions: {
      listByParticipant: async () => [
        session("personal:alice", title),
        session("personal:bob", "PRIVATE"),
        session("group:team", "SHARED"),
        session("personal:alice", "ARCHIVED", true),
      ],
    },
    context: "YC founder rollout",
    oneShot: async (system, prompt, signal) => {
      assert.match(system, /YC founder rollout/);
      assert.match(system, /untrusted evidence/);
      assert.ok(signal);
      inputs.push(prompt);
      return JSON.stringify(activities);
    },
    now: () => time,
  });
  assert.deepEqual(await service("alice", []), activities);
  assert.deepEqual(await service("alice", []), activities);
  assert.equal(inputs.length, 1);
  assert.match(inputs[0]!, /Review my deck/);
  assert.doesNotMatch(inputs[0]!, /PRIVATE|SHARED|ARCHIVED/);
  title = "New interest";
  assert.deepEqual(await service("alice", []), []);
  time += 5 * 60_000;
  assert.deepEqual(await service("alice", []), activities);
  assert.equal(inputs.length, 2);
  await service("bob", []);
  assert.equal(inputs.length, 3);
  assert.doesNotMatch(inputs[2]!, /New interest/);
});

test("durable cooldown prevents simultaneous generation across service instances", async () => {
  const store = createMemoryMap<SuggestedActivityCache>();
  let calls = 0;
  const deps = {
    store,
    sessions: { listByParticipant: async () => [] },
    oneShot: async () => {
      calls++;
      return JSON.stringify(activities);
    },
  };
  await Promise.all([
    createSuggestedActivityService(deps)("alice", []),
    createSuggestedActivityService(deps)("alice", []),
  ]);
  assert.equal(calls, 1);
});

test("errors and malformed output preserve seeds and obey retry cooldown", async () => {
  for (const result of [undefined, "not json", JSON.stringify(activities.slice(0, 1)), "throw"]) {
    let calls = 0;
    const service = createSuggestedActivityService({
      store: createMemoryMap<SuggestedActivityCache>(),
      sessions: { listByParticipant: async () => [] },
      oneShot: async () => {
        calls++;
        if (result === "throw") throw new Error("offline");
        return result;
      },
    });
    assert.deepEqual(await service("alice", activities), activities);
    assert.deepEqual(await service("alice", activities), activities);
    assert.equal(calls, 1);
  }
});
