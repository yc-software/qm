import type {
  FinnyApprovalAction,
  FinnyAttestation,
  FinnyCheckId,
  FinnyJob,
  FinnyFinalReceipt,
  FinnyFinalReceiptPayload,
  FinnyPolicySnapshot,
  FinnyVerdict,
} from "./types.ts";

export interface CreateFinnyJobInput {
  id: string;
  scopeId: string;
  planDigest: string;
  artifactDigest: string;
  policy: FinnyPolicySnapshot;
  originThreadRef: string;
  provisionalRevision: string;
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
  issuerPrincipalId: string;
  issuerRunId: string;
  idempotencyKey: string;
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
  finalize(input: FinalizeFinnyInput, sign: FinnyReceiptSigner): Promise<FinnyFinalReceipt>;
}
