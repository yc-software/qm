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
  artifactDigest: string;
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
    findings: FinnyAuditFinding[];
    findingPolicy: FinnyFindingPolicy;
    changeKinds: FinnyChangeKind[];
  };
  audit_passed: {
    artifactDigest: string;
    checkId: FinnyCheckId;
    generation: number;
    evidenceDigest: string;
  };
  rework_requested: {
    blockedEventSequence: number;
    requiredGenerations: Record<FinnyCheckId, number>;
  };
  escalated: {
    blockedEventSequence: number;
    reason: string;
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
