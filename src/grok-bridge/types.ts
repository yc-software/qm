import type { RecipientConsent, ScopeId } from "../types.ts";
import { GROK_BRIDGE_PROTOCOL } from "./crypto.ts";

export type PairingStatus = "pending_consent" | "awaiting_inbound" | "paired" | "degraded" | "revoked";

export type JobStatus =
  | "queued"
  | "dispatched"
  | "accepted"
  | "running"
  | "succeeded"
  | "failed"
  | "needs_owner_approval"
  | "needs_human_on_computer"
  | "expired";

export const JOB_EVENT_STATUSES = [
  "accepted",
  "running",
  "succeeded",
  "failed",
  "needs_owner_approval",
  "needs_human_on_computer",
] as const satisfies readonly JobStatus[];

export type JobEventStatus = (typeof JOB_EVENT_STATUSES)[number];

export const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set(["succeeded", "failed", "expired"]);
export const IN_FLIGHT_JOB_STATUSES: ReadonlySet<JobStatus> = new Set([
  "queued",
  "dispatched",
  "accepted",
  "running",
  "needs_owner_approval",
  "needs_human_on_computer",
]);

export interface GrokPairing {
  id: string;
  agentName: string;
  ownerPrincipalId: string;
  grokDisplayName: string;
  grokBotId?: string;
  inboundRef?: string;
  skillRevision: string;
  consent: RecipientConsent;
  status: PairingStatus;
  originScopeId: ScopeId;
  createdAt: number;
  updatedAt: number;
}

export interface PendingGrokEvent {
  seq: number;
  status: JobEventStatus;
  summary: string;
}

export interface GrokJob {
  id: string;
  pairingId: string;
  originSessionId: string;
  originActorId: string;
  instruction: string;
  callbackTokenHash: string;
  seqWatermark: number;
  status: JobStatus;
  summary?: string;
  pendingEvents: PendingGrokEvent[];
  callbackBaseUrl: string;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface PairingView {
  id: string;
  agentName: string;
  ownerPrincipalId: string;
  grokDisplayName: string;
  grokBotId?: string;
  skillRevision: string;
  consent: RecipientConsent;
  status: PairingStatus;
  originScopeId: ScopeId;
}

export interface JobView {
  id: string;
  pairingId: string;
  agentName: string;
  originSessionId: string;
  originActorId: string;
  instruction: string;
  status: JobStatus;
  seqWatermark: number;
  summary?: string;
  expiresAt: number;
}

export interface InboundCreds {
  webhookUrl: string;
  webhookKey: string;
  grokBotId?: string;
}

export interface JobEnvelope {
  protocol: typeof GROK_BRIDGE_PROTOCOL;
  job_id: string;
  qm_agent: string;
  qm_session_id: string;
  instruction: string;
  callback_url: string;
  callback_token: string;
  reply_required: true;
  expires_at: string;
  approval_policy: "owner-must-approve-side-effects";
}

export interface EventEnvelope {
  protocol: typeof GROK_BRIDGE_PROTOCOL;
  job_id: string;
  seq: number;
  status: JobEventStatus;
  summary: string;
  artifacts: unknown[];
}

export interface PairingStore {
  create(pairing: GrokPairing): Promise<GrokPairing>;
  get(id: string): Promise<GrokPairing | null>;
  list(): Promise<GrokPairing[]>;
  save(pairing: GrokPairing): Promise<GrokPairing>;
  findActive(ownerPrincipalId: string, agentName: string): Promise<GrokPairing | null>;
}

export interface JobStore {
  create(job: GrokJob): Promise<GrokJob>;
  get(id: string): Promise<GrokJob | null>;
  save(job: GrokJob): Promise<GrokJob>;
  listByPairing(pairingId: string): Promise<GrokJob[]>;
}

export interface SessionAccess {
  canRead(sessionId: string, actorId: string): Promise<boolean>;
  ownerIsMember(sessionId: string, ownerId: string): Promise<boolean>;
}

export interface OutboundPort {
  postJob(url: string, bearer: string, envelope: JobEnvelope): Promise<{ ok: boolean; status: number }>;
}

export interface SecretVault {
  put(id: string, value: { url: string; bearer: string }): Promise<void>;
  get(id: string): Promise<{ url: string; bearer: string } | null>;
  delete(id: string): Promise<void>;
}

export interface ProjectorPort {
  project(job: GrokJob, pairing: GrokPairing, event: PendingGrokEvent): Promise<void>;
}

export interface ProvisionerPort {
  skillFor(pairing: Pick<PairingView, "agentName" | "grokDisplayName">): string;
}

export interface RequestPairing {
  agentName: string;
  ownerPrincipalId: string;
  actorId: string;
  actorType: "internal" | "guest";
  originScopeId: ScopeId;
}

export interface DispatchJob {
  agentName: string;
  ownerPrincipalId: string;
  originSessionId: string;
  originActorId: string;
  actorType: "internal" | "guest";
  instruction: string;
  callbackBaseUrl: string;
}

export interface GrokBridge {
  requestPairing(input: RequestPairing): Promise<PairingView>;
  decidePairing(id: string, ownerId: string, decision: "accept" | "decline"): Promise<PairingView>;
  completeInbound(id: string, ownerId: string, inbound: InboundCreds): Promise<PairingView>;
  revoke(id: string, actorId: string): Promise<void>;
  dispatch(input: DispatchJob): Promise<JobView>;
  ingest(jobId: string, raw: unknown, authorizationHeader: string | undefined): Promise<{ duplicate: boolean }>;
  getJob(jobId: string, viewerId: string): Promise<JobView>;
}

export interface GrokBridgeDeps {
  pairings: PairingStore;
  jobs: JobStore;
  secrets: SecretVault;
  sessions: SessionAccess;
  outbound: OutboundPort;
  projector: ProjectorPort;
  now?: () => number;
  id?: () => string;
  mintToken?: () => string;
}

export class GrokBridgeError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "GrokBridgeError";
    this.code = code;
    this.status = status;
  }
}
