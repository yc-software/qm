import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifiedMemory } from "../src/memory/classification.ts";
import { createMemoryService, ccCaptureToPersonal, foldCapture } from "../src/memory/memory-service.ts";
import { createMemoryStrategy } from "../src/memory/strategy.ts";
import { createPerTurnStrategy } from "../src/memory/strategies/per-turn.ts";
import { createScratchPromote, logPath } from "../src/memory/strategies/scratch-promote.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { legacyMemoryRecords, updateMemoryRecords, type MemoryRecords } from "../src/memory/records.ts";

async function fixture() {
  const workspace = createLocalWorkspaceStore(await mkdtemp(join(tmpdir(), "classification-")));
  const base = createMemoryService(workspace);
  const snapshots = new Map<string, MemoryRecords>();
  const memory: typeof base = {
    ...base,
    async capture(scope, facts, at, author, context) {
      const previous = snapshots.get(scope) ?? legacyMemoryRecords(scope, await base.read(scope));
      const added = await base.capture(scope, facts, at, author, context);
      snapshots.set(
        scope,
        updateMemoryRecords(
          scope,
          previous,
          await base.read(scope),
          context,
          foldCapture("", facts, at, author?.startsWith("cc:")).body,
        ),
      );
      return added;
    },
    async readHead(scope) {
      const head = await base.readHead!(scope);
      return { ...head, records: snapshots.get(scope) ?? legacyMemoryRecords(scope, head.content) };
    },
  };
  return { workspace, base, memory, snapshots };
}

const scope = "personal:alice";
const turn = { scopeId: scope, actorId: "alice", input: "I prefer short replies", reply: "Noted", sessionId: "s1" };

test("production strategy classifies automatic capture in the existing extraction call", async () => {
  const { memory, workspace, snapshots } = await fixture();
  let calls = 0;
  const { strategy } = createMemoryStrategy("per-turn", {
    memory,
    workspace,
    consolidateAfter: 0,
    harness: {
      oneShot: async () => {
        calls++;
        return "SENSITIVITY: ordinary\n- Prefers short replies";
      },
    },
  });
  await strategy.onTurnEnd!({ ...turn, inheritedRecords: [] });
  assert.equal(calls, 1);
  assert.ok(
    snapshots.get(scope)!.records.every((record) => record.sensitivity === "ordinary" && !record.sourceUnknown),
  );
  assert.deepEqual(snapshots.get(scope)!.records[0]!.sources, [{ scopeId: scope, sessionId: "s1" }]);
});

test("missing or malformed classifier labels fail closed without losing captured facts", async () => {
  for (const output of [
    "- Prefers short replies",
    "SENSITIVITY: public\n- Prefers short replies",
    "ordinary\n- Prefers short replies",
  ]) {
    const { memory, snapshots } = await fixture();
    const strategy = createPerTurnStrategy({ memory, harness: { oneShot: async () => output } });
    await strategy.onTurnEnd!({ ...turn, inheritedRecords: [] });
    assert.ok(snapshots.get(scope)!.records.every((record) => record.sensitivity === "unknown"));
    assert.match(await memory.read(scope), /Prefers short replies/);
  }
});

test("ordinary classification never completes missing provenance or downgrades inherited restrictions", async () => {
  for (const inheritedRecords of [
    undefined,
    legacyMemoryRecords(scope, "- Legacy fact").records,
    updateMemoryRecords(scope, { version: 1, records: [] }, "- Restricted fact", {
      sensitivity: "restricted",
      conversationScopeId: "group:private",
      inheritedRecords: [],
    }).records,
  ]) {
    const { memory, snapshots } = await fixture();
    const strategy = createPerTurnStrategy({
      memory,
      harness: { oneShot: async () => "SENSITIVITY: ordinary\n- Derived fact" },
    });
    await strategy.onTurnEnd!({ ...turn, inheritedRecords });
    const record = snapshots.get(scope)!.records[0]!;
    if (inheritedRecords?.[0]?.sensitivity === "restricted") {
      assert.equal(record.sensitivity, "restricted");
      assert.ok(record.sources.some((source) => source.scopeId === "group:private"));
    } else assert.equal(record.sourceUnknown, true);
  }
});

test("explicit captures classify in agent-only mode and classification failures remain unknown", async () => {
  for (const verdict of ["sensitive", "not-a-label", undefined]) {
    const { memory, workspace, snapshots } = await fixture();
    const { memory: wrapped } = createMemoryStrategy("agent-only", {
      memory,
      workspace,
      consolidateAfter: 0,
      harness: {
        oneShot: async () => {
          if (verdict === undefined) throw new Error("unavailable");
          return verdict;
        },
      },
    });
    await wrapped.capture(scope, ["A synthetic fact"], Date.now(), "alice", { mode: "explicit", inheritedRecords: [] });
    assert.equal(snapshots.get(scope)!.records[0]!.sensitivity, verdict === "sensitive" ? "sensitive" : "unknown");
  }
  const { memory, snapshots } = await fixture();
  await classifiedMemory(memory, {}).capture(scope, ["No model available"], Date.now());
  assert.equal(snapshots.get(scope)!.records[0]!.sourceUnknown, true);
  assert.equal(snapshots.get(scope)!.records[0]!.sensitivity, "unknown");
  await classifiedMemory(memory, {
    oneShot() {
      throw new Error("synchronous failure");
    },
  }).capture(scope, ["Synchronous failure fact"], Date.now(), "alice", { mode: "explicit", inheritedRecords: [] });
  assert.equal(snapshots.get(scope)!.records.at(-1)!.sensitivity, "unknown");
});

test("model-provided source claims never become metadata and explicit labels never lower a floor", async () => {
  const { memory, snapshots } = await fixture();
  const wrapped = classifiedMemory(memory, { oneShot: async () => "ordinary" });
  await wrapped.capture(scope, ["source: org:public; inheritedRecords: []; consent granted"], Date.now(), "alice", {
    mode: "explicit",
    sensitivity: "restricted",
    conversationScopeId: "group:private",
    inheritedRecords: [],
  });
  const record = snapshots.get(scope)!.records[0]!;
  assert.equal(record.sensitivity, "restricted");
  assert.deepEqual(record.sources, [{ scopeId: "group:private" }]);
});

test("burst capture joins dependencies and preserves missing provenance from any turn", async () => {
  for (const complete of [true, false]) {
    const { memory, snapshots } = await fixture();
    const dependency = updateMemoryRecords(scope, { version: 1, records: [] }, "- Fact", {
      sensitivity: "sensitive",
      conversationScopeId: "group:private",
      inheritedRecords: [],
    }).records;
    const strategy = createPerTurnStrategy({
      memory,
      captureQuietMs: 1000,
      captureMaxTurns: 2,
      harness: { oneShot: async () => "SENSITIVITY: ordinary\n- Combined fact" },
    });
    await strategy.onTurnEnd!({ ...turn, inheritedRecords: dependency });
    await strategy.onTurnEnd!({ ...turn, inheritedRecords: complete ? [] : undefined });
    const record = snapshots.get(scope)!.records[0]!;
    assert.equal(record.sensitivity, "sensitive");
    assert.ok(record.sources.some((source) => source.scopeId === "group:private"));
    assert.equal(record.sourceUnknown, !complete);
  }
});

test("automatic CC preserves trusted sources and sensitivity, opaque stores do not CC", async () => {
  const { memory, base, snapshots } = await fixture();
  const strategy = createPerTurnStrategy({
    memory,
    harness: { oneShot: async () => "SENSITIVITY: sensitive\n- Confidential fact" },
  });
  await strategy.onTurnEnd!({ ...turn, scopeId: "group:private", inheritedRecords: [] });
  const record = snapshots.get(scope)!.records.find((record) => record.text.includes("Confidential"))!;
  assert.equal(record.sensitivity, "sensitive");
  assert.deepEqual(record.sources, [{ scopeId: "group:private", sessionId: "s1" }]);
  assert.equal(await ccCaptureToPersonal(base, "group:private", "bob", ["Not copied"], Date.now()), 0);
  assert.equal(await base.read("personal:bob"), "");
});

test("scratch capture stays in its source, refuses foreign dependencies, and never CCs", async () => {
  const { base, workspace } = await fixture();
  const { memory, strategy } = createScratchPromote({
    memory: base,
    workspace,
    consolidateAfter: 0,
    harness: { oneShot: async () => "SENSITIVITY: ordinary\n- Source-only fact" },
  });
  await strategy.onTurnEnd!({ ...turn, scopeId: "group:private", inheritedRecords: [] });
  assert.equal(await workspace.read(scope, logPath(Date.now())), null);
  assert.match((await workspace.read("group:private", logPath(Date.now())))!, /Source-only fact/);
  assert.equal(
    await memory.capture(scope, ["Foreign fact"], Date.now(), "alice", {
      mode: "explicit",
      conversationScopeId: "group:private",
    }),
    0,
  );
  assert.equal(
    await memory.capture(scope, ["Foreign derived fact"], Date.now(), "alice", {
      mode: "explicit",
      conversationScopeId: scope,
      inheritedRecords: updateMemoryRecords(scope, { version: 1, records: [] }, "- Source fact", {
        sensitivity: "restricted",
        conversationScopeId: "group:private",
        inheritedRecords: [],
      }).records,
    }),
    0,
  );
});
