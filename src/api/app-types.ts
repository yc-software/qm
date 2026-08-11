import type {
  Grant,
  PendingApproval,
  PendingApprovalRecord,
  Permission,
  ScopeId,
  Session,
  SessionEntry,
  TurnRequest,
  TurnResult,
} from "../types.ts";
import type { OutgoingAttachment } from "../types.ts";
import type { Readable } from "node:stream";
import { type FileArtifact, type FileArtifactStore, type ListOwnedOptions } from "../files/file-artifact-store.ts";
import type { IdentityService } from "../identity/identity-service.ts";
import type { SessionStore, TranscriptEntry } from "../sessions/session-store.ts";
import { type Sandbox } from "../sandbox/sandbox.ts";
import type { ProcessRegistry } from "../processes/process-registry.ts";
import type { MonitorStore } from "../monitors/monitor-store.ts";
import type { EngagedRegistry } from "../wake/engaged-registry.ts";
import type { Orchestrator } from "../core/orchestrator.ts";
import type { Run, RunDeliveryState, RunStore } from "../runs/run-store.ts";
import type { TurnStream } from "../runs/turn-stream.ts";
import type { SessionStateBus, SessionStateEvent } from "../runs/session-state-bus.ts";
import type { RunActivityEntry, RunActivityStore } from "../runs/run-activity-store.ts";
import type { RunSignal, RunSignalStore } from "../runs/run-signal-store.ts";
import type { TaskStore, TaskStatus } from "../tasks/task-store.ts";
import type { ModelGateway } from "../model/model-gateway.ts";
import type { ModelCredentialStore } from "../model/model-credential-store.ts";
import type { CustomProviderStore } from "../model/custom-provider-store.ts";
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
import type {
  Cron,
  Delivery,
  Destination,
  RecipientConsent,
  SurfaceContextQuery,
  SurfaceContextRequest,
  SurfaceContextResult,
} from "../types.ts";
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
import type { AmbientJudgmentStore } from "../surface-cache/ambient-judgment-store.ts";
import type { AckEmojiPickStore } from "../surface-cache/ack-emoji-pick-store.ts";
import type { Deployment } from "../deploy/deploy-store.ts";
import type { DeploymentLayerRuntime } from "../deployment/load-layer.ts";
import { type ArtifactHome, type ArtifactType } from "./artifact-share.ts";
import type {
  DeployService,
  DeployFile,
  DeployInput,
  Reach,
  ReachOptions,
  DeploymentGrantee,
} from "../deploy/deploy-service.ts";
import { type DurableMap } from "../persistence/durable-map.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import type { Environment, EnvironmentAttachment, EnvironmentStore } from "../environments/environment-store.ts";
import type { ModelProviderAvailability } from "../model/pi-models.ts";
import type { RuntimeChoice } from "../harness/harness-router.ts";
import { type ReachOpts, type ReachResolution, type ReachTarget } from "../reach/reach.ts";
import { type Project, type ProjectStore } from "../projects/project-store.ts";

interface DeploymentVersionView {
  version: number;
  createdAt: number;
  commit?: string;
  parentCommit?: string;
}

export interface DeploymentView {
  id: string;
  ownerScopeId: ScopeId;
  createdBy: string;
  createdInScope?: ScopeId;
  name?: string;
  displayName?: string;
  currentVersion: number;
  appliedVersion?: number;
  status: Deployment["status"];
  lastAccessAt?: number;
  createdAt?: number;
  updatedAt?: number;
  versions: DeploymentVersionView[];
}

export interface ViewerDeployment extends DeploymentView {
  permission: Permission;
}

export function deploymentView(d: Deployment): DeploymentView {
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
  currentDestination?: Destination;
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

export type ProjectView = Project & {
  scopeId: ScopeId;
  members: Array<{ principalId: string; displayName: string; viaChannel?: boolean }>;
};

type ProjectViewMutation =
  | { status: "ok"; project: ProjectView; changed: boolean }
  | { status: "not_found" | "forbidden" | "invalid_member" | "invalid_name" | "invalid_channel" | "channel_in_use" };

interface DeploymentGitUrl {
  url: string;
  permission: "read" | "write";
}

interface SessionBackgroundView {
  jobs: Array<{ processId: string; command: string; startedAt: number; expiresAt: number }>;
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
  crons: Array<{ id: string; title?: string; nextFireAt?: number }>;
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

export interface App {
  turn(req: TurnRequest): Promise<TurnResult>;
  getApproval(requestId: string, viewer?: string): Promise<(PendingApprovalRecord & { requestId: string }) | null>;
  subscribeSessionStates(cb: (event: SessionStateEvent) => void): () => void;
  listSessionApprovals(sessionId: string, viewer: string): Promise<PendingApproval[]>;
  pendingApprovalForThread(threadRef: string, viewer?: string): Promise<TurnResult | null>;
  getRun(
    runId: string,
    viewer?: string,
  ): Promise<{
    status: Run["status"];
    result: TurnResult | null;
    partial?: string;
    alive?: boolean;
    stale?: boolean;
    replying?: boolean;
    replyComplete?: boolean;
    firstBlock?: string;
    firstBlockClosed?: boolean;
    surfacePosted?: boolean;
    tasks?: Array<{ id: string; title: string; status: TaskStatus }>;
    activity?: RunActivityEntry[];
    startedAt: number | null;
    finishedAt: number | null;
  } | null>;
  activeRunForThread(
    threadRef: string,
    viewer?: string,
  ): Promise<{ runId: string; queued?: Array<{ runId: string; text: string }> } | null>;
  withdrawRun(runId: string, viewer?: string): Promise<{ withdrawn: boolean; reason?: string }>;
  signalRun(
    runId: string,
    signal: RunSignal,
    viewer?: string,
  ): Promise<{ accepted: boolean; reason?: string; replayed?: boolean }>;
  replayOrphanedRunSignals(runId: string): Promise<void>;
  getSession(
    sessionId: string,
    window?: TranscriptWindow,
  ): Promise<{ session: Session; entries: TranscriptEntry[]; earlierEntries?: number } | null>;
  getSessionForViewer(
    sessionId: string,
    principalId: string,
    window?: TranscriptWindow,
  ): Promise<{ session: Session; entries: TranscriptEntry[]; earlierEntries?: number } | null>;
  getSessionEntryForViewer(
    sessionId: string,
    principalId: string,
    seq: number,
  ): Promise<{ entry: SessionEntry } | null>;
  listSessions(principalId: string): Promise<Session[]>;
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
  updateSession(
    sessionId: string,
    principalId: string,
    patch: { title?: string | null; archived?: boolean; pinned?: boolean; color?: string | null },
  ): Promise<Session | null>;
  regenerateTitle(sessionId: string, principalId: string): Promise<{ title: string | null } | null>;
  spawnSession(principalId: string, opts: { scopeId: ScopeId; title?: string }): Promise<{ session: Session } | null>;
  discardSession(sessionId: string, principalId: string): Promise<boolean>;
  forkSession(
    sessionId: string,
    principalId: string,
    opts?: { upToSeq?: number },
  ): Promise<{ session: Session; entries: SessionEntry[] } | null>;
  listFilesForViewer(principalId: string, opts?: ListOwnedOptions, inScope?: ScopeId): Promise<FileListPage>;
  uploadFileForViewer(
    principalId: string,
    input: { scopeId?: ScopeId; name: string; mimetype?: string; data: AsyncIterable<Uint8Array> },
  ): Promise<FileListItem | null>;
  listScopeResources(principalId: string, scope: ScopeId): Promise<ScopeResources | null>;
  managesScope(principalId: string, scope: ScopeId): Promise<boolean>;
  membershipControlsScope(scope: ScopeId): Promise<boolean>;
  authorizesCapabilityScope(claims: Pick<CapabilityClaims, "actorId" | "scopeId" | "scopeVersion">): Promise<boolean>;
  openFileForViewer(id: string, principalId: string): Promise<OpenedFile | null>;
  grant(g: Grant): Promise<void>;
  revokeGrant(ownerScopeId: ScopeId, ref: string, granteeScopeId: ScopeId, revokedBy: string): Promise<void>;
  promoteSkill(id: string, targetScopeId: ScopeId, actorId: string, liveActor: boolean): Promise<Skill>;
  belongsToScope(principalId: string, scope: ScopeId): Promise<boolean>;
  canManageArtifactHome(homeScopeId: ScopeId, createdBy: string, principalId: string): Promise<boolean>;
  getArtifactHome(type: ArtifactType, idOrName: string): Promise<ArtifactHome | null>;
  moveArtifactHome(type: ArtifactType, id: string, toScope: ScopeId, movedBy: string): Promise<void>;
  getSoul(scopeId: ScopeId): {
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
    opts?: { allowSharedScope?: boolean },
  ): Promise<number>;
  createCron(input: CreateCronInput): Promise<Cron>;
  getCron(id: string): Promise<Cron | null>;
  listCrons(): Promise<Cron[]>;
  listCronsForViewer(principalId: string): Promise<{ owned: Cron[]; visible: VisibleCron[] }>;
  updateCron(id: string, patch: CronPatch): Promise<Cron | null>;
  deleteCron(id: string): Promise<void>;
  setCronEnabled(id: string, enabled: boolean): Promise<void>;
  setCronDestination(id: string, destination: Destination | undefined): Promise<Cron | null>;
  setCronRecipientConsent(id: string, recipientConsent: RecipientConsent): Promise<void>;
  pendingDeliveries(type: string, claimMs?: number): Promise<Delivery[]>;
  enqueueDelivery(input: { destination: Destination; text: string; idempotencyKey: string }): Promise<void>;
  createContextRequest(source: string, query: SurfaceContextQuery): Promise<SurfaceContextRequest>;
  getContextRequest(id: string): Promise<SurfaceContextRequest | null>;
  deleteContextRequest(id: string): Promise<void>;
  pendingContextRequests(source: string): Promise<SurfaceContextRequest[]>;
  fulfillContextRequest(id: string, outcome: { result?: SurfaceContextResult; error?: string }): Promise<boolean>;
  onContextRequestCreated(listener: (request: SurfaceContextRequest) => void): () => void;
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
  ackDeliveryByKey(idempotencyKey: string): Promise<void>;
  setRunDeliveryState(runId: string, state: RunDeliveryState): Promise<boolean>;
  upsertDirectory(members: DirectoryMember[], syncedAt?: number): Promise<void>;
  upsertChannels(channels: DirectoryChannel[], channelMembers?: ChannelMembership[], syncedAt?: number): Promise<void>;
  upsertGroups(groupMembers: GroupMembership[], syncedAt?: number): Promise<void>;
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
  channelMember(channelId: string, principalId: string): Promise<boolean>;
  channelVisibleTo(actorId: string, channelId: string, isPrivate?: boolean): Promise<boolean>;
  recordPrincipalDelivery(deliveryId: string, recipientThreadRef: string): Promise<void>;
  reachNow(input: ReachNowInput): Promise<ReachNowResult>;
  resolveReachTarget(target: ReachTarget, authorityId: string, opts?: ReachOpts): Promise<ReachResolution>;
  deploy(input: DeployInput): Promise<Deployment>;
  redeploy(
    id: string,
    input: { entrypoint: string; files: DeployFile[]; env?: Record<string, string> },
  ): Promise<Deployment>;
  listDeployments(): Promise<Deployment[]>;
  getDeployment(idOrName: string): Promise<Deployment | null>;
  listDeploymentsForViewer(principalId: string): Promise<ViewerDeployment[]>;
  effectiveDeploymentPermission(d: Deployment, principalId: string): Promise<Permission | null>;
  deploymentGitPermissionFor(idOrName: string, principalId: string): Promise<"read" | "write" | null>;
  listSkills(): Promise<Skill[]>;
  getSkill(id: string): Promise<Skill | null>;
  archiveSkill(id: string): Promise<Skill>;
  listVisibleSkills(principalId: string): Promise<SkillResolution[]>;
  canManageSkill(skill: Skill, principalId: string): Promise<boolean>;
  updateOwnedSkill(
    id: string,
    principalId: string,
    patch: { description?: string; body?: string },
    opts?: { liveActor?: boolean },
  ): Promise<Skill | "trigger_blocked" | null>;
  restoreOwnedSkill(id: string, principalId: string): Promise<Skill | null>;
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
  }): Promise<"missing" | "forbidden" | "trigger_blocked" | "deleted">;
  rollbackDeployment(id: string, version: number): Promise<void>;
  archiveDeployment(id: string): Promise<void>;
  restoreDeployment(id: string, actorId?: string): Promise<Deployment>;
  canManageDeployment(idOrName: string, callerId: string, actingScopeId?: ScopeId): Promise<boolean>;
  renameDeployment(id: string, name: string): Promise<Deployment>;
  setDeploymentDisplayName(id: string, displayName: string): Promise<Deployment>;
  reachDeployment(id: string, principalId: string, opts?: ReachOptions): Promise<Reach>;
  shareDeployment(
    idOrName: string,
    grantee: ScopeId,
    permission: Permission | null,
    actor: { createdBy: string },
  ): Promise<DeploymentGrantee[]>;
  deploymentGrantees(idOrName: string): Promise<DeploymentGrantee[]>;
  deploymentGitRepoPath(id: string): Promise<string | null>;
  runDeploymentGitPush<T>(id: string, runReceivePack: () => Promise<{ result: T; ok: boolean }>): Promise<T>;
  deploymentGitUrlFor(
    idOrName: string,
    principalId: string,
    opts: { secret: string; baseUrl: string; ttlMs?: number },
  ): Promise<DeploymentGitUrl | null>;
  authorizesDeploymentGitAccess(id: string, principalId: string, permission: "read" | "write"): Promise<boolean>;
  reapIdleDeployments(ttlMs: number, now?: number): Promise<number>;
  listEnvironments(): Promise<{ environment: Environment; attachments: EnvironmentAttachment[] }[]>;
  createEnvironment(input: { scopeId: ScopeId; name: string; actorId: string }): Promise<Environment>;
  resolveEnvironmentByName(name: string): Promise<Environment | null>;
  attachScope(input: { scopeId: ScopeId; environmentId: string; actorId: string }): Promise<void>;
}

export interface AppDeps {
  identity: IdentityService;
  publicWebUrl?: string;
  sessions: SessionStore;
  orchestrator: Orchestrator;
  runs: RunStore;
  leaseTtlMs: number;
  maxAttempts: number;
  runWaitMs?: number;
  turnStream?: TurnStream;
  runActivity?: RunActivityStore;
  signals?: RunSignalStore;
  tasks?: TaskStore;
  modelGateway: ModelGateway;
  modelCredentials?: ModelCredentialStore;
  mcpServers?: McpServerStore;
  mcpToolService?: McpToolService;
  modelCredentialFetch?: typeof fetch;
  customProviders?: CustomProviderStore;
  refreshCustomProviders?: () => Promise<void>;
  acl: AclStore;
  admin?: AdminService;
  skills: SkillStore;
  skillPacks?: SkillPackStore;
  skillFetcher?: SkillPackFetcher;
  skillBundles?: SkillBundleStore;
  advisoryLock?: AdvisoryLock;
  auditLog: AuditLog;
  config: ScopedConfigStore;
  crons: CronStore;
  deliveries: DeliveryStore;
  directory: DirectoryStore;
  projects?: ProjectStore;
  deploy: DeployService;
  deploymentLayer?: DeploymentLayerRuntime;
  files: FileArtifactStore;
  approvals?: DurableMap<PendingApprovalRecord>;
  sessionStateBus?: SessionStateBus;
  contextRequests?: DurableMap<SurfaceContextRequest>;
  environments?: EnvironmentStore;
  processes?: ProcessRegistry;
  monitors?: MonitorStore;
  sandbox?: Sandbox;
  reaperPoke?: () => void;
  engaged?: EngagedRegistry;
  surfaceCache?: SurfaceCache;
  channelPolicy?: ChannelPolicyStore;
  ambientJudge?: (systemPrompt: string, prompt: string) => Promise<string | undefined>;
  ambientCursors?: DurableMap<{ lastJudgedTs: string; lastJudgedAt?: number }>;
  ambientJudgments?: AmbientJudgmentStore;
  ackEmojiPicks?: AckEmojiPickStore;
  judgeModelId?: () => string;
  harnessId?: string;
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

export interface ScopeDeployment {
  id: string;
  name: string;
  status: Deployment["status"];
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
  crons: Cron[];
  deployments: ScopeDeployment[];
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

export const CONTEXT_REQUEST_EXPIRY_MS = 2 * 60_000;

export const STALE_LEASE_GRACE_MS = 30_000;
