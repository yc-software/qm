import type { ScopeId, SessionEntry } from "../types.ts";
import { parseScopeId } from "../types.ts";
import { headSlice, tailSlice } from "../util/text.ts";
import { countTokens } from "../util/tokens.ts";

const CONTEXT_SUMMARY_KIND = "context_summary";

const MAX_COMPACT_ENTRY_CHARS = 16_000;
const COMPACT_ENTRY_TAIL_CHARS = 2_000;

function capCompactLine(s: string): string {
  if (s.length <= MAX_COMPACT_ENTRY_CHARS) return s;
  const notice = `…[truncated — ${s.length} chars]…`;
  return (
    headSlice(s, MAX_COMPACT_ENTRY_CHARS - COMPACT_ENTRY_TAIL_CHARS - notice.length) +
    notice +
    tailSlice(s, COMPACT_ENTRY_TAIL_CHARS)
  );
}

export const INTERRUPTED_TOOL_RESULT =
  "[interrupted — the platform restarted while this tool call was running and its outcome was not recorded. Check what actually happened before redoing anything with side effects.]";

export interface ContextSummaryPayload {
  kind: typeof CONTEXT_SUMMARY_KIND;
  throughSeq: number;
  text: string;
}

export function contextSummaryPayload(entry: SessionEntry): ContextSummaryPayload | null {
  const payload = entry.payload as Partial<ContextSummaryPayload> | null;
  if (
    entry.type === "system" &&
    payload?.kind === CONTEXT_SUMMARY_KIND &&
    typeof payload.throughSeq === "number" &&
    typeof payload.text === "string"
  ) {
    return { kind: CONTEXT_SUMMARY_KIND, throughSeq: payload.throughSeq, text: payload.text };
  }
  return null;
}

export function createContextSummaryPayload(throughSeq: number, text: string): ContextSummaryPayload {
  return { kind: CONTEXT_SUMMARY_KIND, throughSeq, text };
}

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

export function forModelContext(
  entries: SessionEntry[],
  opts: { includeSecurityTainted?: boolean } = {},
): SessionEntry[] {
  const replayable = entries.filter(
    (e) =>
      e.type !== "thinking" &&
      e.type !== "text" &&
      e.type !== "soul" &&
      (e.payload as { kind?: unknown } | null)?.kind !== "turn_failure",
  );
  const latest = replayable.findLast((e) => contextSummaryPayload(e));
  const visible = replayable.filter((e) => {
    const securityTainted = (e.payload as { securityTainted?: unknown } | null)?.securityTainted === true;
    return opts.includeSecurityTainted || !securityTainted;
  });
  if (!latest) return visible;
  const throughSeq = contextSummaryPayload(latest)!.throughSeq;
  return [
    ...(visible.includes(latest) ? [latest] : []),
    ...visible.filter((e) => !contextSummaryPayload(e) && e.seq > throughSeq),
  ];
}

const entryTokenCache = new Map<string, number>();
const ENTRY_TOKEN_CACHE_MAX = 50_000;

export function estimateEntryTokens(entry: SessionEntry): number {
  const payload = entry.payload as { text?: string } | null;
  const text = typeof payload?.text === "string" ? payload.text : JSON.stringify(entry.payload ?? {});
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

export function recentEntryCountWithinBudget(history: SessionEntry[], maxCount: number, maxTokens: number): number {
  let count = 0;
  let tokens = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (count >= maxCount) break;
    const next = tokens + estimateEntryTokens(history[i]!);
    if (count >= 1 && next > maxTokens) break;
    tokens = next;
    count += 1;
  }
  return count;
}

export function compactTranscript(history: SessionEntry[]): string {
  const resultByCallId = new Map<string, true>();
  for (const entry of history) {
    if (entry.type !== "tool_result") continue;
    const cid = (entry.payload as { callId?: unknown } | null)?.callId;
    if (typeof cid === "string" && cid) resultByCallId.set(cid, true);
  }
  const lines: string[] = [];
  const push = (line: string) => lines.push(capCompactLine(line));
  for (const entry of history) {
    const summary = contextSummaryPayload(entry);
    if (summary) {
      push(`Prior summary through seq ${summary.throughSeq}: ${summary.text}`);
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
    const label = ov
      ? `overheard#${entry.seq} (${typeof op?.name === "string" && op.name ? op.name : "someone"})`
      : `${entry.type}#${entry.seq}`;
    if (text) push(`${label}: ${text}${ovFiles.length ? ` (files: ${ovFiles.join(", ")})` : ""}`);
    else if (ov && ovFiles.length) push(`${label}: (shared file) (files: ${ovFiles.join(", ")})`);
    else if (!ov) push(`${label}:${op?.isError === true ? " [isError]" : ""} ${JSON.stringify(entry.payload ?? {})}`);
    if (entry.type === "tool_call") {
      const cid = (entry.payload as { callId?: unknown } | null)?.callId;
      if (typeof cid === "string" && cid && !resultByCallId.has(cid)) {
        lines.push(`tool_result#${entry.seq}: ${INTERRUPTED_TOOL_RESULT}`);
      }
    }
  }
  return lines.join("\n");
}

export const COMPACT_SOFT_FRACTION = 0.7;
export const COMPACT_HARD_FRACTION = 0.9;

export function overBudgetFraction(
  history: SessionEntry[],
  maxEntries: number,
  maxTokens: number,
  fraction: number,
): boolean {
  return history.length > maxEntries * fraction || estimateHistoryTokens(history) > maxTokens * fraction;
}

export interface CompactionPlan {
  toSummarize: SessionEntry[];
  kept: SessionEntry[];
  reuse?: SessionEntry;
}

export function planCompaction(
  history: SessionEntry[],
  maxEntries: number,
  maxTokens: number,
  keepRecentTokenFraction: number,
  keepRecentEntries: number = maxEntries - 1,
  reuseBudget: { entries: number; tokens: number } = { entries: maxEntries, tokens: maxTokens },
): CompactionPlan | null {
  const latestSummary = [...history].reverse().find((entry) => contextSummaryPayload(entry));
  const latestPayload = latestSummary ? contextSummaryPayload(latestSummary) : null;
  const afterSummary = history.filter((entry) => {
    if (contextSummaryPayload(entry)) return false;
    return latestPayload ? entry.seq > latestPayload.throughSeq : true;
  });
  const summarySlots = 1;
  const keepRecent = Math.max(1, keepRecentEntries);
  const keepRecentTokens = Math.floor(maxTokens * keepRecentTokenFraction);
  if (
    latestSummary &&
    afterSummary.length + summarySlots <= reuseBudget.entries &&
    estimateHistoryTokens([latestSummary, ...afterSummary]) <= reuseBudget.tokens
  ) {
    return { toSummarize: [], kept: [latestSummary, ...afterSummary], reuse: latestSummary };
  }

  const keptCount = recentEntryCountWithinBudget(afterSummary, keepRecent, keepRecentTokens);
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
  const body = headSlice(compactTranscript(history), 8_000);
  return `Compacted ${history.length} prior entr${history.length === 1 ? "y" : "ies"} through seq ${throughSeq}.\n${body}`;
}
