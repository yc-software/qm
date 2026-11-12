import type { ScopeId, Session } from "../../types.ts";
import { parseScopeId } from "../../types.ts";
import type { SessionWriter } from "../../sessions/session-store.ts";
import { contextSummary } from "../../sessions/session-store.ts";
import {
  COMPACT_HARD_FRACTION,
  COMPACT_KEEP_PERCENT,
  COMPACT_SOFT_FRACTION,
  validateCompactSummary,
  compactionThroughSeq,
  estimateItemTokens,
  estimateHistoryTokens,
  forModelContext,
  overBudgetFraction,
  planCompaction,
  recentItemCountWithinBudget,
} from "../../agent/context-compaction.ts";
import { estimateCostUsd } from "../../ratelimit/budget.ts";
import { errMessage } from "../../util/errors.ts";
import { createKeyedQueue } from "../../util/async.ts";
import { waitForNoRunningRun } from "../../runs/run-store.ts";
import type { OrchestratorDeps } from "./types.ts";
import type { Item } from "../../sessions/items.ts";
import { countTokens } from "../../util/tokens.ts";
import type { SessionRoute } from "../../agent/agent.ts";
import type { Tenant } from "../../tenants/context.ts";

const MAX_CONTEXT_TOKENS = 120_000;
const DOCUMENT_TOKEN_FRACTION = 0.5;
const RECENT_NOTICE =
  "[Context reduced without a new summary. Earlier entries are excluded, not deleted. Use history to reopen missing requests and tool calls; history does not return tool results. Check actual state before repeating actions whose outcomes are missing.]";
const SAVED_SUMMARY = "\n\nLast saved summary (not updated):\n";

interface Summarized {
  text: string;
  throughSeq: number;
  mode?: "recent";
  savedSummary?: string;
}

interface CompactionInput {
  tenant: Tenant;
  session: Session;
  writer: SessionWriter;
  visibleHistory: Item[];
  scopeId: string;
  actorId: string;
  route?: SessionRoute;
  cancel?: AbortSignal;
  reservedTokens?: number;
}

export interface CompactionContext {
  compactContextIfNeeded(input: CompactionInput): Promise<Item[]>;
  compactRecent(input: CompactionInput): Promise<Item[]>;
  scheduleBackgroundCompaction(input: {
    tenant: Tenant;
    sessionId: string;
    runLeaseToken?: string;
    scopeId: string;
    actorId: string;
    route?: SessionRoute;
  }): void;
  documentTokenBudget(model?: string): number;
}

export function createCompaction(deps: OrchestratorDeps): CompactionContext {
  const tokenBudgetFor = (model?: string): number =>
    deps.maxContextTokens ?? deps.agent.contextTokenBudget?.(model) ?? MAX_CONTEXT_TOKENS;
  const documentTokenBudget = (model?: string): number => Math.floor(tokenBudgetFor(model) * DOCUMENT_TOKEN_FRACTION);
  const historyBudgetFor = (input: { route?: SessionRoute; reservedTokens?: number }): number => {
    const model = input.route?.runtime?.modelId;
    const total = tokenBudgetFor(model);
    const reserved = Math.min(Math.max(0, input.reservedTokens ?? 0), documentTokenBudget(model));
    return Math.max(1, total - reserved);
  };

  const boundRecent = (items: Item[], maxContextTokens: number): Item[] => {
    const summary = items.find((e) => contextSummary(e));
    const rest = summary ? items.filter((e) => e !== summary) : items;
    const kept = rest.slice(
      rest.length - recentItemCountWithinBudget(rest, maxContextTokens - (summary ? estimateItemTokens(summary) : 0)),
    );
    return summary ? [summary, ...kept] : kept;
  };
  const isManagedGroupScope = (scope: string): boolean => {
    const parsed = parseScopeId(scope);
    return parsed.kind === "group" && deps.managedGroups?.recognizes(parsed.ref) === true;
  };

  const keepRecentTokenFraction = (): number =>
    (deps.config.getCompactionKeepPercent() ?? COMPACT_KEEP_PERCENT.default) / 100;

  async function summarizeForCompaction(
    input: Omit<CompactionInput, "writer">,
    onFailure?: (reason: string) => void,
  ): Promise<Summarized | null> {
    if (isManagedGroupScope(input.scopeId)) return null;
    if (!deps.agent.compactHistory) return null;
    const maxContextTokens = historyBudgetFor(input);
    const keepFraction = keepRecentTokenFraction();
    const reuseBudgetTokens = Math.floor(maxContextTokens * keepFraction);
    const plan = planCompaction(input.visibleHistory, maxContextTokens, keepFraction, reuseBudgetTokens);
    if (!plan || !plan.toSummarize.length) return null;

    input.cancel?.throwIfAborted();
    let text: string;
    try {
      const raw = await deps.agent.compactHistory({
        ...input.route,
        scopeLabel: input.scopeId as ScopeId,
        session: input.session,
        history: plan.toSummarize,
        recordModelCall: (rec) => {
          void deps.budget?.record(input.tenant, input.actorId, estimateCostUsd(rec.inputTokens));
        },
      });
      text = validateCompactSummary(raw);
    } catch (error) {
      input.cancel?.throwIfAborted();
      if (!onFailure || (error instanceof Error && error.name === "AbortError")) throw error;
      deps.errors.record(
        input.tenant,
        {
          category: "turn",
          code: "compaction_summary_failed",
          message: errMessage(error),
          scopeLabel: input.scopeId as ScopeId,
          sessionId: input.session.id,
        },
        error,
      );
      onFailure(errMessage(error));
      return null;
    }
    input.cancel?.throwIfAborted();
    return {
      text,
      throughSeq: compactionThroughSeq(plan.toSummarize),
    };
  }

  async function writeCompaction(input: {
    session: Session;
    writer: SessionWriter;
    summarized: Summarized;
  }): Promise<Item> {
    const { text, throughSeq, mode, savedSummary } = input.summarized;
    const summary = await deps.sessions.append(input.writer, {
      kind: "ContextCompaction",
      text,
      throughSeq,
      body: { ...(mode ? { mode } : {}), ...(savedSummary ? { savedSummary } : {}) },
    });
    return summary;
  }

  async function compactContextIfNeeded(input: CompactionInput): Promise<Item[]> {
    const maxContextTokens = historyBudgetFor(input);
    if (!overBudgetFraction(input.visibleHistory, maxContextTokens, COMPACT_HARD_FRACTION)) {
      return input.visibleHistory;
    }
    let failure: string | undefined;
    const summarized = await summarizeForCompaction(input, (reason) => {
      failure = reason;
    });
    if (summarized) {
      const summary = await writeCompaction({ ...input, summarized });
      const recent = input.visibleHistory.filter(
        (entry) => entry.seq > summarized.throughSeq && !contextSummary(entry),
      );
      return boundRecent([summary, ...recent], maxContextTokens);
    }
    return !deps.agent.compactHistory || isManagedGroupScope(input.scopeId)
      ? boundRecent(input.visibleHistory, maxContextTokens)
      : compactRecent(input, failure);
  }

  async function compactRecent(input: CompactionInput, failure?: string): Promise<Item[]> {
    input.cancel?.throwIfAborted();
    const budget = Math.floor(historyBudgetFor(input) * keepRecentTokenFraction());
    const prior = input.visibleHistory.findLast((entry) => contextSummary(entry));
    const rest = input.visibleHistory.filter((entry) => !contextSummary(entry));
    const header = failure ? `${RECENT_NOTICE}\nThe summary call failed: ${failure}` : RECENT_NOTICE;
    const markerTokens = countTokens(`${header}${SAVED_SUMMARY}`);
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
      const item = rest[i]!;
      if (item.kind === "ToolCall" && item.callId) retainedCalls.add(item.callId);
      if (item.kind === "ToolResult" && !retainedCalls.has(item.callId)) {
        start = i + 1;
        retainedCalls.clear();
      }
    }
    const recent = rest.slice(start);
    remaining = budget - markerTokens - estimateHistoryTokens(recent);
    const includedPrior = prior && estimateItemTokens(prior) <= remaining ? prior : undefined;
    const savedSummary =
      includedPrior?.body.mode === "recent"
        ? (includedPrior.body.savedSummary as string | undefined)
        : includedPrior && contextSummary(includedPrior)!.text;
    const text = savedSummary ? `${header}${SAVED_SUMMARY}${savedSummary}` : header;
    const window = await deps.sessions.getContextWindow(input.session.id);
    const boundary = window.items.reduce(
      (seq, item) => Math.max(seq, item.kind === "ContextCompaction" ? (item.throughSeq ?? -1) : -1),
      -1,
    );
    const throughSeq = Math.max(boundary, compactionThroughSeq([...(prior ? [prior] : []), ...rest.slice(0, start)]));
    input.cancel?.throwIfAborted();
    const summary = await writeCompaction({
      ...input,
      summarized: {
        text,
        throughSeq,
        mode: "recent",
        ...(savedSummary ? { savedSummary } : {}),
      },
    });
    return [summary, ...recent];
  }

  const WRITE_WAIT_MS = 60_000;

  const backgroundCompaction = createKeyedQueue<string>();
  const compactionPending = new Set<string>();

  function scheduleBackgroundCompaction(input: {
    tenant: Tenant;
    sessionId: string;
    runLeaseToken?: string;
    scopeId: string;
    actorId: string;
    route?: SessionRoute;
  }): void {
    if (compactionPending.has(input.sessionId)) return;
    compactionPending.add(input.sessionId);
    const recordFailure = (e: unknown) =>
      deps.errors.record(
        input.tenant,
        {
          category: "turn",
          code: "background_compaction_failed",
          message: errMessage(e),
          scopeLabel: input.scopeId as ScopeId,
          sessionId: input.sessionId,
        },
        e,
      );
    void backgroundCompaction(input.sessionId, async () => {
      compactionPending.delete(input.sessionId);
      try {
        const session = await deps.sessions.get(input.sessionId);
        if (!session) return;
        const maxContextTokens = tokenBudgetFor(input.route?.runtime?.modelId);
        const items = (await deps.sessions.getContextWindow(input.sessionId)).items;
        const history = forModelContext(items);
        if (!overBudgetFraction(history, maxContextTokens, COMPACT_SOFT_FRACTION)) return;
        const snapshotSeq = items.at(-1)?.seq ?? -1;
        const summarized = await summarizeForCompaction({
          tenant: input.tenant,
          session,
          visibleHistory: history,
          scopeId: input.scopeId,
          actorId: input.actorId,
          ...(input.route ? { route: input.route } : {}),
        });
        if (!summarized) return;
        if (deps.runs && !(await waitForNoRunningRun(deps.runs, session.threadRef, WRITE_WAIT_MS, input.runLeaseToken)))
          return;
        const since = await deps.sessions.getItems(input.sessionId, { sinceSeq: snapshotSeq + 1 });
        if (!since.some((item) => item.kind === "ContextCompaction" && item.throughSeq !== null)) {
          await writeCompaction({ session, writer: { sessionId: input.sessionId }, summarized });
        }
      } catch (e) {
        recordFailure(e);
      }
    }).catch((e) => {
      recordFailure(e);
    });
  }

  return { compactContextIfNeeded, compactRecent, scheduleBackgroundCompaction, documentTokenBudget };
}
