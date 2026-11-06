import { isDeepStrictEqual } from "node:util";
import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import type { Destination } from "../types.ts";
import type { FinnyParentBindingSnapshot } from "./integration.ts";
import type { CreateFinnyJobInput } from "./store.ts";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS finny_plan_intents(
    job_id TEXT PRIMARY KEY CHECK (job_id <> ''),
    job_input JSONB NOT NULL CHECK (jsonb_typeof(job_input) = 'object'),
    parent_input JSONB NOT NULL CHECK (jsonb_typeof(parent_input) = 'object'),
    created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS finny_integration_jobs(
    job_id TEXT PRIMARY KEY REFERENCES finny_jobs(id) ON DELETE CASCADE,
    scope_id TEXT NOT NULL CHECK (scope_id <> ''),
    request_id TEXT NOT NULL UNIQUE CHECK (request_id <> ''),
    actor_id TEXT NOT NULL CHECK (actor_id <> ''),
    origin_thread_ref TEXT NOT NULL CHECK (origin_thread_ref <> ''),
    destination JSONB NOT NULL CHECK (jsonb_typeof(destination) = 'object'),
    parent_binding JSONB NOT NULL CHECK (jsonb_typeof(parent_binding) = 'object'),
    created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS finny_artifact_proposals(
    idempotency_key TEXT PRIMARY KEY CHECK (idempotency_key <> ''),
    scope_id TEXT NOT NULL CHECK (scope_id <> ''),
    job_id TEXT NOT NULL REFERENCES finny_jobs(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL CHECK (session_id <> ''),
    run_id TEXT NOT NULL CHECK (run_id <> ''),
    artifact_digest TEXT NOT NULL CHECK (artifact_digest <> ''),
    provisional_revision TEXT NOT NULL CHECK (provisional_revision <> ''),
    created_at BIGINT NOT NULL
  )`,
];

export interface FinnyIntegrationParentRecord {
  scopeId: string;
  jobId: string;
  requestId: string;
  actorId: string;
  originThreadRef: string;
  destination: Destination;
  binding: FinnyParentBindingSnapshot;
}

export interface FinnyPlanIntent {
  job: CreateFinnyJobInput;
  parent: FinnyIntegrationParentRecord;
}
export interface FinnyArtifactProposal {
  scopeId: string;
  jobId: string;
  sessionId: string;
  runId: string;
  artifactDigest: string;
  provisionalRevision: string;
  idempotencyKey: string;
}

function parent(row: Record<string, unknown>): FinnyIntegrationParentRecord {
  return {
    scopeId: row.scope_id as string,
    jobId: row.job_id as string,
    requestId: row.request_id as string,
    actorId: row.actor_id as string,
    originThreadRef: row.origin_thread_ref as string,
    destination: row.destination as Destination,
    binding: row.parent_binding as FinnyParentBindingSnapshot,
  };
}

function proposal(row: Record<string, unknown>): FinnyArtifactProposal {
  return {
    scopeId: row.scope_id as string,
    jobId: row.job_id as string,
    sessionId: row.session_id as string,
    runId: row.run_id as string,
    artifactDigest: row.artifact_digest as string,
    provisionalRevision: row.provisional_revision as string,
    idempotencyKey: row.idempotency_key as string,
  };
}

export function createPostgresFinnyIntegrationStore(connectionString: string) {
  const { q, pool } = createPgPool(connectionString, [{ id: "finny/integration/0001", statements: SCHEMA }]);
  return {
    async createPlanIntent(input: FinnyPlanIntent): Promise<void> {
      await q(
        `INSERT INTO finny_plan_intents(job_id,job_input,parent_input,created_at)
         VALUES($1,$2,$3,$4) ON CONFLICT(job_id) DO NOTHING`,
        [input.job.id, input.job, input.parent, Date.now()],
      );
      const rows = await q("SELECT job_input,parent_input FROM finny_plan_intents WHERE job_id=$1", [input.job.id]);
      const existing = rows[0] ? { job: rows[0].job_input, parent: rows[0].parent_input } : undefined;
      if (!existing || !isDeepStrictEqual(existing, input)) throw new Error("Finny plan intent idempotency conflict");
    },
    async pendingPlanIntents(): Promise<FinnyPlanIntent[]> {
      const rows = await q("SELECT job_input,parent_input FROM finny_plan_intents ORDER BY created_at,job_id");
      return rows.map((row) => ({
        job: row.job_input as unknown as CreateFinnyJobInput,
        parent: row.parent_input as unknown as FinnyIntegrationParentRecord,
      }));
    },
    async completePlanIntent(input: FinnyIntegrationParentRecord): Promise<void> {
      await this.createApprovalBoundParent(input);
      await q("DELETE FROM finny_plan_intents WHERE job_id=$1", [input.jobId]);
    },
    async createApprovalBoundParent(input: FinnyIntegrationParentRecord): Promise<void> {
      await withPgTransaction(await pool(), async (db) => {
        const jobResult = await db.query("SELECT * FROM finny_jobs WHERE id=$1 AND scope_id=$2 FOR UPDATE", [
          input.jobId,
          input.scopeId,
        ]);
        const job = jobResult.rows[0] as Record<string, unknown> | undefined;
        if (!job || job.origin_thread_ref !== input.originThreadRef)
          throw new Error("Finny approval parent does not match the job");
        await db.query(
          `INSERT INTO finny_approval_requests(request_id,scope_id,job_id,plan_digest,origin_thread_ref,authorized_actor_id,created_at)
           VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(request_id) DO NOTHING`,
          [
            input.requestId,
            input.scopeId,
            input.jobId,
            job.plan_digest,
            input.originThreadRef,
            input.actorId,
            Date.now(),
          ],
        );
        await db.query(
          `INSERT INTO finny_integration_jobs(job_id,scope_id,request_id,actor_id,origin_thread_ref,destination,parent_binding,created_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(job_id) DO NOTHING`,
          [
            input.jobId,
            input.scopeId,
            input.requestId,
            input.actorId,
            input.originThreadRef,
            input.destination,
            input.binding,
            Date.now(),
          ],
        );
        const stored = await db.query("SELECT * FROM finny_integration_jobs WHERE job_id=$1", [input.jobId]);
        const existing = stored.rows[0] ? parent(stored.rows[0] as Record<string, unknown>) : undefined;
        const approval = await db.query("SELECT * FROM finny_approval_requests WHERE request_id=$1", [input.requestId]);
        const request = approval.rows[0] as Record<string, unknown> | undefined;
        if (
          !existing ||
          !isDeepStrictEqual(existing, input) ||
          !request ||
          request.scope_id !== input.scopeId ||
          request.job_id !== input.jobId ||
          request.authorized_actor_id !== input.actorId ||
          request.origin_thread_ref !== input.originThreadRef
        )
          throw new Error("Finny approval parent idempotency conflict");
      });
    },
    async getParent(scopeId: string, jobId: string): Promise<FinnyIntegrationParentRecord | null> {
      const rows = await q("SELECT * FROM finny_integration_jobs WHERE scope_id=$1 AND job_id=$2", [scopeId, jobId]);
      return rows[0] ? parent(rows[0]) : null;
    },
    async saveArtifactProposal(input: FinnyArtifactProposal): Promise<void> {
      await withPgTransaction(await pool(), async (db) => {
        await db.query(
          `INSERT INTO finny_artifact_proposals(idempotency_key,scope_id,job_id,session_id,run_id,artifact_digest,provisional_revision,created_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(idempotency_key) DO NOTHING`,
          [
            input.idempotencyKey,
            input.scopeId,
            input.jobId,
            input.sessionId,
            input.runId,
            input.artifactDigest,
            input.provisionalRevision,
            Date.now(),
          ],
        );
        const result = await db.query("SELECT * FROM finny_artifact_proposals WHERE idempotency_key=$1", [
          input.idempotencyKey,
        ]);
        const existing = result.rows[0] ? proposal(result.rows[0] as Record<string, unknown>) : undefined;
        if (!existing || !isDeepStrictEqual(existing, input))
          throw new Error("Finny artifact proposal idempotency conflict");
      });
    },
    async getArtifactProposal(idempotencyKey: string): Promise<FinnyArtifactProposal | null> {
      const rows = await q("SELECT * FROM finny_artifact_proposals WHERE idempotency_key=$1", [idempotencyKey]);
      return rows[0] ? proposal(rows[0]) : null;
    },
    async pendingApprovalCards(): Promise<FinnyIntegrationParentRecord[]> {
      const rows = await q(
        `SELECT i.* FROM finny_integration_jobs i
         JOIN finny_approval_requests a ON a.request_id=i.request_id AND a.job_id=i.job_id
         WHERE a.decided_at IS NULL ORDER BY a.created_at, i.job_id`,
      );
      return rows.map(parent);
    },
    async readyForFinalization(scopeId: string, jobId: string): Promise<boolean> {
      const jobs = await q(
        `SELECT required_generations,artifact_digest,ledger_head FROM finny_jobs
         WHERE scope_id=$1 AND id=$2 AND approval_action='approve' AND approval_consumed_at IS NULL
           AND pending_rework_seq IS NULL AND unresolved_escalation_seq IS NULL AND artifact_digest IS NOT NULL`,
        [scopeId, jobId],
      );
      const job = jobs[0];
      if (!job) return false;
      const rows = await q(
        `SELECT DISTINCT ON (check_id) check_id,generation,verdict,artifact_digest,seq
         FROM finny_attestations WHERE job_id=$1 ORDER BY check_id,seq DESC`,
        [jobId],
      );
      const required = job.required_generations as Record<string, number>;
      const latest = new Map(rows.map((row) => [row.check_id as string, row]));
      let ledgerHead = 0;
      for (const [checkId, generation] of Object.entries(required)) {
        const attestation = latest.get(checkId);
        if (
          !attestation ||
          Number(attestation.generation) !== generation ||
          attestation.verdict !== "pass" ||
          attestation.artifact_digest !== job.artifact_digest
        )
          return false;
        ledgerHead = Math.max(ledgerHead, Number(attestation.seq));
      }
      return ledgerHead === Number(job.ledger_head);
    },
    async finalizedParents(): Promise<FinnyIntegrationParentRecord[]> {
      const rows = await q(
        `SELECT i.* FROM finny_integration_jobs i
         JOIN finny_jobs j ON j.id=i.job_id AND j.scope_id=i.scope_id
         WHERE j.final_receipt IS NOT NULL ORDER BY j.finalized_at, i.job_id`,
      );
      return rows.map(parent);
    },
    async approvedParents(): Promise<FinnyIntegrationParentRecord[]> {
      const rows = await q(
        `SELECT i.* FROM finny_integration_jobs i
         JOIN finny_jobs j ON j.id=i.job_id AND j.scope_id=i.scope_id
         WHERE j.approval_action='approve' AND j.approval_consumed_at IS NULL AND j.final_receipt IS NULL
         ORDER BY j.approval_decided_at, i.job_id`,
      );
      return rows.map(parent);
    },
    async approvedIncomplete(): Promise<FinnyIntegrationParentRecord[]> {
      const rows = await q(
        `SELECT i.* FROM finny_integration_jobs i
         JOIN finny_jobs j ON j.id=i.job_id AND j.scope_id=i.scope_id
         LEFT JOIN finny_runtime_dispatches d ON d.idempotency_key='finny:' || i.job_id || ':' || i.request_id || ':producer-grant' AND d.delivered_at IS NOT NULL
         WHERE j.approval_action='approve' AND j.approval_consumed_at IS NULL AND d.idempotency_key IS NULL
         ORDER BY j.approval_decided_at, i.job_id`,
      );
      return rows.map(parent);
    },
  };
}
