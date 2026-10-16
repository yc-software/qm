import { TURN_STOPPED_KIND } from "../harness/replay.ts";
import type { RuntimeChoice } from "../harness/harness.ts";
import { unrecordedToolResult } from "../harness/context-compaction.ts";
import type { RunStop } from "../runs/run-store.ts";
import type { SessionEntry } from "../types.ts";
import { isOverheardEntry, type NewEntry } from "../sessions/session-store.ts";

const entryTurnId = (entry: SessionEntry): unknown => (entry.payload as { runId?: unknown } | null)?.runId;
const differentTurn = (entry: SessionEntry, turn: SessionEntry): boolean =>
  entryTurnId(entry) != null && entryTurnId(turn) != null && entryTurnId(entry) !== entryTurnId(turn);

export interface PartialTurn {
  userSeq: number;
  workEntries: number;
}

function entryText(e: SessionEntry): string {
  return String((e.payload as { text?: string } | null)?.text ?? "").trim();
}

function isResumeNote(e: SessionEntry): boolean {
  return (e.payload as { resumeNote?: unknown } | null)?.resumeNote === true;
}

function isTurnStoppedEntry(e: SessionEntry): boolean {
  return e.type === "system" && (e.payload as { kind?: unknown } | null)?.kind === TURN_STOPPED_KIND;
}

export function findTrailingPartialTurn(entries: readonly SessionEntry[], inputText: string): PartialTurn | null {
  const text = inputText.trim();
  if (!text) return null;
  let workEntries = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (isTurnStoppedEntry(e)) return null;
    if (e.type === "assistant") {
      const start = entries
        .slice(0, i)
        .findLast(
          (item) => item.type === "user" && !isOverheardEntry(item) && !isSteerEntry(item) && !isResumeNote(item),
        );
      if (!start || !differentTurn(e, start)) return null;
      continue;
    }
    if (e.type === "tool_call" || e.type === "tool_result") {
      workEntries += 1;
      continue;
    }
    if (e.type !== "user") continue;
    if (isOverheardEntry(e)) continue;
    if (isResumeNote(e)) continue;
    const t = entryText(e);
    return t.startsWith(text) ? { userSeq: e.seq, workEntries } : null;
  }
  return null;
}

export interface RecordedTurn extends PartialTurn {
  answer?: { seq: number; text: string };
}

function isSteerEntry(e: SessionEntry): boolean {
  return (e.payload as { steered?: unknown } | null)?.steered === true;
}

export function turnAtSeq(entries: readonly SessionEntry[], userSeq: number): RecordedTurn | null {
  const start = entries.findIndex((e) => e.seq === userSeq);
  if (start < 0) return null;
  let workEntries = 0;
  let answer: RecordedTurn["answer"];
  for (let i = start + 1; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.type !== "user" && differentTurn(e, entries[start]!)) continue;
    if (e.type === "assistant") {
      answer = { seq: e.seq, text: entryText(e) };
      continue;
    }
    if (e.type === "tool_call" || e.type === "tool_result") {
      workEntries += 1;
      continue;
    }
    if (e.type !== "user") continue;
    if (isSteerEntry(e)) {
      workEntries += 1;
      continue;
    }
    if (isOverheardEntry(e) || isResumeNote(e)) continue;
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

export function resumeStrategy(entries: readonly SessionEntry[], partial: PartialTurn): ResumeStrategy {
  if (partial.workEntries === 0) return { kind: "restart" };
  const anchor = entries.find((e) => e.seq === partial.userSeq);
  const turn = entries.filter((e) => e.seq > partial.userSeq && (!anchor || !differentTurn(e, anchor)));
  const answered = new Set<unknown>();
  const withResult = new Set<unknown>();
  for (const e of turn) {
    const payload = e.payload as { callId?: unknown; interrupted?: unknown } | null;
    if (e.type !== "tool_result") continue;
    withResult.add(payload?.callId);
    if (payload?.interrupted !== true) answered.add(payload?.callId);
  }
  const dangling = turn.filter(
    (e) => e.type === "tool_call" && !answered.has((e.payload as { callId?: unknown } | null)?.callId),
  );
  if (dangling.length === 0) return { kind: "continue" };
  const unrecorded = dangling.flatMap((e) => {
    const p = e.payload as { callId?: unknown; tool?: unknown } | null;
    return typeof p?.callId === "string" && !withResult.has(p.callId)
      ? [{ callId: p.callId, tool: typeof p.tool === "string" ? p.tool : "tool" }]
      : [];
  });
  const settle: ResumeStrategy = unrecorded.length ? { kind: "settle", calls: unrecorded } : { kind: "continue" };
  if (dangling.length !== 1) return settle;
  const payload = dangling[0]!.payload as {
    callId?: unknown;
    retrySafe?: unknown;
    rerun?: { tool?: unknown; input?: unknown };
  } | null;
  const rerun = payload?.rerun;
  if (
    payload?.retrySafe !== true ||
    typeof payload.callId !== "string" ||
    typeof rerun?.tool !== "string" ||
    rerun.input === null ||
    typeof rerun.input !== "object" ||
    Array.isArray(rerun.input)
  )
    return settle;
  return {
    kind: "retry",
    call: { callId: payload.callId, tool: rerun.tool, input: rerun.input as Record<string, unknown> },
  };
}

export function unrecordedResultEntries(
  strategy: Extract<ResumeStrategy, { kind: "settle" }>,
  stop: RunStop | undefined,
  scopeLabel: NewEntry["scopeLabel"],
): NewEntry[] {
  return strategy.calls.map((call) => ({
    type: "tool_result",
    payload: {
      tool: call.tool,
      callId: call.callId,
      interrupted: true,
      isError: true,
      result: unrecordedToolResult(stop),
    },
    scopeLabel,
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
