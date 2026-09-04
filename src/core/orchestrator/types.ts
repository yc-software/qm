import type {
  CommandApprovalGrant,
  Conversation,
  Principal,
  PendingApprovalRecord,
  SurfaceContextQuery,
  SurfaceContextResult,
  TurnRequest,
  TurnResult,
} from "../../types.ts";
import type { TurnOrigin } from "../turn-origin.ts";
import type { IdentityService } from "../../identity/identity-service.ts";
import type { ResolutionService } from "../../resolution/resolution-service.ts";
import type { OrgBranding, ScopedConfigStore } from "../../resolution/config-store.ts";
import type { UserModelCredentialStore } from "../../model/user-model-credential-store.ts";
import type { ManagedGroupDirectory } from "../../resolution/scope-membership.ts";
import type { DirectoryStore } from "../../directory/directory-store.ts";
import type { EnvironmentStore } from "../../environments/environment-store.ts";
import type { SessionStore } from "../../sessions/session-store.ts";
import type { DeliveryStore } from "../../delivery/delivery-store.ts";
import type { WorkspaceStore } from "../../workspace/workspace-store.ts";
import type { Sandbox } from "../../sandbox/sandbox.ts";
import type { ProcessRegistry } from "../../processes/process-registry.ts";
import type { MonitorStore } from "../../monitors/monitor-store.ts";
import type { CronStore } from "../../cron/cron-store.ts";
import type { WebhookStore } from "../../webhooks/webhook-store.ts";
import type { ConnectorTokenStore, Keychain, ServiceCredentialStore } from "../../credentials/keychain.ts";
import type { DeviceFlowCutoverStore } from "../../credentials/device-flow-cutover.ts";
import type { CredentialUsageSink } from "../../admin/credential-usage-sink.ts";
import type { LivenessCache } from "../../credentials/resident-auth.ts";
import type { ConnectorStatusCache } from "../../credentials/connector-status.ts";
import type { ModelGateway } from "../../model/model-gateway.ts";
import type { AuditLog } from "../../audit/audit-log.ts";
import type { SecurityScreener } from "../../security/security-screener.ts";
import type { RateLimiter } from "../../ratelimit/rate-limiter.ts";
import type { BudgetTracker } from "../../ratelimit/budget.ts";
import type { AwsRoleBroker } from "../../auth/aws-role-broker.ts";
import type { ControlService } from "../../api/control-service.ts";
import type { Harness } from "../../harness/harness.ts";
import type { AdminService } from "../../admin/admin-service.ts";
import type { ErrorLog } from "../../admin/error-log.ts";
import type { MetricsSink } from "../../admin/metrics-sink.ts";
import type { ToolLedger } from "../../runs/tool-ledger.ts";
import type { TurnStream } from "../../runs/turn-stream.ts";
import type { RunActivityStore } from "../../runs/run-activity-store.ts";
import type { RunStore } from "../../runs/run-store.ts";
import type { TaskStore } from "../../tasks/task-store.ts";
import type { MemoryService } from "../../memory/memory-service.ts";
import type { McpToolService } from "../../mcp/mcp-tool-service.ts";
import type { MemoryStrategy } from "../../memory/strategy.ts";
import type { MemoryPolicy } from "../../memory/policy.ts";
import type { DurableMap } from "../../persistence/durable-map.ts";
import type { BlobTransferStore } from "../../persistence/blob-transfer.ts";
import type { AdvisoryLock } from "../../persistence/advisory-lock.ts";
import type { SkillStore } from "../../skills/skill-store.ts";
import type { OAuthClientResolver } from "../../connectors/oauth.ts";
import type { SkillBundleStore } from "../../skills/skill-bundle-store.ts";
import type { BrokeredLayerTool, DeploymentLayerRuntime } from "../../deployment/load-layer.ts";
import type { FileArtifactStore } from "../../files/file-artifact-store.ts";
import type { DeployService } from "../../deploy/deploy-service.ts";
import type { AclStore } from "../../acl/acl-store.ts";
import type { ChannelPolicyStore } from "../../surface-cache/channel-policy-store.ts";
import type { SurfaceCache } from "../../surface-cache/types.ts";

export interface OrchestratorInput extends Omit<
  TurnRequest,
  | "surface"
  | "actor"
  | "conversation"
  | "idempotencyKey"
  | "spawned"
  | "async"
  | "triggerTs"
  | "entryTs"
  | "triggered"
  | "securityScreenData"
  | "triggerDestination"
  | "ownerKeychainUnion"
  | "unprompted"
  | "liveActor"
> {
  surface?: string;
  actor: Principal;
  conversation: Conversation;
  origin: TurnOrigin;
  runId?: string;
  attempt?: number;
  finalAttempt?: boolean;
  background?: boolean;
  cancel?: AbortSignal;
  queueMs?: number;
  sessionParticipantIds?: readonly string[];
  scopeVersion?: string;
}

export interface OrchestratorDeps {
  identity: IdentityService;
  resolution: ResolutionService;
  config?: ScopedConfigStore;
  /** The deployment's fallback harness (wiring's config.harness) — used when no org runtime selection exists. */
  defaultHarness?: string;
  userModelCredentials?: UserModelCredentialStore;
  brandingDefault?: OrgBranding;
  resolveBaseModelId?: () => string | undefined;
  sessionTapeMode?: "shadow" | "serve";
  sessions: SessionStore;
  workspace: WorkspaceStore;
  files: FileArtifactStore;
  sandbox: Sandbox;
  modelGateway: ModelGateway;
  auditLog: AuditLog;
  rateLimiter: RateLimiter;
  budget?: BudgetTracker;
  maxContextEntries?: number;
  maxContextTokens?: number;
  execTimeoutMs?: number;
  execTimeoutCeilingMs?: number;
  approvalSummaryTimeoutMs?: number;
  securityScreenTimeoutMs?: number;
  securityScreener?: SecurityScreener;
  backgroundJobTtlMs?: number;
  backgroundJobTtlMaxMs?: number;
  harness: Harness;
  signingSecret?: string;
  capabilitySecret?: string;
  apiBaseUrl?: string;
  publicWebUrl?: string;
  /** The public base for an inbound webhook URL (PUBLIC_WEB_URL ?? api url) — what the webhook
   *  tool hands the user to point the sender at; matches the HTTP webhook route's base exactly. */
  webhookPublicUrl?: string;
  deploy: DeployService;
  acl: AclStore;
  admin?: AdminService;
  memory: MemoryService;
  mcp?: McpToolService;
  memoryPolicy?: MemoryPolicy;
  memoryStrategy?: MemoryStrategy;
  skills?: SkillStore;
  skillBundles?: SkillBundleStore;
  skillsReady?: Promise<void>;
  advisoryLock?: AdvisoryLock;
  approvals?: DurableMap<PendingApprovalRecord>;
  approvalGrants?: DurableMap<CommandApprovalGrant>;
  errors?: ErrorLog;
  metrics?: MetricsSink;
  ledger?: ToolLedger;
  turnStream?: TurnStream;
  runActivity?: RunActivityStore;
  runs?: RunStore;
  tasks?: TaskStore;
  blobTransfer?: BlobTransferStore;
  processes?: ProcessRegistry;
  monitors?: MonitorStore;
  crons?: CronStore;
  webhooks?: WebhookStore;
  control?: ControlService;
  livenessCache?: LivenessCache;
  connectorTokens?: ConnectorTokenStore;
  connectorStatusCache?: ConnectorStatusCache;
  resolveConnectorClient?: OAuthClientResolver;
  scratchExec?: boolean;
  sharedOwnerAuthIsolation?: boolean;
  deviceFlowCutover?: DeviceFlowCutoverStore;
  credentialUsage?: CredentialUsageSink;
  keychain?: Keychain;
  serviceCreds?: ServiceCredentialStore;
  deliveries?: DeliveryStore;
  directory?: DirectoryStore;
  managedGroups?: Pick<ManagedGroupDirectory, "recognizes" | "members" | "version" | "withVersion" | "slackChannel">;
  reachExec?: boolean;
  eagerProvision?: boolean;
  environments?: EnvironmentStore;
  layerBrokerFor?: (tool: BrokeredLayerTool) => AwsRoleBroker | undefined;
  brokeredTools?: readonly BrokeredLayerTool[];
  deploymentLayer?: DeploymentLayerRuntime;
  surfaceContext?: SurfaceContextPuller;
  surfaceSearch?: SurfaceSearchStore;
  surfaceCache?: SurfaceCache;
  channelPolicy?: ChannelPolicyStore;
  surfaceDebugFooter?: boolean;
}

export interface SurfaceContextPuller {
  pull(source: string, query: SurfaceContextQuery): Promise<SurfaceContextResult | null>;
  searchLive?(source: string, query: SurfaceContextQuery): Promise<SurfaceContextResult | null>;
}

interface SurfaceSearchStore {
  search(query: SurfaceSearchQuery): Promise<SurfaceSearchStoreHit[]>;
}
interface SurfaceSearchQuery {
  surface: string;
  container: string;
  query: string;
  limit: number;
}
interface SurfaceSearchStoreHit {
  ref?: string;
  author?: string;
  when?: string;
  snippet: string;
}

export interface Orchestrator {
  handleTurn(input: OrchestratorInput): Promise<TurnResult>;
  screenSecuritySteer(input: {
    payload: string;
    actor: Principal;
    conversation: Conversation;
    sessionId?: string;
  }): Promise<"allow" | "block" | "unscreened">;
  regenerateTitle(
    sessionId: string,
    principalId: string,
    participantIds?: readonly string[],
  ): Promise<{ title: string | null } | null>;
}
