import type { ResolvedSecurityPolicy } from "./security/security-posture.ts";

export type PrincipalType = "internal" | "guest";

export interface Principal {
  id: string;
  type: PrincipalType;
  teamIds?: string[];
  displayName?: string;
}

const SCOPE_KINDS = ["personal", "channel", "team", "org", "group"] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

export type ScopeId = string;

function isScopeKind(s: string): s is ScopeKind {
  return (SCOPE_KINDS as readonly string[]).includes(s);
}

export function scopeId(kind: ScopeKind, ref: string): ScopeId {
  return `${kind}:${ref}`;
}

export function personalScope(principalId: string): ScopeId {
  return scopeId("personal", principalId);
}

export function parseScopeId(id: ScopeId): { kind: ScopeKind | null; ref: string } {
  const sep = id.indexOf(":");
  if (sep < 0) return { kind: null, ref: "" };
  const raw = id.slice(0, sep);
  return { kind: isScopeKind(raw) ? raw : null, ref: id.slice(sep + 1) };
}

export function isManageableCreationScope(id: ScopeId | undefined): boolean {
  if (!id) return false;
  const { kind } = parseScopeId(id);
  return kind === "channel" || kind === "team";
}

export function isSharedScope(id: ScopeId | undefined): boolean {
  if (!id) return false;
  const { kind } = parseScopeId(id);
  return kind === "channel" || kind === "group";
}

export type ConversationKind = "dm" | "channel" | "group";

export interface Conversation {
  kind: ConversationKind;
  threadRef: string;
  channelRef?: string;
  channelName?: string;
  audience: Principal[];
  isPrivate?: boolean;
  isMpim?: boolean;
  publishMembers?: Principal[];
}

export type SessionType = "dm" | "channel" | "group";

export interface Session {
  id: string;
  type: SessionType;
  scopeId: ScopeId;
  threadRef: string;
  surface?: string;
  createdAt: number;
  channelName?: string;
  title?: string | null;
  archived?: boolean;
  pinned?: boolean;
  color?: string;
  forkedFrom?: { sessionId: string; title?: string | null };
  forkBoundarySeq?: number;
  lastActivityAt?: number;
  hasEntries?: boolean;
  working?: boolean;
  awaitingInput?: boolean;
  backgroundJobs?: number;
  watches?: number;
  crons?: number;
}

export type EntryType =
  | "user"
  | "assistant"
  | "thinking"
  | "text"
  | "tool_call"
  | "tool_result"
  | "soul"
  | "system"
  | "delivery"
  | "approval_request"
  | "approval_resolved";

export interface SessionEntry {
  sessionId: string;
  seq: number;
  parentSeq: number | null;
  type: EntryType;
  payload: unknown;
  scopeLabel: ScopeId;
  createdAt: number;
}

type LayerMode = "ro" | "rw";

export interface WorkspaceLayer {
  scopeId: ScopeId;
  mountPath: string;
  mode: LayerMode;
}

export interface Resolution {
  layers: WorkspaceLayer[];
  systemPrompt: string;
  egress: EgressPolicy;
  commandPolicy: CommandPolicy;
  securityPolicy: ResolvedSecurityPolicy;
  approvalGrantModes: ApprovalGrantModes;
  orgScopeId: ScopeId;
  grantedHandles: GrantedHandle[];
}

export type Permission = "read" | "write";

export interface Grant {
  ownerScopeId: ScopeId;
  ref: string;
  granteeScopeId: ScopeId;
  permission: Permission;
  grantedBy: string;
}

export interface GrantedHandle {
  handlePath: string;
  ownerScopeId: ScopeId;
  ownerPath: string;
  permission: Permission;
}

export interface RecipientConsent {
  recipientId: string;
  status: "pending" | "accepted" | "declined";
  decidedAt?: number;
}

export interface TriggerBase {
  id: string;
  ownerScopeId: ScopeId;
  owner: string;
  createdBy: string;
  ownerConsentedAt?: number;
  destination?: Destination;
  enabled: boolean;
  createdAt: number;
  lastFiredAt?: number;
  recipientConsent?: RecipientConsent;
}

export interface Destination {
  type: string;
  target: string;
  audienceScopeId?: ScopeId;
  onBehalfOf?: string;
  threadTs?: string;
  editRef?: string;
  taskList?: Array<{
    id: string;
    title: string;
    status: "pending" | "in_progress" | "completed" | "skipped" | "failed";
  }>;
  unfurlLinks?: boolean;
  react?: { messageTs: string; emoji: string };
  delete?: { messageTs: string };
  identity?: string;
  debugFooter?: string;
}

export interface CandidateDestination extends Destination {
  key: string;
  label: string;
}

export type BackgroundWakeTrigger = "cron" | "webhook" | "monitor" | (string & {});

export interface DeliveryProvenance {
  trigger: BackgroundWakeTrigger;
  surface: string;
  fireKey: string;
  sourceScopeId: ScopeId;
  sourceThreadRef: string;
  sourceSessionId?: string;
  sourceUserSeq?: number;
  sourceAssistantEntrySeq?: number;
}

export interface CronSchedule {
  cron?: string;
  timezone?: string;
  everyMs?: number;
  firstFireAt?: number;
}

export interface CronFireLogEntry {
  fireKey: string;
  threadRef: string;
  firedAt: number;
  scheduledAt?: number;
  status?: TurnResult["status"];
  note?: string;
  reply?: string;
  sessionId?: string;
}

export interface Cron extends TriggerBase {
  schedule: CronSchedule;
  nextFireAt?: number;
  lastAttemptAt?: number;
  title?: string;
  archived?: boolean;
  action?: string;
  message?: string;
  createdAt: number;
  runAs?: "owner" | "scopeFloor" | "scopeShared";
  members?: Principal[];
  unattendedGrants?: string[];
  fireLog?: CronFireLogEntry[];
}

interface WebhookVerification {
  scheme: "hmac-sha256" | "github" | "slack" | "stripe";
  secret?: string;
}

interface WebhookFilter {
  path: string;
  in: string[];
}

export interface Webhook extends TriggerBase {
  action: string;
  verification: WebhookVerification;
  filters?: WebhookFilter[];
  lastDeliveryId?: string;
  lastError?: string;
}

export interface Monitor extends TriggerBase {
  processId: string;
  command: string;
  threadRef: string;
  instructions?: string;
  pattern?: string;
  cursor: number;
  tail?: string;
  expiresAt: number;
  lastError?: string;
}

export interface Delivery {
  id: string;
  destination: Destination;
  text: string;
  attachments?: OutgoingAttachment[];
  provenance?: DeliveryProvenance;
  idempotencyKey: string;
  createdAt: number;
  deliveredAt: number | null;
  shadow?: boolean;
  recipientThreadRef?: string;
  deliverLatencyMs?: number;
  slackApiMs?: number;
}

export interface SurfaceContextQuery {
  conversationTarget?: string;
  channelId?: string;
  channelName?: string;
  count: number;
  viewer?: string;
  before?: string;
  match?: string;
  searchAll?: string;
  viewerToken?: string;
  file?: { ts: string; threadTs?: string; name?: string };
  openGroup?: { participants: string[] };
  syncDirectory?: boolean;
}

export interface SurfaceContextResult {
  messages: unknown[];
  hasMore?: boolean;
  nextBefore?: string;
  note?: string;
  file?: { blobId: string; name: string; mimetype?: string; sizeBytes: number; author?: string };
  group?: { groupId: string };
}

export interface SurfaceContextRequest {
  id: string;
  source: string;
  createdAt: number;
  status: "pending" | "done" | "failed";
  query: SurfaceContextQuery;
  result?: SurfaceContextResult;
  error?: string;
}

export interface EgressPolicy {
  allowedHosts: string[];
  denyPrivateNetworks?: boolean;
  privateNetworkAllowedHosts?: string[];
  deniedHosts?: string[];
}

export type CommandDecision = "allow" | "deny" | "require_approval";

export interface CommandRule {
  pattern: string;
  decision: CommandDecision;
  reason?: string;
}

type CommandPolicyMode = "denylist" | "allowlist";

export interface CommandPolicy {
  mode: CommandPolicyMode;
  rules: CommandRule[];
}

interface BlobAttachment {
  name: string;
  mimetype: string;
  sizeBytes: number;
  blobId: string;
}

export type IncomingAttachment = BlobAttachment & {
  sourceId?: string;
  author?: string;
};

export type OutgoingAttachment = BlobAttachment & {
  artifactId?: string;
  artifactViewerId?: string;
};

export interface AttachmentMeta {
  name: string;
  mimetype: string;
  sizeBytes: number;
  direction: "in" | "out";
  author?: string;
  artifactId?: string;
}

export interface GatewayContext {
  location?: string;
  details?: Record<string, string>;
  instructions?: string;
  reactionGuidance?: string;
  botHandle?: string;
}

export interface ConversationTurn {
  role: "user" | "assistant";
  name?: string;
  text: string;
}

export interface OverheardMessage {
  ts: string;
  role: "user" | "self";
  name?: string;
  text: string;
  files?: string[];
  mentions?: Record<string, string>;
}

export type TurnOrigin =
  | { kind: "human"; messageTs?: string; entryTs?: string }
  | { kind: "ambient"; entryTs?: string; live?: boolean }
  | { kind: "automation"; screenData?: string; destination?: Destination; useOwnerKeychain?: boolean }
  | { kind: "direct" };

export interface TurnRequest {
  surface: string;
  scopeVersion?: string;
  deliveryTarget?: string;
  deliveryCandidates?: { target: string; label: string }[];
  actor: ActorAssertion;
  conversation: {
    kind: ConversationKind;
    threadRef: string;
    channelRef?: string;
    channelName?: string;
    audience?: ActorAssertion[];
    isPrivate?: boolean;
    isMpim?: boolean;
    publishMembers?: ActorAssertion[];
  };
  text: string;
  origin?: TurnOrigin;
  triggerTs?: string;
  entryTs?: string;
  gatewayContext?: GatewayContext;
  triggered?: boolean;
  unattendedGrants?: string[];
  securityScreenData?: string;
  triggerDestination?: Destination;
  ownerKeychainUnion?: boolean;
  unprompted?: boolean;
  liveActor?: boolean;
  botActor?: boolean;
  conversationHeader?: string;
  priorTurns?: ConversationTurn[];
  overheard?: OverheardMessage[];
  detectContext?: string;
  detectOpener?: string;
  attachments?: IncomingAttachment[];
  inboundNotes?: string[];
  model?: string;
  harness?: string;
  thinkingLevel?: string;
  fastMode?: boolean;
  readOnly?: boolean;
  skipMemory?: boolean;
  surfaceTools?: boolean;
  addressed?: boolean;
  envelopeWrapped?: boolean;
  displayText?: string;
  turnWallClockMs?: number;
  timezone?: string;
  intakePreambleMs?: number;
  clientSentAt?: number;
  approval?: { requestId: string; approved: boolean; scope?: ApprovalScope };
  proactiveOpener?: boolean;
  spawned?: boolean;
  idempotencyKey?: string;
  async?: boolean;
}

export interface ActorAssertion {
  externalId: string;
  isExternalGuest?: boolean;
  isBot?: boolean;
  teamIds?: string[];
  displayName?: string;
}

export interface PendingApproval {
  requestId: string;
  command: string;
  reason: string;
  matched?: string;
  purpose?: string;
  summary?: string;
  summaryDetail?: string;
  approvalKey?: string;
  grantModes?: ApprovalGrantModes;
  blocksInput?: boolean;
  kind?: "approval" | "input";
}

export interface PendingApprovalRecord {
  sessionId: string;
  command: string;
  createdAt?: number;
  reason?: string;
  matched?: string;
  purpose?: string;
  summary?: string;
  summaryDetail?: string;
  approvalKey?: string;
  grantModes?: ApprovalGrantModes;
  request?: TurnRequest;
  blocksInput?: boolean;
  kind?: "approval" | "input";
}

type ApprovalScope = "once" | "session" | "always";

export interface ApprovalGrantModes {
  session: boolean;
  always: boolean;
}

export interface CommandApprovalGrant {
  actorId: string;
  command: string;
  scope: Exclude<ApprovalScope, "once">;
  createdAt: number;
  sessionId?: string;
  approvalKey?: string;
}

export interface TurnResult {
  status: "ok" | "refused" | "failed" | "pending_approval" | "queued" | "silent" | "react";
  sessionId?: string;
  reply?: string;
  reactions?: string[];
  reason?: string;
  refusalKind?: "security_quarantine";
  adminUrl?: string;
  runId?: string;
  steered?: true;
  stopped?: boolean;
  pendingApprovals?: PendingApproval[];
  attachments?: OutgoingAttachment[];
  sourceUserSeq?: number;
  sourceAssistantEntrySeq?: number;
}
