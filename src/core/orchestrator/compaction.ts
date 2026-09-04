import type { ScopeId, Session, SessionEntry } from "../../types.ts";
import { parseScopeId } from "../../types.ts";
import type { Lease } from "../../sessions/session-store.ts";
import {
  COMPACT_HARD_FRACTION,
  COMPACT_SOFT_FRACTION,
  compactedScopeLabel,
  compactionThroughSeq,
  contextSummaryPayload,
  createContextSummaryPayload,
  estimateEntryTokens,
  forModelContext,
  overBudgetFraction,
  planCompaction,
  recentEntryCountWithinBudget,
} from "../../harness/context-compaction.ts";
import { estimateCostUsd } from "../../ratelimit/budget.ts";
import { errMessage, swallow } from "../../util/errors.ts";
import { createKeyedQueue, sleep } from "../../util/async.ts";
import type { OrchestratorDeps } from "./types.ts";

const MAX_CONTEXT_ENTRIES = 400;
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
  }): Promise<{ history: SessionEntry[]; compactionMirrorFailed: boolean }>;
  scheduleBackgroundCompaction(input: {
    sessionId: string;
    scopeId: string;
    orgScopeId: string;
    actorId: string;
    includeSecurityTainted?: boolean;
  }): void;
}

export function createCompaction(deps: OrchestratorDeps): CompactionContext {
  const maxContextEntries = deps.maxContextEntries ?? MAX_CONTEXT_ENTRIES;
  const tokenBudgetFor = (scopeLabel?: string, model?: string): number =>
    deps.maxContextTokens ?? deps.harness.models.contextTokenBudget?.(scopeLabel, model) ?? MAX_CONTEXT_TOKENS;

  const boundRecent = (entries: SessionEntry[], maxContextTokens: number): SessionEntry[] => {
    const summary = entries.find((e) => contextSummaryPayload(e));
    const rest = summary ? entries.filter((e) => e !== summary) : entries;
    const kept = rest.slice(
      rest.length -
        recentEntryCountWithinBudget(
          rest,
          maxContextEntries - (summary ? 1 : 0),
          maxContextTokens - (summary ? estimateEntryTokens(summary) : 0),
        ),
    );
    return summary ? [summary, ...kept] : kept;
  };
  const isManagedGroupScope = (scope: string): boolean => {
    const parsed = parseScopeId(scope);
    return parsed.kind === "group" && deps.managedGroups?.recognizes(parsed.ref) === true;
  };

  const keepRecentEntries = Math.max(1, Math.floor(maxContextEntries * COMPACT_SOFT_FRACTION) - 1);
  const keepRecentTokenFraction = Math.min(KEEP_RECENT_TOKEN_FRACTION, COMPACT_SOFT_FRACTION - 0.1);

  async function summarizeForCompaction(input: {
    session: Session;
    visibleHistory: SessionEntry[];
    scopeId: string;
    orgScopeId: string;
    actorId: string;
    model?: string;
  }): Promise<Summarized | null> {
    if (isManagedGroupScope(input.scopeId)) return null;
    if (!deps.harness.models.compactHistory) return null;
    const maxContextTokens = tokenBudgetFor(input.scopeId, input.model);
    const reuseBudget = {
      entries: keepRecentEntries + 1,
      tokens: Math.floor(maxContextTokens * keepRecentTokenFraction),
    };
    const plan = planCompaction(
      input.visibleHistory,
      maxContextEntries,
      maxContextTokens,
      keepRecentTokenFraction,
      keepRecentEntries,
      reuseBudget,
    );
    if (!plan || !plan.toSummarize.length) return null;

    const summaryLabel = compactedScopeLabel(plan.toSummarize, input.scopeId, input.orgScopeId);
    if (!summaryLabel) return null;

    const text = await deps.harness.models.compactHistory({
      session: input.session,
      history: plan.toSummarize,
      recordModelCall: (rec) => {
        deps.modelGateway.recordCall({ at: Date.now(), scopeLabel: summaryLabel, ...rec });
        void deps.budget?.record(input.actorId, estimateCostUsd(rec.inputTokens));
      },
    });
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
  }): Promise<{ summary: SessionEntry; mirrored: boolean }> {
    const { text, summaryLabel, throughSeq, securityTainted } = input.summarized;
    const summary = await deps.sessions.append(input.lease, {
      type: "system",
      payload: {
        ...createContextSummaryPayload(throughSeq, text),
        ...(securityTainted ? { securityTainted: true } : {}),
      },
      scopeLabel: summaryLabel,
    });
    let mirrored = true;
    try {
      await deps.sessions.appendTape(input.lease, {
        kind: "context_event",
        payload: { event: "compaction", text },
        scopeLabel: summaryLabel as ScopeId,
        entrySeq: summary.seq,
        coversEntrySeq: throughSeq,
      });
    } catch (e) {
      mirrored = false;
      swallow("tape: compaction event", e);
    }
    try {
      if (mirrored && (await deps.sessions.tapeCoverage(input.session.id)) === summary.seq - 1) {
        await deps.sessions.appendTape(input.lease, {
          kind: "annotation",
          payload: { turnEnd: true },
          scopeLabel: summaryLabel as ScopeId,
          entrySeq: summary.seq,
        });
      }
    } catch (e) {
      swallow("tape: compaction watermark", e);
    }
    await deps.harness.turns.resetSession?.(input.session.id);
    return { summary, mirrored };
  }

  async function applyCompaction(input: {
    session: Session;
    lease: Lease;
    visibleHistory: SessionEntry[];
    scopeId: string;
    orgScopeId: string;
    actorId: string;
    model?: string;
  }): Promise<{ history: SessionEntry[]; mirrored: boolean } | null> {
    const summarized = await summarizeForCompaction(input);
    if (!summarized) return null;
    const { summary, mirrored } = await writeCompaction({ ...input, summarized });
    const recent = input.visibleHistory.filter(
      (entry) => entry.seq > summarized.throughSeq && !contextSummaryPayload(entry),
    );
    return { history: [summary, ...recent.slice(Math.max(0, recent.length - (maxContextEntries - 1)))], mirrored };
  }

  async function compactContextIfNeeded(input: {
    session: Session;
    lease: Lease;
    visibleHistory: SessionEntry[];
    scopeId: string;
    orgScopeId: string;
    actorId: string;
    model?: string;
  }): Promise<{ history: SessionEntry[]; compactionMirrorFailed: boolean }> {
    const maxContextTokens = tokenBudgetFor(input.scopeId, input.model);
    if (!overBudgetFraction(input.visibleHistory, maxContextEntries, maxContextTokens, COMPACT_HARD_FRACTION)) {
      return { history: input.visibleHistory, compactionMirrorFailed: false };
    }
    const rebuilt = await applyCompaction(input);
    return rebuilt
      ? { history: rebuilt.history, compactionMirrorFailed: !rebuilt.mirrored }
      : { history: boundRecent(input.visibleHistory, maxContextTokens), compactionMirrorFailed: false };
  }

  const WRITE_LEASE_WAIT_MS = 60_000;
  const WRITE_LEASE_POLL_MS = 500;

  async function acquireLeaseWithin(sessionId: string, budgetMs: number): Promise<Lease | null> {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const { lease } = await deps.sessions.acquireLease(sessionId, "compaction");
      if (lease) return lease;
      if (Date.now() + WRITE_LEASE_POLL_MS > deadline) return null;
      await sleep(WRITE_LEASE_POLL_MS);
    }
  }

  const backgroundCompaction = createKeyedQueue<string>();
  const compactionPending = new Set<string>();

  function scheduleBackgroundCompaction(input: {
    sessionId: string;
    scopeId: string;
    orgScopeId: string;
    actorId: string;
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
        const maxContextTokens = tokenBudgetFor(input.scopeId);
        const entries = await deps.sessions.getEntries(input.sessionId);
        const history = forModelContext(entries, { includeSecurityTainted: input.includeSecurityTainted });
        if (!overBudgetFraction(history, maxContextEntries, maxContextTokens, COMPACT_SOFT_FRACTION)) return;
        const snapshotSeq = entries.at(-1)?.seq ?? -1;
        const summarized = await summarizeForCompaction({
          session,
          visibleHistory: history,
          scopeId: input.scopeId,
          orgScopeId: input.orgScopeId,
          actorId: input.actorId,
        });
        if (!summarized) return;
        lease = await acquireLeaseWithin(input.sessionId, WRITE_LEASE_WAIT_MS);
        if (!lease) return;
        const since = await deps.sessions.getEntries(input.sessionId, { sinceSeq: snapshotSeq + 1 });
        if (!since.some((entry) => !!contextSummaryPayload(entry))) {
          await writeCompaction({ session, lease, summarized });
        }
      } catch (e) {
        deps.errors?.record({
          category: "turn",
          code: "background_compaction_failed",
          message: errMessage(e),
          scopeLabel: input.scopeId as ScopeId,
          sessionId: input.sessionId,
        });
      } finally {
        if (lease) await deps.sessions.releaseLease(lease);
      }
    }).catch((e) => {
      deps.errors?.record({
        category: "turn",
        code: "background_compaction_failed",
        message: errMessage(e),
        scopeLabel: input.scopeId as ScopeId,
        sessionId: input.sessionId,
      });
    });
  }

  return { compactContextIfNeeded, scheduleBackgroundCompaction };
}
