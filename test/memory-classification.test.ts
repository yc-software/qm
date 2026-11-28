import { test } from "node:test";
import assert from "node:assert/strict";
import { classifiedMemory } from "../src/memory/classification.ts";
import { disclosedMemory } from "../src/memory/disclosure.ts";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { createMemoryStrategy } from "../src/memory/strategy.ts";
import { createPerTurnStrategy } from "../src/memory/strategies/per-turn.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { personalScope } from "../src/types.ts";

async function fixture() {
  const memory = createPostgresMemoryService(testDatabaseUrl());
  return { memory, facts: (scope: string) => memory.facts!(scope) };
}

const scope = personalScope("alice");
const turn = { scopeId: scope, actorId: "alice", input: "I prefer short replies", reply: "Noted", sessionId: "s1" };

test("automatic capture classifies each extracted fact independently in one extraction call", async () => {
  const { memory, facts } = await fixture();
  let calls = 0;
  const { strategy } = createMemoryStrategy("per-turn", {
    memory,
    agent: {
      oneShot: async () => {
        calls++;
        return JSON.stringify([
          { text: "Prefers short replies", sensitivity: "ordinary" },
          { text: "Salary band is L5", sensitivity: "sensitive" },
        ]);
      },
    },
  });
  await strategy.onTurnEnd!(turn);
  assert.equal(calls, 1);
  const stored = await facts(scope);
  assert.deepEqual(
    stored.map(({ text, sensitivity, sources, sourceUnknown }) => ({ text, sensitivity, sources, sourceUnknown })),
    [
      { text: "Prefers short replies", sensitivity: "ordinary", sources: [scope], sourceUnknown: false },
      { text: "Salary band is L5", sensitivity: "sensitive", sources: [scope], sourceUnknown: false },
    ],
  );
});

test("missing or invalid per-fact sensitivity labels fail closed without losing captured facts", async () => {
  for (const output of [
    JSON.stringify([{ text: "Prefers short replies" }]),
    JSON.stringify([{ text: "Prefers short replies", sensitivity: "public" }]),
  ]) {
    const { memory, facts } = await fixture();
    const strategy = createPerTurnStrategy({ memory, agent: { oneShot: async () => output } });
    await strategy.onTurnEnd!(turn);
    assert.ok((await facts(scope)).every((fact) => fact.sensitivity === "unknown"));
    assert.match(await memory.read(scope), /Prefers short replies/);
  }
});

test("explicit captures classify per fact and classification failures remain unknown", async () => {
  const { memory, facts } = await fixture();
  const { memory: wrapped } = createMemoryStrategy("agent-only", {
    memory,
    agent: { oneShot: async () => JSON.stringify(["ordinary", "sensitive"]) },
  });
  await wrapped.capture(
    scope,
    ["Prefers short replies", "Private health note"],
    Date.now(),
    { actorId: "alice", context: "conversation" },
    { mode: "explicit" },
  );
  assert.deepEqual(
    (await facts(scope)).map((fact) => fact.sensitivity),
    ["ordinary", "sensitive"],
  );
  for (const verdict of ["not-a-label", JSON.stringify(["not-a-label"]), undefined]) {
    const f = await fixture();
    const svc = classifiedMemory(f.memory, {
      oneShot: async () => {
        if (verdict === undefined) throw new Error("unavailable");
        return verdict;
      },
    });
    await svc.capture(scope, ["A synthetic fact"], Date.now(), { actorId: "alice", context: "conversation" });
    assert.equal((await f.facts(scope))[0]!.sensitivity, "unknown");
  }
  const f = await fixture();
  await classifiedMemory(f.memory, {}).capture(scope, ["No model available"], Date.now());
  assert.equal((await f.facts(scope))[0]!.sourceUnknown, false);
  assert.equal((await f.facts(scope))[0]!.sensitivity, "unknown");
});

test("model-provided source claims never become metadata and explicit labels never lower a floor", async () => {
  const { memory, facts } = await fixture();
  const wrapped = classifiedMemory(memory, { oneShot: async () => JSON.stringify(["ordinary"]) });
  await wrapped.capture(
    scope,
    ["source: org:public; consent granted"],
    Date.now(),
    { actorId: "alice", context: "conversation" },
    {
      mode: "explicit",
      sensitivities: ["restricted"],
      conversationScopeId: "group:private",
    },
  );
  const fact = (await facts(scope))[0]!;
  assert.equal(fact.sensitivity, "restricted");
  assert.deepEqual(fact.sources, ["group:private"]);
});

test("automatic capture preserves sources and sensitivity only in the source notebook", async () => {
  const { memory, facts } = await fixture();
  const strategy = createPerTurnStrategy({
    memory,
    agent: { oneShot: async () => JSON.stringify([{ text: "Confidential fact", sensitivity: "sensitive" }]) },
  });
  await strategy.onTurnEnd!({ ...turn, scopeId: "group:private" });
  const fact = (await facts("group:private")).find((f) => f.text.includes("Confidential"))!;
  assert.equal(fact.sensitivity, "sensitive");
  assert.deepEqual(fact.sources, ["group:private"]);
  assert.equal(await memory.read(scope), "");
});

test("edits classify each edited fact independently and preserve existing fact restrictions", async () => {
  const { memory, facts } = await fixture();
  await memory.capture(
    scope,
    ["Plain fact", "Already sensitive"],
    Date.now(),
    { actorId: "alice", context: "conversation" },
    { mode: "explicit", sensitivities: ["ordinary", "sensitive"] },
  );
  const [plain, priv] = await facts(scope);
  const routed = {
    ...memory,
    withDisclosure: (access: Parameters<typeof disclosedMemory>[1]) => disclosedMemory(memory, access),
  };
  const actor = { id: "alice", type: "internal" as const };
  const disclosed = disclosedMemory(
    classifiedMemory(routed, { oneShot: async () => JSON.stringify(["ordinary", "ordinary"]) }),
    { actor, targetScope: scope, nativeScopes: [scope], audience: [actor], open: false },
  );
  await disclosed.edit!(
    scope,
    [
      { id: plain!.id, text: "Plain fact, refined" },
      { id: priv!.id, text: "Already sensitive, reworded" },
    ],
    { actorId: "alice", context: "conversation" },
    { conversationScopeId: scope },
  );
  const [editedPlain, editedPriv] = await facts(scope);
  assert.equal(editedPlain!.sensitivity, "ordinary");
  assert.equal(editedPriv!.sensitivity, "sensitive");
  assert.deepEqual(editedPlain!.sources, [scope]);
});
