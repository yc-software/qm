import type { LedgerEvent, LedgerEventOp } from "./events.ts";
import { canonicalJson } from "../../cli/src/canonical-json.ts";
import { wireMentionKeys } from "../slack/mrkdwn.ts";
import type { InboxItem, InboxItemStatus, InboxProposal, InboxPayload, InboxThreadMessage } from "../types.ts";
import { isResolved } from "./view.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import { contentPart } from "../triggers/trigger-store.ts";
import { hashId } from "../util/crypto.ts";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export interface IngestEntryInput {
  cronId: string;
  dedupeKey: string;
  source?: string;
  summary?: string;
  sourcePayload: InboxPayload;
  sourceAt?: number;
  proposal?: Omit<InboxProposal, "at">;
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
  outcome: "actioned" | "dismissed" | "failed";
}

const ACTION_STATUS: Record<RecordActionInput["outcome"], InboxItemStatus> = {
  actioned: "shipped",
  dismissed: "skipped",
  failed: "failed",
};

export interface LatestEvent {
  author: "owner" | "other";
  at: number;
  text?: string;
  from?: string;
}

const EVENT_TEXT_CHARS = 2_000;

export interface InboxLedger {
  ingest(entries: IngestEntryInput[]): Promise<IngestOutcome>;
  recordEvent(item: InboxItem, event: LatestEvent): Promise<boolean>;
  setProposal(
    id: string,
    proposal: Omit<InboxProposal, "at">,
    opts?: { expectedAt?: number },
  ): Promise<InboxItem | null>;
  annotate(
    id: string,
    patch: InboxPayload,
    opts?: { summary?: string; expectedSourceAt?: number; expectedSourcePayload?: InboxPayload },
  ): Promise<InboxItem | null>;
  appendThread(id: string, messages: Array<Omit<InboxThreadMessage, "id" | "at">>): Promise<InboxItem | null>;
  recordAction(id: string, input: RecordActionInput): Promise<InboxItem | null>;
  reopen(id: string, opts?: { sentReply?: boolean }): Promise<InboxItem | null>;
  prune(cronId: string, options: PruneOptions): Promise<number>;
  get(id: string): Promise<InboxItem | null>;
  byCron(cronId: string): Promise<InboxItem[]>;
  summaries(
    cronIds: string[],
    options?: { includeInboxMetadata?: boolean },
  ): Promise<Array<Omit<InboxItem, "proposal" | "agentDrafts" | "thread" | "sourcePayload">>>;
  acquireDecision(id: string, decisionAt?: number): Promise<string | null>;
  releaseDecision(id: string, token: string): Promise<boolean>;
  deleteByCron(cronId: string): Promise<void>;
}

export type InboxEventSink = (item: InboxItem, event: LatestEvent) => Promise<void>;

export function inboxItemId(cronId: string, sourceKey: string): string {
  return hashId([contentPart(cronId), contentPart(sourceKey)]);
}

const LEDGER_THREAD_MAX = 200;
const DECISION_LEASE_MS = 300_000;

function nextIngestStatus(item: InboxItem, proposal: InboxProposal | undefined): InboxItemStatus {
  if (proposal) return "ready";
  return isResolved(item) ? "queued" : item.status;
}

const AGENT_DRAFT_HISTORY = 10;

function sameDraft(a: InboxProposal | undefined, b: InboxProposal): boolean {
  return a !== undefined && canonicalJson(a.data) === canonicalJson(b.data);
}

export function agentDraftsOf(item: Pick<InboxItem, "proposal" | "agentDrafts">): InboxProposal[] {
  const kept = item.agentDrafts ?? [];
  if (item.proposal?.by !== "agent" || sameDraft(kept.at(-1), item.proposal)) return kept;
  return [...kept, item.proposal];
}

export function agentDraftOf(item: Pick<InboxItem, "proposal" | "agentDrafts">): InboxProposal | undefined {
  return agentDraftsOf(item).at(-1);
}

function withAgentDraft(
  item: Pick<InboxItem, "proposal" | "agentDrafts" | "agentMentionKeys">,
  proposal: InboxProposal | undefined,
): Pick<InboxItem, "agentDrafts" | "agentMentionKeys"> {
  const drafts = agentDraftsOf(item);
  const next = proposal?.by === "agent" && !sameDraft(drafts.at(-1), proposal) ? [...drafts, proposal] : drafts;
  const keys = new Set(item.agentMentionKeys ?? []);
  for (const draft of next) for (const key of wireMentionKeys(canonicalJson(draft.data))) keys.add(key);
  return { agentDrafts: next.slice(-AGENT_DRAFT_HISTORY), agentMentionKeys: [...keys] };
}

function inboxPreview(payload: InboxPayload | undefined): InboxPayload {
  if (!payload) return {};
  return Object.fromEntries(
    ["title", "from", "fromDetail", "snippet", "receivedAt", "probablyResolved", "sentChat"].flatMap((key) =>
      payload[key] === undefined ? [] : [[key, payload[key]]],
    ),
  );
}

function eventEntry(item: InboxItem, event: LatestEvent): IngestEntryInput | null {
  const text = event.text?.trim().slice(0, EVENT_TEXT_CHARS);
  const other = event.author === "other";
  const from = other ? event.from?.slice(0, 300) : undefined;
  if (isResolved(item) && !other) return null;
  return {
    cronId: item.cronId,
    dedupeKey: item.sourceKey,
    ...(item.source !== undefined ? { source: item.source } : {}),
    ...(item.sourceSummary !== undefined ? { summary: item.sourceSummary } : {}),
    sourceAt: event.at,
    sourcePayload: {
      ...item.sourcePayload,
      latestEvent: {
        author: event.author,
        at: event.at,
        ...(text && !other ? { text } : {}),
        ...(from ? { from } : {}),
      },
      ...(other ? { receivedAt: event.at, ...(text ? { snippet: text } : {}) } : {}),
    },
  };
}

function mergeIngest(item: InboxItem, entry: IngestEntryInput, now: number): InboxItem | null {
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

export function createInboxLedger(
  backing: DurableMap<InboxItem> = createMemoryMap<InboxItem>(),
  onEvent?: (event: LedgerEvent) => void,
): InboxLedger {
  if (!backing.update) throw new Error("inbox items need atomic durable updates");
  const update = backing.update.bind(backing);
  const emit = (item: InboxItem | null | undefined, op: LedgerEventOp): void => {
    if (item && onEvent) onEvent({ cronId: item.cronId, itemId: item.id, op, at: Date.now() });
  };

  const forCron = async (cronId: string): Promise<InboxItem[]> =>
    (await backing.all()).filter((item) => item.cronId === cronId);

  const ledger: InboxLedger = {
    async summaries(cronIds, options) {
      if (!options?.includeInboxMetadata)
        return backing.select({
          where: { field: "cronId", anyOfFold: cronIds },
          omit: ["proposal", "agentDrafts", "thread", "sourcePayload"],
        });
      const items = await backing.select({
        where: { field: "cronId", anyOfFold: cronIds },
        omit: ["proposal", "agentDrafts", "thread"],
        pickNested: { sourcePayload: ["source", "automated", "participants", "slackAvatarsRefreshAt"] },
      });
      return items.map(({ sourcePayload, ...item }) => {
        const source = item.source ?? (typeof sourcePayload?.source === "string" ? sourcePayload.source : undefined);
        return {
          ...item,
          ...(source !== undefined ? { source } : {}),
          ...(source === "slack"
            ? {
                inboxPreview: {
                  ...item.inboxPreview,
                  participants: sourcePayload?.participants,
                  slackAvatarsRefreshAt: sourcePayload?.slackAvatarsRefreshAt,
                },
              }
            : {}),
          ...(source === "gmail"
            ? { inboxPreview: { ...item.inboxPreview, automated: sourcePayload?.automated === true } }
            : {}),
        };
      });
    },
    async ingest(entries) {
      const outcome: IngestOutcome = { created: 0, updated: 0, skipped: 0 };
      if (!entries.length) return outcome;
      const existing = await backing.select({
        where: { field: "cronId", anyOfFold: [...new Set(entries.map((entry) => entry.cronId))] },
        omit: ["sourcePayload", "proposal", "agentDrafts", "thread"],
      });
      const ids = new Set(existing.map((item) => item.id));
      const legacy = new Map<string, string>();
      for (const item of existing) {
        const key = JSON.stringify([item.cronId, item.sourceKey]);
        if (!legacy.has(key)) legacy.set(key, item.id);
      }
      const changed: InboxItem[] = [];
      await backing.mutateMany(
        entries.map((entry) => {
          const canonical = inboxItemId(entry.cronId, entry.dedupeKey);
          const id = ids.has(canonical)
            ? canonical
            : (legacy.get(JSON.stringify([entry.cronId, entry.dedupeKey])) ?? canonical);
          return {
            id,
            apply: (item: InboxItem | null): InboxItem => {
              const now = Date.now();
              const candidate: InboxItem = {
                id,
                cronId: entry.cronId,
                sourceKey: entry.dedupeKey,
                status: entry.proposal ? "ready" : "queued",
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
              if (!item) {
                outcome.created++;
                changed.push(candidate);
                return candidate;
              }
              const next = mergeIngest(item, entry, now);
              if (next) {
                outcome.updated++;
                changed.push(next);
                return next;
              }
              outcome.skipped++;
              return item;
            },
          };
        }),
      );
      for (const item of changed) emit(item, "ingest");
      return outcome;
    },
    async recordEvent(item, event) {
      const current = await backing.get(item.id);
      if (!current) return false;
      const entry = eventEntry(current, event);
      if (!entry) return false;
      return (await ledger.ingest([entry])).updated > 0;
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
    async annotate(id, patch, opts) {
      let applied = false;
      const after = await update(id, (item) => {
        if (
          (opts?.expectedSourceAt !== undefined && item.sourceAt !== opts.expectedSourceAt) ||
          (opts?.expectedSourcePayload !== undefined &&
            !isDeepStrictEqual(item.sourcePayload, opts.expectedSourcePayload))
        )
          return item;
        applied = true;
        return {
          ...item,
          sourcePayload: { ...item.sourcePayload, ...patch },
          ...(opts?.summary !== undefined ? { sourceSummary: opts.summary } : {}),
          updatedAt: Date.now(),
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
        const status = ACTION_STATUS[input.outcome];
        return {
          ...item,
          status,
          actionKind: input.kind,
          actedAt: now,
          updatedAt: now,
          parkedReason: status === "failed" ? input.result : undefined,
          ...(input.result !== undefined && status !== "failed" ? { actionResult: input.result } : {}),
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
    async prune(cronId, options) {
      const now = options.now ?? Date.now();
      const items = await forCron(cronId);
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
    byCron: forCron,
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
    async deleteByCron(cronId) {
      for (const item of await forCron(cronId)) await backing.delete(item.id);
    },
  };
  return ledger;
}
