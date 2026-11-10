import type {
  FinnyApprovalAction,
  FinnyAttestation,
  FinnyAuditFinding,
  FinnyChangeKind,
  FinnyCheckId,
  FinnyClarificationDecision,
  FinnyClarificationOption,
  FinnyClarificationRequest,
  FinnyDeterministicEvidenceAuthority,
  FinnyJob,
  FinnyJobEvent,
  FinnyFindingPolicy,
  FinnyEvaluatorRef,
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

export interface FinnyApprovalRequest {
  requestId: string;
  scopeId: string;
  jobId: string;
  planDigest: string;
  originThreadRef: string;
  authorizedActorId: string;
  readyAt?: number;
  decidedAt?: number;
  job: FinnyJob;
}

export interface CreateFinnyClarificationRequestInput {
  scopeId: string;
  jobId: string;
  requestId: string;
  authorizedActorId: string;
  question: string;
  options: FinnyClarificationOption[];
  recommendedOptionId: string;
  idempotencyKey: string;
}

export interface FinnyClarificationDecisionResult {
  request: FinnyClarificationRequest;
  approvalReady: boolean;
  revisionRequired: boolean;
}

export interface RecordFinnyClarificationDecisionInput {
  requestId: string;
  actorId: string;
  originThreadRef: string;
  decision: FinnyClarificationDecision;
  decidedAt: number;
}

export interface RecordFinnyApprovalInput {
  scopeId: string;
  jobId: string;
  requestId: string;
  actorId: string;
  action: FinnyApprovalAction;
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
  deterministicAuthority?: FinnyDeterministicEvidenceAuthority;
  idempotencyKey: string;
}

export interface RecordFinnyAuditBlockInput {
  scopeId: string;
  jobId: string;
  checkId: FinnyCheckId;
  generation: number;
  artifactDigest: string;
  evidenceDigest: string;
  issuerPrincipalId: string;
  issuerRunId: string;
  deterministicAuthority?: FinnyDeterministicEvidenceAuthority;
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
  issuerPrincipalId: string;
  issuerRunId: string;
  deterministicAuthority?: FinnyDeterministicEvidenceAuthority;
  idempotencyKey: string;
}

export interface FinnyEventResult<T extends FinnyJobEvent = FinnyJobEvent> {
  events: T[];
  job: FinnyJob;
  deduped: boolean;
}

export interface RecordFinnyEvaluatorCorrectionInput {
  scopeId: string;
  jobId: string;
  fromEvaluator: FinnyEvaluatorRef;
  toEvaluator: FinnyEvaluatorRef;
  idempotencyKey: string;
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
  createClarificationRequest(input: CreateFinnyClarificationRequestInput): Promise<FinnyClarificationRequest>;
  getJob(scopeId: string, jobId: string): Promise<FinnyJob | null>;
  getApprovalRequest(requestId: string): Promise<FinnyApprovalRequest | null>;
  getClarificationRequest(requestId: string): Promise<FinnyClarificationRequest | null>;
  claimWorkerRun(input: ClaimFinnyWorkerRunInput): Promise<void>;
  recordApproval(input: RecordFinnyApprovalInput): Promise<FinnyJob>;
  recordClarificationDecision(input: RecordFinnyClarificationDecisionInput): Promise<FinnyClarificationDecisionResult>;
  recordAttestation(input: RecordFinnyAttestationInput): Promise<{ attestation: FinnyAttestation; deduped: boolean }>;
  recordArtifactReady(input: RecordFinnyArtifactReadyInput): Promise<FinnyEventResult<FinnyJobEvent<"artifact_ready">>>;
  recordAuditPassed(input: RecordFinnyAuditPassedInput): Promise<FinnyEventResult<FinnyJobEvent<"audit_passed">>>;
  recordAuditBlock(input: RecordFinnyAuditBlockInput): Promise<FinnyEventResult>;
  evaluatorCorrectionCandidates(approvedEvaluator: FinnyEvaluatorRef): Promise<FinnyJob[]>;
  recordEvaluatorCorrection(input: RecordFinnyEvaluatorCorrectionInput): Promise<FinnyEventResult>;
  listEvents(scopeId: string, jobId: string, afterSequence?: number): Promise<FinnyJobEvent[]>;
  finalize(input: FinalizeFinnyInput, sign: FinnyReceiptSigner): Promise<FinnyFinalReceipt>;
}
