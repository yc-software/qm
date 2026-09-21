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
  setProposal(
    id: string,
    proposal: Omit<LoopProposal, "at">,
    opts?: { expectedAt?: number; expectedClaimToken?: string },
  ): Promise<LoopItem | null>;
  annotate(id: string, patch: LoopSourcePayload, opts?: { summary?: string }): Promise<LoopItem | null>;
  appendThread(id: string, messages: Array<Omit<LoopThreadMessage, "id" | "at">>): Promise<LoopItem | null>;
  recordAction(id: string, input: RecordActionInput): Promise<LoopItem | null>;
  reopen(id: string, opts?: { sentReply?: boolean }): Promise<LoopItem | null>;
  prune(loopId: string, options: PruneOptions): Promise<number>;
  get(id: string): Promise<LoopItem | null>;
  byLoop(loopId: string): Promise<LoopItem[]>;
  moveSource(from: string, to: string, source: string): Promise<void>;
  summaries(loopIds: string[]): Promise<Array<Omit<LoopItem, "proposal" | "agentDrafts" | "thread" | "sourcePayload">>>;
  queued(loopId: string, limit?: number): Promise<LoopItem[]>;
  claim(id: string, claimedAt?: number, expectedLoopId?: string): Promise<LoopItem | null>;
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

function inboxPreview(payload: LoopSourcePayload | undefined): LoopSourcePayload {
  if (!payload) return {};
  return Object.fromEntries(
    ["title", "from", "fromDetail", "snippet", "receivedAt", "probablyResolved", "sentChat"].flatMap((key) =>
      payload[key] === undefined ? [] : [[key, payload[key]]],
    ),
  );
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
  const refresh = newerSource && !entry.proposal;
  if (refresh && item.decisionToken && (item.decisionAt ?? 0) + DECISION_LEASE_MS > now)
    throw new Error("Item has an active decision; retry the source update");
  const status = refresh ? "queued" : nextIngestStatus(item, proposal);
  return {
    ...item,
    status,
    ...withAgentDraft(item, proposal),
    sourcePayload: entry.sourcePayload,
    inboxPreview: inboxPreview(entry.sourcePayload),
    sourceAt: entry.sourceAt ?? item.sourceAt,
    actedAt: undefined,
    actionKind: undefined,
    actionResult: undefined,
    parkedReason: undefined,
    updatedAt: now,
    ...(entry.source !== undefined ? { source: entry.source } : {}),
    ...(entry.summary !== undefined ? { sourceSummary: entry.summary } : {}),
    ...(proposal ? { proposal } : { proposal: undefined }),
    ...(refresh
      ? {
          proposal: undefined,
          outputIds: [],
          claimToken: undefined,
          claimedAt: undefined,
          attempts: 0,
          ...(item.proposal?.by === "human"
            ? {
                thread: [
                  ...(item.thread ?? []),
                  {
                    id: randomUUID(),
                    role: "human" as const,
                    text: `Previous draft before a newer message arrived:\n${JSON.stringify(item.proposal.data)}`,
                    at: now,
                  },
                ],
              }
            : {}),
        }
      : {}),
  };
}

export function createLoopItemLedger(
  backing: DurableMap<LoopItem> = createMemoryMap<LoopItem>(),
  onEvent?: (event: LedgerEvent) => void,
  coordination?: {
    lock: import("../persistence/advisory-lock.ts").AdvisoryLock;
    accepts: (loopId: string) => Promise<boolean>;
  },
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

  const idFor = async (loopId: string, sourceKey: string): Promise<string> => {
    const id = loopItemId(loopId, sourceKey);
    if (await backing.get(id)) return id;
    return (
      (
        await backing.select({
          where: { field: "loopId", anyOfFold: [loopId] },
          omit: ["sourcePayload", "proposal", "agentDrafts", "thread"],
        })
      ).find((item) => item.loopId === loopId && item.sourceKey === sourceKey)?.id ?? id
    );
  };

  const ledger: LoopItemLedger = {
    async moveSource(from, to, source) {
      const targets = await forLoop(to);
      for (const item of await forLoop(from)) {
        if (item.source !== source) continue;
        if (targets.some((target) => target.sourceKey === item.sourceKey && target.id !== item.id))
          throw new Error("Inbox migration found conflicting source records");
        await update(item.id, (current) => {
          if (
            current.loopId !== from ||
            current.status === "in_progress" ||
            (current.decisionToken && (current.decisionAt ?? 0) + DECISION_LEASE_MS > Date.now())
          )
            return current;
          return { ...current, loopId: to, previousLoopId: from, inboxPreview: inboxPreview(current.sourcePayload) };
        });
      }
    },
    async enqueue(input) {
      const id = await idFor(input.loopId, input.sourceKey);
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
    summaries: (loopIds) =>
      backing.select({
        where: { field: "loopId", anyOfFold: loopIds },
        omit: ["proposal", "agentDrafts", "thread", "sourcePayload"],
      }),
    async ingest(entries) {
      const outcome: IngestOutcome = { created: 0, updated: 0, skipped: 0 };
      for (const entry of entries) {
        const id = await idFor(entry.loopId, entry.dedupeKey);
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
          inboxPreview: inboxPreview(entry.sourcePayload),
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
        if (opts?.expectedClaimToken !== undefined && item.claimToken !== opts.expectedClaimToken) return item;
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
    async annotate(id, patch, opts) {
      let applied = false;
      const after = await update(id, (item) => {
        applied = true;
        const now = Date.now();
        return {
          ...item,
          sourcePayload: { ...item.sourcePayload, ...patch },
          ...(opts?.summary !== undefined ? { sourceSummary: opts.summary } : {}),
          updatedAt: now,
        };
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
    async reopen(id, opts) {
      let applied = false;
      const after = await update(id, (item) => {
        const sentReply = opts?.sentReply === true && item.source === "gmail" && item.sourcePayload?.sentChat === true;
        if (item.status !== "skipped" && item.status !== "failed" && !(sentReply && item.status === "shipped"))
          return item;
        applied = true;
        const now = Date.now();
        return {
          ...item,
          status: sentReply || item.proposal ? "ready" : "queued",
          ...(sentReply
            ? {
                proposal: { data: { body: "" }, by: "human" as const, at: Math.max(now, (item.proposal?.at ?? 0) + 1) },
              }
            : {}),
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
        .filter(
          (item) =>
            item.status === "queued" ||
            (item.status === "in_progress" && (item.claimedAt ?? 0) + CLAIM_LEASE_MS <= Date.now()),
        )
        .sort((a, b) => a.createdAt - b.createdAt);
      return limit === undefined ? queued : queued.slice(0, limit);
    },
    async claim(id, claimedAt = Date.now(), expectedLoopId) {
      const now = claimedAt;
      let applied = false;
      const after = await update(id, (item) => {
        if (expectedLoopId !== undefined && item.loopId !== expectedLoopId) return item;
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
  if (!coordination) return ledger;
  const guarded = async <T>(ids: string[], fn: () => Promise<T>, check = true): Promise<T> => {
    let run = async () => {
      if (check)
        for (const id of ids)
          if (!(await coordination.accepts(id))) throw new Error("This Loop no longer accepts intake");
      return fn();
    };
    for (const id of [...new Set(ids)].sort().reverse()) {
      const next = run;
      run = () => coordination.lock.withLock(`loop-intake:${id}`, next);
    }
    return run();
  };
  return {
    ...ledger,
    enqueue: (input) => guarded([input.loopId], () => ledger.enqueue(input)),
    ingest: async (entries) => {
      const result = { created: 0, updated: 0, skipped: 0 };
      for (const entry of entries) {
        const next = await guarded([entry.loopId], () => ledger.ingest([entry]));
        result.created += next.created;
        result.updated += next.updated;
        result.skipped += next.skipped;
      }
      return result;
    },
    moveSource: (from, to, source) => guarded([from, to], () => ledger.moveSource(from, to, source), false),
  };
}
