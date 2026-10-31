import { isSessionTurn } from "../core/turn-origin.ts";
import { replayableRequest } from "../core/orchestrator/turn-helpers.ts";
import {
  createSlackSessionStatus,
  type SlackStatusActivity,
  type SlackSessionStatus,
  type SlackSessionStatusState,
} from "../slack/session-status.ts";
import type { FeatureFlagStore } from "../feature-flags.ts";
import type { IdentityService } from "../identity/identity-service.ts";
import type { KeychainApprovals } from "../credentials/keychain-approval.ts";
import { createTaskAcknowledgements, type TaskAckState, type TaskAcknowledgements } from "../slack/task-ack.ts";
import { orgId as configOrgId } from "../config.ts";
import type { StagedEnvelope } from "../slack/envelope-staging.ts";
import { resolveBranding } from "../resolution/branding.ts";
import type { App } from "./app.ts";
import type { ErrorLog } from "../admin/error-log.ts";
import type { LeaderLease } from "../persistence/leader-lease.ts";
import type { Delivery, ScopeId, TurnRequest } from "../types.ts";
import type { SurfaceContextRequest } from "../reach/reach.ts";
import { scopeId } from "../types.ts";
import type { CachedMessage, ReadMessagesOpts, IngestEvent } from "../surface-cache/surface-cache.ts";
import type { AckEmojiPickStore } from "../surface-cache/ack-emoji-pick-store.ts";
import type { OrgBranding, ScopedConfigStore } from "../resolution/config-store.ts";
import type { BlobTransferStore } from "../persistence/blob-transfer.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import type { RunStore } from "../runs/run-store.ts";
import type { TurnStream } from "../runs/turn-stream.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { swallowAs } from "../util/errors.ts";
import { resolveRuntimeChoice } from "../agent/runtime-choice.ts";
import type { RuntimeChoice } from "../agent/agent.ts";
import { modelDisplayName } from "../model/pi-models.ts";
import type { ConversationEvent } from "../loops/sources/adapter.ts";
import { slackConversationRef } from "../loops/sources/slack.ts";
import { createSurfaceCoreClient, type SurfaceCoreClient, type SurfaceCoreClientDeps } from "./surface-core-client.ts";

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

export interface SlackCoreClient extends Omit<
  SurfaceCoreClient,
  "streamSnapshot" | "getDelivery" | "reportDeliveryUndeliverable"
> {
  streamSnapshot?(runId: string): string | null;
  getDelivery?(id: string): Promise<Delivery | null>;
  reportDeliveryUndeliverable?(id: string, reason: string): Promise<void>;
  privateContinuationSource?(runId: string): Promise<TurnRequest | null>;
  taskAcknowledgements?: TaskAcknowledgements;
  sessionStatus?: SlackSessionStatus;
  externalSlackParticipants(): Promise<boolean>;
  ackEmojiOverride(): Promise<string[] | null>;
  publishEmojiCatalog(emoji: Record<string, string>): Promise<void>;
  surfaceHeaderFacts(scope: ScopeId): Promise<{ agentLabel?: string; modelName: string }>;
  channelHeaderPinEnabled(scope: ScopeId): Promise<boolean>;
  onScopeModelChanged(listener: (scope: ScopeId) => void): void;
  onChannelHeaderPinChanged(listener: (scope: ScopeId) => void): void;
  rememberSurfaceHistory?(events: IngestEvent[]): Promise<void>;
  readSurfaceMessages?(container: string, opts?: ReadMessagesOpts): Promise<CachedMessage[]>;
  pushDirectory(body: DirectoryPush): Promise<boolean>;
  reportSlowDeliveryDrain?(info: { durationMs: number; rows: number }): Promise<void>;
  holdEnvelopeReplay<T>(account: string, fn: (lost: Promise<void>) => Promise<T>): Promise<T | null>;
  stagedEnvelopes?: DurableMap<StagedEnvelope>;
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

export interface SlackCoreClientDeps extends SurfaceCoreClientDeps {
  identity: IdentityService;
  keychainApprovals?: KeychainApprovals;
  taskAcknowledgements?: DurableMap<TaskAckState>;
  sessionStatus?: DurableMap<SlackSessionStatusState>;
  statusActivity?: SlackStatusActivity;
  featureFlags?: FeatureFlagStore;
  app: App;
  config: ScopedConfigStore;
  runtimeFallback: RuntimeChoice;
  blobTransfer: BlobTransferStore;
  deliveries: DeliveryStore;
  errors?: ErrorLog;
  runs: RunStore;
  turnStream: TurnStream;
  pickAckEmoji?(text: string, candidates: readonly string[]): Promise<string | undefined>;
  ackPicks?: AckEmojiPickStore;
  ackModelId?: () => string | undefined;
  brandingDefault?: OrgBranding;
  leaderLease: LeaderLease;
  stagedEnvelopes?: DurableMap<StagedEnvelope>;
  inboxEvent?(event: ConversationEvent): Promise<void>;
}

export function createSlackCoreClient(deps: SlackCoreClientDeps): SlackCoreClient {
  const lease = deps.leaderLease;
  const orgScope: ScopeId = scopeId("org", configOrgId());

  return {
    ...createSurfaceCoreClient(deps, "slack"),
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
      return (await deps.config.getExternalSlackParticipantsDurable(orgScope)) === true;
    },

    async ackEmojiOverride() {
      return await deps.config.getAckEmojiDurable(orgScope);
    },

    async publishEmojiCatalog(emoji) {
      await deps.config.setSlackEmojiCatalog(orgScope, emoji);
    },

    async surfaceHeaderFacts(scope) {
      const [choice, branding] = await Promise.all([
        resolveRuntimeChoice(deps.config, orgScope, scope, deps.runtimeFallback),
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

    async rememberSurfaceHistory(events) {
      await deps.surfaceCache?.ingest(events);
    },

    async readSurfaceMessages(container, opts) {
      return deps.app.readSurfaceMessages(container, { ...opts, noFallback: true });
    },

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

    holdEnvelopeReplay(account, fn) {
      return lease.hold(`slack:envelope-replay:${account}`, fn);
    },
    stagedEnvelopes: deps.stagedEnvelopes,

    async reportSlowDeliveryDrain(info) {
      deps.errors?.record({
        category: "delivery",
        code: "delivery_drain_slow",
        message: `drain cycle took ${Math.round(info.durationMs / 1000)}s for ${info.rows} rows`,
        scopeLabel: "slack:deliveries" as ScopeId,
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
  };
}
