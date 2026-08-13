import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createMemoryService, MEMORY_FILE } from "../src/memory/memory-service.ts";
import { createMemoryStrategy, parseMemoryStrategyKind } from "../src/memory/strategy.ts";
import { createScratchPromote, logPath, PROMOTION_PROMPT } from "../src/memory/strategies/scratch-promote.ts";
import type { HarnessModelUtilities } from "../src/harness/harness.ts";

const SCOPE = "user:U1";
const DAY = 86_400_000;
const TODAY = Date.UTC(2026, 5, 10, 12);

function harnessOf(oneShot?: HarnessModelUtilities["oneShot"]): HarnessModelUtilities {
  return oneShot ? { oneShot } : {};
}

function fresh(opts: { oneShot?: HarnessModelUtilities["oneShot"]; consolidateAfter?: number } = {}) {
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "msp-")));
  const base = createMemoryService(workspace);
  const { strategy, memory } = createScratchPromote({
    harness: harnessOf(opts.oneShot),
    memory: base,
    workspace,
    consolidateAfter: opts.consolidateAfter ?? 0,
  });
  return { workspace, base, strategy, memory };
}

async function withNow<T>(at: number, fn: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => at;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

test("capture lands in the dated scratch log, not MEMORY.md", async () => {
  const { workspace, memory } = fresh();
  const added = await memory.capture(SCOPE, ["Prefers terse replies"], TODAY);
  assert.equal(added, 1);

  const log = (await workspace.read(SCOPE, logPath(TODAY))) ?? "";
  assert.match(log, /- \(2026-06-10\) Prefers terse replies/);

  const notebook = (await workspace.read(SCOPE, MEMORY_FILE)) ?? "";
  assert.doesNotMatch(notebook, /Prefers terse replies/, "long-term notebook holds no captured fact");

  assert.equal(await memory.capture(SCOPE, ["prefers terse replies"], TODAY), 0);
});

test("a notebook edit landing during a marker bump survives", async () => {
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "msp-")));
  const base = createMemoryService(workspace);
  let racedOnce = false;
  const racy: typeof base = {
    ...base,
    async readHead(scopeId) {
      const head = await base.readHead!(scopeId);
      if (!racedOnce) {
        racedOnce = true;
        await base.replace(scopeId, "# Memory\n\n- user edit mid-bump");
      }
      return head;
    },
  };
  const { memory } = createScratchPromote({
    harness: harnessOf(),
    memory: racy,
    workspace,
    consolidateAfter: 0,
  });

  await memory.capture(SCOPE, ["a fresh fact"], TODAY);

  const notebook = (await workspace.read(SCOPE, MEMORY_FILE)) ?? "";
  assert.match(notebook, /user edit mid-bump/, "the concurrent edit is not reverted by the marker write");
  assert.match(notebook, /captures-since-promote: 1/, "the marker still lands");
});

test("marker CAS exhaustion reports the persisted count, not the phantom bump", async () => {
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "msp-")));
  const base = createMemoryService(workspace);
  let edits = 0;
  const contended: typeof base = {
    ...base,
    async readHead(scopeId) {
      const head = await base.readHead!(scopeId);
      edits += 1;
      await base.replace(scopeId, `# Memory\n\n- concurrent edit ${edits}`);
      return head;
    },
  };
  let consolidations = 0;
  const { memory, strategy } = createScratchPromote({
    harness: harnessOf(),
    memory: contended,
    workspace,
    consolidateAfter: 1,
  });
  strategy.maintain = async () => {
    consolidations += 1;
  };

  const added = await memory.capture(SCOPE, ["a fact under contention"], TODAY);

  assert.equal(added, 1, "the capture itself still lands in the scratch log");
  assert.ok(edits >= 3, "every CAS attempt lost to a concurrent edit");
  assert.equal(consolidations, 0, "an unpersisted counter must not trigger consolidation");
  const notebook = (await workspace.read(SCOPE, MEMORY_FILE)) ?? "";
  assert.match(notebook, /concurrent edit/, "the user's edit wins over the abandoned marker write");
  assert.doesNotMatch(notebook, /captures-since-promote: 1/, "no phantom marker landed");
});

test("recall window = MEMORY.md + today + yesterday, across the day boundary", async () => {
  const { memory } = fresh();
  await memory.replace(SCOPE, "# Memory\n\n- (2026-01-01) Long-term fact");
  await memory.capture(SCOPE, ["Two days ago fact"], TODAY - 2 * DAY);
  await memory.capture(SCOPE, ["Yesterday fact"], TODAY - DAY);
  await memory.capture(SCOPE, ["Today fact"], TODAY);

  const recalled = await withNow(TODAY, () => memory.recall(SCOPE));
  assert.match(recalled, /Long-term fact/);
  assert.match(recalled, /### Scratch log 2026-06-09\n[\s\S]*Yesterday fact/);
  assert.match(recalled, /### Scratch log 2026-06-10\n[\s\S]*Today fact/);
  assert.doesNotMatch(recalled, /Two days ago fact/, "older logs age out of recall");
  assert.doesNotMatch(recalled, /captures-since-promote/, "trigger marker never reaches the prompt");

  const tomorrow = await withNow(TODAY + DAY, () => memory.recall(SCOPE));
  assert.match(tomorrow, /Today fact/);
  assert.doesNotMatch(tomorrow, /Yesterday fact/);
});

test("query greps the scratch log window in addition to the notebook", async () => {
  const { memory } = fresh();
  await memory.replace(SCOPE, "# Memory\n\n- (2026-01-01) zebra notebook fact");
  await memory.capture(SCOPE, ["zebra scratch fact"], TODAY);
  const hits = await withNow(TODAY, () => memory.query(SCOPE, "zebra"));
  assert.deepEqual(hits, ["(2026-01-01) zebra notebook fact", "(2026-06-10) zebra scratch fact"]);
});

test("maintain with readHead but no replaceIfRevision falls back to plain read and replace", async () => {
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "msp-")));
  const base = createMemoryService(workspace);
  let headReads = 0;
  const partial: typeof base = {
    ...base,
    async readHead(scopeId) {
      headReads += 1;
      return base.readHead!(scopeId);
    },
  };
  delete (partial as { replaceIfRevision?: unknown }).replaceIfRevision;
  const promoted = "# Memory\n\n- (2026-06-10) Promoted without CAS";
  const { memory, strategy } = createScratchPromote({
    harness: harnessOf(() => Promise.resolve(promoted)),
    memory: partial,
    workspace,
    consolidateAfter: 0,
  });
  await memory.capture(SCOPE, ["Promoted without CAS"], TODAY);

  await withNow(TODAY, () => strategy.maintain!(SCOPE));

  assert.equal(headReads, 0, "a snapshot revision is never taken when it cannot be enforced");
  assert.equal(await workspace.read(SCOPE, MEMORY_FILE), `${promoted}\n`);
});

test("maintain promotes: one-shot judges the window, rewrites MEMORY.md, leaves the log untouched", async () => {
  const calls: Array<{ system: string; prompt: string }> = [];
  const promoted = "# Memory\n\n- (2026-06-10) Durable graduated fact";
  const { workspace, strategy, memory } = fresh({
    oneShot(system, prompt) {
      calls.push({ system, prompt });
      return Promise.resolve(promoted);
    },
  });
  await memory.capture(SCOPE, ["Durable graduated fact", "One-off trivia"], TODAY);
  const logBefore = await workspace.read(SCOPE, logPath(TODAY));

  await withNow(TODAY, () => strategy.maintain!(SCOPE));

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.system, PROMOTION_PROMPT);
  assert.match(calls[0]!.prompt, /One-off trivia/, "judge sees the scratch window");
  assert.equal(await workspace.read(SCOPE, MEMORY_FILE), `${promoted}\n`, "MEMORY.md rewritten");
  assert.equal(await workspace.read(SCOPE, logPath(TODAY)), logBefore, "log untouched");
});

test("maintain is a no-op rewrite when the judge says NONE, and prunes logs past retention", async () => {
  const { workspace, strategy, memory } = fresh({ oneShot: () => Promise.resolve("NONE") });
  await memory.replace(SCOPE, "# Memory\n\n- keep me");
  await memory.capture(SCOPE, ["recent"], TODAY);
  const ancient = TODAY - 30 * DAY;
  await workspace.write(SCOPE, logPath(ancient), "- (2026-05-11) ancient\n");

  await withNow(TODAY, () => strategy.maintain!(SCOPE));

  assert.match((await workspace.read(SCOPE, MEMORY_FILE)) ?? "", /keep me/);
  assert.equal(await workspace.read(SCOPE, logPath(ancient)), null, "old log pruned");
  assert.match((await workspace.read(SCOPE, logPath(TODAY))) ?? "", /recent/, "recent log kept");
});

test("after-N marker trigger: the Nth capture fires promotion and resets the durable counter", async () => {
  let promotions = 0;
  const { workspace, memory } = fresh({
    oneShot(system) {
      if (system === PROMOTION_PROMPT) {
        promotions++;
        return Promise.resolve("# Memory\n\n- promoted");
      }
      return Promise.resolve("NONE");
    },
    consolidateAfter: 3,
  });
  await withNow(TODAY, async () => {
    await memory.capture(SCOPE, ["fact one"], TODAY);
    await memory.capture(SCOPE, ["fact two"], TODAY);
    assert.equal(promotions, 0);
    assert.match(
      (await workspace.read(SCOPE, MEMORY_FILE)) ?? "",
      /captures-since-promote: 2/,
      "counter lives in the notebook, not RAM",
    );
    await memory.capture(SCOPE, ["fact three"], TODAY);
  });
  assert.equal(promotions, 1);
  assert.doesNotMatch(
    (await workspace.read(SCOPE, MEMORY_FILE)) ?? "",
    /captures-since-promote: [1-9]/,
    "counter reset",
  );
});

test("concurrent captures retain both marker increments", async () => {
  const { memory } = fresh();
  await Promise.all([
    memory.capture(SCOPE, ["first concurrent fact"], TODAY),
    memory.capture(SCOPE, ["second concurrent fact"], TODAY),
  ]);
  assert.match(await memory.read(SCOPE), /captures-since-promote: 2/);
});

test("onTurnEnd extracts facts and captures them into today's log", async () => {
  const { workspace, strategy } = fresh({ oneShot: () => Promise.resolve("- Works at Acme") });
  await withNow(TODAY, () => strategy.onTurnEnd!({ scopeId: SCOPE, input: "hi", reply: "hello" }));
  assert.match((await workspace.read(SCOPE, logPath(TODAY))) ?? "", /- \(2026-06-10\) Works at Acme/);
  assert.doesNotMatch((await workspace.read(SCOPE, MEMORY_FILE)) ?? "", /Works at Acme/);
});

test("strategy wiring: scratch-promote parses, wraps the store, and ships prompt lines", () => {
  assert.equal(parseMemoryStrategyKind("scratch-promote"), "scratch-promote");
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "msp-")));
  const base = createMemoryService(workspace);
  const { strategy, memory } = createMemoryStrategy("scratch-promote", {
    harness: harnessOf(),
    memory: base,
    workspace,
  });
  assert.notEqual(memory, base, "store is wrapped");
  assert.ok(strategy.onTurnEnd && strategy.maintain);
  assert.match((strategy.promptLines?.() ?? []).join("\n"), /two tiers/);

  const perTurn = createMemoryStrategy("per-turn", { harness: harnessOf(), memory: base, workspace });
  assert.notEqual(
    perTurn.memory,
    base,
    "per-turn gets the consolidating store — captures by any path trigger the after-N check",
  );
});

test("a save landing during promotion is not reverted by the promote write", async () => {
  const { base, strategy, memory } = fresh({
    oneShot: async () => {
      await base.replace(SCOPE, "# Memory\n\n- (2026-06-10) the newer edit");
      return "# Memory\n\n- (2026-06-10) promoted fact";
    },
  });
  await withNow(TODAY, () => memory.capture(SCOPE, ["something recent"], TODAY));
  await withNow(TODAY, () => strategy.maintain!(SCOPE));
  const after = await base.read(SCOPE);
  assert.match(after, /the newer edit/, "the mid-flight edit survives");
  assert.doesNotMatch(after, /promoted fact/, "the stale promotion is dropped, not applied");
});
