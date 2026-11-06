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
  FinnyPolicySnapshot,
  FinnyVerdict,
} from "./types.ts";

export interface CreateFinnyJobInput {
  id: string;
  scopeId: string;
  planDigest: string;
  artifactDigest?: string;
  policy: FinnyPolicySnapshot;
  findingPolicy: FinnyFindingPolicy;
  originThreadRef: string;
  provisionalRevision?: string;
}

export interface RecordFinnyApprovalInput {
  scopeId: string;
  jobId: string;
  requestId: string;
  actorId: string;
  action: FinnyApprovalAction;
  planDigest: string;
  originThreadRef: string;
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

export interface FinnyStore {
  createJob(input: CreateFinnyJobInput): Promise<FinnyJob>;
  getJob(scopeId: string, jobId: string): Promise<FinnyJob | null>;
  recordApproval(input: RecordFinnyApprovalInput): Promise<FinnyJob>;
  recordAttestation(input: RecordFinnyAttestationInput): Promise<{ attestation: FinnyAttestation; deduped: boolean }>;
  recordArtifactReady(input: RecordFinnyArtifactReadyInput): Promise<FinnyEventResult<FinnyJobEvent<"artifact_ready">>>;
  recordAuditPassed(input: RecordFinnyAuditPassedInput): Promise<FinnyEventResult<FinnyJobEvent<"audit_passed">>>;
  recordAuditBlock(input: RecordFinnyAuditBlockInput): Promise<FinnyEventResult>;
  listEvents(scopeId: string, jobId: string, afterSequence?: number): Promise<FinnyJobEvent[]>;
  finalize(input: FinalizeFinnyInput, sign: FinnyReceiptSigner): Promise<FinnyFinalReceipt>;
}
