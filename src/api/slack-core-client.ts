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
import type { IngestEvent } from "../surface-cache/surface-cache.ts";
import type { AckEmojiPickStore } from "../surface-cache/ack-emoji-pick-store.ts";
import type { OrgBranding, ScopedConfigStore } from "../resolution/config-store.ts";
import type { BlobTransferStore } from "../persistence/blob-transfer.ts";
import { MAX_BLOB_BYTES } from "../persistence/blob-transfer.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
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
}

interface StoredApprovalView {
  requestId: string;
  command: string;
  reason?: string;
  purpose?: string;
  summary?: string;
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
  inboxEvent?(event: ConversationEvent): Promise<void>;
}

const RUN_FALLBACK_POLL_MS = 1_000;
const RUN_STALL_BUDGET_MS = 300_000;
const AGENT_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

function agentRequestExpired(record: SlackAgentRequestContext): boolean {
  return Date.now() - record.createdAt > AGENT_REQUEST_TTL_MS;
}

export type AgentRequestStore = Pick<
  SlackCoreClient,
  "putAgentRequest" | "getAgentRequest" | "takeAgentRequest" | "agentRequestForApproval"
>;

export function createAgentRequestStore(map: DurableMap<SlackAgentRequestContext>): AgentRequestStore {
  return {
    async putAgentRequest(requestId, record) {
      await map.put(requestId, record);
      await (async () => {
        for (const [id, existing] of await map.entries()) {
          if (agentRequestExpired(existing)) await map.delete(id);
        }
      })().catch(swallowAs("agent-requests: expired sweep", undefined));
    },

    async getAgentRequest(requestId) {
      const record = await map.get(requestId);
      return record && !agentRequestExpired(record) ? record : null;
    },

    async takeAgentRequest(requestId) {
      const record = await map.take(requestId);
      return record && !agentRequestExpired(record) ? record : null;
    },

    async agentRequestForApproval(approvalRequestId) {
      for (const [, record] of await map.entries()) {
        if (record.approvalRequestIds?.includes(approvalRequestId) && !agentRequestExpired(record)) return record;
      }
      return null;
    },
  };
}

export function createSlackCoreClient(deps: SlackCoreClientDeps): SlackCoreClient {
  const lease = deps.leaderLease ?? createNoopLeaderLease();
  const orgScope: ScopeId = scopeId("org", configOrgId());
  const terminalWaiters = new Map<string, Set<() => void>>();
  deps.runs.onTerminal((run) => {
    for (const wake of terminalWaiters.get(run.id) ?? []) wake();
  });

  return {
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

    async ingestSurfaceEvents(events, self) {
      if (!events.length) return;
      await deps.app.ingestSurfaceEvents(events, "slack", self);
    },

    submitTurn(body) {
      return deps.app.turn({ ...body, surface: "slack" });
    },

    async waitRun(runId, hooks = {}) {
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
