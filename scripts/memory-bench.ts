import { fileURLToPath } from "node:url";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiHarness, piHarnessConfigOptions } from "../src/harness/pi-harness.ts";
import { loadConfig } from "../src/config.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createMemoryService, MEMORY_FILE } from "../src/memory/memory-service.ts";
import { createMemoryStrategy, DEFAULT_MEMORY_STRATEGY, type MemoryStrategyKind } from "../src/memory/strategy.ts";
import {
  DEFAULT_STRATEGY_FLOORS,
  floorFailures,
  formatTable,
  JUDGE_PROMPT,
  parseBenchConversation,
  parseJudgeVerdict,
  renderJudgeInput,
  replayConversation,
  summarize,
  type BenchResult,
} from "../src/memory/bench.ts";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY not set — the benchmark replays extraction and judges with a live model.");
  process.exit(1);
}

const KNOWN_KINDS: MemoryStrategyKind[] = ["per-turn", "agent-only"];
const requested = (process.env.MEMORY_BENCH_KINDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const kinds: MemoryStrategyKind[] = requested.length ? (requested as MemoryStrategyKind[]) : KNOWN_KINDS;
for (const k of kinds) {
  if (!KNOWN_KINDS.includes(k)) {
    console.error(`unknown strategy kind '${k}' (known: ${KNOWN_KINDS.join(", ")})`);
    process.exit(1);
  }
}

const fixtureDir = fileURLToPath(new URL("../test/memory-bench/conversations/", import.meta.url));
const conversations = readdirSync(fixtureDir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => parseBenchConversation(JSON.parse(readFileSync(join(fixtureDir, f), "utf8")), f));

const harness = createPiHarness({ ...piHarnessConfigOptions(loadConfig()), tempDirPrefix: "membench" });
if (!harness.models.oneShot) {
  console.error("harness has no oneShot — cannot judge");
  process.exit(1);
}
const oneShot = harness.models.oneShot.bind(harness.models);

const results: BenchResult[] = [];
for (const kind of kinds) {
  for (const conversation of conversations) {
    const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), `membench-${kind}-`)));
    const memory = createMemoryService(workspace);
    const { strategy } = createMemoryStrategy(kind, { harness: harness.models, memory, workspace });
    const scopeId = "user:bench";
    if (!strategy.onTurnEnd && !strategy.maintain) {
      console.log(`[${kind}] ${conversation.id}: no automatic capture — judging empty notebook`);
    }
    await replayConversation(strategy, scopeId, conversation);
    const notebook = (await workspace.read(scopeId, MEMORY_FILE)) ?? "";
    const judgeOut = await oneShot(JUDGE_PROMPT, renderJudgeInput(conversation, notebook));
    const verdict = parseJudgeVerdict(judgeOut ?? "");
    results.push({ kind, conversationId: conversation.id, notebook, verdict });
    console.log(
      `[${kind}] ${conversation.id}: s/n=${verdict.signalToNoise} stale=${verdict.staleness} ` +
        `infer=${verdict.inferenceVsObservation} — ${verdict.notes}`,
    );
  }
}

const rows = summarize(results);
console.log(`\n${formatTable(rows)}\n`);

const outPath = process.env.MEMORY_BENCH_OUT;
if (outPath) {
  writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), rows, results }, null, 2));
  console.log(`report written to ${outPath}`);
}

const defaultRow = rows.find((r) => r.kind === DEFAULT_MEMORY_STRATEGY);
if (defaultRow) {
  const failures = floorFailures(defaultRow);
  if (failures.length) {
    console.error(
      `default strategy '${DEFAULT_MEMORY_STRATEGY}' is below its quality floors ` +
        `(${JSON.stringify(DEFAULT_STRATEGY_FLOORS)}): ${failures.join("; ")}`,
    );
    process.exit(2);
  }
}
