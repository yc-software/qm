import type { RuntimeChoice } from "../harness/harness.ts";
import { unrecordedToolResult } from "../harness/context-compaction.ts";
import type { RunStop } from "../runs/run-store.ts";
import { isOverheard, isReply, type Item, type NewItem } from "../sessions/items.ts";

const differentTurn = (item: Item, turn: Item): boolean =>
  item.turnId !== null && turn.turnId !== null && item.turnId !== turn.turnId;

export interface PartialTurn {
  userSeq: number;
  workEntries: number;
}

function isResumeNote(e: Item): boolean {
  return e.body.resumeNote === true;
}

const isTurnStart = (e: Item): boolean => e.kind === "UserMessage" && !isOverheard(e) && !isResumeNote(e);

export function findTrailingPartialTurn(items: readonly Item[], runId: string | undefined): PartialTurn | null {
  if (!runId) return null;
  let workEntries = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const e = items[i]!;
    if (e.kind === "Stop") return null;
    if (isReply(e)) {
      const start = items.slice(0, i).findLast(isTurnStart);
      if (!start || !differentTurn(e, start)) return null;
      continue;
    }
    if (e.kind === "ToolCall" || e.kind === "ToolResult") {
      workEntries += 1;
      continue;
    }
    if (e.kind === "SteeringMessage") return null;
    if (e.kind !== "UserMessage" || isOverheard(e) || isResumeNote(e)) continue;
    return e.turnId === runId ? { userSeq: e.seq, workEntries } : null;
  }
  return null;
}

export interface RecordedTurn extends PartialTurn {
  answer?: { seq: number; text: string };
}

export function turnAtSeq(entries: readonly Item[], userSeq: number): RecordedTurn | null {
  const start = entries.findIndex((e) => e.seq === userSeq);
  if (start < 0) return null;
  let workEntries = 0;
  let answer: RecordedTurn["answer"];
  for (let i = start + 1; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.kind !== "UserMessage" && e.kind !== "SteeringMessage" && differentTurn(e, entries[start]!)) continue;
    if (isReply(e)) {
      answer = { seq: e.seq, text: (e.text ?? "").trim() };
      continue;
    }
    if (e.kind === "ToolCall" || e.kind === "ToolResult" || e.kind === "SteeringMessage") {
      workEntries += 1;
      continue;
    }
    if (e.kind !== "UserMessage") continue;
    if (isOverheard(e) || isResumeNote(e)) continue;
    break;
  }
  return { userSeq, workEntries, ...(answer ? { answer } : {}) };
}

export interface ResumableToolCall {
  callId: string;
  tool: string;
  input: Record<string, unknown>;
}

export type ResumeStrategy =
  | { kind: "restart" }
  | { kind: "continue" }
  | { kind: "retry"; call: ResumableToolCall }
  | { kind: "settle"; calls: Array<{ callId: string; tool: string }> };

export function resumeStrategy(entries: readonly Item[], partial: PartialTurn): ResumeStrategy {
  if (partial.workEntries === 0) return { kind: "restart" };
  const anchor = entries.find((e) => e.seq === partial.userSeq);
  const turn = entries.filter((e) => e.seq > partial.userSeq && (!anchor || !differentTurn(e, anchor)));
  const answered = new Set<string | null>();
  const withResult = new Set<string | null>();
  for (const e of turn) {
    if (e.kind !== "ToolResult") continue;
    withResult.add(e.callId);
    if (e.body.interrupted !== true) answered.add(e.callId);
  }
  const dangling = turn.filter((e) => e.kind === "ToolCall" && !answered.has(e.callId));
  if (dangling.length === 0) return { kind: "continue" };
  const unrecorded = dangling.flatMap((e) =>
    e.callId && !withResult.has(e.callId) ? [{ callId: e.callId, tool: e.tool ?? "tool" }] : [],
  );
  const settle: ResumeStrategy = unrecorded.length ? { kind: "settle", calls: unrecorded } : { kind: "continue" };
  if (dangling.length !== 1) return settle;
  const call = dangling[0]!;
  const rerun = call.body.rerun as { tool?: unknown; input?: unknown } | undefined;
  if (
    call.body.retrySafe !== true ||
    !call.callId ||
    typeof rerun?.tool !== "string" ||
    rerun.input === null ||
    typeof rerun.input !== "object" ||
    Array.isArray(rerun.input)
  )
    return settle;
  return {
    kind: "retry",
    call: { callId: call.callId, tool: rerun.tool, input: rerun.input as Record<string, unknown> },
  };
}

export function unrecordedResultItems(
  strategy: Extract<ResumeStrategy, { kind: "settle" }>,
  stop: RunStop | undefined,
): NewItem<"ToolResult">[] {
  return strategy.calls.map((call) => ({
    kind: "ToolResult",
    tool: call.tool,
    callId: call.callId,
    isError: true,
    text: unrecordedToolResult(stop),
    body: { interrupted: true },
  }));
}

export function runtimeSwitchNote(choice: RuntimeChoice | undefined): string {
  const head = choice
    ? `[system] Runtime switched to ${choice.modelId}${choice.fastMode ? " fast" : ""}${
        choice.effortLevel && choice.effortLevel !== "auto" ? `; effort ${choice.effortLevel}` : ""
      }.`
    : "[system] Context was trimmed without a new summary.";
  return `${head} Continue from the recorded work; don't repeat completed actions or ask the user to restate.`;
}
