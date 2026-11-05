import type { RuntimeChoice } from "../agent/agent.ts";
import { unrecordedToolResult } from "../agent/context-compaction.ts";
import type { RunStop } from "../runs/run-store.ts";
import { isAgentReply, isOverheard, type Item, type NewItem } from "../sessions/items.ts";
import { isObj } from "../util/objects.ts";

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
    if (e.turnId !== null && e.turnId !== runId) continue;
    if (e.kind === "Stop") return null;
    if (isAgentReply(e)) {
      const start = items.slice(0, i).findLast((x) => isTurnStart(x) && (x.turnId === null || x.turnId === runId));
      if (!start || !differentTurn(e, start)) return null;
      continue;
    }
    if (e.kind === "ToolCall" || e.kind === "ToolResult") {
      workEntries += 1;
      continue;
    }
    if (e.kind === "SteeringMessage") return null;
    if (!isTurnStart(e)) continue;
    return e.turnId === runId ? { userSeq: e.seq, workEntries } : null;
  }
  return null;
}

export function overtaken(items: readonly Item[], partial: PartialTurn, runId: string | undefined): boolean {
  return items.some(
    (e) =>
      e.seq > partial.userSeq && e.kind === "UserMessage" && !isOverheard(e) && e.turnId !== null && e.turnId !== runId,
  );
}

export interface RecordedTurn extends PartialTurn {
  answer?: { seq: number; text: string };
}

export function turnAtSeq(items: readonly Item[], userSeq: number): RecordedTurn | null {
  const start = items.findIndex((e) => e.seq === userSeq);
  if (start < 0) return null;
  let workEntries = 0;
  let answer: RecordedTurn["answer"];
  for (let i = start + 1; i < items.length; i++) {
    const e = items[i]!;
    if (differentTurn(e, items[start]!)) continue;
    if (isAgentReply(e)) {
      answer = { seq: e.seq, text: (e.text ?? "").trim() };
      continue;
    }
    if (e.kind === "ToolCall" || e.kind === "ToolResult" || e.kind === "SteeringMessage") {
      workEntries += 1;
      continue;
    }
    if (e.kind !== "UserMessage" || isOverheard(e) || isResumeNote(e)) continue;
    break;
  }
  return { userSeq, workEntries, ...(answer ? { answer } : {}) };
}

export interface ResumableToolCall {
  callId: string;
  tool: string;
  input: Record<string, unknown>;
}

export interface Reconciled {
  settleItems: NewItem<"ToolResult">[];
  resumed: boolean;
  rerun?: ResumableToolCall;
}

export function reconcile(history: readonly Item[], turn: PartialTurn, stop?: RunStop): Reconciled {
  if (turn.workEntries === 0) return { settleItems: [], resumed: false };
  const anchor = history.find((e) => e.seq === turn.userSeq);
  const answered = new Set(history.flatMap((e) => (e.kind === "ToolResult" ? [e.callId] : [])));
  const dangling = history.flatMap((e) =>
    e.kind === "ToolCall" &&
    e.callId &&
    !answered.has(e.callId) &&
    e.seq > turn.userSeq &&
    !differentTurn(e, anchor ?? e)
      ? [{ callId: e.callId, tool: e.tool ?? "tool", retrySafe: e.body.retrySafe, rerun: e.body.rerun }]
      : [],
  );
  const lone = dangling.length === 1 && dangling[0]!.retrySafe === true ? dangling[0]!.rerun : undefined;
  if (isObj(lone) && typeof lone.tool === "string" && isObj(lone.input) && !Array.isArray(lone.input))
    return {
      settleItems: [],
      resumed: true,
      rerun: { callId: dangling[0]!.callId, tool: lone.tool, input: lone.input },
    };
  return {
    settleItems: dangling.map(({ callId, tool }) => ({
      kind: "ToolResult",
      tool,
      callId,
      isError: true,
      text: unrecordedToolResult(stop),
      body: { interrupted: true },
    })),
    resumed: true,
  };
}

export function runtimeSwitchNote(choice: RuntimeChoice | undefined): string {
  const head = choice
    ? `[system] Runtime switched to ${choice.modelId}${choice.fastMode ? " fast" : ""}${
        choice.effortLevel && choice.effortLevel !== "auto" ? `; effort ${choice.effortLevel}` : ""
      }.`
    : "[system] Context was trimmed without a new summary.";
  return `${head} Continue from the recorded work; don't repeat completed actions or ask the user to restate.`;
}
