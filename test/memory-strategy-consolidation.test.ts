import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createMemoryService } from "../src/memory/memory-service.ts";
import type { MemoryService } from "../src/memory/memory-service.ts";
import {
  createConsolidatingMemory,
  createConsolidator,
  MEMORY_CONSOLIDATION_PROMPT,
  parseConsolidationActions,
} from "../src/memory/strategies/consolidation.ts";
import { createPerTurnStrategy } from "../src/memory/strategies/per-turn.ts";
import type { HarnessModelUtilities } from "../src/harness/harness.ts";

const SCOPE = "user:U1";
const AT = Date.UTC(2026, 5, 10);

function freshMemory() {
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "msc-")));
  return { workspace, memory: createMemoryService(workspace) };
}

function oneShotHarness(reply: string, calls?: Array<{ system: string; prompt: string }>): HarnessModelUtilities {
  return {
    oneShot(system, prompt) {
      calls?.push({ system, prompt });
      return Promise.resolve(reply);
    },
  };
}

test("parseConsolidationActions: UPDATE/DELETE/ADD in, NONE/prose/malformed out", () => {
  assert.deepEqual(
    parseConsolidationActions(
      "UPDATE 2: Now leads the Q3 launch\nDELETE 1\nADD: Uses pnpm\nupdate 3: lowercase works\nsome prose\nDELETE x\nNONE",
    ),
    [
      { kind: "update", index: 2, text: "Now leads the Q3 launch" },
      { kind: "delete", index: 1 },
      { kind: "add", text: "Uses pnpm" },
      { kind: "update", index: 3, text: "lowercase works" },
    ],
  );
  assert.deepEqual(parseConsolidationActions("NONE"), []);
  assert.deepEqual(parseConsolidationActions(""), []);
});

test("capture counter end-to-end: per-turn strategy consolidates once the after-N trigger fires, and not before", async () => {
  const { memory } = freshMemory();
  let turn = 0;
  const harness: HarnessModelUtilities = {
    oneShot: (system: string) =>
      Promise.resolve(system === MEMORY_CONSOLIDATION_PROMPT ? "NONE" : `- fact number ${++turn}`),
  };
  const consolidator = createConsolidator({ harness, memory, afterN: 3, now: () => AT })!;
  const { memory: consolidating } = createConsolidatingMemory(memory, consolidator);
  const strategy = createPerTurnStrategy({ harness, memory: consolidating });

  await strategy.onTurnEnd!({ scopeId: SCOPE, input: "x", reply: "y" });
  await strategy.onTurnEnd!({ scopeId: SCOPE, input: "x", reply: "y" });
  assert.equal((await memory.readHead!(SCOPE)).records!.capturesSinceConsolidation, 2);

  await strategy.onTurnEnd!({ scopeId: SCOPE, input: "x", reply: "y" });
  for (let i = 0; i < 200 && (await memory.readHead!(SCOPE)).records!.capturesSinceConsolidation !== 0; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal((await memory.readHead!(SCOPE)).records!.capturesSinceConsolidation, 0);
  assert.doesNotMatch(await memory.read(SCOPE), /consolidated:/);
  await strategy.onTurnEnd!({ scopeId: SCOPE, input: "x", reply: "y" });
  assert.equal((await memory.readHead!(SCOPE)).records!.capturesSinceConsolidation, 1);
});

test("maintain() sends the numbered bullets with the consolidation prompt", async () => {
  const { memory } = freshMemory();
  await memory.capture(SCOPE, ["first fact", "second fact"], AT);
  const calls: Array<{ system: string; prompt: string }> = [];
  const consolidator = createConsolidator({ harness: oneShotHarness("NONE", calls), memory, now: () => AT })!;
  await consolidator.maintain(SCOPE);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.system, MEMORY_CONSOLIDATION_PROMPT);
  assert.equal(calls[0]!.prompt, "1. (2026-06-10) first fact\n2. (2026-06-10) second fact");
});

test("MEMORY_CONSOLIDATE_AFTER=0 disables consolidation entirely", () => {
  const { memory } = freshMemory();
  assert.equal(createConsolidator({ harness: oneShotHarness("NONE"), memory, afterN: 0 }), undefined);
});

test("a one-shot failure keeps every fact and resets the capture counter", async () => {
  const { memory } = freshMemory();
  await memory.capture(SCOPE, ["a fact"], AT);
  const harness: HarnessModelUtilities = {
    oneShot: () => Promise.reject(new Error("model down")),
  };
  await createConsolidator({ harness, memory })!.maintain(SCOPE);
  const after = await memory.read(SCOPE);
  assert.match(after, /a fact/, "facts survive the failure");
  assert.doesNotMatch(after, /consolidated:/);
  assert.equal((await memory.readHead!(SCOPE)).records!.capturesSinceConsolidation, 0);
});

test("an edit landing during consolidation survives without disabling later consolidation", async () => {
  const { memory } = freshMemory();
  await memory.capture(SCOPE, ["original fact"], AT);
  let calls = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let modelStarted!: () => void;
  const waiting = new Promise<void>((resolve) => {
    modelStarted = resolve;
  });
  const consolidator = createConsolidator({
    harness: {
      async oneShot() {
        calls++;
        modelStarted();
        await blocked;
        return "UPDATE 1: consolidated fact";
      },
    },
    memory,
  })!;

  const first = consolidator.maintain(SCOPE);
  await waiting;
  await memory.replace(SCOPE, "# Memory\n\n- user edit");
  release();
  await first;

  assert.match(await memory.read(SCOPE), /user edit/);
  assert.doesNotMatch(await memory.read(SCOPE), /consolidated fact/);

  await consolidator.maintain(SCOPE);
  assert.equal(calls, 2);
});

test("a lost consolidation race leaves the after-N trigger armed, so the next capture retries", async () => {
  const { memory } = freshMemory();
  await memory.capture(SCOPE, ["original fact"], AT);
  let calls = 0;
  const consolidator = createConsolidator({
    harness: {
      async oneShot() {
        calls++;
        if (calls === 1) await memory.replace(SCOPE, "# Memory\n\n- user edit");
        return "UPDATE 1: consolidated fact";
      },
    },
    memory,
    afterN: 1,
  })!;

  await consolidator.maybeMaintain(SCOPE);
  assert.equal(calls, 1);
  assert.doesNotMatch(await memory.read(SCOPE), /consolidated:/, "a dropped write lands no marker");

  await consolidator.maybeMaintain(SCOPE);
  assert.equal(calls, 2);
  assert.match(await memory.read(SCOPE), /consolidated fact/);
});

test("opaque providers own consolidation without generic Markdown rewrites", async () => {
  const memory: MemoryService = {
    read: async () => "- Legacy fact",
    recall: async () => "- Legacy fact",
    capture: async () => 0,
    query: async () => [],
    replace: async () => assert.fail("must not rewrite opaque provider"),
  };
  const consolidator = createConsolidator({
    memory,
    harness: {
      oneShot: async () => {
        assert.fail("must not consolidate opaque provider");
      },
    },
  })!;
  await consolidator.maintain(SCOPE);
  await consolidator.maybeMaintain(SCOPE);
});

for (const answer of ["NONE", "UPDATE 1: Updated harmless preference\nADD: Another harmless preference", "DELETE 1"]) {
  test(`structured consolidation isolates provenance and retains unaffected records: ${answer}`, async () => {
    const { memory } = freshMemory();
    const scope = "personal:alice";
    await memory.capture(scope, ["ORDINARY_SENTINEL"], AT, "alice", {
      mode: "explicit",
      conversationScopeId: scope,
      sensitivity: "ordinary",
      inheritedRecords: [],
    });
    await memory.capture(scope, ["PRIVATE_SENTINEL"], AT, "alice", {
      mode: "explicit",
      conversationScopeId: "group:private",
      sensitivity: "sensitive",
      inheritedRecords: [],
    });
    const before = (await memory.readHead!(scope)).records!;
    const privateRecord = before.records.find((record) => record.text.includes("PRIVATE_SENTINEL"))!;
    const prompts: string[] = [];
    await createConsolidator({
      memory,
      harness: {
        oneShot: async (_system, prompt) => {
          prompts.push(prompt);
          return prompt.includes("ORDINARY_SENTINEL") ? answer : "NONE";
        },
      },
    })!.maintain(scope);
    const after = (await memory.readHead!(scope)).records!;
    assert.equal(prompts.length, 2);
    assert.ok(
      prompts.every((prompt) => !(prompt.includes("ORDINARY_SENTINEL") && prompt.includes("PRIVATE_SENTINEL"))),
    );
    assert.deepEqual(
      after.records.find((record) => record.id === privateRecord.id),
      privateRecord,
    );
    assert.equal(after.capturesSinceConsolidation, 0);
    for (const record of after.records.filter((record) => !record.text.includes("PRIVATE_SENTINEL"))) {
      assert.equal(record.sensitivity, "ordinary");
      assert.equal(record.sourceUnknown, false);
      assert.deepEqual(record.sources, [{ scopeId: scope }]);
    }
    if (answer === "NONE") assert.deepEqual(after.records, before.records);
    if (answer.startsWith("UPDATE")) {
      assert.equal(
        after.records.find((record) => record.text.includes("Updated harmless"))!.id,
        before.records.find((record) => record.text.includes("ORDINARY_SENTINEL"))!.id,
      );
      assert.ok(after.records.some((record) => record.text.includes("Another harmless")));
    }
  });
}
