import { durableTaskContext } from "../durable/tasks.ts";
import { createMemoryAdvisoryLock, type AdvisoryLock } from "../persistence/advisory-lock.ts";
import { createTaskAcknowledgements, type TaskAckState, type TaskAcknowledgements } from "../slack/task-ack.ts";
import { orgId as configOrgId } from "../config.ts";
import type { StagedEnvelope } from "../slack/envelope-staging.ts";
import { resolveBranding } from "../resolution/branding.ts";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import type { App } from "./app.ts";
import type { ErrorLog } from "../admin/error-log.ts";
import { createNoopLeaderLease, type LeaderLease } from "../persistence/leader-lease.ts";
import type {
  Delivery,
  ScopeId,
  SurfaceContextRequest,
  SurfaceContextResult,
  TurnRequest,
  TurnResult,
} from "../types.ts";
import { scopeId } from "../types.ts";
import type { CachedMessage, ReadMessagesOpts, SurfaceCache, IngestEvent } from "../surface-cache/surface-cache.ts";
import type { AckEmojiPickStore } from "../surface-cache/ack-emoji-pick-store.ts";
import type { OrgBranding, ScopedConfigStore } from "../resolution/config-store.ts";
import type { BlobTransferStore } from "../persistence/blob-transfer.ts";
import { MAX_BLOB_BYTES } from "../persistence/blob-transfer.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import type { DeliveryDispatcher, DeliveryHandler } from "../delivery/task-delivery.ts";
import type { Run } from "../runs/run-store.ts";
import type { DurableTasks } from "../durable/tasks.ts";
import { createSlackIngress, type SlackIngress } from "../slack/task-ingress.ts";
import type { MetricsSink } from "../admin/metrics-sink.ts";
import type { RunStore } from "../runs/run-store.ts";
import { isTerminal } from "../runs/run-store.ts";
import type { GoalView, TurnStream } from "../runs/turn-stream.ts";
import type { TaskStore, TaskStatus } from "../tasks/task-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { swallowAs } from "../util/errors.ts";
import { resolveRuntimeChoiceDurable } from "../harness/harness-router.ts";
import type { RuntimeChoice } from "../harness/harness.ts";
import { modelDisplayName } from "../model/pi-models.ts";
import type { ConversationEvent } from "../loops/sources/adapter.ts";
import { slackConversationRef } from "../loops/sources/slack.ts";

interface SlackRunHooks {
  onFirstBlock?(text: string): void;
  onSurfacePosted?(): void;
  onTasks?(tasks: Array<{ id: string; title: string; status: TaskStatus }>): void | Promise<void>;
  onGoal?(goal: GoalView): void | Promise<void>;
}

export interface SlackAgentRequestContext {
  requestId: string;
  requesterId: string | undefined;
  targetUserId: string;
  targetDisplayName?: string;
  originChannel: string;
  originConversationKind?: "dm" | "channel" | "group";
  originThreadTs?: string;
  originThreadOnly: boolean;
  originChannelName?: string;
  originStatusTs?: string;
  dmChannel: string;
  dmMessageTs?: string;
  task: string;
  originAgentLabel: string;
  targetAgentLabel: string;
  createdAt: number;
  approvalRequestIds?: string[];
  acceptedAt?: number;
  decision?: "run" | "deny";
  settledAt?: number;
}

interface StoredApprovalView {
  requestId: string;
  command: string;
  reason?: string;
  purpose?: string;
  summary?: string;
  kind?: "approval" | "input";
  grantModes?: { session: boolean; always: boolean };
  request?: Record<string, unknown>;
}

interface DirectoryPush {
  members?: Array<{ principalId: string; displayName: string; type: "internal"; slackId?: string }>;
  channels?: Array<{ channelId: string; name: string; isPrivate?: boolean; isExternal?: boolean }>;
  channelMembers?: Array<{ channelId: string; principalId: string }>;
  channelRosterIds?: string[];
  channelRevocations?: Array<{ channelId: string; principalId: string }>;
  groupMembers?: Array<{ groupId: string; principalId: string }>;
  groupIds?: string[];
  groupRosterIds?: string[];
  workspaceUrl?: string;
  membersSyncedAt?: number;
  channelsSyncedAt?: number;
  groupsSyncedAt?: number;
}

export interface SlackCoreClient {
  durableIngress?: SlackIngress;
  durableDeliveries?: boolean;
  registerDeliveryHandler?(handler: DeliveryHandler, account?: string): () => void;
  getDeliveryRun?(id: string): Promise<Run | null>;
  withRunDeliveryLock?<T>(runId: string, execute: () => Promise<T>): Promise<T>;
  runProgress?<T>(runId: string, execute: () => Promise<T>): Promise<T | undefined>;
  recordPrincipalDelivery?(id: string, recipientThreadRef: string): Promise<void>;
  taskAcknowledgements?: TaskAcknowledgements;
  externalSlackParticipants(): Promise<boolean>;
  internalMemberOverrides(): Promise<string[]>;
  ackEmojiOverride(): Promise<string[] | null>;
  publishEmojiCatalog(emoji: Record<string, string>): Promise<void>;
  surfaceHeaderFacts(scope: ScopeId): Promise<{ agentLabel?: string; modelName: string }>;
  channelHeaderPinEnabled(scope: ScopeId): Promise<boolean>;
  onScopeModelChanged(listener: (scope: ScopeId) => void): void;
  onChannelHeaderPinChanged(listener: (scope: ScopeId) => void): void;
  stageBlob(bytes: Uint8Array): Promise<{ blobId: string; sizeBytes: number }>;
  readBlob(blobId: string): Promise<Buffer>;
  readFileArtifact(artifactId: string, viewerId: string): Promise<Buffer>;
  rememberSurfaceHistory?(events: IngestEvent[]): Promise<void>;
  readSurfaceMessages?(container: string, opts?: ReadMessagesOpts): Promise<CachedMessage[]>;
  ingestSurfaceEvents(events: IngestEvent[], self?: { name?: string; mentionId?: string }): Promise<void>;
  submitTurn(body: Omit<TurnRequest, "surface">): Promise<TurnResult>;
  waitRun(runId: string, hooks?: SlackRunHooks): Promise<TurnResult | null>;
  activeRunForThread(threadRef: string): Promise<string | undefined>;
  signalRunAbort(runId: string): Promise<void>;
  ackRunDelivery(runId: string): Promise<void>;
  reportTurnMetrics(runId: string, patch: { deliverMs?: number; slackInflightMs?: number }): Promise<void>;
  reportRunEditRef(runId: string, editRef: string): Promise<void>;
  getApproval(requestId: string): Promise<StoredApprovalView | null>;
  putAgentRequest(requestId: string, record: SlackAgentRequestContext): Promise<void>;
  getAgentRequest(requestId: string): Promise<SlackAgentRequestContext | null>;
  decideAgentRequest?(requestId: string, decision: "run" | "deny"): Promise<SlackAgentRequestContext | null>;
  takeAgentRequest(requestId: string): Promise<SlackAgentRequestContext | null>;
  agentRequestForApproval(approvalRequestId: string): Promise<SlackAgentRequestContext | null>;
  pushDirectory(body: DirectoryPush): Promise<boolean>;
  claimDeliveries(type: string, claimMs: number): Promise<Delivery[]>;
  ackDelivery(id: string, body?: { recipientThreadRef?: string; slackApiMs?: number }): Promise<void>;
  reportSlowDeliveryDrain?(info: { durationMs: number; rows: number }): Promise<void>;
  reportDeliveryUndeliverable?(id: string, reason: string): Promise<void>;

  holdDeliveryDispatch<T>(fn: (lost: Promise<void>) => Promise<T>): Promise<T | null>;
  holdEnvelopeReplay<T>(account: string, fn: (lost: Promise<void>) => Promise<T>): Promise<T | null>;
  stagedEnvelopes?: DurableMap<StagedEnvelope>;
  holdDirectorySync<T>(fn: (lost: Promise<void>) => Promise<T>): Promise<T | null>;
  onDeliveryEnqueued(listener: () => void): () => void;
  pendingContextRequests(): Promise<SurfaceContextRequest[]>;
  onContextRequest(listener: (request: SurfaceContextRequest) => void): () => void;
  fulfillContextRequest(id: string, outcome: { result?: SurfaceContextResult; error?: string }): Promise<void>;
  pickAckEmoji(text: string, candidates: readonly string[]): Promise<string | undefined>;
  recordAckPick(pick: AckPickInput): Promise<void>;
  inboxSlackMessage(msg: {
    channel: string;
    ts: string;
    threadTs?: string;
    text?: string;
    senderEmail?: string;
  }): Promise<void>;
}

type AckPickInput = {
  channel: string;
  ts: string;
  outcome: "picked" | "declined";
  picked?: string;
  icon?: string;
  message?: string;
  candidates?: string;
  latencyMs?: number;
};

export type { SurfaceContextRequest };

export interface SlackCoreClientDeps {
  advisoryLock?: AdvisoryLock;
  inboundTasks?: DurableTasks;
  deliveryDispatcher?: DeliveryDispatcher;
  taskAcknowledgements?: DurableMap<TaskAckState>;
  app: App;
  config: ScopedConfigStore;
  runtimeFallback: RuntimeChoice;
  blobTransfer: BlobTransferStore;
  deliveries: DeliveryStore;
  errors?: ErrorLog;
  metrics: MetricsSink;
  runs: RunStore;
  turnStream: TurnStream;
  tasks: TaskStore;
  agentRequests: DurableMap<SlackAgentRequestContext>;
  pickAckEmoji?(text: string, candidates: readonly string[]): Promise<string | undefined>;
  ackPicks?: AckEmojiPickStore;
  ackModelId?: () => string | undefined;
  brandingDefault?: OrgBranding;
  leaderLease?: LeaderLease;
  stagedEnvelopes?: DurableMap<StagedEnvelope>;
  surfaceCache?: SurfaceCache;
  inboxEvent?(event: ConversationEvent): Promise<void>;
}

const RUN_FALLBACK_POLL_MS = 1_000;
const RUN_STALL_BUDGET_MS = 300_000;
const AGENT_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

function agentRequestExpired(record: SlackAgentRequestContext): boolean {
  return record.acceptedAt === undefined && Date.now() - record.createdAt > AGENT_REQUEST_TTL_MS;
}

export type AgentRequestStore = Pick<
  SlackCoreClient,
  "putAgentRequest" | "getAgentRequest" | "decideAgentRequest" | "takeAgentRequest" | "agentRequestForApproval"
>;

export function createAgentRequestStore(map: DurableMap<SlackAgentRequestContext>): AgentRequestStore {
  if (!map.update || !map.deleteIf) throw new Error("Agent requests require atomic updates");
  const available = (record: SlackAgentRequestContext) =>
    record.settledAt === undefined && !agentRequestExpired(record);
  return {
    async putAgentRequest(requestId, record) {
      await map.putIfAbsent(requestId, record);
      await map.update!(requestId, (existing) =>
        existing.settledAt === undefined
          ? {
              ...existing,
              ...record,
              ...(existing.acceptedAt === undefined ? {} : { acceptedAt: existing.acceptedAt }),
              ...(existing.decision === undefined ? {} : { decision: existing.decision }),
            }
          : existing,
      );
      await (async () => {
        for (const [id, existing] of await map.entries()) {
          if (existing.settledAt === undefined && agentRequestExpired(existing))
            await map.deleteIf!(id, (current) => current.settledAt === undefined && agentRequestExpired(current));
        }
      })().catch(swallowAs("agent-requests: expired sweep", undefined));
    },

    async getAgentRequest(requestId) {
      const record = await map.get(requestId);
      return record && available(record) ? record : null;
    },

    async decideAgentRequest(requestId, decision) {
      let decided: SlackAgentRequestContext | null = null;
      await map.update!(requestId, (record) => {
        if (!available(record)) return record;
        const previous = record.decision ?? (record.acceptedAt === undefined ? undefined : "run");
        if (previous !== undefined && previous !== decision) return record;
        decided = { ...record, decision, acceptedAt: record.acceptedAt ?? Date.now() };
        return decided;
      });
      return decided;
    },

    async takeAgentRequest(requestId) {
      let taken: SlackAgentRequestContext | null = null;
      await map.update!(requestId, (record) => {
        if (!available(record)) return record;
        taken = record;
        return { ...record, settledAt: Date.now() };
      });
      return taken;
    },

    async agentRequestForApproval(approvalRequestId) {
      for (const [, record] of await map.entries()) {
        if (record.approvalRequestIds?.includes(approvalRequestId) && available(record)) return record;
      }
      return null;
    },
  };
}

export function createSlackCoreClient(deps: SlackCoreClientDeps): SlackCoreClient {
  const durableIngress = deps.inboundTasks ? createSlackIngress(deps.inboundTasks) : undefined;
  const messageLock = deps.advisoryLock ?? createMemoryAdvisoryLock();
  const withRunDeliveryLock = <T>(runId: string, execute: () => Promise<T>) =>
    messageLock.withLock(`slack-progress:${runId}`, execute);
  const lease = deps.leaderLease ?? createNoopLeaderLease();
  const orgScope: ScopeId = scopeId("org", configOrgId());
  const terminalWaiters = new Map<string, Set<() => void>>();
  deps.runs.onTerminal((run) => {
    for (const wake of terminalWaiters.get(run.id) ?? []) wake();
  });

  return {
    ...(deps.taskAcknowledgements
      ? { taskAcknowledgements: createTaskAcknowledgements(deps.taskAcknowledgements, lease, deps) }
      : {}),
    ...(durableIngress ? { durableIngress } : {}),
    durableDeliveries: Boolean(deps.deliveryDispatcher),
    ...(deps.deliveryDispatcher
      ? {
          registerDeliveryHandler: (handler: DeliveryHandler, account?: string) =>
            deps.deliveryDispatcher!.register(["slack", "group", "principal"], handler, account),
        }
      : {}),
    getDeliveryRun: (id) => deps.runs.get(id),
    withRunDeliveryLock,
    runProgress: (runId, execute) =>
      withRunDeliveryLock(runId, async () => {
        const run = await deps.runs.get(runId);
        if (!run || isTerminal(run.status)) return undefined;
        return execute();
      }),
    recordPrincipalDelivery: (id, recipientThreadRef) => deps.app.recordPrincipalDelivery(id, recipientThreadRef),
    async externalSlackParticipants() {
      return (await deps.config.getExternalSlackParticipantsDurable(orgScope)) === true;
    },

    async internalMemberOverrides() {
      return deps.config.getInternalMemberOverridesDurable();
    },

    async ackEmojiOverride() {
      return await deps.config.getAckEmojiDurable(orgScope);
    },

    async publishEmojiCatalog(emoji) {
      deps.config.setSlackEmojiCatalog(orgScope, emoji);
    },

    async surfaceHeaderFacts(scope) {
      const [choice, branding] = await Promise.all([
        resolveRuntimeChoiceDurable(deps.config, orgScope, scope, deps.runtimeFallback),
        resolveBranding(deps.config, orgScope, deps.brandingDefault),
      ]);
      return {
        ...(branding.selfLabel ? { agentLabel: branding.selfLabel } : {}),
        modelName: modelDisplayName(choice.modelId),
      };
    },

    async channelHeaderPinEnabled(scope) {
      return deps.config.getChannelHeaderPinDurable(scope);
    },

    onScopeModelChanged(listener) {
      deps.config.onRuntimeSelectionChanged((scope) => listener(scope));
    },

    onChannelHeaderPinChanged(listener) {
      deps.config.onChannelHeaderPinChanged((scope) => listener(scope));
    },

    async stageBlob(bytes) {
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const info = await deps.blobTransfer.put(Readable.from([Buffer.from(bytes)]), {
        maxBytes: MAX_BLOB_BYTES,
        expectedSha256: sha256,
      });
      return { blobId: info.blobId, sizeBytes: info.sizeBytes };
    },

    async readBlob(blobId) {
      const blob = await deps.blobTransfer.open(blobId);
      if (!blob) throw new Error(`blob ${blobId} not found`);
      return buffer(blob.stream);
    },

    async readFileArtifact(artifactId, viewerId) {
      const opened = await deps.app.openFileForViewer(artifactId, viewerId);
      if (!opened) throw new Error(`file artifact ${artifactId} not found (or not visible to ${viewerId})`);
      return buffer(opened.stream);
    },

    async rememberSurfaceHistory(events) {
      await deps.surfaceCache?.ingest(events);
    },

    async readSurfaceMessages(container, opts) {
      return deps.app.readSurfaceMessages(container, { ...opts, noFallback: true });
    },

    async ingestSurfaceEvents(events, self) {
      if (!events.length) return;
      await deps.app.ingestSurfaceEvents(events, "slack", self);
    },

    submitTurn(body) {
      return deps.app.turn({ ...body, surface: "slack" });
    },

    async waitRun(runId, hooks = {}) {
      const current = durableTaskContext.getStore();
      let firstBlockSignaled = false;
      let surfaceSignaled = false;
      const signalFirstBlock = (text: string): void => {
        if (firstBlockSignaled || !text.trim()) return;
        firstBlockSignaled = true;
        hooks.onFirstBlock?.(text);
      };
      const signalSurface = (): void => {
        if (surfaceSignaled) return;
        surfaceSignaled = true;
        hooks.onSurfacePosted?.();
      };
      const waiters = terminalWaiters.get(runId) ?? new Set();
      terminalWaiters.set(runId, waiters);
      const unsubscribe = deps.turnStream.subscribe(runId, {
        onFirstBlock: signalFirstBlock,
        onSurfacePosted: signalSurface,
      });
      let lastProgressAt = Date.now();
      let lastMark = "";
      let taskSnapshot = "";
      let goalSnapshot = "";
      const emitGoal = async (): Promise<void> => {
        if (!hooks.onGoal) return;
        const goal = deps.turnStream.goal(runId);
        if (!goal) return;
        const next = JSON.stringify(goal);
        if (next === goalSnapshot) return;
        goalSnapshot = next;
        await hooks.onGoal(goal);
      };
      const emitTasks = async (): Promise<void> => {
        if (!hooks.onTasks) return;
        const tasks = (await deps.tasks.list({ originRunId: runId })).map(({ id, title, status }) => ({
          id,
          title,
          status,
        }));
        if (!tasks.length) return;
        const next = JSON.stringify(tasks);
        if (next === taskSnapshot) return;
        taskSnapshot = next;
        await hooks.onTasks(tasks);
      };
      try {
        for (;;) {
          current?.signal.throwIfAborted();
          if (current?.handoff.requested.aborted) return { status: "queued", runId };
          let run;
          try {
            run = await deps.runs.get(runId);
          } catch (err) {
            if (Date.now() - lastProgressAt >= RUN_STALL_BUDGET_MS) throw err;
            run = undefined;
          }
          if (run !== undefined) {
            if (!run) throw new Error(`run ${runId} not found`);
            if (deps.turnStream.surfacePosted(runId)) signalSurface();
            if (isTerminal(run.status)) {
              const view = await deps.app.getRun(runId);
              await emitTasks().catch(swallowAs("slack-core-client: terminal task refresh", undefined));
              await emitGoal().catch(swallowAs("slack-core-client: terminal goal refresh", undefined));
              if (view?.surfacePosted) signalSurface();
              return (view?.result as TurnResult | null | undefined) ?? null;
            }
            await emitTasks();
            await emitGoal().catch(swallowAs("slack-core-client: goal refresh", undefined));
            const fb = deps.turnStream.firstBlock(runId);
            if (fb?.closed) signalFirstBlock(fb.text);
            const mark = `${run.status}:${run.attempts}:${run.leaseExpiresAt ?? ""}`;
            if (mark !== lastMark) {
              lastMark = mark;
              lastProgressAt = Date.now();
            }
            if (Date.now() - lastProgressAt >= RUN_STALL_BUDGET_MS) {
              throw Object.assign(
                new Error(`run ${runId} made no progress for ${Math.round(RUN_STALL_BUDGET_MS / 1000)}s — giving up`),
                { code: "run_stalled" },
              );
            }
          }
          await new Promise<void>((resolve) => {
            const timer = setTimeout(done, RUN_FALLBACK_POLL_MS);
            function done(): void {
              clearTimeout(timer);
              waiters.delete(done);
              resolve();
            }
            waiters.add(done);
          });
        }
      } finally {
        unsubscribe();
        if (waiters.size === 0) terminalWaiters.delete(runId);
      }
    },

    async activeRunForThread(threadRef) {
      return (await deps.app.activeRunForThread(threadRef))?.runId;
    },

    async signalRunAbort(runId) {
      const outcome = await deps.app.signalRun(runId, { kind: "abort" });
      if (!outcome.accepted) throw new Error(`signal abort not accepted: ${outcome.reason ?? "unknown"}`);
    },

    async ackRunDelivery(runId) {
      await deps.app.ackDeliveryByKey(`run:${runId}`);
    },

    async reportTurnMetrics(runId, patch) {
      await deps.metrics.updateByRunId(runId, patch);
    },

    async reportRunEditRef(runId, editRef) {
      const found = await deps.app.setRunDeliveryState(runId, { editRef });
      if (!found) throw new Error(`run ${runId} not found`);
    },

    async getApproval(requestId) {
      const record = await deps.app.getApproval(requestId);
      if (!record) return null;
      return {
        requestId: record.requestId,
        command: record.command,
        ...(record.reason !== undefined ? { reason: record.reason } : {}),
        ...(record.purpose !== undefined ? { purpose: record.purpose } : {}),
        ...(record.summary !== undefined ? { summary: record.summary } : {}),
        ...(record.kind !== undefined ? { kind: record.kind } : {}),
        ...(record.grantModes !== undefined ? { grantModes: record.grantModes } : {}),
        ...(record.request !== undefined ? { request: record.request as unknown as Record<string, unknown> } : {}),
      };
    },

    ...createAgentRequestStore(deps.agentRequests),

    async pushDirectory(body) {
      if (body.workspaceUrl) await deps.app.setDirectoryWorkspaceUrl(body.workspaceUrl);
      let applied = true;
      if (body.members) applied = (await deps.app.upsertDirectory(body.members, body.membersSyncedAt)) && applied;
      if (body.channels) {
        applied =
          (await deps.app.upsertChannels(
            body.channels,
            body.channelMembers,
            body.channelsSyncedAt,
            body.channelRosterIds,
            body.channelRevocations,
          )) && applied;
      }
      if (body.groupMembers) {
        applied =
          (await deps.app.upsertGroups(body.groupMembers, body.groupsSyncedAt, body.groupIds, body.groupRosterIds)) &&
          applied;
      }
      return applied;
    },

    claimDeliveries(type, claimMs) {
      return deps.app.pendingDeliveries(type, claimMs);
    },
    holdDeliveryDispatch(fn) {
      return lease.hold("slack:delivery-dispatch", fn);
    },
    holdDirectorySync(fn) {
      return lease.hold("slack:directory-sync", fn);
    },
    holdEnvelopeReplay(account, fn) {
      return lease.hold(`slack:envelope-replay:${account}`, fn);
    },
    stagedEnvelopes: deps.stagedEnvelopes,

    async ackDelivery(id, body) {
      if (body?.recipientThreadRef) await deps.app.recordPrincipalDelivery(id, body.recipientThreadRef);
      await deps.app.ackDelivery(id, body?.slackApiMs);
    },

    async reportDeliveryUndeliverable(id, reason) {
      deps.errors?.record({
        category: "delivery",
        code: "delivery_undeliverable",
        message: `delivery ${id} cannot be delivered (${reason}) — retrying until the TTL expires it`,
        scopeLabel: "slack:deliveries" as ScopeId,
      });
    },

    async reportSlowDeliveryDrain(info) {
      deps.errors?.record({
        category: "delivery",
        code: "delivery_drain_slow",
        message: `drain cycle took ${Math.round(info.durationMs / 1000)}s for ${info.rows} rows`,
        scopeLabel: "slack:deliveries" as ScopeId,
      });
    },

    onDeliveryEnqueued(listener) {
      return deps.deliveries.onEnqueue(listener);
    },

    pendingContextRequests() {
      return deps.app.pendingContextRequests("slack");
    },

    onContextRequest(listener) {
      return deps.app.onContextRequestCreated((request) => {
        if (request.source === "slack") listener(request);
      });
    },

    pickAckEmoji(text, candidates) {
      return deps.pickAckEmoji?.(text, candidates) ?? Promise.resolve(undefined);
    },

    async inboxSlackMessage(msg) {
      const at = Math.round(Number.parseFloat(msg.ts) * 1000);
      if (!Number.isFinite(at)) return;
      await deps.inboxEvent?.({
        source: "slack",
        conversationRef: slackConversationRef(msg.channel, msg.ts, msg.threadTs),
        at,
        ...(msg.text ? { text: msg.text } : {}),
        ...(msg.senderEmail ? { senderEmail: msg.senderEmail } : {}),
      });
    },
    async recordAckPick(pick) {
      if (!deps.ackPicks) return;
      const ackModel = deps.ackModelId?.();
      await deps.ackPicks
        .record({
          surface: "slack",
          channel: pick.channel,
          ts: pick.ts,
          outcome: pick.outcome,
          ...(pick.picked ? { picked: pick.picked } : {}),
          ...(pick.icon ? { icon: pick.icon } : {}),
          ...(pick.message ? { message: pick.message } : {}),
          ...(pick.candidates ? { candidates: pick.candidates } : {}),
          ...(ackModel ? { model: ackModel } : {}),
          ...(pick.latencyMs != null ? { latencyMs: pick.latencyMs } : {}),
          createdAt: Date.now(),
        })
        .catch(() => {});
    },

    async fulfillContextRequest(id, outcome) {
      await deps.app
        .fulfillContextRequest(id, outcome)
        .then((ok) => {
          if (!ok) return;
        })
        .catch(swallowAs("slack-core-client: fulfill context request", undefined));
    },
  };
}
