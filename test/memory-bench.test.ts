import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createMemoryService, MEMORY_FILE } from "../src/memory/memory-service.ts";
import { createMemoryStrategy } from "../src/memory/strategy.ts";
import { createMockHarness } from "../src/harness/mock-harness.ts";
import {
  floorFailures,
  formatTable,
  parseBenchConversation,
  parseJudgeVerdict,
  renderJudgeInput,
  replayConversation,
  summarize,
  type BenchConversation,
  type BenchResult,
} from "../src/memory/bench.ts";

const FIXTURE_DIR = fileURLToPath(new URL("./memory-bench/conversations/", import.meta.url));

test("every bench fixture parses and has at least two turns", () => {
  const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json"));
  assert.ok(files.length >= 5, "fixed conversation set exists");
  for (const f of files) {
    const conv = parseBenchConversation(JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf8")), f);
    assert.ok(conv.turns.length >= 2, `${f} has a real conversation`);
    assert.equal(conv.id, f.replace(/\.json$/, ""), `${f} id matches filename`);
  }
});

test("parseBenchConversation rejects malformed input", () => {
  assert.throws(() => parseBenchConversation({ id: "x" }, "x.json"));
  assert.throws(() => parseBenchConversation({ id: "x", description: "d", turns: [{ input: "hi" }] }, "x.json"));
});

test("replayConversation runs every turn through the strategy and writes the notebook", async () => {
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "membench-")));
  const memory = createMemoryService(workspace);
  const { strategy } = createMemoryStrategy("per-turn", { harness: createMockHarness().models, memory, workspace });
  const conv: BenchConversation = {
    id: "t",
    description: "test",
    turns: [
      { input: "remember that I own the billing service", reply: "ok" },
      { input: "remember that I prefer terse replies", reply: "ok" },
    ],
  };
  await replayConversation(strategy, "user:U1", conv);
  const notebook = (await workspace.read("user:U1", MEMORY_FILE)) ?? "";
  assert.match(notebook, /billing service/);
  assert.match(notebook, /terse replies/);
});

test("replayConversation tolerates strategies with no automatic capture (agent-only)", async () => {
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "membench-")));
  const memory = createMemoryService(workspace);
  const { strategy } = createMemoryStrategy("agent-only", { harness: createMockHarness().models, memory, workspace });
  const conv: BenchConversation = { id: "t", description: "test", turns: [{ input: "hi", reply: "yo" }] };
  await replayConversation(strategy, "user:U1", conv);
  assert.equal(await workspace.read("user:U1", MEMORY_FILE), null);
});

test("renderJudgeInput includes the transcript and marks an empty notebook", () => {
  const conv: BenchConversation = { id: "t", description: "d", turns: [{ input: "a", reply: "b" }] };
  const out = renderJudgeInput(conv, "");
  assert.match(out, /USER: a/);
  assert.match(out, /ASSISTANT: b/);
  assert.match(out, /\(empty\)/);
});

test("parseJudgeVerdict reads plain JSON, fenced JSON, and clamps out-of-range scores", () => {
  const v1 = parseJudgeVerdict('{"signalToNoise": 8, "staleness": 7, "inferenceVsObservation": 9, "notes": "good"}');
  assert.deepEqual(v1, { signalToNoise: 8, staleness: 7, inferenceVsObservation: 9, notes: "good" });

  const v2 = parseJudgeVerdict(
    'Here you go:\n```json\n{"signalToNoise": 14, "staleness": -2, "inferenceVsObservation": 5.6, "notes": "x"}\n```',
  );
  assert.deepEqual(v2, { signalToNoise: 10, staleness: 0, inferenceVsObservation: 6, notes: "x" });

  assert.throws(() => parseJudgeVerdict("no json here"));
});

function result(kind: "per-turn" | "agent-only", id: string, s: number, st: number, i: number): BenchResult {
  return {
    kind,
    conversationId: id,
    notebook: "",
    verdict: { signalToNoise: s, staleness: st, inferenceVsObservation: i, notes: "" },
  };
}

test("summarize averages per strategy and sorts by overall; formatTable renders every row", () => {
  const rows = summarize([
    result("per-turn", "a", 8, 6, 9),
    result("per-turn", "b", 6, 4, 7),
    result("agent-only", "a", 2, 10, 10),
  ]);
  assert.equal(rows.length, 2);
  const perTurn = rows.find((r) => r.kind === "per-turn")!;
  assert.equal(perTurn.conversations, 2);
  assert.equal(perTurn.signalToNoise, 7);
  assert.equal(perTurn.staleness, 5);
  assert.equal(perTurn.inferenceVsObservation, 8);
  assert.ok(rows[0]!.overall >= rows[1]!.overall, "sorted best-first");

  const table = formatTable(rows);
  assert.match(table, /per-turn/);
  assert.match(table, /agent-only/);
  assert.match(table, /signal\/noise/);
});

test("floorFailures flags only axes below the default-strategy floors", () => {
  const good = summarize([result("per-turn", "a", 8, 8, 8)])[0]!;
  assert.deepEqual(floorFailures(good), []);
  const bad = summarize([result("per-turn", "a", 3, 8, 8)])[0]!;
  assert.equal(bad.signalToNoise, 3);
  assert.equal(floorFailures(bad).length, 1);
  assert.match(floorFailures(bad)[0]!, /signalToNoise/);
});
