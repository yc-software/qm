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
  artifactDigest: string;
  policy: FinnyPolicySnapshot;
  originThreadRef: string;
  provisionalRevision: string;
  approval?: FinnyApproval;
  ledgerHead: number;
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
