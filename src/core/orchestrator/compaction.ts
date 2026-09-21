import type { ScopeId, Session, SessionEntry } from "../../types.ts";
import { parseScopeId } from "../../types.ts";
import type { Lease } from "../../sessions/session-store.ts";
import {
  acquireLeaseWithin,
  contextSummaryPayload,
  createContextSummaryPayload,
  tapeCheckpointPayload,
} from "../../sessions/session-store.ts";
import {
  COMPACT_HARD_FRACTION,
  COMPACT_SOFT_FRACTION,
  validateCompactSummary,
  compactionThroughSeq,
  estimateEntryTokens,
  estimateHistoryTokens,
  forModelContext,
  overBudgetFraction,
  planCompaction,
  recentEntryCountWithinBudget,
} from "../../harness/context-compaction.ts";
import { countTokens } from "../../util/tokens.ts";
import { estimateCostUsd } from "../../ratelimit/budget.ts";
import { errMessage } from "../../util/errors.ts";
import { createKeyedQueue } from "../../util/async.ts";
import { NonRetryableTurnError } from "../turn-error.ts";
import type { OrchestratorDeps } from "./types.ts";

const MAX_CONTEXT_TOKENS = 120_000;
const KEEP_RECENT_TOKEN_FRACTION = 0.6;

interface Summarized {
  text: string;
  summaryLabel: ScopeId;
  throughSeq: number;
  securityTainted: boolean;
}

export interface CompactionContext {
  compactContextIfNeeded(input: {
    session: Session;
    lease: Lease;
    visibleHistory: SessionEntry[];
    scopeId: string;
    orgScopeId: string;
    actorId: string;
    model?: string;
    cancel?: AbortSignal;
  }): Promise<SessionEntry[]>;
  scheduleBackgroundCompaction(input: {
    sessionId: string;
    scopeId: string;
    orgScopeId: string;
    actorId: string;
    model?: string;
    cancel?: AbortSignal;
    includeSecurityTainted?: boolean;
  }): void;
}

export function createCompaction(deps: OrchestratorDeps): CompactionContext {
  const tokenBudgetFor = (scopeLabel?: string, model?: string): number =>
    deps.maxContextTokens ?? deps.harness.models.contextTokenBudget?.(scopeLabel, model) ?? MAX_CONTEXT_TOKENS;

  const boundRecent = (entries: SessionEntry[], maxContextTokens: number): SessionEntry[] => {
    const summary = entries.find((e) => contextSummaryPayload(e));
    const rest = summary ? entries.filter((e) => e !== summary) : entries;
    const kept = rest.slice(
      rest.length - recentEntryCountWithinBudget(rest, maxContextTokens - (summary ? estimateEntryTokens(summary) : 0)),
    );
    return summary ? [summary, ...kept] : kept;
  };
  const isManagedGroupScope = (scope: string): boolean => {
    const parsed = parseScopeId(scope);
    return parsed.kind === "group" && deps.managedGroups?.recognizes(parsed.ref) === true;
  };

  const keepRecentTokenFraction = Math.min(KEEP_RECENT_TOKEN_FRACTION, COMPACT_SOFT_FRACTION - 0.1);

  async function summarizeForCompaction(input: {
    session: Session;
    visibleHistory: SessionEntry[];
    scopeId: string;
    orgScopeId: string;
    actorId: string;
    model?: string;
    cancel?: AbortSignal;
  }): Promise<Summarized | null> {
    if (isManagedGroupScope(input.scopeId)) return null;
    if (!deps.harness.models.compactHistory) return null;
    const maxContextTokens = tokenBudgetFor(input.scopeId, input.model);
    const reuseBudgetTokens = Math.floor(maxContextTokens * keepRecentTokenFraction);
    const plan = planCompaction(input.visibleHistory, maxContextTokens, keepRecentTokenFraction, reuseBudgetTokens);
    if (!plan || !plan.toSummarize.length) return null;

    const summaryLabel = input.scopeId;

    const raw = await deps.harness.models.compactHistory({
      session: input.session,
      history: plan.toSummarize,
      cancel: input.cancel,
      recordModelCall: (rec) => {
        deps.modelGateway.recordCall({ at: Date.now(), scopeLabel: summaryLabel, ...rec });
        void deps.budget?.record(input.actorId, estimateCostUsd(rec.inputTokens));
      },
    });
    input.cancel?.throwIfAborted();
    const text = validateCompactSummary(raw);
    return {
      text,
      summaryLabel,
      throughSeq: compactionThroughSeq(plan.toSummarize),
      securityTainted: plan.toSummarize.some(
        (entry) => (entry.payload as { securityTainted?: unknown } | null)?.securityTainted === true,
      ),
    };
  }

  async function writeCompaction(input: {
    session: Session;
    lease: Lease;
    summarized: Summarized;
  }): Promise<SessionEntry> {
    const { text, summaryLabel, throughSeq, securityTainted } = input.summarized;
    const summary = await deps.sessions.append(input.lease, {
      type: "system",
      payload: {
        ...createContextSummaryPayload(throughSeq, text),
        ...(securityTainted ? { securityTainted: true } : {}),
      },
      scopeLabel: summaryLabel,
    });
    await deps.sessions.appendTape(input.lease, {
      kind: "context_event",
      payload: { event: "compaction", text },
      scopeLabel: summaryLabel as ScopeId,
      entrySeq: summary.seq,
      coversEntrySeq: throughSeq,
      meta: {
        entryCreatedAt: summary.createdAt,
        ...(securityTainted ? { securityTainted: true } : {}),
      },
    });
    if ((await deps.sessions.tapeCoverage(input.session.id)) === summary.seq - 1) {
      await deps.sessions.appendTape(input.lease, {
        kind: "annotation",
        payload: tapeCheckpointPayload("turnEnd"),
        scopeLabel: summaryLabel as ScopeId,
        entrySeq: summary.seq,
      });
    }
    await deps.harness.turns.resetSession?.(input.session.id);
    return summary;
  }

  async function applyCompaction(input: {
    session: Session;
    lease: Lease;
    visibleHistory: SessionEntry[];
    scopeId: string;
    orgScopeId: string;
    actorId: string;
    model?: string;
    cancel?: AbortSignal;
  }): Promise<SessionEntry[] | null> {
    const summarized = await summarizeForCompaction(input);
    if (!summarized) return null;
    const recent = input.visibleHistory.filter(
      (entry) => entry.seq > summarized.throughSeq && !contextSummaryPayload(entry),
    );
    const rebuiltTokens =
      estimateHistoryTokens(recent) +
      countTokens(createContextSummaryPayload(summarized.throughSeq, summarized.text).text);
    if (rebuiltTokens > tokenBudgetFor(input.scopeId, input.model)) {
      throw new NonRetryableTurnError(
        "Conversation summary and recent messages still exceed the context budget. Your history is preserved; shorten the latest input before retrying.",
      );
    }
    input.cancel?.throwIfAborted();
    const summary = await writeCompaction({ ...input, summarized });
    return [summary, ...recent];
  }

  async function compactContextIfNeeded(input: {
    session: Session;
    lease: Lease;
    visibleHistory: SessionEntry[];
    scopeId: string;
    orgScopeId: string;
    actorId: string;
    model?: string;
    cancel?: AbortSignal;
  }): Promise<SessionEntry[]> {
    const maxContextTokens = tokenBudgetFor(input.scopeId, input.model);
    if (!overBudgetFraction(input.visibleHistory, maxContextTokens, COMPACT_HARD_FRACTION)) {
      return input.visibleHistory;
    }
    if (isManagedGroupScope(input.scopeId)) return boundRecent(input.visibleHistory, maxContextTokens);
    const rebuilt = await applyCompaction(input);
    if (rebuilt) return rebuilt;
    if (!overBudgetFraction(input.visibleHistory, maxContextTokens, 1)) return input.visibleHistory;
    throw new NonRetryableTurnError(
      "Conversation summarization is unavailable and the context budget is full. Your history is preserved.",
    );
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
    cancel?: AbortSignal;
    includeSecurityTainted?: boolean;
  }): void {
    if (compactionPending.has(input.sessionId)) return;
    compactionPending.add(input.sessionId);
    void backgroundCompaction(input.sessionId, async () => {
      let lease: Lease | null = null;
      try {
        const session = await deps.sessions.get(input.sessionId);
        if (!session) return;
        const maxContextTokens = tokenBudgetFor(input.scopeId, input.model);
        const entries = (await deps.sessions.getContextWindow(input.sessionId)).entries;
        const history = forModelContext(entries, { includeSecurityTainted: input.includeSecurityTainted });
        if (!overBudgetFraction(history, maxContextTokens, COMPACT_SOFT_FRACTION)) return;
        const snapshotSeq = entries.at(-1)?.seq ?? -1;
        const summarized = await summarizeForCompaction({
          session,
          cancel: input.cancel,
          visibleHistory: history,
          scopeId: input.scopeId,
          orgScopeId: input.orgScopeId,
          actorId: input.actorId,
          ...(input.model ? { model: input.model } : {}),
        });
        if (!summarized) return;
        lease = (await acquireLeaseWithin(deps.sessions, input.sessionId, "compaction", WRITE_LEASE_WAIT_MS)).lease;
        if (!lease) return;
        const since = await deps.sessions.getEntries(input.sessionId, { sinceSeq: snapshotSeq + 1 });
        if (!since.some((entry) => !!contextSummaryPayload(entry))) {
          input.cancel?.throwIfAborted();
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
        compactionPending.delete(input.sessionId);
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

  return { compactContextIfNeeded, scheduleBackgroundCompaction };
}
