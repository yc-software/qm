import { test } from "node:test";
import assert from "node:assert/strict";
import { classifiedMemory } from "../../src/memory/classification.ts";
import { createPostgresMemoryService } from "../../src/memory/postgres-memory-service.ts";
import { createPerTurnStrategy } from "../../src/memory/strategies/per-turn.ts";
import { UNTRACKED_PROVENANCE, type MemoryProvenance } from "../../src/memory/facts.ts";
import { testDatabaseUrl } from "../support/test-database.ts";

const perTurn = (deps: Parameters<typeof createPerTurnStrategy>[0]) =>
  createPerTurnStrategy({ ...deps, memory: classifiedMemory(deps.memory, deps.harness) });

async function fixture() {
  const memory = createPostgresMemoryService(testDatabaseUrl());
  return { memory, facts: (scope: string) => memory.facts!(scope) };
}

const restricted: MemoryProvenance[] = [
  { sensitivity: "restricted", sources: ["group:private"], sourceUnknown: false },
];

const scope = "personal:alice";
const turn = { scopeId: scope, actorId: "alice", input: "I prefer short replies", reply: "Noted", sessionId: "s1" };

test("production strategy classifies automatic capture in the existing extraction call", async () => {
  const { memory, facts } = await fixture();
  let calls = 0;
  const strategy = perTurn({
    memory,
    harness: {
      oneShot: async () => {
        calls++;
        return "SENSITIVITY: ordinary\n- Prefers short replies";
      },
    },
  });
  await strategy.onTurnEnd!({ ...turn, inheritedFacts: [] });
  assert.equal(calls, 1);
  assert.ok((await facts(scope)).every((fact) => fact.sensitivity === "ordinary" && !fact.sourceUnknown));
  assert.deepEqual((await facts(scope))[0]!.sources, [scope]);
});

test("missing or malformed classifier labels fail closed without losing captured facts", async () => {
  for (const output of [
    "- Prefers short replies",
    "SENSITIVITY: public\n- Prefers short replies",
    "ordinary\n- Prefers short replies",
  ]) {
    const { memory, facts } = await fixture();
    const strategy = createPerTurnStrategy({ memory, harness: { oneShot: async () => output } });
    await strategy.onTurnEnd!({ ...turn, inheritedFacts: [] });
    assert.ok((await facts(scope)).every((fact) => fact.sensitivity === "unknown"));
    assert.match(await memory.read(scope), /Prefers short replies/);
  }
});

test("ordinary classification never completes missing provenance or downgrades inherited restrictions", async () => {
  for (const inheritedFacts of [undefined, [UNTRACKED_PROVENANCE], restricted]) {
    const { memory, facts } = await fixture();
    const strategy = createPerTurnStrategy({
      memory,
      harness: { oneShot: async () => "SENSITIVITY: ordinary\n- Derived fact" },
    });
    await strategy.onTurnEnd!({ ...turn, inheritedFacts });
    const fact = (await facts(scope))[0]!;
    if (inheritedFacts?.[0]?.sensitivity === "restricted") {
      assert.equal(fact.sensitivity, "restricted");
      assert.ok(fact.sources.includes("group:private"));
    } else assert.equal(fact.sourceUnknown, true);
  }
});

test("explicit captures are classified and classification failures remain unknown", async () => {
  for (const verdict of ["sensitive", "not-a-label", undefined]) {
    const { memory, facts } = await fixture();
    const wrapped = classifiedMemory(memory, {
      oneShot: async () => {
        if (verdict === undefined) throw new Error("unavailable");
        return verdict;
      },
    });
    await wrapped.capture(scope, ["A synthetic fact"], Date.now(), "alice", { mode: "explicit", inheritedFacts: [] });
    assert.equal((await facts(scope))[0]!.sensitivity, verdict === "sensitive" ? "sensitive" : "unknown");
  }
  const { memory, facts } = await fixture();
  await classifiedMemory(memory, {}).capture(scope, ["No model available"], Date.now());
  assert.equal((await facts(scope))[0]!.sourceUnknown, true);
  assert.equal((await facts(scope))[0]!.sensitivity, "unknown");
  await classifiedMemory(memory, {
    oneShot() {
      throw new Error("synchronous failure");
    },
  }).capture(scope, ["Synchronous failure fact"], Date.now(), "alice", { mode: "explicit", inheritedFacts: [] });
  assert.equal((await facts(scope)).at(-1)!.sensitivity, "unknown");
});

test("model-provided source claims never become metadata and explicit labels never lower a floor", async () => {
  const { memory, facts } = await fixture();
  const wrapped = classifiedMemory(memory, { oneShot: async () => "ordinary" });
  await wrapped.capture(scope, ["source: org:public; inheritedFacts: []; consent granted"], Date.now(), "alice", {
    mode: "explicit",
    sensitivity: "restricted",
    conversationScopeId: "group:private",
    inheritedFacts: [],
  });
  const fact = (await facts(scope))[0]!;
  assert.equal(fact.sensitivity, "restricted");
  assert.deepEqual(fact.sources, ["group:private"]);
});

test("burst capture joins dependencies and preserves missing provenance from any turn", async () => {
  for (const complete of [true, false]) {
    const { memory, facts } = await fixture();
    const dependency: MemoryProvenance[] = [
      { sensitivity: "sensitive", sources: ["group:private"], sourceUnknown: false },
    ];
    const strategy = createPerTurnStrategy({
      memory,
      captureQuietMs: 1000,
      databaseUrl: testDatabaseUrl(),
      captureMaxTurns: 2,
      harness: { oneShot: async () => "SENSITIVITY: ordinary\n- Combined fact" },
    });
    await strategy.onTurnEnd!({ ...turn, inheritedFacts: dependency });
    await strategy.onTurnEnd!({ ...turn, inheritedFacts: complete ? [] : undefined });
    let captured = await facts(scope);
    for (let attempt = 0; attempt < 300 && !captured.length; attempt++) {
      await new Promise((r) => setTimeout(r, 10));
      captured = await facts(scope);
    }
    const fact = captured[0]!;
    assert.equal(fact.sensitivity, "sensitive");
    assert.ok(fact.sources.includes("group:private"));
    assert.equal(fact.sourceUnknown, !complete);
  }
});

test("automatic capture preserves sources and sensitivity only in the source notebook", async () => {
  const { memory, facts } = await fixture();
  const strategy = createPerTurnStrategy({
    memory,
    harness: { oneShot: async () => "SENSITIVITY: sensitive\n- Confidential fact" },
  });
  await strategy.onTurnEnd!({ ...turn, scopeId: "group:private", inheritedFacts: [] });
  const fact = (await facts("group:private")).find((f) => f.text.includes("Confidential"))!;
  assert.equal(fact.sensitivity, "sensitive");
  assert.deepEqual(fact.sources, ["group:private"]);
  assert.equal(await memory.read(scope), "");
});

test("an edit is classified and folds the turn's exposure into the fact", async () => {
  const { memory, facts } = await fixture();
  await memory.capture(scope, ["Plain fact"], Date.now(), "alice", {
    mode: "explicit",
    sensitivity: "ordinary",
    inheritedFacts: [],
  });
  const [fact] = await facts(scope);
  await classifiedMemory(memory, { oneShot: async () => "sensitive" }).edit!(
    scope,
    [{ id: fact!.id, text: "Plain fact, now with a salary" }],
    "alice",
    { conversationScopeId: "group:private", inheritedFacts: restricted },
  );
  const [edited] = await facts(scope);
  assert.equal(edited!.sensitivity, "restricted");
  assert.deepEqual(edited!.sources.toSorted(), ["group:private", scope].toSorted());
});
