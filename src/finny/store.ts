import type {
  FinnyApprovalAction,
  FinnyAttestation,
  FinnyAuditFinding,
  FinnyChangeKind,
  FinnyCheckId,
  FinnyJob,
  FinnyJobEvent,
  FinnyFindingPolicy,
  FinnyFinalReceipt,
  FinnyFinalReceiptPayload,
  FinnyPlanPresentation,
  FinnyPolicySnapshot,
  FinnyVerdict,
  FinnyWorkerRole,
} from "./types.ts";

export interface CreateFinnyJobInput {
  id: string;
  scopeId: string;
  plan: FinnyPlanPresentation;
  policy: FinnyPolicySnapshot;
  findingPolicy: FinnyFindingPolicy;
  originThreadRef: string;
}

export interface CreateFinnyApprovalRequestInput {
  scopeId: string;
  jobId: string;
  requestId: string;
  authorizedActorId: string;
}

export interface RecordFinnyApprovalInput {
  scopeId: string;
  jobId: string;
  requestId: string;
  actorId: string;
  action: FinnyApprovalAction;
  decidedAt: number;
}

export interface RecordFinnyAttestationInput {
  id: string;
  scopeId: string;
  jobId: string;
  checkId: FinnyCheckId;
  generation: number;
  verdict: FinnyVerdict;
  evidenceDigest: string;
  artifactDigest: string;
  issuerPrincipalId: string;
  issuerRunId: string;
  idempotencyKey: string;
}

export interface RecordFinnyAuditBlockInput {
  scopeId: string;
  jobId: string;
  checkId: FinnyCheckId;
  generation: number;
  artifactDigest: string;
  findings: FinnyAuditFinding[];
  changeKinds: FinnyChangeKind[];
  resolution: { kind: "rework" } | { kind: "escalate"; reason: string };
  idempotencyKey: string;
}

export interface RecordFinnyArtifactReadyInput {
  scopeId: string;
  jobId: string;
  artifactDigest: string;
  provisionalRevision: string;
  idempotencyKey: string;
}

export interface RecordFinnyAuditPassedInput {
  scopeId: string;
  jobId: string;
  checkId: FinnyCheckId;
  generation: number;
  artifactDigest: string;
  evidenceDigest: string;
  idempotencyKey: string;
}

export interface FinnyEventResult<T extends FinnyJobEvent = FinnyJobEvent> {
  events: T[];
  job: FinnyJob;
  deduped: boolean;
}

export interface FinalizeFinnyInput {
  scopeId: string;
  jobId: string;
  idempotencyKey: string;
}

export type FinnyReceiptSigner = (payload: FinnyFinalReceiptPayload) => Promise<string>;

export interface ClaimFinnyWorkerRunInput {
  scopeId: string;
  jobId: string;
  runId: string;
  role: FinnyWorkerRole;
}

export interface FinnyStore {
  createJob(input: CreateFinnyJobInput): Promise<FinnyJob>;
  createApprovalRequest(input: CreateFinnyApprovalRequestInput): Promise<void>;
  getJob(scopeId: string, jobId: string): Promise<FinnyJob | null>;
  claimWorkerRun(input: ClaimFinnyWorkerRunInput): Promise<void>;
  recordApproval(input: RecordFinnyApprovalInput): Promise<FinnyJob>;
  recordAttestation(input: RecordFinnyAttestationInput): Promise<{ attestation: FinnyAttestation; deduped: boolean }>;
  recordArtifactReady(input: RecordFinnyArtifactReadyInput): Promise<FinnyEventResult<FinnyJobEvent<"artifact_ready">>>;
  recordAuditPassed(input: RecordFinnyAuditPassedInput): Promise<FinnyEventResult<FinnyJobEvent<"audit_passed">>>;
  recordAuditBlock(input: RecordFinnyAuditBlockInput): Promise<FinnyEventResult>;
  listEvents(scopeId: string, jobId: string, afterSequence?: number): Promise<FinnyJobEvent[]>;
  finalize(input: FinalizeFinnyInput, sign: FinnyReceiptSigner): Promise<FinnyFinalReceipt>;
}
