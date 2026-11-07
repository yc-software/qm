import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import { assertFinnyAuditFindings, assertFinnyEscalationReason, assertFinnyFindingPolicy } from "./coordinator.ts";
import {
  assertFinnyMaterialClarificationMatchesPlan,
  canonicalFinnyPlanDigest,
  validateFinnyMaterialClarification,
  validateFinnyPlanPresentation,
} from "./plan.ts";
import {
  FINNY_DETERMINISTIC_CHECK_IDS,
  activateFinnyEvaluator,
  assertFinnyApprovedEvaluatorRef,
  assertFinnyDeterministicAuthority,
  assertFinnyEvaluatorRef,
  assertFinnyPolicy,
  reviseFinnyPolicy,
} from "./policy.ts";
import type {
  ClaimFinnyWorkerRunInput,
  CreateFinnyApprovalRequestInput,
  CreateFinnyClarificationRequestInput,
  CreateFinnyJobInput,
  FinalizeFinnyInput,
  FinnyApprovalRequest,
  FinnyReceiptSigner,
  FinnyStore,
  RecordFinnyApprovalInput,
  RecordFinnyClarificationDecisionInput,
  RecordFinnyArtifactReadyInput,
  RecordFinnyAuditBlockInput,
  RecordFinnyEvaluatorCorrectionInput,
  RecordFinnyAuditPassedInput,
  RecordFinnyAttestationInput,
} from "./store.ts";
import type {
  FinnyAttestation,
  FinnyCheckId,
  FinnyClarificationRequest,
  FinnyEvaluatorRef,
  FinnyFinalReceipt,
  FinnyFinalReceiptPayload,
  FinnyJob,
  FinnyJobEvent,
  FinnyJobEventPayloads,
  FinnyJobEventType,
  FinnyFindingPolicy,
  FinnyPlanPresentation,
  FinnyPolicySnapshot,
} from "./types.ts";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS finny_jobs(
    id TEXT PRIMARY KEY,
    scope_id TEXT NOT NULL CHECK (scope_id <> ''),
    plan_presentation JSONB NOT NULL CHECK (jsonb_typeof(plan_presentation) = 'object'),
    plan_digest TEXT NOT NULL CHECK (plan_digest <> ''),
    artifact_digest TEXT CHECK (artifact_digest IS NULL OR artifact_digest <> ''),
    policy_version TEXT NOT NULL CHECK (policy_version <> ''),
    required_generations JSONB NOT NULL CHECK (jsonb_typeof(required_generations) = 'object'),
    origin_thread_ref TEXT NOT NULL CHECK (origin_thread_ref <> ''),
    provisional_revision TEXT CHECK (provisional_revision IS NULL OR provisional_revision <> ''),
    approval_request_id TEXT,
    approval_actor_id TEXT,
    approval_action TEXT CHECK (approval_action IN ('approve', 'reject', 'request_change')),
    approval_plan_digest TEXT,
    approval_origin_thread_ref TEXT,
    approval_decided_at BIGINT,
    approval_consumed_at BIGINT,
    ledger_head BIGINT NOT NULL DEFAULT 0 CHECK (ledger_head >= 0),
    finalization_key TEXT,
    final_receipt JSONB,
    finalized_at BIGINT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS finny_jobs_finalization_key
    ON finny_jobs(finalization_key) WHERE finalization_key IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS finny_jobs_scope_created ON finny_jobs(scope_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS finny_attestations(
    seq BIGSERIAL PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    job_id TEXT NOT NULL REFERENCES finny_jobs(id) ON DELETE CASCADE,
    check_id TEXT NOT NULL CHECK (check_id <> ''),
    generation BIGINT NOT NULL CHECK (generation > 0),
    verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'block')),
    evidence_digest TEXT NOT NULL CHECK (evidence_digest <> ''),
    artifact_digest TEXT NOT NULL CHECK (artifact_digest <> ''),
    issuer_principal_id TEXT NOT NULL CHECK (issuer_principal_id <> ''),
    issuer_run_id TEXT NOT NULL CHECK (issuer_run_id <> ''),
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS finny_attestations_check_sequence
    ON finny_attestations(job_id, check_id, generation, seq DESC)`,
  `CREATE INDEX IF NOT EXISTS finny_attestations_job_sequence ON finny_attestations(job_id, seq)`,
];

const EVENT_SCHEMA = [
  `ALTER TABLE finny_jobs ALTER COLUMN artifact_digest DROP NOT NULL`,
  `ALTER TABLE finny_jobs ALTER COLUMN provisional_revision DROP NOT NULL`,
  `ALTER TABLE finny_jobs ADD CONSTRAINT finny_jobs_artifact_binding_pair
     CHECK ((artifact_digest IS NULL) = (provisional_revision IS NULL))`,
  `ALTER TABLE finny_jobs ADD COLUMN IF NOT EXISTS event_head BIGINT NOT NULL DEFAULT 0 CHECK (event_head >= 0)`,
  `ALTER TABLE finny_jobs ADD COLUMN IF NOT EXISTS pending_rework_seq BIGINT CHECK (pending_rework_seq > 0)`,
  `ALTER TABLE finny_jobs ADD COLUMN IF NOT EXISTS unresolved_escalation_seq BIGINT CHECK (unresolved_escalation_seq > 0)`,
  `ALTER TABLE finny_jobs ADD COLUMN IF NOT EXISTS finding_policy JSONB CHECK (finding_policy IS NULL OR jsonb_typeof(finding_policy) = 'object')`,
  `CREATE TABLE IF NOT EXISTS finny_job_events(
    seq BIGSERIAL PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    job_id TEXT NOT NULL REFERENCES finny_jobs(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL CHECK (event_type IN ('artifact_ready','audit_blocked','audit_passed','rework_requested','escalated')),
    payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    idempotency_key TEXT NOT NULL,
    event_index INTEGER NOT NULL CHECK (event_index >= 0),
    created_at BIGINT NOT NULL,
    UNIQUE(idempotency_key, event_index)
  )`,
  `CREATE INDEX IF NOT EXISTS finny_job_events_job_sequence ON finny_job_events(job_id, seq)`,
];

const PLAN_FIRST_SCHEMA = [
  `ALTER TABLE finny_jobs ADD COLUMN IF NOT EXISTS plan_presentation JSONB`,
  `ALTER TABLE finny_jobs ALTER COLUMN plan_presentation SET NOT NULL`,
  `ALTER TABLE finny_jobs ADD CONSTRAINT finny_jobs_plan_presentation_object
     CHECK (jsonb_typeof(plan_presentation) = 'object')`,
  `ALTER TABLE finny_jobs ALTER COLUMN artifact_digest DROP NOT NULL`,
  `ALTER TABLE finny_jobs ALTER COLUMN provisional_revision DROP NOT NULL`,
  `CREATE TABLE IF NOT EXISTS finny_approval_requests(
    request_id TEXT PRIMARY KEY,
    scope_id TEXT NOT NULL CHECK (scope_id <> ''),
    job_id TEXT NOT NULL REFERENCES finny_jobs(id) ON DELETE CASCADE,
    plan_digest TEXT NOT NULL CHECK (plan_digest <> ''),
    origin_thread_ref TEXT NOT NULL CHECK (origin_thread_ref <> ''),
    authorized_actor_id TEXT NOT NULL CHECK (authorized_actor_id <> ''),
    decided_at BIGINT,
    created_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS finny_approval_requests_job ON finny_approval_requests(job_id)`,
  `CREATE TABLE IF NOT EXISTS finny_worker_runs(
    job_id TEXT NOT NULL REFERENCES finny_jobs(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('producer','auditor')),
    created_at BIGINT NOT NULL,
    PRIMARY KEY(job_id, run_id)
  )`,
];

const FINNY_REQUEST_ID_MAX = 2_000;

const CLARIFICATION_SCHEMA = [
  `CREATE UNIQUE INDEX IF NOT EXISTS finny_approval_requests_one_pending_job
     ON finny_approval_requests(job_id) WHERE decided_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS finny_clarification_requests(
    request_id TEXT PRIMARY KEY,
    scope_id TEXT NOT NULL CHECK (scope_id <> ''),
    job_id TEXT NOT NULL REFERENCES finny_jobs(id) ON DELETE CASCADE,
    question TEXT NOT NULL CHECK (question <> ''),
    options JSONB NOT NULL CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) > 0),
    recommended_option_id TEXT NOT NULL CHECK (recommended_option_id <> ''),
    origin_thread_ref TEXT NOT NULL CHECK (origin_thread_ref <> ''),
    authorized_actor_id TEXT NOT NULL CHECK (authorized_actor_id <> ''),
    idempotency_key TEXT NOT NULL UNIQUE CHECK (idempotency_key <> ''),
    decision JSONB CHECK (
      decision IS NULL OR
      (jsonb_typeof(decision) = 'object' AND (
        decision->>'kind' = 'other' OR
        (decision->>'kind' = 'option' AND COALESCE(decision->>'optionId', '') <> '')
      ))
    ),
    decided_at BIGINT,
    created_at BIGINT NOT NULL,
    CHECK ((decision IS NULL) = (decided_at IS NULL))
  )`,
  `CREATE INDEX IF NOT EXISTS finny_clarification_requests_job ON finny_clarification_requests(job_id)`,
];

const APPROVAL_READINESS_SCHEMA = [
  `ALTER TABLE finny_approval_requests ADD COLUMN IF NOT EXISTS ready_at BIGINT`,
  `UPDATE finny_approval_requests SET ready_at=created_at WHERE ready_at IS NULL`,
];

const APPROVAL_READINESS_REPAIR_SCHEMA = [
  `UPDATE finny_approval_requests AS approvals
      SET ready_at=CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM finny_clarification_requests AS clarifications
           WHERE clarifications.job_id=approvals.job_id
             AND (
               clarifications.decision IS NULL OR
               clarifications.decision->>'kind' <> 'option' OR
               clarifications.decision->>'optionId' <> clarifications.recommended_option_id
             )
        ) THEN COALESCE(approvals.ready_at, approvals.created_at)
        ELSE NULL
      END`,
];

const EVALUATOR_AUTHORITY_SCHEMA = [
  `ALTER TABLE finny_jobs ADD COLUMN IF NOT EXISTS evaluator_ref JSONB`,
  `UPDATE finny_jobs SET evaluator_ref=jsonb_build_object(
     'id','legacy-unpinned','revision','legacy-unpinned','buildDigest','legacy-unpinned',
     'contractVersion','legacy-unpinned','configurationDigest','legacy-unpinned'
   ) WHERE evaluator_ref IS NULL`,
  `ALTER TABLE finny_jobs ALTER COLUMN evaluator_ref SET NOT NULL`,
  `ALTER TABLE finny_jobs ADD CONSTRAINT finny_jobs_evaluator_ref_object
     CHECK (jsonb_typeof(evaluator_ref) = 'object')`,
  `ALTER TABLE finny_job_events DROP CONSTRAINT IF EXISTS finny_job_events_event_type_check`,
  `ALTER TABLE finny_job_events ADD CONSTRAINT finny_job_events_event_type_check CHECK (event_type IN (
     'artifact_ready','audit_blocked','audit_passed','rework_requested','escalated',
     'evaluator_revision_activated','evidence_invalidated','rework_cancelled','verification_reopened'
   ))`,
];

const DETERMINISTIC_ATTESTATION_SCHEMA = [
  `ALTER TABLE finny_attestations ADD COLUMN IF NOT EXISTS deterministic_authority JSONB`,
  `ALTER TABLE finny_attestations ADD CONSTRAINT finny_attestations_deterministic_authority_object
     CHECK (deterministic_authority IS NULL OR jsonb_typeof(deterministic_authority) = 'object')`,
];

function rowToClarification(row: Record<string, unknown>): FinnyClarificationRequest {
  return {
    requestId: row.request_id as string,
    scopeId: row.scope_id as string,
    jobId: row.job_id as string,
    question: row.question as string,
    options: row.options as FinnyClarificationRequest["options"],
    recommendedOptionId: row.recommended_option_id as string,
    originThreadRef: row.origin_thread_ref as string,
    authorizedActorId: row.authorized_actor_id as string,
    idempotencyKey: row.idempotency_key as string,
    ...(row.decision !== null ? { decision: row.decision as FinnyClarificationRequest["decision"] } : {}),
    ...(row.decided_at !== null ? { decidedAt: Number(row.decided_at) } : {}),
    createdAt: Number(row.created_at),
  };
}

function validateClarification(input: CreateFinnyClarificationRequestInput): void {
  assertNonEmpty(input.requestId, "clarification request ID");
  assertNonEmpty(input.authorizedActorId, "clarification actor ID");
  if (input.requestId.length > FINNY_REQUEST_ID_MAX)
    throw new Error("Finny clarification request ID exceeds Slack limits");
  assertNonEmpty(input.idempotencyKey, "clarification idempotency key");
  validateFinnyMaterialClarification(input);
}

function rowToJob(row: Record<string, unknown>): FinnyJob {
  const policy: FinnyPolicySnapshot = {
    policyVersion: row.policy_version as string,
    evaluator: row.evaluator_ref as FinnyEvaluatorRef,
    requiredGenerations: row.required_generations as Record<FinnyCheckId, number>,
  };
  const decidedAt = row.approval_decided_at;
  return {
    id: row.id as string,
    scopeId: row.scope_id as string,
    plan: row.plan_presentation as FinnyPlanPresentation,
    planDigest: row.plan_digest as string,
    ...(row.artifact_digest !== null ? { artifactDigest: row.artifact_digest as string } : {}),
    policy,
    ...(row.finding_policy !== null ? { findingPolicy: row.finding_policy as FinnyFindingPolicy } : {}),
    originThreadRef: row.origin_thread_ref as string,
    ...(row.provisional_revision !== null ? { provisionalRevision: row.provisional_revision as string } : {}),
    ...(decidedAt !== null
      ? {
          approval: {
            requestId: row.approval_request_id as string,
            actorId: row.approval_actor_id as string,
            action: row.approval_action as NonNullable<FinnyJob["approval"]>["action"],
            planDigest: row.approval_plan_digest as string,
            originThreadRef: row.approval_origin_thread_ref as string,
            decidedAt: Number(decidedAt),
            ...(row.approval_consumed_at !== null ? { consumedAt: Number(row.approval_consumed_at) } : {}),
          },
        }
      : {}),
    ledgerHead: Number(row.ledger_head),
    eventHead: Number(row.event_head),
    ...(row.pending_rework_seq !== null ? { pendingReworkSequence: Number(row.pending_rework_seq) } : {}),
    ...(row.unresolved_escalation_seq !== null
      ? { unresolvedEscalationSequence: Number(row.unresolved_escalation_seq) }
      : {}),
    ...(row.finalization_key !== null ? { finalizationKey: row.finalization_key as string } : {}),
    ...(row.final_receipt !== null ? { finalReceipt: row.final_receipt as FinnyJob["finalReceipt"] } : {}),
    ...(row.finalized_at !== null ? { finalizedAt: Number(row.finalized_at) } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToAttestation(row: Record<string, unknown>): FinnyAttestation {
  return {
    seq: Number(row.seq),
    id: row.id as string,
    jobId: row.job_id as string,
    checkId: row.check_id as FinnyCheckId,
    generation: Number(row.generation),
    verdict: row.verdict as FinnyAttestation["verdict"],
    evidenceDigest: row.evidence_digest as string,
    artifactDigest: row.artifact_digest as string,
    issuerPrincipalId: row.issuer_principal_id as string,
    issuerRunId: row.issuer_run_id as string,
    ...(row.deterministic_authority !== null
      ? { deterministicAuthority: row.deterministic_authority as FinnyAttestation["deterministicAuthority"] }
      : {}),
    idempotencyKey: row.idempotency_key as string,
    createdAt: Number(row.created_at),
  };
}

function rowToEvent(row: Record<string, unknown>): FinnyJobEvent {
  return {
    seq: Number(row.seq),
    id: row.id as string,
    jobId: row.job_id as string,
    type: row.event_type as FinnyJobEventType,
    payload: row.payload as FinnyJobEventPayloads[FinnyJobEventType],
    idempotencyKey: row.idempotency_key as string,
    createdAt: Number(row.created_at),
  } as FinnyJobEvent;
}

function sameValue(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

async function insertEvent<T extends FinnyJobEventType>(
  db: PoolClient,
  jobId: string,
  type: T,
  payload: FinnyJobEventPayloads[T],
  idempotencyKey: string,
  eventIndex: number,
  createdAt: number,
): Promise<FinnyJobEvent<T>> {
  const inserted = await db.query(
    `INSERT INTO finny_job_events(id, job_id, event_type, payload, idempotency_key, event_index, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [randomUUID(), jobId, type, JSON.stringify(payload), idempotencyKey, eventIndex, createdAt],
  );
  return rowToEvent(inserted.rows[0]) as FinnyJobEvent<T>;
}

async function eventsForIdempotency(db: PoolClient, idempotencyKey: string): Promise<FinnyJobEvent[]> {
  const result = await db.query("SELECT * FROM finny_job_events WHERE idempotency_key=$1 ORDER BY event_index", [
    idempotencyKey,
  ]);
  return result.rows.map(rowToEvent);
}

function assertEventReplayJob(events: readonly FinnyJobEvent[], jobId: string): void {
  if (events.some((event) => event.jobId !== jobId)) throw new Error("Finny event idempotency key was reused");
}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Finny ${label} is invalid`);
}

function assertCurrentAuditEvent(policy: FinnyPolicySnapshot, checkId: FinnyCheckId, generation: number): void {
  assertFinnyPolicy(policy);
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("Finny audit generation is invalid");
  const requiredGeneration = policy.requiredGenerations[checkId];
  if (requiredGeneration === undefined) throw new Error("Finny audit is not for a required check");
  if (requiredGeneration !== generation) throw new Error("Finny audit generation is not current");
}

function sameAttestation(row: FinnyAttestation, input: RecordFinnyAttestationInput): boolean {
  return (
    row.id === input.id &&
    row.jobId === input.jobId &&
    row.checkId === input.checkId &&
    row.generation === input.generation &&
    row.verdict === input.verdict &&
    row.evidenceDigest === input.evidenceDigest &&
    row.artifactDigest === input.artifactDigest &&
    row.issuerPrincipalId === input.issuerPrincipalId &&
    row.issuerRunId === input.issuerRunId &&
    sameValue(row.deterministicAuthority, input.deterministicAuthority)
  );
}

function auditAttestationInput(
  input: RecordFinnyAuditPassedInput | RecordFinnyAuditBlockInput,
  verdict: "pass" | "block",
): RecordFinnyAttestationInput {
  const digest = createHash("sha256").update(input.idempotencyKey).digest("base64url");
  return {
    id: `finny-audit-${digest}`,
    scopeId: input.scopeId,
    jobId: input.jobId,
    checkId: input.checkId,
    generation: input.generation,
    verdict,
    evidenceDigest: input.evidenceDigest,
    artifactDigest: input.artifactDigest,
    issuerPrincipalId: input.issuerPrincipalId,
    issuerRunId: input.issuerRunId,
    ...(input.deterministicAuthority ? { deterministicAuthority: input.deterministicAuthority } : {}),
    idempotencyKey: `finny-audit-${digest}`,
  };
}

async function existingAuditAttestation(
  db: PoolClient,
  input: RecordFinnyAttestationInput,
): Promise<FinnyAttestation | undefined> {
  const result = await db.query("SELECT * FROM finny_attestations WHERE idempotency_key=$1", [input.idempotencyKey]);
  const attestation = result.rows[0] ? rowToAttestation(result.rows[0]) : undefined;
  if (attestation && !sameAttestation(attestation, input)) {
    throw new Error("Finny audit outcome idempotency key was reused");
  }
  return attestation;
}

async function insertAuditAttestation(
  db: PoolClient,
  input: RecordFinnyAttestationInput,
  createdAt: number,
): Promise<FinnyAttestation> {
  const inserted = await db.query(
    `INSERT INTO finny_attestations(
      id, job_id, check_id, generation, verdict, evidence_digest, artifact_digest,
      issuer_principal_id, issuer_run_id, deterministic_authority, idempotency_key, created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
    [
      input.id,
      input.jobId,
      input.checkId,
      input.generation,
      input.verdict,
      input.evidenceDigest,
      input.artifactDigest,
      input.issuerPrincipalId,
      input.issuerRunId,
      input.deterministicAuthority ? JSON.stringify(input.deterministicAuthority) : null,
      input.idempotencyKey,
      createdAt,
    ],
  );
  const attestation = inserted.rows[0] ? rowToAttestation(inserted.rows[0]) : await existingAuditAttestation(db, input);
  if (!attestation) throw new Error("Finny audit outcome attestation was not persisted");
  return attestation;
}

async function lockedJob(db: PoolClient, scopeId: string, jobId: string): Promise<Record<string, unknown>> {
  const { rows } = await db.query("SELECT * FROM finny_jobs WHERE id = $1 AND scope_id = $2 FOR UPDATE", [
    jobId,
    scopeId,
  ]);
  if (!rows[0]) throw new Error("Finny job was not found in this scope");
  return rows[0] as Record<string, unknown>;
}

export function createPostgresFinnyStore(connectionString: string): FinnyStore {
  const { q, pool } = createPgPool(connectionString, [
    { id: "finny/store/0001", statements: SCHEMA },
    { id: "finny/store/0002-events", statements: EVENT_SCHEMA },
    { id: "finny/store/0003-plan-first", statements: PLAN_FIRST_SCHEMA },
    { id: "finny/store/0004-clarifications", statements: CLARIFICATION_SCHEMA },
    { id: "finny/store/0005-approval-readiness", statements: APPROVAL_READINESS_SCHEMA },
    { id: "finny/store/0006-approval-readiness-repair", statements: APPROVAL_READINESS_REPAIR_SCHEMA },
    { id: "finny/store/0007-evaluator-authority", statements: EVALUATOR_AUTHORITY_SCHEMA },
    { id: "finny/store/0008-deterministic-attestation", statements: DETERMINISTIC_ATTESTATION_SCHEMA },
  ]);
  return {
    async createJob(input: CreateFinnyJobInput) {
      assertFinnyPolicy(input.policy);
      assertFinnyApprovedEvaluatorRef(input.policy.evaluator);
      assertFinnyFindingPolicy(input.findingPolicy);
      const plan = validateFinnyPlanPresentation(input.plan);
      const planDigest = canonicalFinnyPlanDigest(plan);
      const now = Date.now();
      const rows = await q(
        `INSERT INTO finny_jobs(
          id, scope_id, plan_presentation, plan_digest, policy_version, evaluator_ref, required_generations,
          finding_policy, origin_thread_ref, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
        RETURNING *`,
        [
          input.id,
          input.scopeId,
          JSON.stringify(plan),
          planDigest,
          input.policy.policyVersion,
          JSON.stringify(input.policy.evaluator),
          JSON.stringify(input.policy.requiredGenerations),
          JSON.stringify(input.findingPolicy),
          input.originThreadRef,
          now,
        ],
      );
      if (!rows[0]) throw new Error("Finny job insert returned no row");
      return rowToJob(rows[0]);
    },
    async getJob(scopeId, jobId) {
      const rows = await q("SELECT * FROM finny_jobs WHERE id = $1 AND scope_id = $2", [jobId, scopeId]);
      return rows[0] ? rowToJob(rows[0]) : null;
    },
    async getApprovalRequest(requestId) {
      const rows = await q(
        `SELECT r.*, to_jsonb(j) AS job_row
           FROM finny_approval_requests r
           JOIN finny_jobs j ON j.id = r.job_id
          WHERE r.request_id = $1`,
        [requestId],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        requestId: row.request_id as string,
        scopeId: row.scope_id as string,
        jobId: row.job_id as string,
        planDigest: row.plan_digest as string,
        originThreadRef: row.origin_thread_ref as string,
        authorizedActorId: row.authorized_actor_id as string,
        ...(row.ready_at !== null ? { readyAt: Number(row.ready_at) } : {}),
        ...(row.decided_at !== null ? { decidedAt: Number(row.decided_at) } : {}),
        job: rowToJob(row.job_row as Record<string, unknown>),
      } satisfies FinnyApprovalRequest;
    },
    async getClarificationRequest(requestId) {
      const rows = await q("SELECT * FROM finny_clarification_requests WHERE request_id=$1", [requestId]);
      return rows[0] ? rowToClarification(rows[0]) : null;
    },
    async claimWorkerRun(input: ClaimFinnyWorkerRunInput) {
      assertNonEmpty(input.runId, "worker run ID");
      await withPgTransaction(await pool(), async (db) => {
        await lockedJob(db, input.scopeId, input.jobId);
        const existing = await db.query("SELECT role FROM finny_worker_runs WHERE job_id=$1 AND run_id=$2", [
          input.jobId,
          input.runId,
        ]);
        if (existing.rows[0]) {
          if (existing.rows[0].role !== input.role) throw new Error("Finny producer and Auditor runs must be distinct");
          return;
        }
        await db.query("INSERT INTO finny_worker_runs(job_id, run_id, role, created_at) VALUES ($1,$2,$3,$4)", [
          input.jobId,
          input.runId,
          input.role,
          Date.now(),
        ]);
      });
    },
    async createApprovalRequest(input: CreateFinnyApprovalRequestInput) {
      assertNonEmpty(input.requestId, "approval request ID");
      assertNonEmpty(input.authorizedActorId, "approval actor ID");
      await withPgTransaction(await pool(), async (db) => {
        const job = await lockedJob(db, input.scopeId, input.jobId);
        if (job.approval_decided_at !== null) throw new Error("Finny approval was already decided");
        const pending = await db.query("SELECT 1 FROM finny_approval_requests WHERE job_id=$1 AND decided_at IS NULL", [
          input.jobId,
        ]);
        if (pending.rows[0]) throw new Error("Finny approval request is already pending");
        await db.query(
          `INSERT INTO finny_approval_requests(
             request_id, scope_id, job_id, plan_digest, origin_thread_ref, authorized_actor_id, ready_at, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
          [
            input.requestId,
            input.scopeId,
            input.jobId,
            job.plan_digest,
            job.origin_thread_ref,
            input.authorizedActorId,
            Date.now(),
          ],
        );
      });
    },
    async createClarificationRequest(input: CreateFinnyClarificationRequestInput) {
      validateClarification(input);
      return withPgTransaction(await pool(), async (db) => {
        const job = await lockedJob(db, input.scopeId, input.jobId);
        const lockApproval = async (): Promise<void> => {
          const approval = await db.query(
            `SELECT * FROM finny_approval_requests
              WHERE scope_id=$1 AND job_id=$2 AND authorized_actor_id=$3
                AND origin_thread_ref=$4 AND decided_at IS NULL FOR UPDATE`,
            [input.scopeId, input.jobId, input.authorizedActorId, job.origin_thread_ref],
          );
          if (approval.rowCount !== 1) throw new Error("Finny clarification approval request is unavailable");
          await db.query("UPDATE finny_approval_requests SET ready_at=NULL WHERE request_id=$1", [
            approval.rows[0].request_id,
          ]);
        };
        const replay = await db.query("SELECT * FROM finny_clarification_requests WHERE idempotency_key=$1", [
          input.idempotencyKey,
        ]);
        if (replay.rows[0]) {
          const existing = rowToClarification(replay.rows[0]);
          if (
            existing.requestId !== input.requestId ||
            existing.scopeId !== input.scopeId ||
            existing.jobId !== input.jobId ||
            existing.authorizedActorId !== input.authorizedActorId ||
            existing.question !== input.question ||
            !isDeepStrictEqual(existing.options, input.options) ||
            existing.recommendedOptionId !== input.recommendedOptionId ||
            existing.originThreadRef !== job.origin_thread_ref
          )
            throw new Error("Finny clarification idempotency key was reused");
          if (existing.decidedAt === undefined) await lockApproval();
          return existing;
        }
        const prior = await db.query("SELECT 1 FROM finny_clarification_requests WHERE job_id=$1", [input.jobId]);
        if (prior.rowCount) throw new Error("Finny job already has a material clarification");
        assertFinnyMaterialClarificationMatchesPlan(job.plan_presentation as FinnyPlanPresentation, input);
        await lockApproval();
        const now = Date.now();
        const inserted = await db.query(
          `INSERT INTO finny_clarification_requests(
             request_id, scope_id, job_id, question, options, recommended_option_id,
             origin_thread_ref, authorized_actor_id, idempotency_key, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [
            input.requestId,
            input.scopeId,
            input.jobId,
            input.question,
            JSON.stringify(input.options),
            input.recommendedOptionId,
            job.origin_thread_ref,
            input.authorizedActorId,
            input.idempotencyKey,
            now,
          ],
        );
        return rowToClarification(inserted.rows[0]);
      });
    },
    async recordClarificationDecision(input: RecordFinnyClarificationDecisionInput) {
      return withPgTransaction(await pool(), async (db) => {
        const selected = await db.query("SELECT * FROM finny_clarification_requests WHERE request_id=$1 FOR UPDATE", [
          input.requestId,
        ]);
        const row = selected.rows[0];
        if (!row) throw new Error("Finny clarification request was not found");
        if (row.decided_at !== null) throw new Error("Finny clarification request was already decided");
        if (row.authorized_actor_id !== input.actorId) throw new Error("Finny clarification actor is not authorized");
        if (row.origin_thread_ref !== input.originThreadRef)
          throw new Error("Finny clarification must be decided in its origin thread");
        if (input.decision.kind === "option") {
          const optionId = input.decision.optionId;
          if (!(row.options as FinnyClarificationRequest["options"]).some((option) => option.id === optionId))
            throw new Error("Finny clarification option is not available");
        }
        const updated = await db.query(
          `UPDATE finny_clarification_requests SET decision=$2, decided_at=$3
            WHERE request_id=$1 RETURNING *`,
          [input.requestId, JSON.stringify(input.decision), input.decidedAt],
        );
        const approval = await db.query(
          `SELECT request_id FROM finny_approval_requests
            WHERE job_id=$1 AND decided_at IS NULL
              AND authorized_actor_id=$2 AND origin_thread_ref=$3 FOR UPDATE`,
          [row.job_id, row.authorized_actor_id, row.origin_thread_ref],
        );
        if (approval.rowCount !== 1) throw new Error("Finny clarification approval request is unavailable");
        const clarificationState = await db.query(
          `SELECT
             COALESCE(bool_and(
               decided_at IS NOT NULL AND decision->>'kind'='option'
               AND decision->>'optionId'=recommended_option_id
             ), FALSE) AS all_recommended,
             COALESCE(bool_or(
               decided_at IS NOT NULL AND (
                 decision->>'kind'<>'option' OR decision->>'optionId'<>recommended_option_id
               )
             ), FALSE) AS revision_required
             FROM finny_clarification_requests WHERE job_id=$1`,
          [row.job_id],
        );
        const approvalReady = clarificationState.rows[0]?.all_recommended === true;
        const revisionRequired = clarificationState.rows[0]?.revision_required === true;
        await db.query("UPDATE finny_approval_requests SET ready_at=$2 WHERE request_id=$1", [
          approval.rows[0].request_id,
          approvalReady ? input.decidedAt : null,
        ]);
        return { request: rowToClarification(updated.rows[0]), approvalReady, revisionRequired };
      });
    },
    async recordApproval(input: RecordFinnyApprovalInput) {
      return withPgTransaction(await pool(), async (db) => {
        const job = await lockedJob(db, input.scopeId, input.jobId);
        if (job.approval_decided_at !== null) throw new Error("Finny approval was already decided");
        const request = await db.query(
          `SELECT * FROM finny_approval_requests
           WHERE request_id=$1 AND scope_id=$2 AND job_id=$3 FOR UPDATE`,
          [input.requestId, input.scopeId, input.jobId],
        );
        const binding = request.rows[0];
        if (!binding) throw new Error("Finny approval request binding does not match the job");
        if (binding.decided_at !== null) throw new Error("Finny approval request was already decided");
        if (binding.ready_at === null) throw new Error("Finny approval request is not ready");
        if (binding.authorized_actor_id !== input.actorId) throw new Error("Finny approval actor is not authorized");
        if (binding.origin_thread_ref !== input.originThreadRef)
          throw new Error("Finny approval must be decided in its origin thread");
        if (binding.plan_digest !== job.plan_digest || binding.origin_thread_ref !== job.origin_thread_ref) {
          throw new Error("Finny approval request binding does not match the job");
        }
        const updated = await db.query(
          `UPDATE finny_jobs SET
             approval_request_id=$2, approval_actor_id=$3, approval_action=$4,
             approval_plan_digest=$5, approval_origin_thread_ref=$6, approval_decided_at=$7, updated_at=$7
           WHERE id=$1 RETURNING *`,
          [
            input.jobId,
            input.requestId,
            input.actorId,
            input.action,
            binding.plan_digest,
            binding.origin_thread_ref,
            input.decidedAt,
          ],
        );
        await db.query("UPDATE finny_approval_requests SET decided_at=$2 WHERE request_id=$1", [
          input.requestId,
          input.decidedAt,
        ]);
        return rowToJob(updated.rows[0]);
      });
    },
    async recordAttestation(input: RecordFinnyAttestationInput) {
      return withPgTransaction(await pool(), async (db) => {
        const job = await lockedJob(db, input.scopeId, input.jobId);
        const replay = await db.query("SELECT * FROM finny_attestations WHERE idempotency_key = $1", [
          input.idempotencyKey,
        ]);
        if (replay.rows[0]) {
          const attestation = rowToAttestation(replay.rows[0]);
          if (!sameAttestation(attestation, input)) throw new Error("Finny attestation idempotency key was reused");
          return { attestation, deduped: true };
        }
        if (job.finalized_at !== null) throw new Error("Finny job is already finalized");
        if (job.pending_rework_seq !== null) throw new Error("Finny job is awaiting a reworked artifact");
        if (job.unresolved_escalation_seq !== null) throw new Error("Finny job has an unresolved escalation");
        const policy: FinnyPolicySnapshot = {
          policyVersion: job.policy_version as string,
          evaluator: job.evaluator_ref as FinnyEvaluatorRef,
          requiredGenerations: job.required_generations as Record<FinnyCheckId, number>,
        };
        assertFinnyPolicy(policy);
        const requiredGeneration = policy.requiredGenerations[input.checkId];
        if (requiredGeneration === undefined) throw new Error("Finny attestation is not for a required check");
        if (input.generation !== requiredGeneration) throw new Error("Finny attestation generation is not current");
        assertFinnyDeterministicAuthority(input.deterministicAuthority, input.checkId, input.verdict, policy.evaluator);
        if (job.artifact_digest !== input.artifactDigest) throw new Error("Finny attestation artifact is not current");
        const now = Date.now();
        const inserted = await db.query(
          `INSERT INTO finny_attestations(
            id, job_id, check_id, generation, verdict, evidence_digest, artifact_digest,
            issuer_principal_id, issuer_run_id, deterministic_authority, idempotency_key, created_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          ON CONFLICT (idempotency_key) DO NOTHING
          RETURNING *`,
          [
            input.id,
            input.jobId,
            input.checkId,
            input.generation,
            input.verdict,
            input.evidenceDigest,
            input.artifactDigest,
            input.issuerPrincipalId,
            input.issuerRunId,
            input.deterministicAuthority ? JSON.stringify(input.deterministicAuthority) : null,
            input.idempotencyKey,
            now,
          ],
        );
        if (!inserted.rows[0]) {
          const existing = await db.query("SELECT * FROM finny_attestations WHERE idempotency_key = $1", [
            input.idempotencyKey,
          ]);
          const attestation = rowToAttestation(existing.rows[0]);
          if (!sameAttestation(attestation, input)) throw new Error("Finny attestation idempotency key was reused");
          return { attestation, deduped: true };
        }
        const attestation = rowToAttestation(inserted.rows[0]);
        await db.query("UPDATE finny_jobs SET ledger_head=$2, updated_at=$3 WHERE id=$1", [
          input.jobId,
          attestation.seq,
          now,
        ]);
        return { attestation, deduped: false };
      });
    },
    async recordArtifactReady(input: RecordFinnyArtifactReadyInput) {
      return withPgTransaction(await pool(), async (db) => {
        const row = await lockedJob(db, input.scopeId, input.jobId);
        assertNonEmpty(input.idempotencyKey, "event idempotency key");
        assertNonEmpty(input.artifactDigest, "artifact digest");
        assertNonEmpty(input.provisionalRevision, "provisional revision");
        const payload: FinnyJobEventPayloads["artifact_ready"] = {
          artifactDigest: input.artifactDigest,
          provisionalRevision: input.provisionalRevision,
        };
        const existing = await eventsForIdempotency(db, input.idempotencyKey);
        assertEventReplayJob(existing, input.jobId);
        if (existing.length) {
          if (
            existing.length !== 1 ||
            existing[0]?.type !== "artifact_ready" ||
            !sameValue(existing[0].payload, payload)
          ) {
            throw new Error("Finny event idempotency key was reused");
          }
          return { events: existing as FinnyJobEvent<"artifact_ready">[], job: rowToJob(row), deduped: true };
        }
        if (row.finalized_at !== null) throw new Error("Finny job is already finalized");
        if (row.approval_action !== "approve" || row.approval_decided_at === null) {
          throw new Error("Finny job must be approved before artifact readiness");
        }
        if (row.unresolved_escalation_seq !== null) throw new Error("Finny job has an unresolved escalation");
        const artifactWasBound = row.artifact_digest !== null || row.provisional_revision !== null;
        if ((row.artifact_digest === null) !== (row.provisional_revision === null)) {
          throw new Error("Finny artifact binding is inconsistent");
        }
        const changesArtifact =
          row.artifact_digest !== input.artifactDigest || row.provisional_revision !== input.provisionalRevision;
        if (artifactWasBound && changesArtifact) {
          if (row.pending_rework_seq === null) throw new Error("Finny artifact replacement requires a rework request");
          const latest = await db.query(
            "SELECT event_type FROM finny_job_events WHERE job_id=$1 ORDER BY seq DESC LIMIT 1",
            [input.jobId],
          );
          if (latest.rows[0]?.event_type !== "rework_requested") {
            throw new Error("Finny artifact replacement requires a rework request");
          }
        } else if (artifactWasBound && Number(row.event_head) !== 0) {
          throw new Error("Finny artifact readiness was already recorded");
        }
        const currentPolicy: FinnyPolicySnapshot = {
          policyVersion: row.policy_version as string,
          evaluator: row.evaluator_ref as FinnyEvaluatorRef,
          requiredGenerations: row.required_generations as Record<FinnyCheckId, number>,
        };
        const nextPolicy =
          artifactWasBound && row.artifact_digest !== input.artifactDigest
            ? reviseFinnyPolicy(currentPolicy, ["source_or_logic"])
            : currentPolicy;
        const now = Date.now();
        const event = await insertEvent(db, input.jobId, "artifact_ready", payload, input.idempotencyKey, 0, now);
        const updated = await db.query(
          `UPDATE finny_jobs SET artifact_digest=$2, provisional_revision=$3, event_head=$4,
             required_generations=$5, pending_rework_seq=NULL, updated_at=$6 WHERE id=$1 RETURNING *`,
          [
            input.jobId,
            input.artifactDigest,
            input.provisionalRevision,
            event.seq,
            JSON.stringify(nextPolicy.requiredGenerations),
            now,
          ],
        );
        return { events: [event], job: rowToJob(updated.rows[0]), deduped: false };
      });
    },
    async recordAuditPassed(input: RecordFinnyAuditPassedInput) {
      return withPgTransaction(await pool(), async (db) => {
        const row = await lockedJob(db, input.scopeId, input.jobId);
        assertNonEmpty(input.idempotencyKey, "event idempotency key");
        assertNonEmpty(input.artifactDigest, "audit artifact digest");
        assertNonEmpty(input.evidenceDigest, "audit evidence digest");
        assertNonEmpty(input.issuerPrincipalId, "audit issuer principal ID");
        assertNonEmpty(input.issuerRunId, "audit issuer run ID");
        const payload: FinnyJobEventPayloads["audit_passed"] = {
          artifactDigest: input.artifactDigest,
          checkId: input.checkId,
          generation: input.generation,
          evidenceDigest: input.evidenceDigest,
          issuerPrincipalId: input.issuerPrincipalId,
          issuerRunId: input.issuerRunId,
          ...(input.deterministicAuthority ? { deterministicAuthority: input.deterministicAuthority } : {}),
        };
        const attestationInput = auditAttestationInput(input, "pass");
        const existing = await eventsForIdempotency(db, input.idempotencyKey);
        assertEventReplayJob(existing, input.jobId);
        if (existing.length) {
          const attestation = await existingAuditAttestation(db, attestationInput);
          if (
            existing.length !== 1 ||
            existing[0]?.type !== "audit_passed" ||
            !sameValue(existing[0].payload, payload) ||
            !attestation
          ) {
            throw new Error("Finny event idempotency key was reused");
          }
          return { events: existing as FinnyJobEvent<"audit_passed">[], job: rowToJob(row), deduped: true };
        }
        if (await existingAuditAttestation(db, attestationInput)) {
          throw new Error("Finny audit outcome idempotency key was reused");
        }
        if (row.finalized_at !== null) throw new Error("Finny job is already finalized");
        if (row.unresolved_escalation_seq !== null) throw new Error("Finny job has an unresolved escalation");
        if (row.pending_rework_seq !== null) throw new Error("Finny job is awaiting a reworked artifact");
        const policy: FinnyPolicySnapshot = {
          policyVersion: row.policy_version as string,
          evaluator: row.evaluator_ref as FinnyEvaluatorRef,
          requiredGenerations: row.required_generations as Record<FinnyCheckId, number>,
        };
        assertCurrentAuditEvent(policy, input.checkId, input.generation);
        assertFinnyDeterministicAuthority(input.deterministicAuthority, input.checkId, "pass", policy.evaluator);
        if (row.artifact_digest !== input.artifactDigest) throw new Error("Finny audit artifact is not current");
        const now = Date.now();
        const attestation = await insertAuditAttestation(db, attestationInput, now);
        const event = await insertEvent(db, input.jobId, "audit_passed", payload, input.idempotencyKey, 0, now);
        const updated = await db.query(
          "UPDATE finny_jobs SET ledger_head=$2, event_head=$3, updated_at=$4 WHERE id=$1 RETURNING *",
          [input.jobId, attestation.seq, event.seq, now],
        );
        return { events: [event], job: rowToJob(updated.rows[0]), deduped: false };
      });
    },
    async recordAuditBlock(input: RecordFinnyAuditBlockInput) {
      return withPgTransaction(await pool(), async (db) => {
        const row = await lockedJob(db, input.scopeId, input.jobId);
        assertNonEmpty(input.idempotencyKey, "event idempotency key");
        assertNonEmpty(input.artifactDigest, "audit artifact digest");
        assertNonEmpty(input.evidenceDigest, "audit evidence digest");
        assertNonEmpty(input.issuerPrincipalId, "audit issuer principal ID");
        assertNonEmpty(input.issuerRunId, "audit issuer run ID");
        const blockedPayload: FinnyJobEventPayloads["audit_blocked"] = {
          artifactDigest: input.artifactDigest,
          checkId: input.checkId,
          generation: input.generation,
          evidenceDigest: input.evidenceDigest,
          issuerPrincipalId: input.issuerPrincipalId,
          issuerRunId: input.issuerRunId,
          ...(input.deterministicAuthority ? { deterministicAuthority: input.deterministicAuthority } : {}),
          findings: input.findings,
          findingPolicy: row.finding_policy as FinnyFindingPolicy,
          changeKinds: input.changeKinds,
        };
        const attestationInput = auditAttestationInput(input, "block");
        const existing = await eventsForIdempotency(db, input.idempotencyKey);
        assertEventReplayJob(existing, input.jobId);
        if (existing.length) {
          const transitionType = input.resolution.kind === "rework" ? "rework_requested" : "escalated";
          const escalationMatches =
            input.resolution.kind !== "escalate" ||
            (existing[1]?.type === "escalated" && existing[1].payload.reason === input.resolution.reason);
          const attestation = await existingAuditAttestation(db, attestationInput);
          if (
            existing.length !== 2 ||
            existing[0]?.type !== "audit_blocked" ||
            !sameValue(existing[0].payload, blockedPayload) ||
            existing[1]?.type !== transitionType ||
            !escalationMatches ||
            !attestation
          ) {
            throw new Error("Finny event idempotency key was reused");
          }
          return { events: existing, job: rowToJob(row), deduped: true };
        }
        if (await existingAuditAttestation(db, attestationInput)) {
          throw new Error("Finny audit outcome idempotency key was reused");
        }
        if (row.finalized_at !== null) throw new Error("Finny job is already finalized");
        if (row.unresolved_escalation_seq !== null) throw new Error("Finny job has an unresolved escalation");
        if (row.pending_rework_seq !== null) throw new Error("Finny job is awaiting a reworked artifact");
        const policy: FinnyPolicySnapshot = {
          policyVersion: row.policy_version as string,
          evaluator: row.evaluator_ref as FinnyEvaluatorRef,
          requiredGenerations: row.required_generations as Record<FinnyCheckId, number>,
        };
        assertCurrentAuditEvent(policy, input.checkId, input.generation);
        assertFinnyDeterministicAuthority(input.deterministicAuthority, input.checkId, "block", policy.evaluator);
        if (row.finding_policy === null) throw new Error("Finny finding policy is not configured");
        assertFinnyAuditFindings(input.findings, row.finding_policy as FinnyFindingPolicy);
        const revised = reviseFinnyPolicy(policy, input.changeKinds);
        if (row.artifact_digest !== input.artifactDigest) throw new Error("Finny audit artifact is not current");
        const now = Date.now();
        const attestation = await insertAuditAttestation(db, attestationInput, now);
        const blocked = await insertEvent(
          db,
          input.jobId,
          "audit_blocked",
          blockedPayload,
          input.idempotencyKey,
          0,
          now,
        );
        if (input.resolution.kind === "rework") {
          const requested = await insertEvent(
            db,
            input.jobId,
            "rework_requested",
            { blockedEventSequence: blocked.seq, requiredGenerations: revised.requiredGenerations },
            input.idempotencyKey,
            1,
            now,
          );
          const updated = await db.query(
            `UPDATE finny_jobs SET required_generations=$2, ledger_head=$3, event_head=$4,
               pending_rework_seq=$4, updated_at=$5 WHERE id=$1 RETURNING *`,
            [input.jobId, JSON.stringify(revised.requiredGenerations), attestation.seq, requested.seq, now],
          );
          return { events: [blocked, requested], job: rowToJob(updated.rows[0]), deduped: false };
        }
        assertFinnyEscalationReason(input.resolution.reason);
        const escalated = await insertEvent(
          db,
          input.jobId,
          "escalated",
          { blockedEventSequence: blocked.seq, reason: input.resolution.reason },
          input.idempotencyKey,
          1,
          now,
        );
        const updated = await db.query(
          `UPDATE finny_jobs SET ledger_head=$2, event_head=$3, unresolved_escalation_seq=$3, updated_at=$4
           WHERE id=$1 RETURNING *`,
          [input.jobId, attestation.seq, escalated.seq, now],
        );
        return { events: [blocked, escalated], job: rowToJob(updated.rows[0]), deduped: false };
      });
    },
    async evaluatorCorrectionCandidates(approvedEvaluator: FinnyEvaluatorRef) {
      assertFinnyApprovedEvaluatorRef(approvedEvaluator);
      const rows = await q(
        `SELECT jobs.* FROM finny_jobs AS jobs
          WHERE jobs.finalized_at IS NULL
            AND jobs.artifact_digest IS NOT NULL
            AND jobs.provisional_revision IS NOT NULL
            AND jobs.unresolved_escalation_seq IS NULL
            AND jobs.evaluator_ref <> $1::jsonb
            AND (
              jobs.pending_rework_seq IS NULL
              OR EXISTS (
                SELECT 1 FROM finny_job_events AS rework
                JOIN finny_job_events AS blocked
                  ON blocked.job_id=rework.job_id
                 AND blocked.seq=(rework.payload->>'blockedEventSequence')::bigint
                 AND blocked.event_type='audit_blocked'
                 AND blocked.payload->>'checkId' IN ('formula.recalculate','summary.crossfoot','artifact.structure')
               WHERE rework.job_id=jobs.id
                 AND rework.seq=jobs.pending_rework_seq
                 AND rework.event_type='rework_requested'
              )
            )
          ORDER BY jobs.created_at,jobs.id`,
        [JSON.stringify(approvedEvaluator)],
      );
      return rows.map(rowToJob);
    },
    async recordEvaluatorCorrection(input: RecordFinnyEvaluatorCorrectionInput) {
      return withPgTransaction(await pool(), async (db) => {
        const row = await lockedJob(db, input.scopeId, input.jobId);
        assertNonEmpty(input.idempotencyKey, "event idempotency key");
        assertFinnyEvaluatorRef(input.fromEvaluator);
        assertFinnyApprovedEvaluatorRef(input.toEvaluator);
        if (sameValue(input.fromEvaluator, input.toEvaluator)) {
          throw new Error("Finny evaluator correction must activate a new evaluator");
        }

        const existing = await eventsForIdempotency(db, input.idempotencyKey);
        assertEventReplayJob(existing, input.jobId);
        if (existing.length) {
          const activated = existing[0];
          const reopened = existing.at(-1);
          if (
            (existing.length !== 3 && existing.length !== 4) ||
            activated?.type !== "evaluator_revision_activated" ||
            !sameValue(activated.payload, { fromEvaluator: input.fromEvaluator, toEvaluator: input.toEvaluator }) ||
            existing[1]?.type !== "evidence_invalidated" ||
            (existing.length === 4 && existing[2]?.type !== "rework_cancelled") ||
            reopened?.type !== "verification_reopened" ||
            !sameValue(reopened.payload.evaluator, input.toEvaluator)
          ) {
            throw new Error("Finny event idempotency key was reused");
          }
          return { events: existing, job: rowToJob(row), deduped: true };
        }

        if (row.finalized_at !== null) throw new Error("Finny job is already finalized");
        if (row.unresolved_escalation_seq !== null) throw new Error("Finny job has an unresolved escalation");
        if (!row.artifact_digest || !row.provisional_revision) {
          throw new Error("Finny evaluator correction requires a bound artifact");
        }
        if (!sameValue(row.evaluator_ref, input.fromEvaluator)) {
          throw new Error("Finny evaluator correction does not match the current evaluator");
        }

        const policy: FinnyPolicySnapshot = {
          policyVersion: row.policy_version as string,
          evaluator: row.evaluator_ref as FinnyEvaluatorRef,
          requiredGenerations: row.required_generations as Record<FinnyCheckId, number>,
        };
        assertFinnyPolicy(policy);
        const revised = activateFinnyEvaluator(policy, input.toEvaluator);

        let cancelled: { reworkEventSequence: number; blockedEventSequence: number; checkId: FinnyCheckId } | undefined;
        if (row.pending_rework_seq !== null) {
          const transitionResult = await db.query("SELECT * FROM finny_job_events WHERE job_id=$1 AND seq=$2", [
            input.jobId,
            row.pending_rework_seq,
          ]);
          const transition = transitionResult.rows[0] ? rowToEvent(transitionResult.rows[0]) : undefined;
          if (transition?.type !== "rework_requested") {
            throw new Error("Finny pending rework is unrelated to evaluator correction");
          }
          const blockedResult = await db.query("SELECT * FROM finny_job_events WHERE job_id=$1 AND seq=$2", [
            input.jobId,
            transition.payload.blockedEventSequence,
          ]);
          const blocked = blockedResult.rows[0] ? rowToEvent(blockedResult.rows[0]) : undefined;
          if (
            blocked?.type !== "audit_blocked" ||
            blocked.payload.artifactDigest !== row.artifact_digest ||
            !FINNY_DETERMINISTIC_CHECK_IDS.includes(
              blocked.payload.checkId as (typeof FINNY_DETERMINISTIC_CHECK_IDS)[number],
            )
          ) {
            throw new Error("Finny pending rework is non-deterministic or unrelated to evaluator correction");
          }
          cancelled = {
            reworkEventSequence: transition.seq,
            blockedEventSequence: blocked.seq,
            checkId: blocked.payload.checkId,
          };
        }

        const now = Date.now();
        const events: FinnyJobEvent[] = [];
        events.push(
          await insertEvent(
            db,
            input.jobId,
            "evaluator_revision_activated",
            { fromEvaluator: input.fromEvaluator, toEvaluator: input.toEvaluator },
            input.idempotencyKey,
            events.length,
            now,
          ),
        );
        events.push(
          await insertEvent(
            db,
            input.jobId,
            "evidence_invalidated",
            {
              fromEvaluator: input.fromEvaluator,
              toEvaluator: input.toEvaluator,
              checkIds: [...FINNY_DETERMINISTIC_CHECK_IDS],
              previousRequiredGenerations: policy.requiredGenerations,
              requiredGenerations: revised.requiredGenerations,
            },
            input.idempotencyKey,
            events.length,
            now,
          ),
        );
        if (cancelled) {
          events.push(
            await insertEvent(db, input.jobId, "rework_cancelled", cancelled, input.idempotencyKey, events.length, now),
          );
        }
        events.push(
          await insertEvent(
            db,
            input.jobId,
            "verification_reopened",
            {
              evaluator: input.toEvaluator,
              previousRequiredGenerations: policy.requiredGenerations,
              requiredGenerations: revised.requiredGenerations,
            },
            input.idempotencyKey,
            events.length,
            now,
          ),
        );
        const eventHead = events.at(-1)!.seq;
        const updated = await db.query(
          `UPDATE finny_jobs SET evaluator_ref=$2, required_generations=$3,
             pending_rework_seq=NULL, event_head=$4, updated_at=$5 WHERE id=$1 RETURNING *`,
          [input.jobId, JSON.stringify(revised.evaluator), JSON.stringify(revised.requiredGenerations), eventHead, now],
        );
        return { events, job: rowToJob(updated.rows[0]), deduped: false };
      });
    },
    async listEvents(scopeId, jobId, afterSequence = 0) {
      const jobs = await q("SELECT id FROM finny_jobs WHERE id=$1 AND scope_id=$2", [jobId, scopeId]);
      if (!jobs[0]) throw new Error("Finny job was not found in this scope");
      const rows = await q("SELECT * FROM finny_job_events WHERE job_id=$1 AND seq>$2 ORDER BY seq", [
        jobId,
        afterSequence,
      ]);
      return rows.map(rowToEvent);
    },
    async finalize(input: FinalizeFinnyInput, sign: FinnyReceiptSigner): Promise<FinnyFinalReceipt> {
      return withPgTransaction(await pool(), async (db) => {
        const row = await lockedJob(db, input.scopeId, input.jobId);
        if (row.final_receipt !== null) {
          if (row.finalization_key !== input.idempotencyKey) {
            throw new Error("Finny job was finalized with a different idempotency key");
          }
          return row.final_receipt as FinnyFinalReceipt;
        }
        if (row.pending_rework_seq !== null) throw new Error("Finny job is awaiting a reworked artifact");
        if (row.unresolved_escalation_seq !== null) throw new Error("Finny job has an unresolved escalation");
        if (
          typeof row.artifact_digest !== "string" ||
          !row.artifact_digest ||
          typeof row.provisional_revision !== "string" ||
          !row.provisional_revision
        ) {
          throw new Error("Finny job does not have a bound artifact");
        }
        if (
          row.approval_action !== "approve" ||
          row.approval_decided_at === null ||
          row.approval_consumed_at !== null ||
          row.approval_plan_digest !== row.plan_digest ||
          row.approval_origin_thread_ref !== row.origin_thread_ref
        ) {
          throw new Error("Finny job does not have an unconsumed bound approved decision");
        }
        const policy: FinnyPolicySnapshot = {
          policyVersion: row.policy_version as string,
          evaluator: row.evaluator_ref as FinnyEvaluatorRef,
          requiredGenerations: row.required_generations as Record<FinnyCheckId, number>,
        };
        assertFinnyPolicy(policy);
        const attestations = await db.query(
          `SELECT DISTINCT ON (check_id) * FROM finny_attestations
           WHERE job_id=$1 ORDER BY check_id, seq DESC`,
          [input.jobId],
        );
        const latest = new Map<FinnyCheckId, FinnyAttestation>();
        let observedHead = 0;
        for (const attestationRow of attestations.rows) {
          const attestation = rowToAttestation(attestationRow);
          latest.set(attestation.checkId, attestation);
          observedHead = Math.max(observedHead, attestation.seq);
        }
        for (const checkId of Object.keys(policy.requiredGenerations) as FinnyCheckId[]) {
          const attestation = latest.get(checkId);
          if (!attestation) throw new Error(`Finny finalization is missing ${checkId}`);
          if (attestation.generation !== policy.requiredGenerations[checkId]) {
            throw new Error(`Finny finalization has a stale generation for ${checkId}`);
          }
          if (attestation.verdict === "block") throw new Error(`Finny finalization has a BLOCK for ${checkId}`);
          assertFinnyDeterministicAuthority(
            attestation.deterministicAuthority,
            checkId,
            attestation.verdict,
            policy.evaluator,
          );
          if (attestation.artifactDigest !== row.artifact_digest) {
            throw new Error(`Finny finalization has stale artifact evidence for ${checkId}`);
          }
        }
        if (observedHead !== Number(row.ledger_head)) throw new Error("Finny attestation ledger head is inconsistent");
        const issuedAt = Date.now();
        const payload: FinnyFinalReceiptPayload = {
          aud: "finny.final.delivery",
          jobId: input.jobId,
          scopeId: input.scopeId,
          planDigest: row.plan_digest as string,
          artifactDigest: row.artifact_digest as string,
          policyVersion: policy.policyVersion,
          evaluator: policy.evaluator,
          requiredGenerations: policy.requiredGenerations,
          ledgerHead: observedHead,
          approvalRequestId: row.approval_request_id as string,
          approvalActorId: row.approval_actor_id as string,
          originThreadRef: row.origin_thread_ref as string,
          provisionalRevision: row.provisional_revision as string,
          issuedAt,
        };
        const receipt: FinnyFinalReceipt = { payload, token: await sign(payload) };
        await db.query(
          `UPDATE finny_jobs SET finalization_key=$2, final_receipt=$3,
             finalized_at=$4, approval_consumed_at=$4, updated_at=$4
           WHERE id=$1`,
          [input.jobId, input.idempotencyKey, JSON.stringify(receipt), issuedAt],
        );
        return receipt;
      });
    },
  };
}
