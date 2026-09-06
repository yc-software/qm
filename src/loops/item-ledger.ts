import type { LedgerEvent, LedgerEventOp } from "./ledger-events.ts";
import { canonicalJson } from "../util/objects.ts";
import { wireMentionKeys } from "../slack/mrkdwn.ts";
import type { LoopItem, LoopItemStatus, LoopProposal, LoopSourcePayload, LoopThreadMessage } from "../types.ts";
import { isResolved } from "./ledger-view.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import { contentPart } from "../triggers/trigger-store.ts";
import { hashId } from "../util/crypto.ts";
import { randomUUID } from "node:crypto";

interface EnqueueItemInput {
  loopId: string;
  sourceKey: string;
  sourceSummary?: string;
}

interface EnqueueResult {
  item: LoopItem;
  created: boolean;
}

export interface LoopQueueStats {
  queued: number;
  inProgress: number;
  ready: number;
  failed: number;
  oldestQueuedAgeMs?: number;
}

export interface IngestEntryInput {
  loopId: string;
  dedupeKey: string;
  source?: string;
  summary?: string;
  sourcePayload: LoopSourcePayload;
  sourceAt?: number;
  proposal?: Omit<LoopProposal, "at">;
}

interface IngestOutcome {
  created: number;
  updated: number;
  skipped: number;
}

interface PruneOptions {
  maxItems: number;
  retentionMs: number;
  now?: number;
}

interface RecordActionInput {
  kind: string;
  result?: string;
  actorId?: string;
  outcome: "actioned" | "dismissed";
}

export interface LoopItemLedger {
  enqueue(input: EnqueueItemInput): Promise<EnqueueResult>;
  ingest(entries: IngestEntryInput[]): Promise<IngestOutcome>;
  setProposal(id: string, proposal: Omit<LoopProposal, "at">, opts?: { expectedAt?: number }): Promise<LoopItem | null>;
  annotate(id: string, patch: LoopSourcePayload): Promise<LoopItem | null>;
  appendThread(id: string, messages: Array<Omit<LoopThreadMessage, "id" | "at">>): Promise<LoopItem | null>;
  recordAction(id: string, input: RecordActionInput): Promise<LoopItem | null>;
  reopen(id: string): Promise<LoopItem | null>;
  prune(loopId: string, options: PruneOptions): Promise<number>;
  get(id: string): Promise<LoopItem | null>;
  byLoop(loopId: string): Promise<LoopItem[]>;
  queued(loopId: string, limit?: number): Promise<LoopItem[]>;
  claim(id: string, claimedAt?: number): Promise<LoopItem | null>;
  acquireDecision(id: string, decisionAt?: number): Promise<string | null>;
  releaseDecision(id: string, token: string): Promise<boolean>;
  recordRun(id: string, runId: string, claimToken: string): Promise<LoopItem | null>;
  markReady(id: string, outputIds: string[], claimToken: string): Promise<LoopItem | null>;
  markShipped(id: string, claimToken?: string): Promise<LoopItem | null>;
  returnToWork(id: string, guidance: string, claimToken?: string): Promise<LoopItem | null>;
  park(id: string, reason: string, claimToken?: string): Promise<LoopItem | null>;
  skip(id: string, reason: string): Promise<LoopItem | null>;
  stats(loopId: string, now: number): Promise<LoopQueueStats>;
  deleteByLoop(loopId: string): Promise<void>;
}

export function loopItemId(loopId: string, sourceKey: string): string {
  return hashId([contentPart(loopId), contentPart(sourceKey)]);
}

const CLAIM_LEASE_MS = 600_000;
const LEDGER_THREAD_MAX = 200;
export const DECISION_LEASE_MS = 300_000;

function nextIngestStatus(item: LoopItem, proposal: LoopProposal | undefined): LoopItemStatus {
  if (item.status === "in_progress") return "in_progress";
  if (proposal) return "ready";
  return isResolved(item) ? "queued" : item.status;
}

const AGENT_DRAFT_HISTORY = 10;

function sameDraft(a: LoopProposal | undefined, b: LoopProposal): boolean {
  return a !== undefined && canonicalJson(a.data) === canonicalJson(b.data);
}

export function agentDraftsOf(item: Pick<LoopItem, "proposal" | "agentDrafts">): LoopProposal[] {
  const kept = item.agentDrafts ?? [];
  if (item.proposal?.by !== "agent" || sameDraft(kept.at(-1), item.proposal)) return kept;
  return [...kept, item.proposal];
}

export function agentDraftOf(item: Pick<LoopItem, "proposal" | "agentDrafts">): LoopProposal | undefined {
  return agentDraftsOf(item).at(-1);
}

function withAgentDraft(
  item: Pick<LoopItem, "proposal" | "agentDrafts" | "agentMentionKeys">,
  proposal: LoopProposal | undefined,
): Pick<LoopItem, "agentDrafts" | "agentMentionKeys"> {
  const drafts = agentDraftsOf(item);
  const next = proposal?.by === "agent" && !sameDraft(drafts.at(-1), proposal) ? [...drafts, proposal] : drafts;
  const keys = new Set(item.agentMentionKeys ?? []);
  for (const draft of next) for (const key of wireMentionKeys(canonicalJson(draft.data))) keys.add(key);
  return { agentDrafts: next.slice(-AGENT_DRAFT_HISTORY), agentMentionKeys: [...keys] };
}

function mergeIngest(item: LoopItem, entry: IngestEntryInput, now: number): LoopItem | null {
  const newerSource = entry.sourceAt !== undefined && entry.sourceAt > (item.sourceAt ?? 0);
  if (isResolved(item) && !newerSource) return null;
  if (!isResolved(item) && !newerSource && !entry.proposal) return null;
  const keepHumanProposal = item.proposal?.by === "human" && !newerSource;
  const incoming = entry.proposal ? { ...entry.proposal, at: now } : item.proposal;
  const proposal =
    keepHumanProposal || (incoming && item.proposal?.by === "agent" && sameDraft(item.proposal, incoming))
      ? item.proposal
      : incoming;
  const status = nextIngestStatus(item, proposal);
  return {
    ...item,
    status,
    ...withAgentDraft(item, proposal),
    sourcePayload: entry.sourcePayload,
    sourceAt: entry.sourceAt ?? item.sourceAt,
    actedAt: undefined,
    actionKind: undefined,
    actionResult: undefined,
    parkedReason: undefined,
    updatedAt: now,
    ...(entry.source !== undefined ? { source: entry.source } : {}),
    ...(entry.summary !== undefined ? { sourceSummary: entry.summary } : {}),
    ...(proposal ? { proposal } : { proposal: undefined }),
  };
}

export function createLoopItemLedger(
  backing: DurableMap<LoopItem> = createMemoryMap<LoopItem>(),
  onEvent?: (event: LedgerEvent) => void,
): LoopItemLedger {
  if (!backing.update) throw new Error("loop items need atomic durable updates");
  const update = backing.update.bind(backing);
  const emit = (item: LoopItem | null | undefined, op: LedgerEventOp): void => {
    if (item && onEvent) onEvent({ loopId: item.loopId, itemId: item.id, op, at: Date.now() });
  };
  const transition = async (
    id: string,
    allowed: ReadonlySet<LoopItemStatus>,
    change: (item: LoopItem, now: number) => LoopItem,
    claimToken?: string,
    op?: LedgerEventOp,
  ): Promise<LoopItem | null> => {
    let applied = false;
    const after = await update(id, (item) => {
      if (!allowed.has(item.status)) return item;
      if (item.status === "in_progress" && item.claimToken !== claimToken) return item;
      applied = true;
      return change(item, Date.now());
    });
    if (applied && op) emit(after, op);
    return applied ? after : null;
  };

  const forLoop = async (loopId: string): Promise<LoopItem[]> =>
    (await backing.all()).filter((item) => item.loopId === loopId);

  return {
    async enqueue(input) {
      const id = loopItemId(input.loopId, input.sourceKey);
      const now = Date.now();
      const candidate: LoopItem = {
        id,
        loopId: input.loopId,
        sourceKey: input.sourceKey,
        status: "queued",
        attempts: 0,
        runIds: [],
        outputIds: [],
        createdAt: now,
        updatedAt: now,
        ...(input.sourceSummary !== undefined ? { sourceSummary: input.sourceSummary } : {}),
      };
      if (backing.insertIfAbsent) {
        const created = await backing.insertIfAbsent(id, candidate);
        return { item: created ? candidate : ((await backing.get(id)) ?? candidate), created };
      }
      const stored = await backing.putIfAbsent(id, candidate);
      return { item: stored, created: stored.createdAt === candidate.createdAt };
    },
    async ingest(entries) {
      const outcome: IngestOutcome = { created: 0, updated: 0, skipped: 0 };
      for (const entry of entries) {
        const id = loopItemId(entry.loopId, entry.dedupeKey);
        const now = Date.now();
        const candidate: LoopItem = {
          id,
          loopId: entry.loopId,
          sourceKey: entry.dedupeKey,
          status: entry.proposal ? "ready" : "queued",
          attempts: 0,
          runIds: [],
          outputIds: [],
          sourcePayload: entry.sourcePayload,
          createdAt: now,
          updatedAt: now,
          ...(entry.source !== undefined ? { source: entry.source } : {}),
          ...(entry.summary !== undefined ? { sourceSummary: entry.summary } : {}),
          ...(entry.sourceAt !== undefined ? { sourceAt: entry.sourceAt } : {}),
          ...(entry.proposal ? { proposal: { ...entry.proposal, at: now } } : {}),
          ...withAgentDraft({ agentDrafts: [] }, entry.proposal ? { ...entry.proposal, at: now } : undefined),
        };
        const inserted = backing.insertIfAbsent
          ? await backing.insertIfAbsent(id, candidate)
          : (await backing.putIfAbsent(id, candidate)).createdAt === candidate.createdAt;
        if (inserted) {
          outcome.created++;
          emit(candidate, "ingest");
          continue;
        }
        let merged = false;
        await update(id, (item) => {
          const next = mergeIngest(item, entry, Date.now());
          if (next === null) return item;
          merged = true;
          return next;
        });
        if (merged) {
          outcome.updated++;
          emit(await backing.get(id), "ingest");
        } else outcome.skipped++;
      }
      return outcome;
    },
    async setProposal(id, proposal, opts) {
      let applied = false;
      const after = await update(id, (item) => {
        if (item.status === "shipped") return item;
        if (opts?.expectedAt !== undefined && item.proposal?.at !== opts.expectedAt) return item;
        applied = true;
        const now = Date.now();
        const stamped = { ...proposal, at: now };
        return {
          ...item,
          proposal: stamped,
          ...withAgentDraft(item, stamped),
          status: item.status === "queued" ? "ready" : item.status,
          updatedAt: now,
        };
      });
      if (applied) emit(after, "proposal");
      return applied ? after : null;
    },
    async annotate(id, patch) {
      let applied = false;
      const after = await update(id, (item) => {
        applied = true;
        const now = Date.now();
        return { ...item, sourcePayload: { ...item.sourcePayload, ...patch }, updatedAt: now };
      });
      if (applied) emit(after, "annotate");
      return applied ? after : null;
    },
    async appendThread(id, messages) {
      if (messages.length === 0) return backing.get(id);
      let applied = false;
      const after = await update(id, (item) => {
        applied = true;
        const now = Date.now();
        const added = messages.map((message) => ({ ...message, id: randomUUID(), at: now }));
        const thread = [...(item.thread ?? []), ...added];
        return {
          ...item,
          thread: thread.length > LEDGER_THREAD_MAX ? thread.slice(thread.length - LEDGER_THREAD_MAX) : thread,
          updatedAt: now,
        };
      });
      if (applied) emit(after, "thread");
      return applied ? after : null;
    },
    async recordAction(id, input) {
      let applied = false;
      const after = await update(id, (item) => {
        if (item.status === "shipped") return item;
        applied = true;
        const now = Date.now();
        return {
          ...item,
          status: input.outcome === "actioned" ? "shipped" : "skipped",
          actionKind: input.kind,
          actedAt: now,
          claimedAt: undefined,
          claimToken: undefined,
          parkedReason: undefined,
          updatedAt: now,
          ...(input.result !== undefined ? { actionResult: input.result } : {}),
        };
      });
      if (applied) emit(after, "action");
      return applied ? after : null;
    },
    async reopen(id) {
      let applied = false;
      const after = await update(id, (item) => {
        if (item.status !== "skipped" && item.status !== "failed") return item;
        applied = true;
        const now = Date.now();
        return {
          ...item,
          status: item.proposal ? "ready" : "queued",
          actedAt: undefined,
          actionKind: undefined,
          actionResult: undefined,
          parkedReason: undefined,
          updatedAt: now,
        };
      });
      if (applied) emit(after, "reopen");
      return applied ? after : null;
    },
    async prune(loopId, options) {
      const now = options.now ?? Date.now();
      const items = await forLoop(loopId);
      const expired = items.filter(
        (item) => isResolved(item) && now - (item.actedAt ?? item.updatedAt) >= options.retentionMs,
      );
      const doomed = new Map(expired.map((item) => [item.id, item]));
      const surviving = items.filter((item) => !doomed.has(item.id));
      if (surviving.length > options.maxItems) {
        const resolvedOldestFirst = surviving
          .filter(isResolved)
          .sort((a, b) => (a.actedAt ?? a.updatedAt) - (b.actedAt ?? b.updatedAt));
        for (const item of resolvedOldestFirst.slice(0, surviving.length - options.maxItems)) doomed.set(item.id, item);
      }
      for (const id of doomed.keys()) await backing.delete(id);
      return doomed.size;
    },
    get: (id) => backing.get(id),
    byLoop: forLoop,
    async queued(loopId, limit) {
      const queued = (await forLoop(loopId))
        .filter((item) => item.status === "queued")
        .sort((a, b) => a.createdAt - b.createdAt);
      return limit === undefined ? queued : queued.slice(0, limit);
    },
    async claim(id, claimedAt = Date.now()) {
      const now = claimedAt;
      let applied = false;
      const after = await update(id, (item) => {
        const stale = item.status === "in_progress" && (item.claimedAt ?? 0) + CLAIM_LEASE_MS <= now;
        if (item.status !== "queued" && !stale) return item;
        applied = true;
        return {
          ...item,
          status: "in_progress",
          attempts: item.attempts + 1,
          claimedAt: now,
          claimToken: randomUUID(),
          parkedReason: undefined,
          updatedAt: now,
        };
      });
      return applied ? after : null;
    },
    async acquireDecision(id, decisionAt = Date.now()) {
      let token: string | null = null;
      await update(id, (item) => {
        const active = item.decisionToken && (item.decisionAt ?? 0) + DECISION_LEASE_MS > decisionAt;
        if (active) return item;
        token = randomUUID();
        return { ...item, decisionAt, decisionToken: token, updatedAt: decisionAt };
      });
      return token;
    },
    async releaseDecision(id, token) {
      let released = false;
      await update(id, (item) => {
        if (item.decisionToken !== token) return item;
        released = true;
        return { ...item, decisionAt: undefined, decisionToken: undefined, updatedAt: Date.now() };
      });
      return released;
    },
    async recordRun(id, runId, claimToken) {
      return transition(
        id,
        new Set(["in_progress"]),
        (item, now) => ({
          ...item,
          runIds: [...new Set([...item.runIds, runId])],
          updatedAt: now,
        }),
        claimToken,
      );
    },
    async markReady(id, outputIds, claimToken) {
      return transition(
        id,
        new Set(["in_progress"]),
        (item, now) => ({
          ...item,
          status: "ready",
          outputIds: [...new Set([...item.outputIds, ...outputIds])],
          claimedAt: undefined,
          claimToken: undefined,
          updatedAt: now,
        }),
        claimToken,
        "ready",
      );
    },
    markShipped: (id, claimToken) =>
      transition(
        id,
        new Set(["ready", "in_progress"]),
        (item, now) => ({
          ...item,
          status: "shipped",
          claimedAt: undefined,
          claimToken: undefined,
          updatedAt: now,
        }),
        claimToken,
        "shipped",
      ),
    returnToWork: (id, guidance, claimToken) =>
      transition(
        id,
        new Set(["ready", "in_progress"]),
        (item, now) => ({
          ...item,
          status: "queued",
          guidance,
          claimedAt: undefined,
          claimToken: undefined,
          updatedAt: now,
        }),
        claimToken,
        "returned",
      ),
    park: (id, reason, claimToken) =>
      transition(
        id,
        new Set(["queued", "in_progress", "ready"]),
        (item, now) => ({
          ...item,
          status: item.status === "ready" ? "ready" : "failed",
          parkedReason: reason,
          claimedAt: undefined,
          claimToken: undefined,
          updatedAt: now,
        }),
        claimToken,
        "parked",
      ),
    skip: (id, reason) =>
      transition(
        id,
        new Set(["queued", "in_progress"]),
        (item, now) => ({
          ...item,
          status: "skipped",
          parkedReason: reason,
          claimedAt: undefined,
          updatedAt: now,
        }),
        undefined,
        "skipped",
      ),
    async stats(loopId, now) {
      const items = await forLoop(loopId);
      const queued = items.filter((item) => item.status === "queued");
      const oldest = queued.reduce<number | undefined>(
        (acc, item) => (acc === undefined || item.createdAt < acc ? item.createdAt : acc),
        undefined,
      );
      return {
        queued: queued.length,
        inProgress: items.filter((item) => item.status === "in_progress").length,
        ready: items.filter((item) => item.status === "ready").length,
        failed: items.filter((item) => item.status === "failed").length,
        ...(oldest !== undefined ? { oldestQueuedAgeMs: Math.max(0, now - oldest) } : {}),
      };
    },
    async deleteByLoop(loopId) {
      for (const item of await forLoop(loopId)) await backing.delete(item.id);
    },
  };
}
