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

test("a one-shot failure leaves the notebook untouched — consolidation is best-effort", async () => {
  const { workspace, memory } = freshMemory();
  await memory.capture(SCOPE, ["a fact"], AT);
  const before = await workspace.read(SCOPE, MEMORY_FILE);
  const harness: HarnessModelUtilities = {
    oneShot: () => Promise.reject(new Error("model down")),
  };
  await createConsolidator({ harness, memory })!.maintain(SCOPE);
  assert.equal(await workspace.read(SCOPE, MEMORY_FILE), before);
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
  const logs: string[] = [];
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
    log: (message) => logs.push(message),
  })!;

  const first = consolidator.maintain(SCOPE);
  await waiting;
  await memory.replace(SCOPE, "# Memory\n\n- user edit");
  release();
  await first;

  assert.match(await memory.read(SCOPE), /user edit/);
  assert.doesNotMatch(await memory.read(SCOPE), /consolidated fact/);
  assert.deepEqual(logs, []);

  await consolidator.maintain(SCOPE);
  assert.equal(calls, 2);
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
  assert.equal(calls.length, 1);

  await consolidator.maybeMaintain(SCOPE);
  await consolidator.maintain(SCOPE);
  assert.equal(calls.length, 1);
  assert.equal(logs.length, 1);

  await consolidator.maybeMaintain("user:U2");
  assert.equal(calls.length, 2);
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
