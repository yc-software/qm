import type { SessionEntry } from "../types.ts";
import { entryDeliveryKey, isOverheardEntry } from "../sessions/session-store.ts";

const NOTE_HEAD = "(system note:";

export interface PartialTurn {
  userSeq: number;
  workEntries: number;
}

function entryText(e: SessionEntry): string {
  return String((e.payload as { text?: string } | null)?.text ?? "").trim();
}

export function isResumeNote(text: string): boolean {
  return text.trimStart().startsWith(NOTE_HEAD);
}

const MODEL_TURN_ENTRY_TYPES = new Set<SessionEntry["type"]>(["user", "assistant", "tool_call", "tool_result"]);

export function findTrailingPartialTurn(entries: readonly SessionEntry[], inputText: string): PartialTurn | null {
  const text = inputText.trim();
  if (!text) return null;
  let workEntries = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.type === "assistant") return null;
    if (e.type === "tool_call" || e.type === "tool_result") {
      workEntries += 1;
      continue;
    }
    if (e.type !== "user") continue;
    if (isOverheardEntry(e)) continue;
    const t = entryText(e);
    if (isResumeNote(t)) continue;
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
    if (e.type === "assistant") {
      if (!entryDeliveryKey(e)) answer = { seq: e.seq, text: entryText(e) };
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
    if (isOverheardEntry(e) || isResumeNote(entryText(e))) continue;
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
  { kind: "restart" } | { kind: "note" } | { kind: "continue" } | { kind: "retry"; call: ResumableToolCall };

export function resumeStrategy(entries: readonly SessionEntry[], partial: PartialTurn): ResumeStrategy {
  if (partial.workEntries === 0) return { kind: "restart" };
  const turn = entries.filter((e) => e.seq > partial.userSeq);
  const answered = new Set<unknown>();
  for (const e of turn) {
    const payload = e.payload as { callId?: unknown; interrupted?: unknown } | null;
    if (e.type === "tool_result" && payload?.interrupted !== true) answered.add(payload?.callId);
  }
  const dangling = turn.filter(
    (e) => e.type === "tool_call" && !answered.has((e.payload as { callId?: unknown } | null)?.callId),
  );
  if (dangling.length === 0) {
    const last = turn.findLast((e) => MODEL_TURN_ENTRY_TYPES.has(e.type));
    return last?.type === "tool_result" ? { kind: "continue" } : { kind: "note" };
  }
  if (dangling.length !== 1) return { kind: "note" };
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
    return { kind: "note" };
  return {
    kind: "retry",
    call: { callId: payload.callId, tool: rerun.tool, input: rerun.input as Record<string, unknown> },
  };
}

const ROUTINE = "This was a routine platform restart; it is common and almost never worth mentioning to the user.";
const CONTINUE = "Continue from where you left off; don't start over or repeat completed steps.)";

export function resumeNote(opts?: {
  strategy?: ResumeStrategy;
  backgroundJobs?: boolean;
  cause?: "restart" | "runtime-change";
}): string {
  const strategy = opts?.strategy ?? { kind: "note" };
  if (strategy.kind === "restart") {
    return `${NOTE_HEAD} your previous attempt at the request above was interrupted before it recorded any work (a routine platform restart), so there is nothing to pick up. Start the request now.)`;
  }
  const parts =
    strategy.kind === "retry"
      ? [
          `${NOTE_HEAD} your previous attempt at the request above was paused mid-turn and has resumed.`,
          ROUTINE,
          "The result of the tool call that was in flight is recorded above.",
        ]
      : [
          `${NOTE_HEAD} your previous attempt at the request above was interrupted mid-turn.`,
          opts?.cause === "runtime-change" ? "" : ROUTINE,
          "Your work up to the interruption is recorded above; a tool result marked interrupted has an",
          "unknown outcome, so check what actually happened before redoing anything with side effects.",
        ];
  if (opts?.backgroundJobs) {
    parts.push("Background jobs on your computer kept running — `background` list/poll to check on them.");
  }
  parts.push(CONTINUE);
  return parts.filter(Boolean).join(" ");
}
