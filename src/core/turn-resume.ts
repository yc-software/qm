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

export function resumeNote(opts?: { backgroundJobs?: boolean; workRecorded?: boolean }): string {
  if (opts?.workRecorded === false) {
    return `${NOTE_HEAD} your previous attempt at the request above was interrupted before it recorded any work, so there is nothing to pick up. Start the request now.)`;
  }
  const parts = [
    `${NOTE_HEAD} your previous attempt at the request above was interrupted mid-turn.`,
    "Your work up to the interruption is recorded above; a tool result marked interrupted has an",
    "unknown outcome, so check what actually happened before redoing anything with side effects.",
  ];
  if (opts?.backgroundJobs) {
    parts.push("Background jobs on your computer kept running — `background` list/poll to check on them.");
  }
  parts.push("Continue from where you left off; don't start over or repeat completed steps.)");
  return parts.join(" ");
}
