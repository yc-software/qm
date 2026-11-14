import type { PersonaHandover } from "../personas/persona-handover.ts";
import type { Tenant } from "../tenants/context.ts";
import type { PersonaService } from "../personas/persona-service.ts";
import type { TeamStore } from "../teams/teams.ts";
import type { CronScriptTrial } from "../cron/script.ts";
import type { ExternalSlackPolicies } from "../resolution/external-slack.ts";
import type { Mailer } from "../../plugins/chassis/src/resend.ts";
import type { AppInvitation } from "../deploy/email-access.ts";
import type { AdmittedWork } from "../util/admitted-work.ts";
import type { EventBus, SubscribeOptions } from "../util/event-bus.ts";
import type { RunStreamEvent } from "../runs/run-stream-events.ts";
import type { ResourceSearchStore, ResourceSearchHit } from "../search/resource-search.ts";
import type { ModelOverlayStore } from "../model/model-overlay-store.ts";
import type { SwarmService } from "../swarms/swarm-service.ts";
import type {
  DeliveryProvenance,
  Grant,
  PendingApproval,
  PendingApprovalRecord,
  Permission,
  Principal,
  ScopeId,
  Session,
  TurnRequest,
  TurnResult,
  TurnRuntime,
} from "../types.ts";
import type { OutgoingAttachment } from "../types.ts";
import type { Readable } from "node:stream";
import { type FileArtifact, type FileArtifactStore, type ListOwnedOptions } from "../files/file-artifact-store.ts";
import type { IdentityService } from "../identity/identity-service.ts";
import type { UserStore } from "../identity/user-store.ts";
import type { SessionStore, TranscriptItem } from "../sessions/session-store.ts";
import type { Item } from "../sessions/items.ts";
import { type Sandbox } from "../sandbox/sandbox.ts";
import type { ProcessRegistry } from "../processes/process-registry.ts";
import type { MonitorStore } from "../monitors/monitor-store.ts";
import type { EngagedRegistry } from "../wake/engaged-registry.ts";
import type { Orchestrator } from "../core/orchestrator.ts";
import type { Run, RunDeliveryState, RunStore } from "../runs/run-store.ts";
import type { GoalView, ReasoningBlock, TurnStream } from "../runs/turn-stream.ts";
import type { SessionStateBus, SessionStateEvent } from "../runs/session-state-bus.ts";
import type { LedgerEventBus, OwnedLedgerEvent } from "../loops/ledger-events.ts";
import type { RunActivityEntry, RunActivityStore } from "../runs/run-activity-store.ts";
import type { RunSignal, RunSignalStore } from "../runs/run-signal-store.ts";
import type { CustomProviderStore, ModelCredentialStore } from "../model/model-credential-store.ts";
import type { UserModelCredentialStore } from "../model/user-model-credential-store.ts";
import type { McpServerStore } from "../mcp/mcp-server-store.ts";
import type { McpToolService } from "../mcp/mcp-tool-service.ts";
import type { AclStore } from "../acl/acl-store.ts";
import type { SkillStore, Skill, SkillResolution } from "../skills/skill-store.ts";
import type { SkillPack, NewSkillPack, SkillPackStore } from "../skills/skill-pack-store.ts";
import type { SkillPackFetcher } from "../skills/pack-fetcher.ts";
import { type IngestPlan, type ImportResult } from "../skills/ingest.ts";
import { type SkillBundleStore } from "../skills/skill-bundle-store.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import type { CapabilityClaims } from "../auth/capability-token.ts";
import type { ScopedConfigStore } from "../resolution/config-store.ts";
import { type AdminService } from "../admin/admin-service.ts";
import type { CronStore, CreateCronInput, CronPatch } from "../cron/cron-store.ts";
import type { CronFireRecord } from "../cron/fire-store.ts";
import type { WebhookStore, WebhookEvent, CreateWebhookInput } from "../webhooks/webhook-store.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import type {
  ChannelMembership,
  ChannelResolution,
  DirectoryChannel,
  DirectoryMember,
  DirectoryMeta,
  DirectoryStore,
  GroupMembership,
  RecipientResolution,
} from "../directory/directory-store.ts";
import type { Delivery, Destination } from "../types.ts";
import type { Cron, CronFireLogEntry, CronFireNote, TriggerBase, Webhook } from "../triggers/types.ts";
import type { SurfaceContextQuery, SurfaceContextRequest, SurfaceContextResult } from "../reach/reach.ts";
import type {
  ActiveThread,
  CachedMessage,
  ContainerSummary,
  IngestEvent,
  ReadMessagesOpts,
  SearchOpts,
  SurfaceCache,
} from "../surface-cache/surface-cache.ts";
import { type BotPolicy, type ChannelPolicy, type ChannelPolicyStore } from "../surface-cache/channel-policy-store.ts";
import { type AmbientDecision } from "../surface-cache/ambient-judge.ts";
import type { SurfaceRegistry } from "../surfaces/registry.ts";
import type { AmbientJudgmentStore } from "../surface-cache/ambient-judgment-store.ts";
import type { AckEmojiPickStore } from "../surface-cache/ack-emoji-pick-store.ts";
import type { PublishedApp, AppDraft } from "../deploy/deploy-store.ts";
import type { DeploymentLayerRuntime } from "../deployment/load-layer.ts";
import { type ArtifactHome, type ArtifactType } from "./artifact-share.ts";
import type {
  DeployService,
  DeployInput,
  RedeployInput,
  Reach,
  ReachOptions,
  AppGrantee,
  AppActor,
} from "../deploy/deploy-service.ts";
import { type DurableMap } from "../persistence/durable-map.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import type { Environment, EnvironmentAttachment, EnvironmentStore } from "../environments/environment-store.ts";
import type { ModelProviderAvailability } from "../model/pi-models.ts";
import type { RuntimeChoice } from "../agent/agent.ts";
import { type ReachOpts, type ReachResolution, type ReachTarget } from "../reach/reach.ts";
import { type Project, type ProjectIcon, type ProjectStore } from "../projects/project-store.ts";
import type { CoreSearch } from "../search/core-search.ts";
import type { ErrorLog } from "../admin/error-log.ts";

interface AppVersionView {
  version: number;
  createdAt: number;
  commit?: string;
  parentCommit?: string;
}

export interface AppView {
  id: string;
  ownerScopeId: ScopeId;
  createdBy: string;
  createdInScope?: ScopeId;
  name?: string;
  displayName?: string;
  currentVersion: number;
  appliedVersion?: number;
  status: PublishedApp["status"];
  alwaysOn?: boolean;
  embedAncestors?: string[];
  connectors?: string[];
  public: boolean;
  lastAccessAt?: number;
  createdAt?: number;
  updatedAt?: number;
  versions: AppVersionView[];
}

export interface ViewerApp extends AppView {
  permission: Permission;
  webUrl?: string;
}

export function appView(d: PublishedApp): AppView {
  const versions = d.versions.map(({ version, createdAt, commit, parentCommit }) => ({
    version,
    createdAt,
    ...(commit ? { commit } : {}),
    ...(parentCommit ? { parentCommit } : {}),
  }));
  return {
    id: d.id,
    ownerScopeId: d.ownerScopeId,
    createdBy: d.createdBy,
    ...(d.createdInScope ? { createdInScope: d.createdInScope } : {}),
    ...(d.name ? { name: d.name } : {}),
    ...(d.displayName ? { displayName: d.displayName } : {}),
    currentVersion: d.currentVersion,
    ...(d.appliedVersion !== undefined ? { appliedVersion: d.appliedVersion } : {}),
    status: d.status,
    ...(d.alwaysOn ? { alwaysOn: true } : {}),
    ...(d.embedAncestors?.length ? { embedAncestors: d.embedAncestors } : {}),
    ...(d.connectors ? { connectors: d.connectors } : {}),
    public: d.public === true,
    ...(d.lastAccessAt !== undefined ? { lastAccessAt: d.lastAccessAt } : {}),
    ...(versions[0] ? { createdAt: versions[0].createdAt } : {}),
    ...(versions.at(-1) ? { updatedAt: versions.at(-1)!.createdAt } : {}),
    versions,
  };
}
interface ReachNowInput {
  senderId: string;
  senderScope: ScopeId;
  text?: string;
  recipient?: string;
  channel?: string;
  participants?: readonly string[];
  threadTs?: string;
  unfurlLinks?: boolean;
  attachments?: OutgoingAttachment[];
  react?: { messageTs: string; emoji: string };
  delete?: { messageTs: string };
  edit?: { messageTs: string };
  currentDestination?: Destination;
  turn?: { surface?: string; liveReplies?: boolean };
}
export type ReachNowResult =
  | {
      ok: true;
      delivery: Delivery;
      recipient?: { principalId: string; displayName: string };
      channel?: { channelId: string; name: string };
      group?: { groupId: string };
    }
  | {
      ok: false;
      status: 400 | 403 | 404 | 409 | 502;
      error: string;
      message: string;
      candidates?: Array<Record<string, string>>;
    };

export type VisibleCron = Cron & { scopeName?: string };

export type CronEditor = Pick<CapabilityClaims, "actorId" | "runId" | "botActor">;

export type ProjectView = Project & {
  scopeId: ScopeId;
  members: Array<{ principalId: string; displayName: string; avatarUrl?: string; viaChannel?: boolean }>;
};

type ProjectViewMutation =
  | { status: "ok"; project: ProjectView; changed: boolean }
  | {
      status:
        | "not_found"
        | "forbidden"
        | "invalid_member"
        | "invalid_name"
        | "invalid_icon"
        | "invalid_channel"
        | "channel_in_use";
    };

interface AppGitUrl {
  url: string;
  permission: "read" | "write";
}

interface SessionBackgroundView {
  jobs: Array<{ processId: string; command: string; purpose?: string; startedAt: number; expiresAt: number }>;
  watches: Array<{
    id: string;
    processId: string;
    command: string;
    pattern?: string;
    instructions?: string;
    createdAt: number;
    expiresAt: number;
    lastFiredAt?: number;
  }>;
  crons: Array<{
    id: string;
    title?: string;
    nextFireAt?: number;
    lastFire?: { firedAt: number; status?: CronFireLogEntry["status"] };
  }>;
}

interface SessionBackgroundOutput {
  chunk: string;
  cursor: number;
  state: "running" | "exited";
  exitCode?: number;
}

interface TranscriptWindow {
  tailTurns?: number;
  sinceSeq?: number;
  beforeSeq?: number;
}

export interface SessionPinView {
  id: string;
  text?: string;
  entrySeq?: number;
  preview?: string;
  addedBy: string;
  createdAt: number;
}

type PinItemResult = { pin: SessionPinView } | { error: "not_found" | "bad_entry" | "limit" };

export interface SessionSearchHit {
  sessionId: string;
  title: string | null;
  scopeId: string;
  channelName?: string;
  surface?: string;
  seq: number;
  entryType: string;
  author?: string;
  snippet: string;
  createdAt: number;
  archived?: boolean;
}

export interface App {
  tenantFor: import("../tenants/lookup.ts").TenantLookup["tenantFor"];
  swarms?: SwarmService;
  personas?: PersonaService;
  personaHandover?: PersonaHandover;
  turn(req: TurnRequest, replay?: { signalDedupKey: string }): Promise<TurnResult>;
  getApproval(
    requestId: string,
    viewer?: string,
  ): Promise<(Omit<PendingApprovalRecord, "call"> & { requestId: string; executesOnApprove?: boolean }) | null>;
  subscribeSessionStates(cb: (event: SessionStateEvent) => void | Promise<void>, opts?: SubscribeOptions): () => void;
  subscribeLedgerEvents(cb: (event: OwnedLedgerEvent) => void | Promise<void>, opts?: SubscribeOptions): () => void;
  listSessionApprovals(sessionId: string, viewer: string): Promise<PendingApproval[]>;
  pendingApprovalForThread(threadRef: string, viewer?: string): Promise<TurnResult | null>;
  subscribeRun(runId: string, listener: (event: RunStreamEvent) => void, onResync?: () => void): () => void;
  syncRunStream(runId: string, offset: number, reasoning: Record<string, number>): void;
  getRun(
    runId: string,
    viewer?: string,
  ): Promise<{
    status: Run["status"];
    attempt: number;
    result: TurnResult | null;
    input?: {
      runId: string;
      seq: number | null;
      text: string;
      createdAt: number;
      attachments?: Array<{ name: string; mimetype: string; sizeBytes: number }>;
    };
    goal?: GoalView;
    runtime?: TurnRuntime;
    partial?: string;
    partialStartOffset?: number;
    alive?: boolean;
    stale?: boolean;
    replying?: boolean;
    replyComplete?: boolean;
    firstBlock?: string;
    firstBlockClosed?: boolean;
    surfacePosted?: boolean;
    activity?: RunActivityEntry[];
    reasoning?: ReasoningBlock[];
    startedAt: number | null;
    finishedAt: number | null;
  } | null>;
  getRunToolItems(runId: string, viewer?: string, afterSeq?: number): Promise<Item[]>;
  activeRunForThread(
    threadRef: string,
    viewer?: string,
  ): Promise<{ runId: string; queued?: Array<{ runId: string; text: string; hasAttachments?: boolean }> } | null>;
  editQueuedRun(
    runId: string,
    text: string,
    expectedText: string,
    viewer?: string,
  ): Promise<{ edited: boolean; reason?: string }>;
  withdrawRun(runId: string, viewer?: string): Promise<{ withdrawn: boolean; reason?: string }>;
  signalRun(
    runId: string,
    signal: RunSignal & { tree?: boolean; remark?: boolean },
    viewer?: string,
  ): Promise<{ accepted: boolean; reason?: string; why?: string; queuedRunId?: string; replayed?: boolean }>;
  replayOrphanedRunSignals(runId: string): Promise<void>;
  steerRun(
    run: Run,
    signal: RunSignal,
  ): Promise<{ sent: boolean; terminal?: boolean; drained?: boolean; replayRunId?: string }>;
  getSession(
    sessionId: string,
    window?: TranscriptWindow,
  ): Promise<{ session: Session; items: TranscriptItem[]; earlierItems?: number; pins?: SessionPinView[] } | null>;
  getSessionForViewer(
    sessionId: string,
    viewer: Pick<CapabilityClaims, "actorId" | "botActor">,
    window?: TranscriptWindow,
  ): Promise<{
    session: Session;
    items: TranscriptItem[];
    earlierItems?: number;
    pins?: SessionPinView[];
    goal?: GoalView;
    runtime?: TurnRuntime;
    latestPromptAt?: number;
  } | null>;
  canViewSessionSnapshot(sessionId: string, principalId: string): Promise<boolean>;
  getSessionItemForViewer(sessionId: string, principalId: string, seq: number): Promise<{ item: Item } | null>;
  pinConversationItem(
    threadRef: string,
    addedBy: string,
    pin: { text?: string; entrySeq?: number },
  ): Promise<PinItemResult>;
  listConversationPins(threadRef: string, reader: string): Promise<SessionPinView[] | null>;
  unpinConversationItem(threadRef: string, pinId: string): Promise<boolean | null>;
  listSessions(viewer: Pick<CapabilityClaims, "actorId" | "botActor">): Promise<Session[]>;
  listSessionPage(principalId: string, query: SessionPageQuery): Promise<SessionPageResult>;
  sideChats(principalId: string, sessionId: string): Promise<Session[] | null>;
  expandSideChat(principalId: string, sessionId: string): Promise<Session | null>;
  sessionChildren(principalId: string, sessionId: string): Promise<Session[] | null>;
  sessionRow(principalId: string, ref: { id?: string; threadRef?: string }): Promise<Session | null>;
  searchResources(
    tenant: Tenant,
    principalId: string,
    query: string,
  ): Promise<{ hits: ResourceSearchHit[]; failed: string[]; limited: string[] }>;
  searchConversations: CoreSearch["search"];
  searchSessions(
    viewer: Pick<CapabilityClaims, "actorId" | "botActor">,
    query: string,
    limit?: number,
  ): Promise<SessionSearchHit[]>;
  search: CoreSearch["search"];
  sessionBackground(sessionId: string, viewer: string): Promise<SessionBackgroundView | null>;
  readSessionBackgroundOutput(
    sessionId: string,
    processId: string,
    viewer: string,
    sinceCursor: number,
  ): Promise<SessionBackgroundOutput | null>;
  listContexts(principalId: string): Promise<ContextSummary[]>;
  listProjects(principalId: string): Promise<ProjectView[]>;
  createProject(principalId: string, name: string): Promise<ProjectView | null>;
  addProjectMember(id: string, principalId: string, memberId: string): Promise<ProjectViewMutation>;
  removeProjectMember(id: string, principalId: string, memberId: string): Promise<ProjectViewMutation>;
  setProjectSlackChannel(id: string, principalId: string, channel: string | null): Promise<ProjectViewMutation>;
  renameProject(id: string, principalId: string, name: string): Promise<ProjectViewMutation>;
  setProjectIcon(id: string, principalId: string, icon: ProjectIcon | null): Promise<ProjectViewMutation>;
  updateSession(
    sessionId: string,
    viewer: Pick<CapabilityClaims, "actorId" | "botActor">,
    patch: {
      title?: string | null;
      archived?: boolean;
      pinned?: boolean;
      color?: string | null;
      readAt?: number;
    },
  ): Promise<Session | null>;
  regenerateTitle(sessionId: string, principalId: string): Promise<{ title: string | null } | null>;
  suggestNextPrompt(
    sessionId: string,
    principalId: string,
  ): Promise<{ enabled: boolean; suggestion: string | null } | null>;
  detachSession(sessionId: string, principalId: string): Promise<{ detached: true } | null>;
  cancelSessionGoal(
    sessionId: string,
    principalId: string,
  ): Promise<{ cancelled: true } | { cancelled: false; reason: "no_open_goal" | "busy" } | null>;
  resumeSessionGoal(
    sessionId: string,
    principalId: string,
  ): Promise<{ resumed: true; goal: GoalView } | { resumed: false; reason: "no_open_goal" | "busy" } | null>;
  spawnSession(principalId: string, opts: { scopeId: ScopeId; title?: string }): Promise<{ session: Session } | null>;
  discardSession(sessionId: string, principalId: string): Promise<boolean>;
  forkSession(
    sessionId: string,
    principalId: string,
    opts?: { upToSeq?: number; sideChat?: { entrySeq: number; quote: string; occurrence: number } },
  ): Promise<{ session: Session; items: Item[] } | null>;
  listFilesForViewer(
    tenant: Tenant,
    principalId: string,
    opts?: ListOwnedOptions,
    inScope?: ScopeId,
    ownScopeBotWork?: boolean,
  ): Promise<FileListPage>;
  uploadFileForViewer(
    tenant: Tenant,
    principalId: string,
    input: { scopeId?: ScopeId; name: string; mimetype?: string; data: AsyncIterable<Uint8Array> },
  ): Promise<FileListItem | null>;
  listScopeResources(tenant: Tenant, principalId: string, scope: ScopeId): Promise<ScopeResources | null>;
  loopAdministration(
    actor: Pick<CapabilityClaims, "actorId" | "botActor">,
    loops: readonly Pick<TriggerBase, "owner" | "ownerScopeId" | "botActor">[],
  ): Promise<boolean[]>;
  managesScope(principalId: string, scope: ScopeId): Promise<boolean>;
  currentScopeMembers(scope: ScopeId): Promise<Principal[] | undefined>;
  isCurrentSharedScopeMember(principalId: string, scope: ScopeId): Promise<boolean>;
  isOpenScopeMember(principalId: string, scope: ScopeId): Promise<boolean>;
  membershipControlsScope(scope: ScopeId): Promise<boolean>;
  authorizesCapabilityScope(
    claims: Pick<CapabilityClaims, "actorId" | "scopeId" | "scopeVersion" | "botActor" | "liveActor" | "members">,
  ): Promise<boolean>;
  openFileForViewer(
    tenant: Tenant,
    id: string,
    principalId: string,
    ownScopeBotWork: boolean,
  ): Promise<OpenedFile | null>;
  grant(tenant: Tenant, g: Grant, opts?: { notify?: boolean }): Promise<void>;
  revokeGrant(
    tenant: Tenant,
    ownerScopeId: ScopeId,
    ref: string,
    granteeScopeId: ScopeId,
    revokedBy: string,
  ): Promise<void>;
  promoteSkill(id: string, targetScopeId: ScopeId, actorId: string, liveActor: boolean): Promise<Skill>;
  belongsToScope(principalId: string, scope: ScopeId): Promise<boolean>;
  canManageArtifactHome(homeScopeId: ScopeId, createdBy: string, principalId: string): Promise<boolean>;
  artifactGrantPermission(ownerScopeId: ScopeId, ref: string, principalId: string): Promise<Permission | null>;
  getArtifactHome(type: ArtifactType, idOrName: string): Promise<ArtifactHome | null>;
  moveArtifactHome(type: ArtifactType, id: string, toScope: ScopeId, movedBy: string): Promise<void>;
  getSoul(
    scopeId: ScopeId,
    reader: { actorId: string; ownScopeBotWork: boolean },
  ): {
    scopeId: ScopeId;
    soul: string | null;
    soulVersion: number;
    orgScopeId: ScopeId;
    orgSoul: string | null;
    orgSoulVersion: number;
    effectiveSoul: string;
  };
  updateSoul(
    scopeId: ScopeId,
    content: string,
    actorId: string,
    opts?: { allowSharedScope?: boolean; botActor?: boolean; expectedVersion?: number; sessionId?: string },
  ): Promise<number>;
  createCron(input: CreateCronInput, trial?: CronScriptTrial): Promise<Cron>;
  getCron(id: string): Promise<Cron | null>;
  listCrons(ids?: readonly string[]): Promise<Cron[]>;
  listCronsForViewer(principalId: string): Promise<{ owned: Cron[]; visible: VisibleCron[] }>;
  updateCron(id: string, patch: CronPatch, by: CronEditor, trial?: CronScriptTrial): Promise<Cron | null>;
  deleteCron(id: string, by: CronEditor): Promise<void>;
  setCronEnabled(id: string, enabled: boolean): Promise<void>;
  setCronFireNote(id: string, note: CronFireNote, by: CronEditor): Promise<"applied" | "superseded" | "missing">;
  listCronFires(id: string, opts?: { limit?: number }): Promise<{ runs: CronFireLogEntry[]; total: number }>;
  cronFiresByThreadRefs(threadRefs: readonly string[]): Promise<CronFireRecord[]>;
  latestCronFireForThread(id: string, threadRef: string): Promise<CronFireLogEntry | undefined>;
  setCronRuntime(id: string, runtime: Exclude<Cron["runtime"], undefined>): Promise<Cron | null>;
  setCronDestination(id: string, destination: Destination | undefined, by: CronEditor): Promise<Cron | null>;
  createWebhook(input: CreateWebhookInput): Promise<Webhook>;
  getWebhook(id: string): Promise<Webhook | null>;
  listWebhookEvents(id: string, viewer: string): Promise<Array<WebhookEvent & { sessionId?: string }>>;
  listWebhooks(): Promise<Webhook[]>;
  setWebhookEnabled(id: string, enabled: boolean): Promise<void>;
  updateWebhook(id: string, patch: { action: string }): Promise<Webhook | null>;
  pendingDeliveries(type: string, claimMs?: number): Promise<Delivery[]>;
  enqueueDelivery(input: {
    destination: Destination;
    text: string;
    idempotencyKey: string;
    provenance?: DeliveryProvenance;
  }): Promise<void>;
  createContextRequest(source: string, query: SurfaceContextQuery): Promise<SurfaceContextRequest>;
  getContextRequest(id: string): Promise<SurfaceContextRequest | null>;
  deleteContextRequest(id: string): Promise<void>;
  pendingContextRequests(source: string): Promise<SurfaceContextRequest[]>;
  fulfillContextRequest(id: string, outcome: { result?: SurfaceContextResult; error?: string }): Promise<boolean>;
  onContextRequestCreated(listener: (request: SurfaceContextRequest) => void): () => void;
  surfaceMirrored(kind: string): boolean;
  chatSurfaces(): { kind: string; label: string; mark?: string }[];
  ingestSurfaceEvents(
    events: IngestEvent[],
    surface?: string,
    self?: { name?: string; mentionId?: string },
  ): Promise<{ upserted: number }>;
  searchSurface(query: string, opts?: SearchOpts): Promise<CachedMessage[]>;
  readSurfaceMessages(container: string, opts?: ReadMessagesOpts): Promise<CachedMessage[]>;
  activeSurfaceThreads(opts?: { container?: string; limit?: number }): Promise<ActiveThread[]>;
  listSurfaceContainers(opts?: { limit?: number }): Promise<ContainerSummary[]>;
  getChannelPolicy(container: string): Promise<ChannelPolicy | null>;
  setChannelPolicy(
    container: string,
    orders: string,
    setBy?: string,
    bots?: Record<string, BotPolicy>,
    sessionId?: string,
    ambientEnabled?: boolean | null,
  ): Promise<ChannelPolicy | null>;
  judgeAmbientContainer(
    surface: string,
    container: string,
    opts?: { reason?: "messages" | "scheduled" },
  ): Promise<AmbientDecision>;
  ackDelivery(id: string, slackApiMs?: number): Promise<void>;
  failDelivery(id: string, reason: string): Promise<Delivery | null>;
  ackDeliveryByKey(idempotencyKey: string): Promise<void>;
  setRunDeliveryState(runId: string, state: RunDeliveryState): Promise<boolean>;
  upsertDirectory(members: DirectoryMember[], syncedAt?: number): Promise<boolean>;
  upsertChannels(
    channels: DirectoryChannel[],
    channelMembers?: ChannelMembership[],
    syncedAt?: number,
    channelRosterIds?: string[],
    revocations?: ChannelMembership[],
    partial?: boolean,
  ): Promise<boolean>;
  upsertGroups(
    groupMembers: GroupMembership[],
    syncedAt?: number,
    groupIds?: string[],
    groupRosterIds?: string[],
  ): Promise<boolean>;
  setDirectoryWorkspaceUrl(url: string): Promise<void>;
  directoryMeta(): Promise<DirectoryMeta>;
  resolveRecipient(query: string): Promise<RecipientResolution>;
  resolveChannel(query: string): Promise<ChannelResolution>;
  directoryMember(principalId: string): Promise<DirectoryMember | null>;
  samePerson(a: string, b: string): Promise<boolean>;
  personMatcher(actorId: string): Promise<(id: string) => Promise<boolean>>;
  cronAdminUrl(cron: Cron): string | undefined;
  channelName(channelId: string): Promise<string | undefined>;
  ambientJudge?(systemPrompt: string, prompt: string): Promise<string | undefined>;
  directoryMembers(): Promise<DirectoryMember[]>;
  directoryChannels(): Promise<DirectoryChannel[]>;
  directoryChannelsFor(principalId: string): Promise<DirectoryChannel[]>;
  channelMember(channelId: string, principalId: string): Promise<boolean>;
  channelVisibleTo(actorId: string, channelId: string, isPrivate?: boolean): Promise<boolean>;
  recordPrincipalDelivery(deliveryId: string, recipientThreadRef: string): Promise<void>;
  reachNow(input: ReachNowInput): Promise<ReachNowResult>;
  resolveReachTarget(target: ReachTarget, authorityId: string, opts?: ReachOpts): Promise<ReachResolution>;
  deploy(input: DeployInput): Promise<PublishedApp>;
  redeploy(id: string, input: RedeployInput): Promise<PublishedApp>;
  listApps(): Promise<PublishedApp[]>;
  getApp(idOrName: string): Promise<PublishedApp | null>;
  listAppsForViewer(tenant: Tenant, viewer: Pick<CapabilityClaims, "actorId" | "botActor">): Promise<ViewerApp[]>;
  effectiveAppPermission(d: PublishedApp, principalId: string): Promise<Permission | null>;
  appGitPermissionFor(
    idOrName: string,
    viewer: Pick<CapabilityClaims, "actorId" | "botActor">,
  ): Promise<"read" | "write" | null>;
  appGitPermissionsFor(
    tenant: Tenant,
    publishedApps: readonly PublishedApp[],
    viewer: Pick<CapabilityClaims, "actorId" | "botActor">,
  ): Promise<Array<"read" | "write" | null>>;
  listSkills(): Promise<Skill[]>;
  getSkill(id: string): Promise<Skill | null>;
  archiveSkill(id: string): Promise<Skill>;
  listVisibleSkills(principalId: string, ownScopeBotWork: boolean): Promise<SkillResolution[]>;
  canManageSkill(skill: Skill, principalId: string, botWork: boolean): Promise<boolean>;
  updateOwnedSkill(
    id: string,
    principalId: string,
    patch: { description?: string; body?: string },
    opts?: { liveActor?: boolean; botActor?: boolean },
  ): Promise<Skill | "trigger_blocked" | null>;
  restoreOwnedSkill(
    id: string,
    principalId: string,
    opts?: { liveActor?: boolean; botActor?: boolean },
  ): Promise<Skill | "exists" | "trigger_blocked" | null>;
  listSkillPacks(): Promise<SkillPack[]>;
  getSkillPack(id: string): Promise<SkillPack | null>;
  registerSkillPack(input: NewSkillPack): Promise<SkillPack>;
  updateSkillPack(id: string, patch: Partial<Omit<SkillPack, "id" | "createdAt">>): Promise<SkillPack>;
  skillPackCatalog(id: string): Promise<IngestPlan & { bundlePaths: string[] }>;
  importSkillPack(id: string, selected: "all" | string[], scopeIds?: ScopeId[]): Promise<ImportResult>;
  syncSkillPack(id: string): Promise<ImportResult>;
  removeSkillPack(id: string): Promise<{ removed: number }>;
  createOwnedSkill(input: {
    principalId: string;
    homeScope?: ScopeId;
    name: string;
    description: string;
    body: string;
    requiredCapabilities?: string[];
  }): Promise<Skill | null>;
  deleteOwnedSkill(input: {
    principalId: string;
    id: string;
    liveActor?: boolean;
    botActor?: boolean;
  }): Promise<"missing" | "forbidden" | "trigger_blocked" | "deleted">;
  rollbackApp(id: string, version: number, actor?: string): Promise<void>;
  archiveApp(id: string): Promise<void>;
  restoreApp(id: string, actorId?: string): Promise<PublishedApp>;
  canManageApp(
    idOrName: string,
    caller: Pick<CapabilityClaims, "actorId" | "botActor">,
    actingScopeId?: ScopeId,
  ): Promise<boolean>;
  renameApp(id: string, name: string): Promise<PublishedApp>;
  setAppDisplayName(id: string, displayName: string): Promise<PublishedApp>;
  setAppAlwaysOn(id: string, alwaysOn: boolean): Promise<PublishedApp>;
  setAppEmbedAncestors(id: string, embedAncestors: string[]): Promise<PublishedApp>;
  setAppPublic(idOrName: string, isPublic: boolean, actor: AppActor): Promise<PublishedApp>;
  setAppConnectors(idOrName: string, connectors: string[], actor: { createdBy: string }): Promise<PublishedApp>;
  maintainApps(): Promise<number>;
  publishDueLiveEdits(): Promise<number>;
  appLiveEdit(id: string): Promise<{ draft: AppDraft | null } | null>;
  reachApp(id: string, principalId: string, opts?: ReachOptions): Promise<Reach>;
  appLogsFor(
    id: string,
    principalId: string,
    opts: { tailLines: number },
  ): Promise<{ status: "ok"; logs: string | null } | { status: "not_found" | "denied" }>;
  shareApp(
    idOrName: string,
    grantee: ScopeId,
    permission: Permission | null,
    actor: AppActor,
    opts?: { notify?: boolean },
  ): Promise<AppGrantee[]>;
  inviteToApp(
    idOrName: string,
    email: string,
    actor: AppActor,
    opts?: { notify?: boolean },
  ): Promise<{
    grantees: AppGrantee[];
    invitation: AppInvitation;
  }>;
  appGrantees(idOrName: string): Promise<AppGrantee[]>;
  appUrl(publishedApp: PublishedApp): string | undefined;
  appGitRepoPath(id: string): Promise<string | null>;
  runAppGitPush<T>(
    id: string,
    actor: string | undefined,
    runReceivePack: () => Promise<{ result: T; ok: boolean }>,
  ): Promise<T>;
  appGitUrlFor(
    idOrName: string,
    caller: Pick<CapabilityClaims, "actorId" | "botActor">,
    opts: { secret: string; baseUrl: string; ttlMs?: number },
  ): Promise<AppGitUrl | null>;
  authorizesAppGitAccess(id: string, principalId: string, permission: "read" | "write"): Promise<boolean>;
  reapIdleApps(ttlMs: number, now?: number): Promise<number>;
  listEnvironments(): Promise<{ environment: Environment; attachments: EnvironmentAttachment[] }[]>;
  createEnvironment(input: { scopeId: ScopeId; name: string; actorId: string }): Promise<Environment>;
  resolveEnvironmentByName(name: string): Promise<Environment | null>;
  attachScope(input: { scopeId: ScopeId; environmentId: string; actorId: string }): Promise<void>;
}

interface AppGitPrincipals {
  authorizes(
    publishedApp: PublishedApp,
    principalId: string,
    permission: "read" | "write",
  ): Promise<boolean | undefined>;
}

export interface AppDeps {
  personas?: PersonaService;
  personaHandover?: PersonaHandover;
  externalSlackPolicies?: ExternalSlackPolicies;
  admittedWork?: AdmittedWork;
  shutdown?: () => AbortSignal;
  resourceSearch: ResourceSearchStore;
  swarms?: SwarmService;
  identity: IdentityService;
  users?: Pick<UserStore, "resolve">;
  publicWebUrl?: string;
  inviteMailer?: Mailer;
  sessions: SessionStore;
  orchestrator: Orchestrator;
  runs: RunStore;
  maxAttempts: number;
  runWaitMs?: number;
  turnStream?: TurnStream;
  runStreamEvents?: EventBus<RunStreamEvent>;
  runActivity?: RunActivityStore;
  signals?: RunSignalStore;
  settleTreeWakes?: (root: Session, botRunsOnly?: boolean) => Promise<void>;
  modelCredentials?: ModelCredentialStore;
  userModelCredentials?: UserModelCredentialStore;
  mcpServers?: McpServerStore;
  mcpToolService?: McpToolService;
  modelCredentialFetch?: typeof fetch;
  modelRegistry?: ModelOverlayStore;
  refreshModels?: () => Promise<void>;
  customProviders?: CustomProviderStore;
  refreshCustomProviders?: () => Promise<void>;
  acl: AclStore;
  admin?: AdminService;
  skills: SkillStore;
  skillPacks?: SkillPackStore;
  skillFetcher?: SkillPackFetcher;
  skillBundles?: SkillBundleStore;
  advisoryLock: AdvisoryLock;
  auditLog: AuditLog;
  config: ScopedConfigStore;
  crons: CronStore;
  webhooks: WebhookStore;
  deliveries: DeliveryStore;
  directory: DirectoryStore;
  teams?: Pick<TeamStore, "isMember" | "memberTeams">;
  emailAuthMembers?: DirectoryMember[];
  projects?: ProjectStore;
  deploy: DeployService;
  deployAppsDomain?: string;
  appGitPrincipals?: AppGitPrincipals;
  deploymentLayer?: DeploymentLayerRuntime;
  files: FileArtifactStore;
  approvals?: DurableMap<PendingApprovalRecord>;
  sessionStateBus?: SessionStateBus;
  ledgerEventBus?: LedgerEventBus;
  contextRequests: DurableMap<SurfaceContextRequest>;
  environments?: EnvironmentStore;
  processes?: ProcessRegistry;
  monitors?: MonitorStore;
  sandbox?: Sandbox;
  reaperPoke?: () => void;
  engaged?: EngagedRegistry;
  surfaceCache?: SurfaceCache;
  surfaces: SurfaceRegistry;
  channelPolicy?: ChannelPolicyStore;
  ambientJudge?: (systemPrompt: string, prompt: string, signal?: AbortSignal) => Promise<string | undefined>;
  ambientCursors?: DurableMap<{ lastJudgedTs: string; lastJudgedAt?: number }>;
  ambientJudgments?: AmbientJudgmentStore;
  errors?: ErrorLog;
  ackEmojiPicks?: AckEmojiPickStore;
  judgeModelId?: () => string;
  modelProviders?: ModelProviderAvailability;
  providerKeys?: ModelProviderAvailability;
  runtimeFallback?: RuntimeChoice;
}

export interface ContextSummary {
  scopeId: ScopeId;
  kind: "personal" | "channel" | "group";
  name: string | null;
  isPrivate?: boolean;
  sessionCount: number;
  lastActivityAt: number | null;
  project?: ProjectView;
  groupMembers?: Array<{ principalId: string; displayName: string; avatarUrl?: string }>;
}

interface FileListItem {
  id: string;
  ownerScopeId: ScopeId;
  name: string;
  mimetype: string;
  sizeBytes: number;
  direction: "in" | "out";
  createdAt: number;
  createdInScope?: ScopeId;
  openable: boolean;
}

export interface FileListPage {
  owned: FileListItem[];
  shared: FileListItem[];
  nextCursor?: string;
}

interface OpenedFile {
  name: string;
  mimetype: string;
  sizeBytes: number;
  stream: Readable;
}

export interface ScopeApp {
  id: string;
  name: string;
  status: PublishedApp["status"];
  permission: Permission;
  currentVersion: number;
}

interface ScopeSkill {
  id: string;
  name: string;
  description: string;
  status: Skill["status"];
}

interface ScopeResources {
  files: FileListItem[];
  webhooks: Webhook[];
  crons: Cron[];
  apps: ScopeApp[];
  skills: ScopeSkill[];
  manageable: boolean;
}

export function toFileItem(a: FileArtifact): FileListItem {
  return {
    id: a.id,
    ownerScopeId: a.ownerScopeId,
    name: a.name,
    mimetype: a.mimetype,
    sizeBytes: a.sizeBytes,
    direction: a.direction,
    createdAt: a.createdAt,
    ...(a.createdInScope ? { createdInScope: a.createdInScope } : {}),
    openable: a.blobKey != null,
  };
}

export class SoulUpdateDeniedError extends Error {
  constructor() {
    super("not authorized to update SOUL for this scope");
    this.name = "SoulUpdateDeniedError";
  }
}

export class SideChatAnchorError extends Error {
  constructor() {
    super("sideChat needs a nonempty quote and an entrySeq inside the forked range");
    this.name = "SideChatAnchorError";
  }
}

export class SoulVersionConflictError extends Error {
  constructor() {
    super("Guidance changed; read it and retry the edit.");
    this.name = "SoulVersionConflictError";
  }
}

export const CONTEXT_REQUEST_EXPIRY_MS = 2 * 60_000;

export const STALE_LEASE_GRACE_MS = 30_000;

interface SessionPageQuery {
  limit: number;
  before?: { activity: number; id: string };
  status?: SessionPageStatus;
  surface?: string;
  scopeId?: ScopeId;
  titleQuery?: string;
}

export type SessionPageStatus = "active" | "archived" | "waiting";

interface SessionPageResult {
  sessions: Session[];
  pinned?: Session[];
  next: { activity: number; id: string } | null;
  hasArchived?: boolean;
}
