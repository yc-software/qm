import { orgId as configOrgId } from "../config.ts";
import { resolveBranding } from "../resolution/branding.ts";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import type { App } from "./app.ts";
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
import type { TurnStream } from "../runs/turn-stream.ts";
import type { TaskStore, TaskStatus } from "../tasks/task-store.ts";
import { swallowAs } from "../util/errors.ts";
import { resolveRuntimeChoiceDurable, type RuntimeChoice } from "../harness/harness-router.ts";
import { modelDisplayName } from "../model/pi-models.ts";

interface SlackRunHooks {
  onFirstBlock?(text: string): void;
  onSurfacePosted?(): void;
  onTasks?(tasks: Array<{ id: string; title: string; status: TaskStatus }>): void | Promise<void>;
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
  ackEmojiOverride(): Promise<string[] | null>;
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
  pushDirectory(body: DirectoryPush): Promise<void>;
  claimDeliveries(type: string, claimMs: number): Promise<Delivery[]>;
  ackDelivery(id: string, body?: { recipientThreadRef?: string; slackApiMs?: number }): Promise<void>;
  onDeliveryEnqueued(listener: () => void): () => void;
  pendingContextRequests(): Promise<SurfaceContextRequest[]>;
  onContextRequest(listener: (request: SurfaceContextRequest) => void): () => void;
  fulfillContextRequest(id: string, outcome: { result?: SurfaceContextResult; error?: string }): Promise<void>;
  pickAckEmoji(text: string, candidates: readonly string[]): Promise<string | undefined>;
  recordAckPick(pick: AckPickInput): Promise<void>;
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
  metrics: MetricsSink;
  runs: RunStore;
  turnStream: TurnStream;
  tasks: TaskStore;
  pickAckEmoji?(text: string, candidates: readonly string[]): Promise<string | undefined>;
  ackPicks?: AckEmojiPickStore;
  ackModelId?: () => string | undefined;
  brandingDefault?: OrgBranding;
}

const RUN_FALLBACK_POLL_MS = 1_000;
const RUN_STALL_BUDGET_MS = 300_000;

export function createSlackCoreClient(deps: SlackCoreClientDeps): SlackCoreClient {
  const orgScope: ScopeId = scopeId("org", configOrgId());
  const terminalWaiters = new Map<string, Set<() => void>>();
  deps.runs.onTerminal((run) => {
    for (const wake of terminalWaiters.get(run.id) ?? []) wake();
  });

  return {
    async externalSlackParticipants() {
      return (await deps.config.getExternalSlackParticipantsDurable(orgScope)) === true;
    },

    async ackEmojiOverride() {
      return await deps.config.getAckEmojiDurable(orgScope);
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
              if (view?.surfacePosted) signalSurface();
              return (view?.result as TurnResult | null | undefined) ?? null;
            }
            await emitTasks();
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

    async pushDirectory(body) {
      if (body.workspaceUrl) await deps.app.setDirectoryWorkspaceUrl(body.workspaceUrl);
      if (body.members) await deps.app.upsertDirectory(body.members, body.membersSyncedAt);
      if (body.channels)
        await deps.app.upsertChannels(
          body.channels,
          body.channelMembers,
          body.channelsSyncedAt,
          body.channelRosterIds,
          body.channelRevocations,
        );
      if (body.groupMembers)
        await deps.app.upsertGroups(body.groupMembers, body.groupsSyncedAt, body.groupIds, body.groupRosterIds);
    },

    claimDeliveries(type, claimMs) {
      return deps.app.pendingDeliveries(type, claimMs);
    },

    async ackDelivery(id, body) {
      if (body?.recipientThreadRef) await deps.app.recordPrincipalDelivery(id, body.recipientThreadRef);
      await deps.app.ackDelivery(id, body?.slackApiMs);
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
