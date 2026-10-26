import type { ScopeId, Session } from "../../types.ts";
import type { Item } from "../../sessions/items.ts";
import { countTokens } from "../../util/tokens.ts";
import { parseScopeId } from "../../types.ts";
import type { Lease } from "../../sessions/session-store.ts";
import { acquireLeaseWithin, contextSummary, contextSummaryItem } from "../../sessions/session-store.ts";
import {
  COMPACT_HARD_FRACTION,
  COMPACT_SOFT_FRACTION,
  validateCompactSummary,
  compactionThroughSeq,
  estimateItemTokens,
  estimateHistoryTokens,
  forModelContext,
  overBudgetFraction,
  planCompaction,
  recentItemCountWithinBudget,
} from "../../harness/context-compaction.ts";
import { estimateCostUsd } from "../../ratelimit/budget.ts";
import { errMessage } from "../../util/errors.ts";
import { createKeyedQueue } from "../../util/async.ts";
import type { OrchestratorDeps } from "./types.ts";

const MAX_CONTEXT_TOKENS = 120_000;
const KEEP_RECENT_TOKEN_FRACTION = 0.6;
const DOCUMENT_TOKEN_FRACTION = 0.5;

interface Summarized {
  text: string;
  summaryLabel: ScopeId;
  throughSeq: number;
  mode?: "recent";
}

export interface CompactionContext {
  compactContextIfNeeded(input: {
    session: Session;
    lease: Lease;
    visibleHistory: Item[];
    scopeId: string;
    orgScopeId: string;
    actorId: string;
    model?: string;
    cancel?: AbortSignal;
    reservedTokens?: number;
  }): Promise<Item[]>;
  compactRecent(input: {
    session: Session;
    lease: Lease;
    visibleHistory: Item[];
    scopeId: string;
    orgScopeId: string;
    actorId: string;
    model?: string;
    cancel?: AbortSignal;
    reservedTokens?: number;
  }): Promise<Item[]>;
  scheduleBackgroundCompaction(input: {
    sessionId: string;
    scopeId: string;
    orgScopeId: string;
    actorId: string;
    model?: string;
  }): void;
  documentTokenBudget(scopeId: string, model?: string): number;
}

export function createCompaction(deps: OrchestratorDeps): CompactionContext {
  const tokenBudgetFor = (scopeLabel?: string, model?: string): number =>
    deps.maxContextTokens ?? deps.harness.models.contextTokenBudget?.(scopeLabel, model) ?? MAX_CONTEXT_TOKENS;
  const documentTokenBudget = (scopeId: string, model?: string): number =>
    Math.floor(tokenBudgetFor(scopeId, model) * DOCUMENT_TOKEN_FRACTION);
  const historyBudgetFor = (input: { scopeId: string; model?: string; reservedTokens?: number }): number => {
    const total = tokenBudgetFor(input.scopeId, input.model);
    const reserved = Math.min(Math.max(0, input.reservedTokens ?? 0), documentTokenBudget(input.scopeId, input.model));
    return Math.max(1, total - reserved);
  };

  const boundRecent = (entries: Item[], maxContextTokens: number): Item[] => {
    const summary = entries.find((e) => contextSummary(e));
    const rest = summary ? entries.filter((e) => e !== summary) : entries;
    const kept = rest.slice(
      rest.length - recentItemCountWithinBudget(rest, maxContextTokens - (summary ? estimateItemTokens(summary) : 0)),
    );
    return summary ? [summary, ...kept] : kept;
  };
  const isManagedGroupScope = (scope: string): boolean => {
    const parsed = parseScopeId(scope);
    return parsed.kind === "group" && deps.managedGroups?.recognizes(parsed.ref) === true;
  };

  const keepRecentTokenFraction = Math.min(KEEP_RECENT_TOKEN_FRACTION, COMPACT_SOFT_FRACTION - 0.1);

  async function summarizeForCompaction(
    input: {
      session: Session;
      visibleHistory: Item[];
      scopeId: string;
      orgScopeId: string;
      actorId: string;
      model?: string;
      cancel?: AbortSignal;
      reservedTokens?: number;
    },
    recoverOnFailure = false,
  ): Promise<Summarized | null> {
    if (isManagedGroupScope(input.scopeId)) return null;
    if (!deps.harness.models.compactHistory) return null;
    const maxContextTokens = historyBudgetFor(input);
    const reuseBudgetTokens = Math.floor(maxContextTokens * keepRecentTokenFraction);
    const plan = planCompaction(input.visibleHistory, maxContextTokens, keepRecentTokenFraction, reuseBudgetTokens);
    if (!plan || !plan.toSummarize.length) return null;

    const summaryLabel = input.scopeId;

    input.cancel?.throwIfAborted();
    let text: string;
    try {
      const raw = await deps.harness.models.compactHistory({
        session: input.session,
        history: plan.toSummarize,
        recordModelCall: (rec) => {
          deps.modelGateway.recordCall({ at: Date.now(), scopeLabel: summaryLabel, ...rec });
          void deps.budget?.record(input.actorId, estimateCostUsd(rec.inputTokens));
        },
      });
      text = validateCompactSummary(raw);
    } catch (error) {
      input.cancel?.throwIfAborted();
      if (!recoverOnFailure || (error instanceof Error && error.name === "AbortError")) throw error;
      deps.errors?.record(
        {
          category: "turn",
          code: "compaction_summary_failed",
          message: errMessage(error),
          scopeLabel: input.scopeId as ScopeId,
          sessionId: input.session.id,
        },
        error,
      );
      return null;
    }
    input.cancel?.throwIfAborted();
    return {
      text,
      summaryLabel,
      throughSeq: compactionThroughSeq(plan.toSummarize),
    };
  }

  async function writeCompaction(input: { session: Session; lease: Lease; summarized: Summarized }): Promise<Item> {
    const { text, throughSeq, mode } = input.summarized;
    const summary = await deps.sessions.append(input.lease, {
      ...contextSummaryItem(throughSeq, text),
      ...(mode ? { body: { mode } } : {}),
    });
    await deps.harness.turns.resetSession?.(input.session.id);
    return summary;
  }

  async function applyCompaction(input: {
    session: Session;
    lease: Lease;
    visibleHistory: Item[];
    scopeId: string;
    orgScopeId: string;
    actorId: string;
    model?: string;
    cancel?: AbortSignal;
    reservedTokens?: number;
  }): Promise<Item[] | null> {
    const summarized = await summarizeForCompaction(input, true);
    if (!summarized) return null;
    const summary = await writeCompaction({ ...input, summarized });
    const recent = input.visibleHistory.filter((entry) => entry.seq > summarized.throughSeq && !contextSummary(entry));
    return boundRecent([summary, ...recent], historyBudgetFor(input));
  }

  async function compactContextIfNeeded(input: {
    session: Session;
    lease: Lease;
    visibleHistory: Item[];
    scopeId: string;
    orgScopeId: string;
    actorId: string;
    model?: string;
    cancel?: AbortSignal;
    reservedTokens?: number;
  }): Promise<Item[]> {
    const maxContextTokens = historyBudgetFor(input);
    if (!overBudgetFraction(input.visibleHistory, maxContextTokens, COMPACT_HARD_FRACTION)) {
      return input.visibleHistory;
    }
    const rebuilt = await applyCompaction(input);
    return (
      rebuilt ??
      (!deps.harness.models.compactHistory || isManagedGroupScope(input.scopeId)
        ? boundRecent(input.visibleHistory, maxContextTokens)
        : compactRecent(input))
    );
  }

  async function compactRecent(input: Parameters<CompactionContext["compactRecent"]>[0]): Promise<Item[]> {
    input.cancel?.throwIfAborted();
    const budget = Math.floor(historyBudgetFor(input) * keepRecentTokenFraction);
    const prior = input.visibleHistory.findLast((entry) => contextSummary(entry));
    const rest = input.visibleHistory.filter((entry) => !contextSummary(entry));
    const notice =
      "[Context reduced without a new summary. Earlier entries are excluded, not deleted. Use history to reopen missing requests and tool calls; history does not return tool results. Check actual state before repeating actions whose outcomes are missing.]";
    const markerTokens = countTokens(`${notice}\n\nLast saved summary (not updated):\n`);
    let remaining = Math.max(0, budget - markerTokens);
    let start = rest.length;
    while (start > 0) {
      const cost = estimateItemTokens(rest[start - 1]!);
      if (cost > remaining) break;
      remaining -= cost;
      start--;
    }
    const retainedCalls = new Set<string | null>();
    for (let i = start; i < rest.length; i++) {
      const entry = rest[i]!;
      if (entry.kind === "ToolCall" && entry.callId) retainedCalls.add(entry.callId);
      if (entry.kind === "ToolResult" && !retainedCalls.has(entry.callId)) {
        start = i + 1;
        retainedCalls.clear();
      }
    }
    const recent = rest.slice(start);
    remaining = budget - markerTokens - estimateHistoryTokens(recent);
    const includedPrior = prior && estimateItemTokens(prior) <= remaining ? prior : undefined;
    const priorText = includedPrior ? contextSummary(includedPrior)!.text : undefined;
    let text = notice;
    if (priorText)
      text = priorText.startsWith(notice) ? priorText : `${notice}\n\nLast saved summary (not updated):\n${priorText}`;
    const window = await deps.sessions.getContextWindow(input.session.id);
    const boundary = window.items.reduce((seq, entry) => Math.max(seq, contextSummary(entry)?.throughSeq ?? -1), -1);
    const throughSeq = Math.max(boundary, compactionThroughSeq([...(prior ? [prior] : []), ...rest.slice(0, start)]));
    input.cancel?.throwIfAborted();
    const summary = await writeCompaction({
      ...input,
      summarized: {
        text,
        summaryLabel: input.scopeId as ScopeId,
        throughSeq,
        mode: "recent",
      },
    });
    return [summary, ...recent];
  }

  const WRITE_LEASE_WAIT_MS = 60_000;

  const backgroundCompaction = createKeyedQueue<string>();
  const compactionPending = new Set<string>();

  function scheduleBackgroundCompaction(input: {
    sessionId: string;
    scopeId: string;
    orgScopeId: string;
    actorId: string;
    model?: string;
  }): void {
    if (compactionPending.has(input.sessionId)) return;
    compactionPending.add(input.sessionId);
    void backgroundCompaction(input.sessionId, async () => {
      compactionPending.delete(input.sessionId);
      let lease: Lease | null = null;
      try {
        const session = await deps.sessions.get(input.sessionId);
        if (!session) return;
        const maxContextTokens = tokenBudgetFor(input.scopeId, input.model);
        const entries = (await deps.sessions.getContextWindow(input.sessionId)).items;
        const history = forModelContext(entries);
        if (!overBudgetFraction(history, maxContextTokens, COMPACT_SOFT_FRACTION)) return;
        const snapshotSeq = entries.at(-1)?.seq ?? -1;
        const summarized = await summarizeForCompaction({
          session,
          visibleHistory: history,
          scopeId: input.scopeId,
          orgScopeId: input.orgScopeId,
          actorId: input.actorId,
          ...(input.model ? { model: input.model } : {}),
        });
        if (!summarized) return;
        lease = (await acquireLeaseWithin(deps.sessions, input.sessionId, "compaction", WRITE_LEASE_WAIT_MS)).lease;
        if (!lease) return;
        const since = await deps.sessions.getItems(input.sessionId, { sinceSeq: snapshotSeq + 1 });
        if (!since.some((entry) => !!contextSummary(entry))) {
          await writeCompaction({ session, lease, summarized });
        }
      } catch (e) {
        deps.errors?.record(
          {
            category: "turn",
            code: "background_compaction_failed",
            message: errMessage(e),
            scopeLabel: input.scopeId as ScopeId,
            sessionId: input.sessionId,
          },
          e,
        );
      } finally {
        if (lease) await deps.sessions.releaseLease(lease);
      }
    }).catch((e) => {
      deps.errors?.record(
        {
          category: "turn",
          code: "background_compaction_failed",
          message: errMessage(e),
          scopeLabel: input.scopeId as ScopeId,
          sessionId: input.sessionId,
        },
        e,
      );
    });
  }

  return { compactContextIfNeeded, compactRecent, scheduleBackgroundCompaction, documentTokenBudget };
}
