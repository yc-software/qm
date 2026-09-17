import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createMemoryService, MEMORY_FILE } from "../src/memory/memory-service.ts";
import type { MemoryService } from "../src/memory/memory-service.ts";
import {
  applyConsolidationActions,
  bulletsBelowMarker,
  consolidationMarker,
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

test("golden file: consolidation rewrites the notebook — UPDATE keeps the original capture date, DELETE drops, ADD appends, marker lands at the end", async () => {
  const before = [
    "# Memory",
    "",
    "- (2026-06-01) Working on the Q2 launch",
    "- (2026-06-02) Prefers terse replies",
    "- (2026-06-03) Likes short answers",
    "",
    consolidationMarker(Date.UTC(2026, 5, 3)),
    "- (2026-06-09) Q2 launch shipped; now planning Q3",
  ].join("\n");

  const after = applyConsolidationActions(
    before,
    parseConsolidationActions(
      "UPDATE 1: Planning the Q3 launch (Q2 shipped)\nDELETE 3\nDELETE 4\nADD: Owns the billing service",
    ),
    AT,
  );

  assert.equal(
    after,
    [
      "# Memory",
      "",
      "- (2026-06-01) Planning the Q3 launch (Q2 shipped)",
      "- (2026-06-02) Prefers terse replies",
      "- (2026-06-10) Owns the billing service",
      "",
      "<!-- consolidated: 2026-06-10 -->",
    ].join("\n"),
  );
});

test("applyConsolidationActions with no actions (model said NONE) still refreshes the marker so the trigger resets", () => {
  const before = "# Memory\n\n- (2026-06-01) a\n- (2026-06-02) b";
  const after = applyConsolidationActions(before, [], AT);
  assert.equal(after, `# Memory\n\n- (2026-06-01) a\n- (2026-06-02) b\n\n${consolidationMarker(AT)}`);
  assert.equal(bulletsBelowMarker(after), 0);
});

test("bulletsBelowMarker: counts all bullets when never consolidated, only post-marker bullets after", () => {
  assert.equal(bulletsBelowMarker("# Memory\n\n- a\n- b\n* c"), 3);
  assert.equal(bulletsBelowMarker(`# Memory\n\n- a\n${consolidationMarker(AT)}\n- b\n- c`), 2);
  assert.equal(bulletsBelowMarker(""), 0);
});

test("marker bookkeeping end-to-end: per-turn strategy consolidates once the after-N trigger fires, and not before", async () => {
  const { workspace, memory } = freshMemory();
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
  let body = (await workspace.read(SCOPE, MEMORY_FILE)) ?? "";
  assert.doesNotMatch(body, /consolidated:/, "no consolidation below N");

  await strategy.onTurnEnd!({ scopeId: SCOPE, input: "x", reply: "y" });
  for (let i = 0; i < 200 && !/consolidated:/.test(body); i++) {
    await new Promise((r) => setTimeout(r, 5));
    body = (await workspace.read(SCOPE, MEMORY_FILE)) ?? "";
  }
  assert.match(body, /<!-- consolidated: 2026-06-10 -->/);
  assert.equal(bulletsBelowMarker(body), 0, "trigger reset by the marker");

  await strategy.onTurnEnd!({ scopeId: SCOPE, input: "x", reply: "y" });
  body = (await workspace.read(SCOPE, MEMORY_FILE)) ?? "";
  assert.equal(bulletsBelowMarker(body), 1);
  assert.equal((body.match(/consolidated:/g) ?? []).length, 1, "old markers are superseded, never accumulated");
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

test("a one-shot failure keeps every fact and leaves the trigger armed for retry", async () => {
  const { workspace, memory } = freshMemory();
  await memory.capture(SCOPE, ["a fact"], AT);
  let calls = 0;
  const harness: HarnessModelUtilities = {
    oneShot() {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("model down")) : Promise.resolve("NONE");
    },
  };
  const consolidator = createConsolidator({ harness, memory, now: () => AT })!;
  await assert.rejects(consolidator.maintain(SCOPE), /model down/);
  const afterFailure = (await workspace.read(SCOPE, MEMORY_FILE)) ?? "";
  assert.match(afterFailure, /a fact/, "facts survive the failure");
  assert.doesNotMatch(afterFailure, /consolidated:/, "failed work cannot consume the trigger");
  assert.equal(bulletsBelowMarker(afterFailure), 1);

  await consolidator.maintain(SCOPE);
  const afterRetry = (await workspace.read(SCOPE, MEMORY_FILE)) ?? "";
  assert.match(afterRetry, /a fact/);
  assert.match(afterRetry, /consolidated:/);
  assert.equal(bulletsBelowMarker(afterRetry), 0);
});

test("a capture landing during consolidation forces a fresh model pass before commit", async () => {
  const { memory } = freshMemory();
  await memory.capture(SCOPE, ["original fact"], AT);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let modelStarted!: () => void;
  const waiting = new Promise<void>((resolve) => {
    modelStarted = resolve;
  });
  const prompts: string[] = [];
  const consolidator = createConsolidator({
    harness: {
      async oneShot(_system, prompt) {
        prompts.push(prompt);
        if (prompts.length === 1) {
          modelStarted();
          await blocked;
          return "UPDATE 1: stale consolidation";
        }
        return "UPDATE 1: fresh consolidation";
      },
    },
    memory,
  })!;

  const maintenance = consolidator.maintain(SCOPE);
  await waiting;
  await memory.capture(SCOPE, ["concurrent capture"], AT);
  release();
  await maintenance;

  assert.equal(prompts.length, 2);
  assert.doesNotMatch(prompts[0]!, /concurrent capture/);
  assert.match(prompts[1]!, /concurrent capture/);
  const after = await memory.read(SCOPE);
  assert.match(after, /fresh consolidation/);
  assert.match(after, /concurrent capture/, "the retry preserves facts absent from the stale model input");
  assert.doesNotMatch(after, /stale consolidation/);
  assert.equal(bulletsBelowMarker(after), 0);
});

test("repeated consolidation CAS losses preserve facts and pending trigger credit", async () => {
  const { memory } = freshMemory();
  await memory.capture(SCOPE, ["original fact"], AT);
  const logs: string[] = [];
  let calls = 0;
  const contended: MemoryService = {
    ...memory,
    async replaceIfRevision(scopeId, content, revision, author) {
      calls += 1;
      await memory.capture(scopeId, [`capture ${calls}`], AT);
      return memory.replaceIfRevision!(scopeId, content, revision, author);
    },
  };
  const consolidator = createConsolidator({
    harness: oneShotHarness("UPDATE 1: should not land"),
    memory: contended,
    log: (message) => logs.push(message),
  })!;

  await consolidator.maintain(SCOPE);

  const after = await memory.read(SCOPE);
  assert.match(after, /original fact/);
  assert.match(after, /capture 1/);
  assert.match(after, /capture 2/);
  assert.doesNotMatch(after, /should not land/);
  assert.equal(bulletsBelowMarker(after), 3);
  assert.match(logs[0] ?? "", /trigger remains armed/);
});

test("degrades to capture-only when the store can't round-trip a rewrite: logs once, stops trying, never crashes", async () => {
  const body = "# Memory\n\n- (2026-06-01) a fact\n";
  const memory: MemoryService = {
    recall: () => Promise.resolve(body),
    capture: () => Promise.resolve(0),
    query: () => Promise.resolve([]),
    read: () => Promise.resolve(body),
    replace: () => Promise.resolve(),
  };
  const logs: string[] = [];
  const calls: Array<{ system: string; prompt: string }> = [];
  const consolidator = createConsolidator({
    harness: oneShotHarness("NONE", calls),
    memory,
    afterN: 1,
    log: (m) => logs.push(m),
  })!;

  await consolidator.maybeMaintain(SCOPE);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /consolidation disabled/);
  assert.equal(calls.length, 0, "the model is not called when its output cannot be committed safely");

  await consolidator.maybeMaintain(SCOPE);
  await consolidator.maintain(SCOPE);
  assert.equal(calls.length, 0);
  assert.equal(logs.length, 1);

  await consolidator.maybeMaintain("user:U2");
  assert.equal(calls.length, 0);
  assert.equal(logs.length, 2);
});

test("a stale marker from an earlier consolidation does not mask a no-op replace(): the scope still degrades", async () => {
  const body = `# Memory\n\n${consolidationMarker(Date.UTC(2026, 4, 1))}\n- (2026-06-01) a fact\n`;
  const memory: MemoryService = {
    recall: () => Promise.resolve(body),
    capture: () => Promise.resolve(0),
    query: () => Promise.resolve([]),
    read: () => Promise.resolve(body),
    replace: () => Promise.resolve(),
  };
  const logs: string[] = [];
  const consolidator = createConsolidator({ harness: oneShotHarness("NONE"), memory, log: (m) => logs.push(m) })!;
  await consolidator.maintain(SCOPE);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /consolidation disabled/);
});
