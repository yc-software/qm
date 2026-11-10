export interface FinnyEvaluatorRef {
  readonly id: string;
  readonly revision: string;
  readonly buildDigest: string;
  readonly contractVersion: string;
  readonly configurationDigest: string;
}

export const FINNY_CHECK_IDS = [
  "source.completeness",
  "financial.reconcile",
  "formula.recalculate",
  "summary.crossfoot",
  "meaning.actionability",
  "artifact.integrity",
  "artifact.structure",
  "lineage.binding",
] as const;

export type FinnyCheckId = (typeof FINNY_CHECK_IDS)[number];

export const FINNY_CHANGE_KINDS = ["source_or_logic", "formula", "disclosure", "presentation", "lineage"] as const;

export type FinnyChangeKind = (typeof FINNY_CHANGE_KINDS)[number];

export interface FinnyPolicySnapshot {
  policyVersion: string;
  evaluator: FinnyEvaluatorRef;
  requiredGenerations: Record<FinnyCheckId, number>;
}

export const FINNY_APPROVAL_ACTIONS = ["approve", "reject", "request_change"] as const;
export type FinnyApprovalAction = (typeof FINNY_APPROVAL_ACTIONS)[number];

export const FINNY_VERDICTS = ["pass", "block"] as const;
export type FinnyVerdict = (typeof FINNY_VERDICTS)[number];

export interface FinnyApproval {
  requestId: string;
  actorId: string;
  action: FinnyApprovalAction;
  planDigest: string;
  originThreadRef: string;
  decidedAt: number;
  consumedAt?: number;
}

export interface FinnyJob {
  id: string;
  scopeId: string;
  plan: FinnyPlanPresentation;
  planDigest: string;
  artifactDigest?: string;
  policy: FinnyPolicySnapshot;
  findingPolicy?: FinnyFindingPolicy;
  originThreadRef: string;
  provisionalRevision?: string;
  approval?: FinnyApproval;
  ledgerHead: number;
  eventHead: number;
  pendingReworkSequence?: number;
  unresolvedEscalationSequence?: number;
  finalizationKey?: string;
  finalReceipt?: FinnyFinalReceipt;
  finalizedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface FinnyDeterministicEvidenceAuthority {
  evaluator: FinnyEvaluatorRef;
  reasonSchemaVersion: "finny.spreadsheet-worker.v2";
  reasonCode: string;
}

export interface FinnyAttestation {
  seq: number;
  id: string;
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
  createdAt: number;
}

export interface FinnyFinalReceiptPayload {
  aud: "finny.final.delivery";
  jobId: string;
  scopeId: string;
  planDigest: string;
  artifactDigest: string;
  policyVersion: string;
  evaluator: FinnyEvaluatorRef;
  requiredGenerations: Record<FinnyCheckId, number>;
  ledgerHead: number;
  approvalRequestId: string;
  approvalActorId: string;
  originThreadRef: string;
  provisionalRevision: string;
  issuedAt: number;
}

export interface FinnyFinalReceipt {
  token: string;
  payload: FinnyFinalReceiptPayload;
}

export type FinnyWorkerRole = "producer" | "auditor";

export interface FinnyWorkerGrantPayload {
  aud: "finny.worker";
  jti: string;
  scopeId: string;
  jobId: string;
  principalId: string;
  role: FinnyWorkerRole;
  runId: string;
  artifactDigest?: string;
  policyDigest: string;
  allowedChecks: FinnyCheckId[];
  issuedAt: number;
  expiresAt: number;
}

export interface FinnyWorkerGrant {
  token: string;
  payload: FinnyWorkerGrantPayload;
}

export const FINNY_JOB_EVENT_TYPES = [
  "artifact_ready",
  "audit_blocked",
  "audit_passed",
  "rework_requested",
  "escalated",
  "evaluator_revision_activated",
  "evidence_invalidated",
  "rework_cancelled",
  "verification_reopened",
] as const;

export type FinnyJobEventType = (typeof FINNY_JOB_EVENT_TYPES)[number];

export interface FinnyAuditFinding {
  code: string;
  message: string;
}

export interface FinnyFindingPolicy {
  id: string;
  maxFindings: number;
  maxCodeLength: number;
  maxMessageLength: number;
}

export interface FinnyJobEventPayloads {
  artifact_ready: {
    artifactDigest: string;
    provisionalRevision: string;
  };
  audit_blocked: {
    artifactDigest: string;
    checkId: FinnyCheckId;
    generation: number;
    evidenceDigest: string;
    issuerPrincipalId: string;
    issuerRunId: string;
    deterministicAuthority?: FinnyDeterministicEvidenceAuthority;
    findings: FinnyAuditFinding[];
    findingPolicy: FinnyFindingPolicy;
    changeKinds: FinnyChangeKind[];
  };
  audit_passed: {
    artifactDigest: string;
    checkId: FinnyCheckId;
    generation: number;
    evidenceDigest: string;
    issuerPrincipalId: string;
    issuerRunId: string;
    deterministicAuthority?: FinnyDeterministicEvidenceAuthority;
  };
  rework_requested: {
    blockedEventSequence: number;
    requiredGenerations: Record<FinnyCheckId, number>;
  };
  escalated: {
    blockedEventSequence: number;
    reason: string;
  };
  evaluator_revision_activated: {
    fromEvaluator: FinnyEvaluatorRef;
    toEvaluator: FinnyEvaluatorRef;
  };
  evidence_invalidated: {
    fromEvaluator: FinnyEvaluatorRef;
    toEvaluator: FinnyEvaluatorRef;
    checkIds: FinnyCheckId[];
    previousRequiredGenerations: Record<FinnyCheckId, number>;
    requiredGenerations: Record<FinnyCheckId, number>;
  };
  rework_cancelled: {
    reworkEventSequence: number;
    blockedEventSequence: number;
    checkId: FinnyCheckId;
  };
  verification_reopened: {
    evaluator: FinnyEvaluatorRef;
    previousRequiredGenerations: Record<FinnyCheckId, number>;
    requiredGenerations: Record<FinnyCheckId, number>;
  };
}

export type FinnyJobEvent<T extends FinnyJobEventType = FinnyJobEventType> = {
  [K in T]: {
    seq: number;
    id: string;
    jobId: string;
    type: K;
    payload: FinnyJobEventPayloads[K];
    idempotencyKey: string;
    createdAt: number;
  };
}[T];

export interface FinnyPlanPhase {
  name: string;
  owner: string;
  dependencies: string[];
}

export interface FinnyPlanClarification {
  question: string;
  answer: string;
}

export interface FinnyPlanPresentation {
  title: string;
  summary?: string;
  phases: FinnyPlanPhase[];
  certification: string;
  deliverable: string;
  destination: string;
  clarifications: FinnyPlanClarification[];
}

export interface FinnyClarificationOption {
  id: string;
  label: string;
  description?: string;
}

export interface FinnyMaterialClarification {
  question: string;
  options: FinnyClarificationOption[];
  recommendedOptionId: string;
}

export type FinnyClarificationDecision = { kind: "option"; optionId: string } | { kind: "other" };

export interface FinnyClarificationRequest {
  requestId: string;
  scopeId: string;
  jobId: string;
  question: string;
  options: FinnyClarificationOption[];
  recommendedOptionId: string;
  originThreadRef: string;
  authorizedActorId: string;
  idempotencyKey: string;
  decision?: FinnyClarificationDecision;
  decidedAt?: number;
  createdAt: number;
}
