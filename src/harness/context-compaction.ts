import type { ScopeId, SessionEntry } from "../types.ts";
import { parseScopeId } from "../types.ts";
import { contextSummaryPayload, entrySecurityTainted } from "../sessions/session-store.ts";
import { headSlice, tailSlice } from "../util/text.ts";
import { countTokens } from "../util/tokens.ts";

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
  "[interrupted — the platform restarted while this tool call was running and its outcome was not recorded. Check what actually happened before redoing anything with side effects.]";

export const CONTEXT_SUMMARY_HEADER =
  "[Earlier conversation summary — an index of turns compacted out of your context. The full transcript is still stored: reopen any type#seq it cites with the history tool (seq parameter; a very long entry returns as head and tail), or search it (query).]";

export function compactedScopeLabel(
  entries: SessionEntry[],
  sessionScopeId: ScopeId,
  orgScopeId: ScopeId,
): ScopeId | null {
  const labels = [...new Set(entries.map((e) => e.scopeLabel))];
  const byKind = (kind: string): ScopeId[] => labels.filter((label) => parseScopeId(label).kind === kind);
  const only = (xs: ScopeId[]): ScopeId | null => (xs.length === 1 ? xs[0]! : null);

  const personal = byKind("personal");
  if (personal.length) return only(personal);

  const team = byKind("team");
  if (team.length) return only(team);

  const nonFloor = labels.filter((label) => label !== orgScopeId && label !== sessionScopeId);
  if (nonFloor.length) return only(nonFloor);

  return labels.includes(sessionScopeId) ? sessionScopeId : orgScopeId;
}

function modelReplayable(entries: SessionEntry[]): SessionEntry[] {
  return entries.filter(
    (e) =>
      e.type !== "thinking" &&
      e.type !== "text" &&
      e.type !== "soul" &&
      (e.payload as { kind?: unknown } | null)?.kind !== "turn_failure",
  );
}

export function forModelContext(
  entries: SessionEntry[],
  opts: { includeSecurityTainted?: boolean } = {},
): SessionEntry[] {
  const replayable = modelReplayable(entries);
  const latest = replayable.findLast((e) => contextSummaryPayload(e));
  const visible = replayable.filter((e) => opts.includeSecurityTainted || !entrySecurityTainted(e));
  if (!latest) return visible;
  const throughSeq = contextSummaryPayload(latest)!.throughSeq;
  return [
    ...(visible.includes(latest) ? [latest] : []),
    ...visible.filter((e) => !contextSummaryPayload(e) && e.seq > throughSeq),
  ];
}

export function forSearchView(entries: SessionEntry[]): SessionEntry[] {
  const replayable = modelReplayable(entries);
  const latest = replayable.findLast((e) => contextSummaryPayload(e));
  return replayable.filter((e) => !entrySecurityTainted(e) && (!contextSummaryPayload(e) || e === latest));
}

const entryTokenCache = new Map<string, number>();
const ENTRY_TOKEN_CACHE_MAX = 50_000;

export function estimateEntryTokens(entry: SessionEntry): number {
  const payload = entry.payload as { text?: string; environment?: string } | null;
  const text =
    typeof payload?.text === "string"
      ? [payload.text, payload.environment].filter((s) => typeof s === "string" && s).join("\n\n")
      : JSON.stringify(entry.payload ?? {});
  const key = `${entry.sessionId}:${entry.seq}:${text.length}`;
  const hit = entryTokenCache.get(key);
  if (hit !== undefined) return hit;
  const n = countTokens(text);
  if (entryTokenCache.size >= ENTRY_TOKEN_CACHE_MAX) {
    entryTokenCache.delete(entryTokenCache.keys().next().value!);
  }
  entryTokenCache.set(key, n);
  return n;
}

export function estimateHistoryTokens(history: SessionEntry[]): number {
  let total = 0;
  for (const entry of history) total += estimateEntryTokens(entry);
  return total;
}

export function recentEntryCountWithinBudget(history: SessionEntry[], maxTokens: number): number {
  let count = 0;
  let tokens = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const next = tokens + estimateEntryTokens(history[i]!);
    if (count >= 1 && next > maxTokens) break;
    tokens = next;
    count += 1;
  }
  return count;
}

function entryStamp(createdAt: number): string {
  return Number.isFinite(createdAt) && createdAt > 0 ? ` ${new Date(createdAt).toISOString().slice(0, 16)}Z` : "";
}

export function compactTranscript(history: SessionEntry[]): string {
  const resultByCallId = new Map<string, true>();
  for (const entry of history) {
    if (entry.type !== "tool_result") continue;
    const cid = (entry.payload as { callId?: unknown } | null)?.callId;
    if (typeof cid === "string" && cid) resultByCallId.set(cid, true);
  }
  const lines: string[] = [];
  const push = (line: string) => lines.push(headTailSlice(line, MAX_COMPACT_ENTRY_CHARS, COMPACT_ENTRY_TAIL_CHARS));
  for (const entry of history) {
    const stamp = entryStamp(entry.createdAt);
    const summary = contextSummaryPayload(entry);
    if (summary) {
      push(`Prior summary through seq ${summary.throughSeq}${stamp ? ` (written${stamp})` : ""}: ${summary.text}`);
      continue;
    }
    const op = entry.payload as {
      text?: string;
      overheard?: unknown;
      name?: unknown;
      files?: unknown;
      isError?: unknown;
    } | null;
    const ov = entry.type === "user" && op?.overheard === true;
    const text = String(op?.text ?? "").trim();
    const ovFiles = ov && Array.isArray(op?.files) ? (op!.files as unknown[]).map(String).filter(Boolean) : [];
    const author = entry.type === "user" && typeof op?.name === "string" && op.name ? op.name : null;
    const label = ov
      ? `overheard#${entry.seq}${stamp} (${author ?? "someone"})`
      : `${entry.type}#${entry.seq}${stamp}${author ? ` (${author})` : ""}`;
    if (text) push(`${label}: ${text}${ovFiles.length ? ` (files: ${ovFiles.join(", ")})` : ""}`);
    else if (ov && ovFiles.length) push(`${label}: (shared file) (files: ${ovFiles.join(", ")})`);
    else if (!ov) push(`${label}:${op?.isError === true ? " [isError]" : ""} ${JSON.stringify(entry.payload ?? {})}`);
    if (entry.type === "tool_call") {
      const cid = (entry.payload as { callId?: unknown } | null)?.callId;
      if (typeof cid === "string" && cid && !resultByCallId.has(cid)) {
        lines.push(`tool_result for tool_call#${entry.seq} (none recorded): ${INTERRUPTED_TOOL_RESULT}`);
      }
    }
  }
  return lines.join("\n");
}

export const COMPACT_SOFT_FRACTION = 0.7;
export const COMPACT_HARD_FRACTION = 0.9;

export function overBudgetFraction(history: SessionEntry[], maxTokens: number, fraction: number): boolean {
  return estimateHistoryTokens(history) > maxTokens * fraction;
}

export interface CompactionPlan {
  toSummarize: SessionEntry[];
  kept: SessionEntry[];
  reuse?: SessionEntry;
}

export function planCompaction(
  history: SessionEntry[],
  maxTokens: number,
  keepRecentTokenFraction: number,
  reuseBudgetTokens: number = maxTokens,
): CompactionPlan | null {
  const latestSummary = [...history].reverse().find((entry) => contextSummaryPayload(entry));
  const latestPayload = latestSummary ? contextSummaryPayload(latestSummary) : null;
  const afterSummary = history.filter((entry) => {
    if (contextSummaryPayload(entry)) return false;
    return latestPayload ? entry.seq > latestPayload.throughSeq : true;
  });
  const keepRecentTokens = Math.floor(maxTokens * keepRecentTokenFraction);
  if (latestSummary && estimateHistoryTokens([latestSummary, ...afterSummary]) <= reuseBudgetTokens) {
    return { toSummarize: [], kept: [latestSummary, ...afterSummary], reuse: latestSummary };
  }

  const keptCount = recentEntryCountWithinBudget(afterSummary, keepRecentTokens);
  let overflowCount = Math.max(0, afterSummary.length - keptCount);
  while (overflowCount > 0) {
    const last = afterSummary[overflowCount - 1]!;
    if (last.type !== "tool_call") break;
    const cid = (last.payload as { callId?: unknown } | null)?.callId;
    if (typeof cid !== "string" || !cid) break;
    const pairedInBatch = afterSummary
      .slice(0, overflowCount)
      .some((e) => e.type === "tool_result" && (e.payload as { callId?: unknown } | null)?.callId === cid);
    if (pairedInBatch) break;
    overflowCount -= 1;
  }
  const overflow = afterSummary.slice(0, overflowCount);
  const toSummarize = latestSummary ? [latestSummary, ...overflow] : overflow;
  if (!overflow.length) return null;
  return { toSummarize, kept: afterSummary.slice(overflowCount) };
}

export function compactionThroughSeq(entries: SessionEntry[]): number {
  return entries.reduce((max, entry) => {
    const summary = contextSummaryPayload(entry);
    return Math.max(max, summary ? summary.throughSeq : entry.seq);
  }, -1);
}

export function deterministicCompactSummary(history: SessionEntry[]): string {
  const throughSeq = compactionThroughSeq(history);
  const body = headTailSlice(compactTranscript(history), FALLBACK_SUMMARY_BODY_CHARS, FALLBACK_SUMMARY_TAIL_CHARS);
  return `Compacted ${history.length} prior entr${history.length === 1 ? "y" : "ies"} through seq ${throughSeq}.\n${body}`;
}

export const MAX_COMPACT_SUMMARY_CHARS = MAX_COMPACT_ENTRY_CHARS - CHAINED_SUMMARY_PREFIX_HEADROOM;

export function boundCompactSummary(candidate: string | undefined, history: SessionEntry[]): string {
  const text = candidate?.trim();
  if (!text || text.length > MAX_COMPACT_SUMMARY_CHARS) return deterministicCompactSummary(history);
  return text;
}
