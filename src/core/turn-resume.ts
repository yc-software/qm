import type { RuntimeChoice } from "../harness/harness.ts";
import { unrecordedToolResult } from "../harness/context-compaction.ts";

export { unrecordedToolResult };
import type { RunStop } from "../runs/run-store.ts";
import type { SessionEntry } from "../types.ts";
import { entryDeliveryKey, isOverheardEntry } from "../sessions/session-store.ts";

const RESUME_HEAD = "[system] Your previous attempt";
const RUNTIME_HEAD = "[system] Runtime switched";
const TRIMMED_HEAD = "[system] Context was trimmed";
/** Resume notes written before the [system] wording; still present in stored history. */
const LEGACY_NOTE_HEAD = "(system note:";

export interface PartialTurn {
  userSeq: number;
  workEntries: number;
}

function entryText(e: SessionEntry): string {
  return String((e.payload as { text?: string } | null)?.text ?? "").trim();
}

export function isResumeNote(text: string): boolean {
  const t = text.trimStart();
  return [RESUME_HEAD, RUNTIME_HEAD, TRIMMED_HEAD, LEGACY_NOTE_HEAD].some((head) => t.startsWith(head));
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
  | { kind: "restart" }
  | { kind: "note" }
  | { kind: "continue" }
  | { kind: "retry"; call: ResumableToolCall }
  /** Tool calls whose outcome was never recorded: record what happened as their results, then continue. */
  | { kind: "settle"; calls: Array<{ callId: string; tool: string }> };

export function resumeStrategy(entries: readonly SessionEntry[], partial: PartialTurn): ResumeStrategy {
  if (partial.workEntries === 0) return { kind: "restart" };
  const turn = entries.filter((e) => e.seq > partial.userSeq);
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
  if (dangling.length === 0) {
    const last = turn.findLast((e) => MODEL_TURN_ENTRY_TYPES.has(e.type));
    return last?.type === "tool_result" ? { kind: "continue" } : { kind: "note" };
  }
  // Calls with no result at all get one recording what happened; a call whose re-run was itself cut off
  // already has a result, so it only gets the note.
  const unrecorded = dangling.flatMap((e) => {
    const p = e.payload as { callId?: unknown; tool?: unknown } | null;
    return typeof p?.callId === "string" && !withResult.has(p.callId)
      ? [{ callId: p.callId, tool: typeof p.tool === "string" ? p.tool : "tool" }]
      : [];
  });
  const settle: ResumeStrategy = unrecorded.length ? { kind: "settle", calls: unrecorded } : { kind: "note" };
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

export type ResumeCause = RunStop;

/** Why the previous attempt stopped, from the cause the run store recorded. Never guessed. */
function causePhrase(cause: ResumeCause | undefined): string {
  switch (cause?.kind) {
    case "shutdown":
      return "a routine platform deploy";
    case "lease_expired":
      return "the worker crashed";
    case "error":
      return cause.code ? `a model-provider call failed (${providerDetail(cause)})` : "an internal error";
    default:
      return "cause not recorded";
  }
}

function providerDetail(cause: { code?: string; status?: number }): string {
  return `${cause.code}${cause.status !== undefined ? `, HTTP ${cause.status}` : ""}`;
}

const QUIET = "Don't mention this.";

export function resumeNote(opts?: {
  strategy?: ResumeStrategy;
  backgroundJobs?: boolean;
  cause?: ResumeCause;
}): string {
  const why = causePhrase(opts?.cause);
  if (opts?.strategy?.kind === "restart")
    return `${RESUME_HEAD} stopped before recording any work — ${why}. Start the request now. ${QUIET}`;
  return [
    `${RESUME_HEAD} was interrupted mid-turn — ${why}. Continue from the recorded work; don't repeat completed steps. ${QUIET}`,
    opts?.backgroundJobs
      ? "Background jobs on your computer kept running — check them with `background` list/poll."
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Told to the model when a task continues on a new runtime, or after its context was cut down. */
export function runtimeSwitchNote(choice: RuntimeChoice | undefined): string {
  const head = choice
    ? `${RUNTIME_HEAD} to ${choice.modelId}${choice.fastMode ? " fast" : ""}${
        choice.effortLevel && choice.effortLevel !== "auto" ? `; effort ${choice.effortLevel}` : ""
      }.`
    : `${TRIMMED_HEAD} without a new summary.`;
  return `${head} Continue from the recorded work; don't repeat completed actions or ask the user to restate.`;
}
