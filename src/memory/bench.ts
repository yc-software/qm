import type { ScopeId } from "../types.ts";
import type { MemoryStrategy, MemoryStrategyKind } from "./strategy.ts";

export interface BenchConversation {
  id: string;
  description: string;
  turns: Array<{ input: string; reply: string }>;
}

export interface JudgeVerdict {
  signalToNoise: number;
  staleness: number;
  inferenceVsObservation: number;
  notes: string;
}

export interface BenchResult {
  kind: MemoryStrategyKind;
  conversationId: string;
  notebook: string;
  verdict: JudgeVerdict;
}

export interface BenchSummaryRow {
  kind: MemoryStrategyKind;
  conversations: number;
  signalToNoise: number;
  staleness: number;
  inferenceVsObservation: number;
  overall: number;
}

export function parseBenchConversation(raw: unknown, source: string): BenchConversation {
  const o = raw as Partial<BenchConversation> | null;
  if (!o || typeof o.id !== "string" || typeof o.description !== "string" || !Array.isArray(o.turns)) {
    throw new Error(`malformed bench conversation in ${source}`);
  }
  for (const t of o.turns) {
    if (typeof t?.input !== "string" || typeof t?.reply !== "string") {
      throw new Error(`malformed turn in ${source} (${o.id})`);
    }
  }
  return { id: o.id, description: o.description, turns: o.turns };
}

export async function replayConversation(
  strategy: MemoryStrategy,
  scopeId: ScopeId,
  conversation: BenchConversation,
): Promise<void> {
  for (const turn of conversation.turns) {
    await strategy.onTurnEnd?.({ scopeId, input: turn.input, reply: turn.reply });
  }
  await strategy.maintain?.(scopeId);
}

export const JUDGE_PROMPT = [
  "You judge the quality of an agent's long-term memory notebook produced from a conversation.",
  "You are given the full conversation (user/assistant turns) and the notebook the memory",
  "strategy wrote. Score the NOTEBOOK on three axes, each an integer 0-10 (10 = best):",
  "- signalToNoise: durable, reusable facts (preferences, identifiers, ongoing projects)",
  "  vs one-off trivia, filler, duplicates, or secrets that should never be stored.",
  "- staleness: when a fact changed during the conversation, does the notebook reflect",
  "  the LATEST state (or clearly supersede the old one) rather than the stale version?",
  "- inferenceVsObservation: entries are things actually stated or observed, not the",
  "  model's speculation dressed up as fact.",
  "An EMPTY notebook is not automatically bad: score signalToNoise low only if the",
  "conversation clearly contained durable facts worth keeping.",
  'Reply with ONLY a JSON object: {"signalToNoise": n, "staleness": n,',
  '"inferenceVsObservation": n, "notes": "<one or two sentences>"}',
].join("\n");

export function renderJudgeInput(conversation: BenchConversation, notebook: string): string {
  const transcript = conversation.turns.map((t) => `USER: ${t.input}\nASSISTANT: ${t.reply}`).join("\n\n");
  return [
    `Conversation (${conversation.id}: ${conversation.description}):`,
    transcript,
    "",
    "Notebook produced by the memory strategy:",
    notebook.trim() ? notebook : "(empty)",
  ].join("\n");
}

function clampScore(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return Math.min(10, Math.max(0, Math.round(v)));
}

export function parseJudgeVerdict(out: string): JudgeVerdict {
  const match = /\{[\s\S]*\}/.exec(out);
  if (!match) throw new Error(`judge output had no JSON object: ${out.slice(0, 200)}`);
  const o = JSON.parse(match[0]) as Partial<JudgeVerdict>;
  return {
    signalToNoise: clampScore(o.signalToNoise),
    staleness: clampScore(o.staleness),
    inferenceVsObservation: clampScore(o.inferenceVsObservation),
    notes: typeof o.notes === "string" ? o.notes : "",
  };
}

export function summarize(results: BenchResult[]): BenchSummaryRow[] {
  const byKind = new Map<MemoryStrategyKind, BenchResult[]>();
  for (const r of results) {
    const list = byKind.get(r.kind) ?? [];
    list.push(r);
    byKind.set(r.kind, list);
  }
  const rows: BenchSummaryRow[] = [];
  for (const [kind, list] of byKind) {
    const avg = (pick: (v: JudgeVerdict) => number) =>
      Math.round((list.reduce((s, r) => s + pick(r.verdict), 0) / list.length) * 10) / 10;
    const signalToNoise = avg((v) => v.signalToNoise);
    const staleness = avg((v) => v.staleness);
    const inferenceVsObservation = avg((v) => v.inferenceVsObservation);
    rows.push({
      kind,
      conversations: list.length,
      signalToNoise,
      staleness,
      inferenceVsObservation,
      overall: Math.round(((signalToNoise + staleness + inferenceVsObservation) / 3) * 10) / 10,
    });
  }
  return rows.sort((a, b) => b.overall - a.overall);
}

export function formatTable(rows: BenchSummaryRow[]): string {
  const header = ["strategy", "convs", "signal/noise", "staleness", "infer-vs-obs", "overall"];
  const data = rows.map((r) => [
    r.kind,
    String(r.conversations),
    r.signalToNoise.toFixed(1),
    r.staleness.toFixed(1),
    r.inferenceVsObservation.toFixed(1),
    r.overall.toFixed(1),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...data.map((row) => row[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  return [line(header), line(widths.map((w) => "-".repeat(w))), ...data.map(line)].join("\n");
}

export const DEFAULT_STRATEGY_FLOORS = { signalToNoise: 5, staleness: 4, inferenceVsObservation: 5 } as const;

export function floorFailures(row: BenchSummaryRow): string[] {
  const failures: string[] = [];
  for (const [axis, floor] of Object.entries(DEFAULT_STRATEGY_FLOORS)) {
    const score = row[axis as keyof typeof DEFAULT_STRATEGY_FLOORS];
    if (score < floor) failures.push(`${axis} ${score} < floor ${floor}`);
  }
  return failures;
}
