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

test("maintain without compare-and-set stays capture-only instead of blindly overwriting", async () => {
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "msp-")));
  const base = createMemoryService(workspace);
  const partial: typeof base = { ...base };
  delete (partial as { readHead?: unknown }).readHead;
  delete (partial as { replaceIfRevision?: unknown }).replaceIfRevision;
  let modelCalls = 0;
  const logs: string[] = [];
  const { memory, strategy } = createScratchPromote({
    harness: harnessOf(() => {
      modelCalls += 1;
      return Promise.resolve("# Memory\n\n- unsafe replacement");
    }),
    memory: partial,
    workspace,
    consolidateAfter: 0,
    log: (message) => logs.push(message),
  });
  await memory.replace(SCOPE, "# Memory\n\n- user edit");
  await memory.capture(SCOPE, ["scratch capture"], TODAY);

  await withNow(TODAY, () => strategy.maintain!(SCOPE));

  assert.equal(modelCalls, 0);
  assert.match(await base.read(SCOPE), /user edit/);
  assert.match((await workspace.read(SCOPE, logPath(TODAY))) ?? "", /scratch capture/);
  assert.match(logs[0] ?? "", /capture-only/);
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

test("maintain refuses a runaway promotion: an oversized one-shot output leaves the notebook untouched and skips log pruning", async () => {
  const runaway = "I'll scan for new signed replies… ".repeat(2_000);
  const { workspace, strategy, memory } = fresh({ oneShot: () => Promise.resolve(runaway) });
  await memory.replace(SCOPE, "# Memory\n\n- keep me");
  await memory.capture(SCOPE, ["recent"], TODAY);
  const ancient = TODAY - 30 * DAY;
  await workspace.write(SCOPE, logPath(ancient), "- (2026-05-11) ancient\n");

  await withNow(TODAY, () => strategy.maintain!(SCOPE));

  const notebook = (await workspace.read(SCOPE, MEMORY_FILE)) ?? "";
  assert.match(notebook, /keep me/, "the existing notebook survives");
  assert.doesNotMatch(notebook, /scan for new signed replies/, "the runaway output is never persisted");
  assert.match(
    (await workspace.read(SCOPE, logPath(ancient))) ?? "",
    /ancient/,
    "unpromoted logs are not pruned when promotion was discarded",
  );
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
  let calls = 0;
  const { base, strategy, memory } = fresh({
    oneShot: async () => {
      calls += 1;
      if (calls === 1) {
        await base.replace(SCOPE, "# Memory\n\n- (2026-06-10) the newer edit");
        return "# Memory\n\n- (2026-06-10) stale promotion";
      }
      return "NONE";
    },
  });
  await withNow(TODAY, () => memory.capture(SCOPE, ["something recent"], TODAY));
  await withNow(TODAY, () => strategy.maintain!(SCOPE));
  const after = await base.read(SCOPE);
  assert.equal(calls, 2);
  assert.match(after, /the newer edit/, "the retry is based on the mid-flight edit");
  assert.doesNotMatch(after, /stale promotion/, "the stale model result is never replayed");
});

test("promotion retries from a fresh snapshot and consumes every pending capture only after commit", async () => {
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "msp-")));
  const base = createMemoryService(workspace);
  let started!: () => void;
  const modelStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prompts: string[] = [];
  const first = createScratchPromote({
    harness: harnessOf(async (_system, prompt) => {
      prompts.push(prompt);
      if (prompts.length === 1) {
        started();
        await blocked;
      }
      return prompts.length === 1 ? "# Memory\n\n- stale promotion" : "# Memory\n\n- first capture\n- second capture";
    }),
    memory: base,
    workspace,
    consolidateAfter: 0,
  });
  const second = createScratchPromote({ harness: harnessOf(), memory: base, workspace, consolidateAfter: 0 });
  await withNow(TODAY, () => first.memory.capture(SCOPE, ["first capture"], TODAY));

  const maintenance = withNow(TODAY, () => first.strategy.maintain!(SCOPE));
  await modelStarted;
  await withNow(TODAY, () => second.memory.capture(SCOPE, ["second capture"], TODAY));
  assert.match(await base.read(SCOPE), /captures-since-promote: 2/);
  release();
  await maintenance;

  assert.equal(prompts.length, 2);
  assert.doesNotMatch(prompts[0]!, /second capture/);
  assert.match(prompts[1]!, /second capture/, "the retry rebuilds input instead of replaying a stale model result");
  const after = await base.read(SCOPE);
  assert.match(after, /first capture/);
  assert.match(after, /second capture/);
  assert.doesNotMatch(after, /stale promotion/);
  assert.doesNotMatch(after, /captures-since-promote/, "the committed pass atomically consumes its trigger credit");
});

test("promotion provider and write failures retain pending trigger credit", async () => {
  let providerCalls = 0;
  const providerFailure = fresh({
    oneShot() {
      providerCalls += 1;
      return providerCalls === 1
        ? Promise.reject(new Error("provider unavailable"))
        : Promise.resolve("# Memory\n\n- provider failure capture\n- retry capture");
    },
    consolidateAfter: 1,
  });
  await withNow(TODAY, () => providerFailure.memory.capture(SCOPE, ["provider failure capture"], TODAY));
  assert.match(await providerFailure.base.read(SCOPE), /captures-since-promote: 1/);
  await withNow(TODAY, () => providerFailure.memory.capture(SCOPE, ["retry capture"], TODAY));
  const afterRetry = await providerFailure.base.read(SCOPE);
  assert.match(afterRetry, /provider failure capture/);
  assert.match(afterRetry, /retry capture/);
  assert.doesNotMatch(afterRetry, /captures-since-promote/);

  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "msp-")));
  const base = createMemoryService(workspace);
  const failingWrite: typeof base = {
    ...base,
    async replaceIfRevision(scopeId, content, revision, author) {
      if (!/captures-since-promote: [1-9]/.test(content)) throw new Error("write unavailable");
      return base.replaceIfRevision!(scopeId, content, revision, author);
    },
  };
  const wrapped = createScratchPromote({
    harness: harnessOf(() => Promise.resolve("# Memory\n\n- promoted")),
    memory: failingWrite,
    workspace,
    consolidateAfter: 1,
  });
  await withNow(TODAY, () => wrapped.memory.capture(SCOPE, ["write failure capture"], TODAY));
  assert.match(await base.read(SCOPE), /captures-since-promote: 1/);
  assert.match((await workspace.read(SCOPE, logPath(TODAY))) ?? "", /write failure capture/);
});
