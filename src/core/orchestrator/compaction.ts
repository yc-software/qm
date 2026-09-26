import type { ScopeId, Session, SessionEntry } from "../../types.ts";
import { parseScopeId } from "../../types.ts";
import type { Lease } from "../../sessions/session-store.ts";
import {
  acquireLeaseWithin,
  contextSummaryPayload,
  createContextSummaryPayload,
  entrySecurityTainted,
  tapeCheckpointPayload,
  tapeEntryMirrorRecord,
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
import { goalSnapshotPayload, latestGoalEntry, latestGoalRecord } from "../../harness/goal.ts";
import { coverageImportEvent } from "../../harness/replay.ts";
import { estimateCostUsd } from "../../ratelimit/budget.ts";
import { errMessage } from "../../util/errors.ts";
import { createKeyedQueue } from "../../util/async.ts";
import type { OrchestratorDeps } from "./types.ts";

const MAX_CONTEXT_TOKENS = 120_000;
const KEEP_RECENT_TOKEN_FRACTION = 0.6;

interface Summarized {
  text: string;
  summaryLabel: ScopeId;
  throughSeq: number;
  securityTainted: boolean;
  mode?: "recent";
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
  compactRecent(input: {
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
    const goal = latestGoalEntry(rest);
    if (goal && !kept.includes(goal)) kept.unshift(goal);
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
      visibleHistory: SessionEntry[];
      scopeId: string;
      orgScopeId: string;
      actorId: string;
      model?: string;
      cancel?: AbortSignal;
    },
    recoverOnFailure = false,
  ): Promise<Summarized | null> {
    if (isManagedGroupScope(input.scopeId)) return null;
    if (!deps.harness.models.compactHistory) return null;
    const maxContextTokens = tokenBudgetFor(input.scopeId, input.model);
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
      securityTainted: plan.toSummarize.some(
        (entry) => (entry.payload as { securityTainted?: unknown } | null)?.securityTainted === true,
      ),
    };
  }

  async function writeCompaction(input: {
    session: Session;
    lease: Lease;
    summarized: Summarized;
    goalSource: SessionEntry | null;
    recent?: SessionEntry[];
  }): Promise<{ summary: SessionEntry; goalEntry?: SessionEntry }> {
    const { text, summaryLabel, throughSeq, securityTainted, mode } = input.summarized;
    const goal = latestGoalRecord(input.goalSource ? [input.goalSource] : []);
    const goalEntry =
      goal && input.goalSource
        ? await deps.sessions.append(input.lease, {
            type: "system",
            payload: {
              ...goalSnapshotPayload(goal),
              ...(entrySecurityTainted(input.goalSource) ? { securityTainted: true } : {}),
            },
            scopeLabel: input.goalSource.scopeLabel,
          })
        : undefined;
    if (goalEntry) await deps.sessions.appendTape(input.lease, tapeEntryMirrorRecord(goalEntry));
    const summary = await deps.sessions.append(input.lease, {
      type: "system",
      payload: {
        ...createContextSummaryPayload(throughSeq, text),
        ...(mode ? { mode } : {}),
        ...(securityTainted ? { securityTainted: true } : {}),
      },
      scopeLabel: summaryLabel,
    });
    const covered = (await deps.sessions.tapeCoverage(input.session.id)) === (goalEntry?.seq ?? summary.seq) - 1;
    const recoveredCoverage = covered ? summary.seq : undefined;
    await deps.sessions.appendTape(input.lease, {
      kind: "context_event",
      payload: mode
        ? { ...coverageImportEvent([...(input.recent ?? []), ...(goalEntry ? [goalEntry] : []), summary]), mode }
        : { event: "compaction", text },
      scopeLabel: summaryLabel as ScopeId,
      entrySeq: summary.seq,
      coversEntrySeq: mode ? recoveredCoverage : throughSeq,
      meta: {
        entryCreatedAt: summary.createdAt,
        ...(securityTainted ? { securityTainted: true } : {}),
      },
    });
    if (covered) {
      await deps.sessions.appendTape(input.lease, {
        kind: "annotation",
        payload: tapeCheckpointPayload("turnEnd"),
        scopeLabel: summaryLabel as ScopeId,
        entrySeq: summary.seq,
      });
    }
    await deps.harness.turns.resetSession?.(input.session.id);
    return { summary, goalEntry };
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
    const summarized = await summarizeForCompaction(input, true);
    if (!summarized) return null;
    const { summary, goalEntry } = await writeCompaction({
      ...input,
      summarized,
      goalSource: latestGoalEntry(input.visibleHistory),
    });
    const recent = input.visibleHistory.filter(
      (entry) => entry.seq > summarized.throughSeq && !contextSummaryPayload(entry),
    );
    return boundRecent(
      [summary, ...recent, ...(goalEntry ? [goalEntry] : [])],
      tokenBudgetFor(input.scopeId, input.model),
    );
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
    const rebuilt = await applyCompaction(input);
    return (
      rebuilt ??
      (!deps.harness.models.compactHistory || isManagedGroupScope(input.scopeId)
        ? boundRecent(input.visibleHistory, maxContextTokens)
        : compactRecent(input))
    );
  }

  async function compactRecent(input: Parameters<CompactionContext["compactRecent"]>[0]): Promise<SessionEntry[]> {
    input.cancel?.throwIfAborted();
    const budget = Math.floor(tokenBudgetFor(input.scopeId, input.model) * keepRecentTokenFraction);
    const goalSource = latestGoalEntry(input.visibleHistory);
    const prior = input.visibleHistory.findLast((entry) => contextSummaryPayload(entry));
    const rest = input.visibleHistory.filter((entry) => !contextSummaryPayload(entry));
    const notice =
      "[Context reduced without a new summary. Earlier entries are excluded, not deleted. Use history to reopen missing requests and tool calls; history does not return tool results. Check actual state before repeating actions whose outcomes are missing.]";
    const marker: SessionEntry = {
      sessionId: input.session.id,
      seq: -1,
      parentSeq: null,
      type: "system",
      payload: { text: `${notice}\n\nLast saved summary (not updated):\n` },
      scopeLabel: input.scopeId as ScopeId,
      createdAt: 0,
    };
    let remaining = Math.max(
      0,
      budget - estimateEntryTokens(marker) - (goalSource ? estimateEntryTokens(goalSource) : 0),
    );
    let start = rest.length;
    while (start > 0) {
      const cost = estimateEntryTokens(rest[start - 1]!);
      if (cost > remaining) break;
      remaining -= cost;
      start--;
    }
    const retainedCalls = new Set<unknown>();
    for (let i = start; i < rest.length; i++) {
      const entry = rest[i]!;
      const callId = (entry.payload as { callId?: unknown } | null)?.callId;
      if (entry.type === "tool_call" && callId) retainedCalls.add(callId);
      if (entry.type === "tool_result" && !retainedCalls.has(callId)) {
        start = i + 1;
        retainedCalls.clear();
      }
    }
    const recent = rest.slice(start);
    remaining =
      budget -
      estimateEntryTokens(marker) -
      (goalSource ? estimateEntryTokens(goalSource) : 0) -
      estimateHistoryTokens(recent);
    const includedPrior = prior && estimateEntryTokens(prior) <= remaining ? prior : undefined;
    const priorText = includedPrior ? contextSummaryPayload(includedPrior)!.text : undefined;
    let text = notice;
    if (priorText)
      text = priorText.startsWith(notice) ? priorText : `${notice}\n\nLast saved summary (not updated):\n${priorText}`;
    const window = await deps.sessions.getContextWindow(input.session.id);
    const boundary = window.entries.reduce(
      (seq, entry) => Math.max(seq, contextSummaryPayload(entry)?.throughSeq ?? -1),
      -1,
    );
    const throughSeq = Math.max(boundary, compactionThroughSeq([...(prior ? [prior] : []), ...rest.slice(0, start)]));
    input.cancel?.throwIfAborted();
    const { summary, goalEntry } = await writeCompaction({
      ...input,
      summarized: {
        text,
        summaryLabel: (includedPrior?.scopeLabel ?? input.scopeId) as ScopeId,
        throughSeq,
        securityTainted: !!includedPrior && entrySecurityTainted(includedPrior),
        mode: "recent",
      },
      goalSource: goalSource && !recent.includes(goalSource) ? goalSource : null,
      recent,
    });
    return [summary, ...recent, ...(goalEntry ? [goalEntry] : [])];
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
    includeSecurityTainted?: boolean;
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
        const entries = (await deps.sessions.getContextWindow(input.sessionId)).entries;
        const history = forModelContext(entries, { includeSecurityTainted: input.includeSecurityTainted });
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
        const since = await deps.sessions.getEntries(input.sessionId, { sinceSeq: snapshotSeq + 1 });
        if (!since.some((entry) => !!contextSummaryPayload(entry))) {
          const current = forModelContext((await deps.sessions.getContextWindow(input.sessionId)).entries, {
            includeSecurityTainted: input.includeSecurityTainted,
          });
          await writeCompaction({ session, lease, summarized, goalSource: latestGoalEntry(current) });
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

  return { compactContextIfNeeded, compactRecent, scheduleBackgroundCompaction };
}
