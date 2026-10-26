import type { RunStop } from "../runs/run-store.ts";
import { contextSummary } from "../sessions/session-store.ts";
import { isOverheard, isUserMessage, itemFields, proseText, stepMessage, type Item } from "../sessions/items.ts";
import { headSlice, tailSlice } from "../util/text.ts";
import { countTokens } from "../util/tokens.ts";
import { documentAttachmentTokens, replayableDocumentMetas } from "../core/document-kinds.ts";

const MAX_COMPACT_ENTRY_CHARS = 16_000;
const COMPACT_ENTRY_TAIL_CHARS = 2_000;
const CHAINED_SUMMARY_PREFIX_HEADROOM = 1_000;
const FALLBACK_SUMMARY_BODY_CHARS = 8_000;
const FALLBACK_SUMMARY_TAIL_CHARS = 6_000;

function headTailSlice(s: string, maxChars: number, tailChars: number): string {
  if (s.length <= maxChars) return s;
  const notice = `…[truncated — ${s.length} chars]…`;
  return headSlice(s, maxChars - tailChars - notice.length) + notice + tailSlice(s, tailChars);
}

export const INTERRUPTED_TOOL_RESULT =
  "[system] This call was interrupted; its outcome wasn't recorded. Check what happened before retrying.";

const STOP_CAUSES = {
  parked: "A pause to let a person's turn run first",
  shutdown: "A routine platform deploy",
  lease_expired: "A worker crash",
  error: "An internal error",
  provider: "A model-provider failure",
};

export function unrecordedToolResult(stop: RunStop | undefined): string {
  const by =
    stop?.kind === "error" && stop.code
      ? `${STOP_CAUSES.provider} (${stop.code}${stop.status !== undefined ? `, HTTP ${stop.status}` : ""})`
      : stop && STOP_CAUSES[stop.kind];
  return by
    ? `[system] ${by} interrupted this call; its outcome wasn't recorded. Check what happened before retrying.`
    : INTERRUPTED_TOOL_RESULT;
}

export const CONTEXT_SUMMARY_HEADER =
  "[Earlier conversation summary — an index of turns compacted out of your context. Conversation turns and tool calls can be reopened with the history tool (seq parameter; a very long entry returns as head and tail), or searched (query). Tool results are excluded.]";

function modelReplayable(items: Item[]): Item[] {
  return items.filter(
    (e) =>
      ((e.kind !== "Reasoning" && !(e.kind === "AgentMessage" && e.variant === "narration")) || !!stepMessage(e)) &&
      e.body.slackReplyReceipt !== true &&
      e.kind !== "Error",
  );
}

export function forModelContext(items: Item[]): Item[] {
  const replayable = modelReplayable(items);
  const latest = replayable.findLast((e) => contextSummary(e));
  if (!latest) return replayable;
  const throughSeq = contextSummary(latest)!.throughSeq;
  return [latest, ...replayable.filter((e) => !contextSummary(e) && e.seq > throughSeq)];
}

export function forSearchView(items: Item[]): Item[] {
  const replayable = modelReplayable(items);
  const latest = replayable.findLast((e) => contextSummary(e));
  return replayable.filter(
    (e) =>
      e.kind !== "ToolResult" &&
      e.kind !== "Reasoning" &&
      !(e.kind === "AgentMessage" && e.variant === "narration") &&
      (!contextSummary(e) || e === latest),
  );
}

const itemTokenCache = new Map<string, number>();
const ITEM_TOKEN_CACHE_MAX = 50_000;

export function estimateItemTokens(item: Item): number {
  return estimateItemTextTokens(item) + (isUserMessage(item) ? documentAttachmentTokens(item.body) : 0);
}

function estimateItemTextTokens(item: Item): number {
  const environment = typeof item.body.environment === "string" ? item.body.environment : null;
  const text =
    item.text !== null
      ? [item.text, item.kind === "Reasoning" ? null : environment].filter((s) => !!s).join("\n\n")
      : JSON.stringify(itemFields(item));
  const key = `${item.sessionId}:${item.seq}:${text.length}`;
  const hit = itemTokenCache.get(key);
  if (hit !== undefined) return hit;
  const n = countTokens(text);
  if (itemTokenCache.size >= ITEM_TOKEN_CACHE_MAX) {
    itemTokenCache.delete(itemTokenCache.keys().next().value!);
  }
  itemTokenCache.set(key, n);
  return n;
}

export function estimateHistoryTokens(history: Item[]): number {
  let total = 0;
  for (const item of history) total += estimateItemTokens(item);
  return total;
}

export function recentItemCountWithinBudget(history: Item[], maxTokens: number): number {
  let count = 0;
  let tokens = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const next = tokens + estimateItemTokens(history[i]!);
    if (count >= 1 && next > maxTokens) break;
    tokens = next;
    count += 1;
  }
  return count;
}

function itemStamp(createdAt: number): string {
  return Number.isFinite(createdAt) && createdAt > 0 ? ` ${new Date(createdAt).toISOString().slice(0, 16)}Z` : "";
}

export function compactTranscript(history: Item[]): string {
  const recorded = new Set<string>();
  for (const item of history)
    if (item.kind === "ToolResult" && item.callId && item.body.interrupted !== true) recorded.add(item.callId);
  const lines: string[] = [];
  const push = (line: string) => lines.push(headTailSlice(line, MAX_COMPACT_ENTRY_CHARS, COMPACT_ENTRY_TAIL_CHARS));
  for (const item of history) {
    if (item.kind === "Reasoning") continue;
    const stamp = itemStamp(item.createdAt);
    const summary = contextSummary(item);
    if (summary) {
      push(`Prior summary through seq ${summary.throughSeq}${stamp ? ` (written${stamp})` : ""}: ${summary.text}`);
      continue;
    }
    const ov = isOverheard(item);
    const text = (proseText(item) ?? "").trim();
    const files = item.body.files;
    const ovFiles = ov && Array.isArray(files) ? files.map(String).filter(Boolean) : [];
    const shownFiles =
      isUserMessage(item) && !ov
        ? replayableDocumentMetas(item.body).map((meta) => `${meta.name} [file ${meta.artifactId}]`)
        : ovFiles;
    const name = item.body.name;
    const author = isUserMessage(item) && typeof name === "string" && name ? name : null;
    const label = ov
      ? `overheard#${item.seq}${stamp} (${item.body.sourceRole === "agent" ? "agent" : (author ?? "someone")})`
      : `${item.kind}#${item.seq}${stamp}${author ? ` (${author})` : ""}`;
    if (text) push(`${label}: ${text}${shownFiles.length ? ` (files: ${shownFiles.join(", ")})` : ""}`);
    else if (ov && ovFiles.length) push(`${label}: (shared file) (files: ${ovFiles.join(", ")})`);
    else if (!ov) {
      push(
        `${label}:${item.isError === true ? " [isError]" : ""} ${JSON.stringify({ ...itemFields(item), memoryRecall: undefined })}`,
      );
    }
    if (item.kind === "ToolCall" && item.callId && !recorded.has(item.callId)) {
      lines.push(`ToolResult for ToolCall#${item.seq} (none recorded): ${INTERRUPTED_TOOL_RESULT}`);
    }
  }
  return lines.join("\n");
}

export const COMPACT_SOFT_FRACTION = 0.7;
export const COMPACT_HARD_FRACTION = 0.9;

export function overBudgetFraction(history: Item[], maxTokens: number, fraction: number): boolean {
  return estimateHistoryTokens(history) > maxTokens * fraction;
}

export interface CompactionPlan {
  toSummarize: Item[];
  kept: Item[];
  reuse?: Item;
}

export function planCompaction(
  history: Item[],
  maxTokens: number,
  keepRecentTokenFraction: number,
  reuseBudgetTokens: number = maxTokens,
): CompactionPlan | null {
  const latestSummary = history.findLast((item) => contextSummary(item));
  const latestPayload = latestSummary ? contextSummary(latestSummary) : null;
  const afterSummary = history.filter((entry) => {
    if (contextSummary(entry)) return false;
    return latestPayload ? entry.seq > latestPayload.throughSeq : true;
  });
  const keepRecentTokens = Math.floor(maxTokens * keepRecentTokenFraction);
  if (latestSummary && estimateHistoryTokens([latestSummary, ...afterSummary]) <= reuseBudgetTokens) {
    return { toSummarize: [], kept: [latestSummary, ...afterSummary], reuse: latestSummary };
  }

  const keptCount = recentItemCountWithinBudget(afterSummary, keepRecentTokens);
  let overflowCount = Math.max(0, afterSummary.length - keptCount);
  while (overflowCount > 0) {
    const last = afterSummary[overflowCount - 1]!;
    if (last.kind !== "ToolCall" || !last.callId) break;
    const cid = last.callId;
    const pairedInBatch = afterSummary.slice(0, overflowCount).some((e) => e.kind === "ToolResult" && e.callId === cid);
    if (pairedInBatch) break;
    overflowCount -= 1;
  }
  const overflow = afterSummary.slice(0, overflowCount);
  const toSummarize = latestSummary ? [latestSummary, ...overflow] : overflow;
  if (!overflow.length) return null;
  return { toSummarize, kept: afterSummary.slice(overflowCount) };
}

export function compactionThroughSeq(items: Item[]): number {
  return items.reduce((max, entry) => {
    const summary = contextSummary(entry);
    return Math.max(max, summary ? summary.throughSeq : entry.seq);
  }, -1);
}

export function deterministicCompactSummary(history: Item[]): string {
  const throughSeq = compactionThroughSeq(history);
  const body = headTailSlice(compactTranscript(history), FALLBACK_SUMMARY_BODY_CHARS, FALLBACK_SUMMARY_TAIL_CHARS);
  return `Compacted ${history.length} prior entr${history.length === 1 ? "y" : "ies"} through seq ${throughSeq}.\n${body}`;
}

export const MAX_COMPACT_SUMMARY_CHARS = MAX_COMPACT_ENTRY_CHARS - CHAINED_SUMMARY_PREFIX_HEADROOM;

export function validateCompactSummary(candidate: string | undefined): string {
  const text = candidate?.trim();
  if (!text) throw new Error("Compaction returned an empty summary");
  if (text.length > MAX_COMPACT_SUMMARY_CHARS) throw new Error("Compaction summary exceeds the character limit");
  return text;
}
