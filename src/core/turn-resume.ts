import type { RunStop } from "../runs/run-store.ts";
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

const CONTINUE = "Continue from where you left off; don't start over or repeat completed steps.)";

export type ResumeCause = RunStop | { kind: "runtime_change" };

/** Why the previous attempt stopped, in words, from the cause the run store recorded. Never guessed. */
function causePhrase(cause: ResumeCause | undefined): string {
  switch (cause?.kind) {
    case "shutdown":
      return "the server running it restarted for a routine platform deploy";
    case "lease_expired":
      return "the worker running it stopped responding (a crash or forced restart)";
    case "runtime_change":
      return "the runtime was switched";
    case "error": {
      const detail = cause.message ? `: ${cause.message}` : "";
      if (!cause.code) return `it failed with an error${detail}`;
      return `the model provider call failed (${cause.code}${cause.status !== undefined ? `, HTTP ${cause.status}` : ""})${detail}`;
    }
    default:
      return "it stopped before finishing (cause not recorded)";
  }
}

const PROVIDER_HINT = "If the same model keeps failing, consider switching to another model with your runtime tool.";

export function resumeNote(opts?: {
  strategy?: ResumeStrategy;
  backgroundJobs?: boolean;
  cause?: ResumeCause;
}): string {
  const strategy = opts?.strategy ?? { kind: "note" };
  const why = causePhrase(opts?.cause);
  const hint = opts?.cause?.kind === "error" && opts.cause.code ? PROVIDER_HINT : "";
  if (strategy.kind === "restart") {
    return [
      `${NOTE_HEAD} your previous attempt at the request above stopped before it recorded any work — ${why}.`,
      hint,
      "There is nothing to pick up. Start the request now.)",
    ]
      .filter(Boolean)
      .join(" ");
  }
  const parts =
    strategy.kind === "retry"
      ? [
          `${NOTE_HEAD} your previous attempt at the request above stopped mid-turn — ${why} — and has resumed.`,
          "The result of the tool call that was in flight is recorded above.",
        ]
      : [
          `${NOTE_HEAD} your previous attempt at the request above was interrupted mid-turn — ${why}.`,
          "Your work up to the interruption is recorded above; a tool result marked interrupted has an",
          "unknown outcome, so check what actually happened before redoing anything with side effects.",
        ];
  if (hint) parts.push(hint);
  if (opts?.backgroundJobs) {
    parts.push("Background jobs on your computer kept running — `background` list/poll to check on them.");
  }
  parts.push(CONTINUE);
  return parts.filter(Boolean).join(" ");
}
