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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
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

test("an edit during promotion survives the stale model result", async () => {
  const entered = deferred<void>();
  const release = deferred<string>();
  const { strategy, memory } = fresh({
    oneShot: async () => {
      entered.resolve();
      return release.promise;
    },
  });
  await memory.replace(SCOPE, "# Memory\n\n- original");
  await memory.capture(SCOPE, ["recent"], TODAY);
  const maintaining = withNow(TODAY, () => strategy.maintain!(SCOPE));
  await entered.promise;
  await memory.replace(SCOPE, "# Memory\n\n- original\n- concurrent edit");
  release.resolve("# Memory\n\n- stale promotion");
  await maintaining;
  assert.match(await memory.read(SCOPE), /concurrent edit/);
  assert.doesNotMatch(await memory.read(SCOPE), /stale promotion/);
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

test("concurrent captures preserve every scratch fact and marker increment", async () => {
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "msp-")));
  const base = createMemoryService(workspace);
  const first = createScratchPromote({ harness: {}, memory: base, workspace, consolidateAfter: 0 }).memory;
  const second = createScratchPromote({ harness: {}, memory: base, workspace, consolidateAfter: 0 }).memory;
  await Promise.all([
    first.capture(SCOPE, ["first concurrent fact"], TODAY),
    second.capture(SCOPE, ["second concurrent fact"], TODAY),
  ]);
  const log = (await workspace.read(SCOPE, logPath(TODAY))) ?? "";
  assert.match(log, /first concurrent fact/);
  assert.match(log, /second concurrent fact/);
  assert.match(await first.read(SCOPE), /captures-since-promote: 2/);
});

test("concurrent equivalent captures dedupe the scratch fact and marker increment", async () => {
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "msp-")));
  const base = createMemoryService(workspace);
  const first = createScratchPromote({ harness: {}, memory: base, workspace, consolidateAfter: 0 }).memory;
  const second = createScratchPromote({ harness: {}, memory: base, workspace, consolidateAfter: 0 }).memory;
  const results = await Promise.all([
    first.capture(SCOPE, ["same concurrent fact"], TODAY),
    second.capture(SCOPE, ["SAME concurrent fact"], TODAY),
  ]);
  const log = (await workspace.read(SCOPE, logPath(TODAY))) ?? "";
  assert.equal((log.match(/concurrent fact/gi) ?? []).length, 1);
  assert.deepEqual(results.sort(), [0, 1]);
  assert.match(await first.read(SCOPE), /captures-since-promote: 1/);
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
