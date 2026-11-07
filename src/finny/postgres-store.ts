import type { PoolClient } from "pg";
import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import { assertFinnyPolicy } from "./policy.ts";
import type {
  CreateFinnyJobInput,
  FinalizeFinnyInput,
  FinnyReceiptSigner,
  FinnyStore,
  RecordFinnyApprovalInput,
  RecordFinnyAttestationInput,
} from "./store.ts";
import type {
  FinnyAttestation,
  FinnyCheckId,
  FinnyFinalReceipt,
  FinnyFinalReceiptPayload,
  FinnyJob,
  FinnyPolicySnapshot,
} from "./types.ts";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS finny_jobs(
    id TEXT PRIMARY KEY,
    scope_id TEXT NOT NULL CHECK (scope_id <> ''),
    plan_digest TEXT NOT NULL CHECK (plan_digest <> ''),
    artifact_digest TEXT NOT NULL CHECK (artifact_digest <> ''),
    policy_version TEXT NOT NULL CHECK (policy_version <> ''),
    required_generations JSONB NOT NULL CHECK (jsonb_typeof(required_generations) = 'object'),
    origin_thread_ref TEXT NOT NULL CHECK (origin_thread_ref <> ''),
    provisional_revision TEXT NOT NULL CHECK (provisional_revision <> ''),
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
    issuer_principal_id TEXT NOT NULL CHECK (issuer_principal_id <> ''),
    issuer_run_id TEXT NOT NULL CHECK (issuer_run_id <> ''),
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS finny_attestations_check_sequence
    ON finny_attestations(job_id, check_id, generation, seq DESC)`,
  `CREATE INDEX IF NOT EXISTS finny_attestations_job_sequence ON finny_attestations(job_id, seq)`,
];

function rowToJob(row: Record<string, unknown>): FinnyJob {
  const policy: FinnyPolicySnapshot = {
    policyVersion: row.policy_version as string,
    requiredGenerations: row.required_generations as Record<FinnyCheckId, number>,
  };
  const decidedAt = row.approval_decided_at;
  return {
    id: row.id as string,
    scopeId: row.scope_id as string,
    planDigest: row.plan_digest as string,
    artifactDigest: row.artifact_digest as string,
    policy,
    originThreadRef: row.origin_thread_ref as string,
    provisionalRevision: row.provisional_revision as string,
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
    issuerPrincipalId: row.issuer_principal_id as string,
    issuerRunId: row.issuer_run_id as string,
    idempotencyKey: row.idempotency_key as string,
    createdAt: Number(row.created_at),
  };
}

function sameAttestation(row: FinnyAttestation, input: RecordFinnyAttestationInput): boolean {
  return (
    row.id === input.id &&
    row.jobId === input.jobId &&
    row.checkId === input.checkId &&
    row.generation === input.generation &&
    row.verdict === input.verdict &&
    row.evidenceDigest === input.evidenceDigest &&
    row.issuerPrincipalId === input.issuerPrincipalId &&
    row.issuerRunId === input.issuerRunId
  );
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
  const { q, pool } = createPgPool(connectionString, [{ id: "finny/store/0001", statements: SCHEMA }]);
  return {
    async createJob(input: CreateFinnyJobInput) {
      assertFinnyPolicy(input.policy);
      const now = Date.now();
      const rows = await q(
        `INSERT INTO finny_jobs(
          id, scope_id, plan_digest, artifact_digest, policy_version, required_generations,
          origin_thread_ref, provisional_revision, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
        RETURNING *`,
        [
          input.id,
          input.scopeId,
          input.planDigest,
          input.artifactDigest,
          input.policy.policyVersion,
          JSON.stringify(input.policy.requiredGenerations),
          input.originThreadRef,
          input.provisionalRevision,
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
    async recordApproval(input: RecordFinnyApprovalInput) {
      const rows = await q(
        `UPDATE finny_jobs SET
          approval_request_id=$3, approval_actor_id=$4, approval_action=$5,
          approval_plan_digest=$6, approval_origin_thread_ref=$7, approval_decided_at=$8, updated_at=$8
        WHERE id=$1 AND scope_id=$2 AND plan_digest=$6 AND origin_thread_ref=$7 AND approval_decided_at IS NULL
        RETURNING *`,
        [
          input.jobId,
          input.scopeId,
          input.requestId,
          input.actorId,
          input.action,
          input.planDigest,
          input.originThreadRef,
          input.decidedAt,
        ],
      );
      if (rows[0]) return rowToJob(rows[0]);
      const existing = await q("SELECT * FROM finny_jobs WHERE id = $1 AND scope_id = $2", [
        input.jobId,
        input.scopeId,
      ]);
      if (!existing[0]) throw new Error("Finny job was not found in this scope");
      if (existing[0].approval_decided_at !== null) throw new Error("Finny approval was already decided");
      throw new Error("Finny approval binding does not match the job");
    },
    async recordAttestation(input: RecordFinnyAttestationInput) {
      return withPgTransaction(await pool(), async (db) => {
        const job = await lockedJob(db, input.scopeId, input.jobId);
        if (job.finalized_at !== null) throw new Error("Finny job is already finalized");
        const policy: FinnyPolicySnapshot = {
          policyVersion: job.policy_version as string,
          requiredGenerations: job.required_generations as Record<FinnyCheckId, number>,
        };
        assertFinnyPolicy(policy);
        const requiredGeneration = policy.requiredGenerations[input.checkId];
        if (requiredGeneration === undefined) throw new Error("Finny attestation is not for a required check");
        if (input.generation !== requiredGeneration) throw new Error("Finny attestation generation is not current");
        const now = Date.now();
        const inserted = await db.query(
          `INSERT INTO finny_attestations(
            id, job_id, check_id, generation, verdict, evidence_digest,
            issuer_principal_id, issuer_run_id, idempotency_key, created_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT (idempotency_key) DO NOTHING
          RETURNING *`,
          [
            input.id,
            input.jobId,
            input.checkId,
            input.generation,
            input.verdict,
            input.evidenceDigest,
            input.issuerPrincipalId,
            input.issuerRunId,
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
    async finalize(input: FinalizeFinnyInput, sign: FinnyReceiptSigner): Promise<FinnyFinalReceipt> {
      return withPgTransaction(await pool(), async (db) => {
        const row = await lockedJob(db, input.scopeId, input.jobId);
        if (row.final_receipt !== null) {
          if (row.finalization_key !== input.idempotencyKey) {
            throw new Error("Finny job was finalized with a different idempotency key");
          }
          return row.final_receipt as FinnyFinalReceipt;
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
