import { isSessionTurn } from "../core/turn-origin.ts";
import { replayableRequest } from "../core/orchestrator/turn-helpers.ts";
import {
  createSlackSessionStatus,
  type SlackStatusActivity,
  type SlackSessionStatus,
  type SessionStatusStore,
} from "../slack/session-status.ts";
import type { FeatureFlagStore } from "../feature-flags.ts";
import { decideDeploymentAccess } from "../slack/deploy-access.ts";
import type { IdentityService } from "../identity/identity-service.ts";
import type { ActorAssertion } from "../types.ts";
import type { KeychainApprovals } from "../credentials/keychain-approval.ts";
import { createTaskAcknowledgements, type TaskAckStore, type TaskAcknowledgements } from "../slack/task-ack.ts";
import type { StagedEnvelopes } from "../slack/envelope-staging.ts";
import type { HandledEvents } from "../slack/message-gating.ts";
import { resolveBranding } from "../resolution/branding.ts";
import { buffer } from "node:stream/consumers";
import type { App } from "./app.ts";
import type { ErrorLog } from "../admin/error-log.ts";
import type { LeaderLease } from "../persistence/leader-lease.ts";
import type {
  PendingApproval,
  ScopeId,
  SurfaceContextRequest,
  SurfaceContextResult,
  TurnRequest,
  TurnResult,
} from "../types.ts";
import { scopeId } from "../types.ts";
import type { MemoryService } from "../memory/memory-service.ts";
import type { CachedMessage, ReadMessagesOpts, SurfaceCache, IngestEvent } from "../surface-cache/surface-cache.ts";
import type { AckEmojiPickStore } from "../surface-cache/ack-emoji-pick-store.ts";
import type { OrgBranding, ScopedConfigStore } from "../resolution/config-store.ts";
import type { BlobTransferStore } from "../persistence/blob-transfer.ts";
import type { ByteSource } from "../util/bytes.ts";
import { MAX_BLOB_BYTES } from "../persistence/blob-transfer.ts";
import type { SlackNative } from "../surfaces/slack-surface.ts";
import type { RunStore } from "../runs/run-store.ts";
import { isTerminal } from "../runs/run-store.ts";
import type { GoalView, TurnStream } from "../runs/turn-stream.ts";
import { reportFailure, swallowAs } from "../util/errors.ts";
import { resolveRuntimeChoiceDurable } from "../harness/runtime-choice.ts";
import type { RuntimeChoice } from "../harness/harness.ts";
import { modelDisplayName } from "../model/pi-models.ts";
import type { ConversationEvent } from "../inbox/sources/adapter.ts";
import { slackConversationRef } from "../inbox/sources/slack.ts";
import { pinnedPerTenant, tenant } from "../tenant.ts";

interface SlackRunHooks {
  onReplying?(): void;
  onFirstBlock?(text: string): void;
  onSurfacePosted?(): void;
  onGoal?(goal: GoalView): void | Promise<void>;
}

interface StoredApprovalView extends Omit<PendingApproval, "reason"> {
  createdAt?: number;
  reason?: string;
  sessionId?: string;
  request?: Record<string, unknown>;
}

interface DirectoryPush {
  members?: Array<{ principalId: string; displayName: string; type: "internal"; slackId?: string; avatarUrl?: string }>;
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
  partialChannels?: boolean;
  groupsSyncedAt?: number;
}

export type SlackUpkeep = { reconcileStatus(): Promise<unknown> } & Partial<
  Record<"replayEnvelopes" | "publishEmojiCatalog" | "reconcileTaskAcks", () => Promise<unknown>>
>;

export interface SlackCoreClient {
  privateContinuationSource?(runId: string): Promise<TurnRequest | null>;
  decideDeploymentAccess(value: string, actor: ActorAssertion, approve: boolean): Promise<string>;
  keychainApprovals?: KeychainApprovals;
  taskAcknowledgements?: TaskAcknowledgements;
  sessionStatus?: SlackSessionStatus;
  externalSlackParticipants(): Promise<boolean>;
  ackEmojiOverride(): Promise<string[] | null>;
  publishEmojiCatalog(emoji: Record<string, string>): Promise<void>;
  surfaceHeaderFacts(scope: ScopeId): Promise<{ agentLabel?: string; modelName: string }>;
  channelHeaderPinEnabled(scope: ScopeId): Promise<boolean>;
  onScopeModelChanged(listener: (scope: ScopeId) => void): void;
  onChannelHeaderPinChanged(listener: (scope: ScopeId) => void): void;
  stageBlob(source: ByteSource): Promise<{ blobId: string; sizeBytes: number }>;
  readBlob(blobId: string): Promise<Buffer>;
  readFileArtifact(artifactId: string, viewerId: string): Promise<Buffer>;
  rememberSurfaceHistory?(events: IngestEvent[]): Promise<void>;
  noteSurfaceHistoryGap?(container: string, note: string): Promise<void>;
  readSurfaceMessages?(container: string, opts?: ReadMessagesOpts): Promise<CachedMessage[]>;
  ingestSurfaceEvents(events: IngestEvent[], self?: { name?: string; mentionId?: string }): Promise<void>;
  submitTurn(body: Omit<TurnRequest, "surface">): Promise<TurnResult>;
  waitRun(runId: string, hooks?: SlackRunHooks): Promise<TurnResult | null>;
  stopConversation(threadRef: string): Promise<boolean>;
  ackRunDelivery(runId: string): Promise<void>;
  reportRunEditRef(runId: string, editRef: string): Promise<void>;
  getApproval(requestId: string): Promise<StoredApprovalView | null>;
  pushDirectory(body: DirectoryPush): Promise<boolean>;
  slack: SlackNative;
  upkeep: {
    attach(upkeep: SlackUpkeep): () => Promise<void>;
    run(kind: keyof SlackUpkeep): Promise<void>;
  };
  stagedEnvelopes?: StagedEnvelopes;
  handledEvents?: HandledEvents;
  holdDirectorySync<T>(fn: (lost: Promise<void>) => Promise<T>): Promise<T | null>;
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
    isDirectMessage: boolean;
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
  identity: IdentityService;
  keychainApprovals?: KeychainApprovals;
  taskAcknowledgements?: TaskAckStore;
  sessionStatus?: SessionStatusStore;
  statusActivity?: SlackStatusActivity;
  featureFlags?: FeatureFlagStore;
  app: App;
  config: ScopedConfigStore;
  runtimeFallback: RuntimeChoice;
  blobTransfer: BlobTransferStore;
  slack: SlackNative;
  errors?: ErrorLog;
  runs: RunStore;
  turnStream: TurnStream;
  pickAckEmoji?(text: string, candidates: readonly string[]): Promise<string | undefined>;
  ackPicks?: AckEmojiPickStore;
  ackModelId?: () => string | undefined;
  brandingDefault?: () => OrgBranding | undefined;
  leaderLease: LeaderLease;
  stagedEnvelopes?: StagedEnvelopes;
  handledEvents?: HandledEvents;
  surfaceCache?: SurfaceCache;
  memory?: MemoryService;
  inboxEvent?(event: ConversationEvent): Promise<void>;
}

const RUN_FALLBACK_POLL_MS = 1_000;
const RUN_STALL_BUDGET_MS = 300_000;

function slackUpkeepRegistry(): SlackCoreClient["upkeep"] {
  const attached = pinnedPerTenant(() => new Map<SlackUpkeep, Set<Promise<unknown>>>());
  return {
    attach(upkeep) {
      const upkeeps = attached();
      const running = new Set<Promise<unknown>>();
      upkeeps.set(upkeep, running);
      return async () => {
        upkeeps.delete(upkeep);
        await Promise.allSettled(running);
      };
    },
    async run(kind) {
      for (const [upkeep, running] of attached()) {
        const run = upkeep[kind]?.() ?? Promise.resolve();
        running.add(run);
        await run.finally(() => running.delete(run));
      }
    },
  };
}

function surfaceSettingsMethods(deps: SlackCoreClientDeps, lease: LeaderLease) {
  const orgScope = (): ScopeId => tenant().orgScope;
  return {
    decideDeploymentAccess: (value, actor, approve) =>
      decideDeploymentAccess(deps.app, deps.identity, value, actor, approve),
    ...(deps.keychainApprovals ? { keychainApprovals: deps.keychainApprovals } : {}),
    ...(deps.taskAcknowledgements
      ? { taskAcknowledgements: createTaskAcknowledgements(deps.taskAcknowledgements, lease, deps) }
      : {}),
    ...(deps.sessionStatus && deps.featureFlags
      ? {
          sessionStatus: createSlackSessionStatus(
            deps.sessionStatus,
            lease,
            deps.runs,
            deps.featureFlags,
            Date.now,
            deps.statusActivity,
          ),
        }
      : {}),
    async externalSlackParticipants() {
      return (await deps.config.settingDurable("externalSlackParticipants", orgScope())) === true;
    },

    ackEmojiOverride: () => deps.config.settingDurable("ackEmoji", orgScope()),
    publishEmojiCatalog: (emoji) => deps.config.setSlackEmojiCatalog(orgScope(), emoji),

    async surfaceHeaderFacts(scope) {
      const [choice, branding] = await Promise.all([
        resolveRuntimeChoiceDurable(deps.config, orgScope(), scope, deps.runtimeFallback),
        resolveBranding(deps.config, orgScope(), deps.brandingDefault?.()),
      ]);
      return {
        ...(branding.selfLabel ? { agentLabel: branding.selfLabel } : {}),
        modelName: modelDisplayName(choice.modelId),
      };
    },

    channelHeaderPinEnabled: (scope) => deps.config.settingDurable("channelHeaderPin", scope),
    onScopeModelChanged(listener) {
      deps.config.onRuntimeSelectionChanged((scope) => listener(scope));
    },
    onChannelHeaderPinChanged(listener) {
      deps.config.onChannelHeaderPinChanged((scope) => listener(scope));
    },
  } satisfies Partial<SlackCoreClient>;
}

function surfaceDataMethods(deps: SlackCoreClientDeps) {
  return {
    async stageBlob(source) {
      const info = await deps.blobTransfer.put(source, { maxBytes: MAX_BLOB_BYTES });
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

    async noteSurfaceHistoryGap(container, note) {
      if (!deps.memory) return;
      const kind = (await deps.surfaceCache?.containerState(container))?.kind;
      await deps.memory.capture(scopeId(kind === "group" ? "group" : "channel", container), [note], Date.now());
    },

    readSurfaceMessages: (container, opts) => deps.app.readSurfaceMessages(container, { ...opts, noFallback: true }),

    async ingestSurfaceEvents(events, self) {
      if (!events.length) return;
      await deps.app.ingestSurfaceEvents(events, "slack", self);
    },
  } satisfies Partial<SlackCoreClient>;
}

function runMethods(deps: SlackCoreClientDeps, terminalWaiters: Map<string, Set<() => void>>) {
  return {
    async privateContinuationSource(runId) {
      const run = await deps.runs.get(runId);
      if (
        !run?.request.externalSlack ||
        run.request.origin.kind !== "human" ||
        isSessionTurn(run.request) ||
        run.request.actor.type !== "internal"
      )
        return null;
      return replayableRequest(run.request);
    },

    submitTurn: (body) => deps.app.turn({ ...body, surface: "slack" }),

    async waitRun(runId, hooks = {}) {
      const signaled = new Set<"replying" | "firstBlock" | "surface">();
      const once = (signal: "replying" | "firstBlock" | "surface", fire: () => void): void => {
        if (signaled.has(signal)) return;
        signaled.add(signal);
        fire();
      };
      const signalReplying = (durable = false): void => {
        if (!signaled.has("replying") && (durable || deps.turnStream.replying(runId)))
          once("replying", () => hooks.onReplying?.());
      };
      const signalFirstBlock = (text: string): void => {
        if (text.trim()) once("firstBlock", () => hooks.onFirstBlock?.(text));
      };
      const signalSurface = (): void => once("surface", () => hooks.onSurfacePosted?.());
      const waiters = terminalWaiters.get(runId) ?? new Set();
      terminalWaiters.set(runId, waiters);
      const unsubscribe = deps.turnStream.subscribe(runId, {
        onFirstBlock: signalFirstBlock,
        onSurfacePosted: signalSurface,
      });
      let lastProgressAt = Date.now();
      let lastMark = "";
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
              await emitGoal().catch(swallowAs("slack-core-client: terminal goal refresh", undefined));
              if (view?.surfacePosted) signalSurface();
              return (view?.result as TurnResult | null | undefined) ?? null;
            }
            signalReplying(run.deliveryState?.replying === true);
            await emitGoal().catch(swallowAs("slack-core-client: goal refresh", undefined));
            const fb = deps.turnStream.firstBlock(runId);
            if (fb?.closed) signalFirstBlock(fb.text);
            const mark = `${run.status}:${run.attempts}`;
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

    stopConversation: (threadRef) => deps.app.stopConversation(threadRef),

    async ackRunDelivery(runId) {
      await deps.runs.setDeliveryState(runId, null, { postedAt: Date.now() });
    },

    async reportRunEditRef(runId, editRef) {
      const found = await deps.runs.setDeliveryState(runId, null, { editRef });
      if (!found) throw new Error(`run ${runId} not found`);
    },
  } satisfies Partial<SlackCoreClient>;
}

function directoryAndContextMethods(deps: SlackCoreClientDeps, lease: LeaderLease) {
  return {
    async getApproval(requestId) {
      const record = await deps.app.getApproval(requestId);
      if (!record) return null;
      return {
        requestId: record.requestId,
        ...(record.createdAt !== undefined ? { createdAt: record.createdAt } : {}),
        command: record.command,
        sessionId: record.sessionId,
        ...(record.reason !== undefined ? { reason: record.reason } : {}),
        ...(record.purpose !== undefined ? { purpose: record.purpose } : {}),
        ...(record.summary !== undefined ? { summary: record.summary } : {}),
        ...(record.summaryDetail !== undefined ? { summaryDetail: record.summaryDetail } : {}),
        ...(record.grantModes !== undefined ? { grantModes: record.grantModes } : {}),
        ...(record.kind !== undefined ? { kind: record.kind } : {}),
        ...(record.request !== undefined ? { request: record.request as unknown as Record<string, unknown> } : {}),
      };
    },

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
            body.partialChannels,
          )) && applied;
      }
      if (body.groupMembers) {
        applied =
          (await deps.app.upsertGroups(body.groupMembers, body.groupsSyncedAt, body.groupIds, body.groupRosterIds)) &&
          applied;
      }
      return applied;
    },

    slack: deps.slack,
    holdDirectorySync: (fn) => lease.hold("slack:directory-sync", fn),
    upkeep: slackUpkeepRegistry(),
    stagedEnvelopes: deps.stagedEnvelopes,
    handledEvents: deps.handledEvents,

    pendingContextRequests: () => deps.app.pendingContextRequests("slack"),

    onContextRequest(listener) {
      return deps.app.onContextRequestCreated((request) => {
        if (request.source === "slack") listener(request);
      });
    },

    pickAckEmoji: (text, candidates) => deps.pickAckEmoji?.(text, candidates) ?? Promise.resolve(undefined),

    async inboxSlackMessage(msg) {
      const at = Math.round(Number.parseFloat(msg.ts) * 1000);
      if (!Number.isFinite(at)) return;
      await deps.inboxEvent?.({
        source: "slack",
        conversationKey: msg.channel,
        conversationRef: slackConversationRef(msg.channel, msg.ts, msg.threadTs, msg.isDirectMessage),
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
        .catch(swallowAs("slack: record ack emoji pick", undefined));
    },

    async fulfillContextRequest(id, outcome) {
      await deps.app.fulfillContextRequest(id, outcome).catch(async (error: unknown) => {
        reportFailure("slack-core-client: fulfill context request", error);
        await deps.app
          .fulfillContextRequest(id, { error: "the conversation couldn't be read" })
          .catch(swallowAs("slack-core-client: fail context request", undefined));
      });
    },
  } satisfies Partial<SlackCoreClient>;
}

export function createSlackCoreClient(deps: SlackCoreClientDeps): SlackCoreClient {
  const lease = deps.leaderLease;
  const terminalWaiters = new Map<string, Set<() => void>>();
  deps.runs.onTerminal((run) => {
    for (const wake of terminalWaiters.get(run.id) ?? []) wake();
  });

  return {
    ...surfaceSettingsMethods(deps, lease),
    ...surfaceDataMethods(deps),
    ...runMethods(deps, terminalWaiters),
    ...directoryAndContextMethods(deps, lease),
  };
}
