import { createHash } from "node:crypto";
import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import type { FinnyWorkerRole } from "./types.ts";

export type FinnyRuntimeRole = "parent" | FinnyWorkerRole;

export interface FinnyRuntimeBinding {
  scopeId: string;
  jobId: string;
  sessionId: string;
  runId: string;
  role: FinnyRuntimeRole;
  principalId: string;
  epoch: number;
  active: boolean;
}

export interface InitialFinnyRuntimeBindings {
  scopeId: string;
  jobId: string;
  parentSessionId: string;
  parentRunId: string;
  producerSessionId: string;
  producerRunId: string;
  auditorSessionId: string;
  auditorRunId: string;
  producerPrincipalId: string;
  auditorPrincipalId: string;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS finny_runtime_bindings(
    session_id TEXT PRIMARY KEY CHECK (session_id <> ''),
    run_id TEXT NOT NULL UNIQUE CHECK (run_id <> ''),
    scope_id TEXT NOT NULL CHECK (scope_id <> ''),
    job_id TEXT NOT NULL REFERENCES finny_jobs(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('parent','producer','auditor')),
    principal_id TEXT NOT NULL CHECK (principal_id <> ''),
    epoch BIGINT NOT NULL CHECK (epoch >= 0),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at BIGINT NOT NULL,
    UNIQUE(job_id, role, epoch)
  )`,
  `CREATE INDEX IF NOT EXISTS finny_runtime_bindings_job_active
    ON finny_runtime_bindings(job_id, active, role)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS finny_runtime_bindings_one_active_role
    ON finny_runtime_bindings(job_id, role) WHERE active=TRUE`,
  `CREATE TABLE IF NOT EXISTS finny_runtime_actions(
    idempotency_key TEXT PRIMARY KEY CHECK (idempotency_key <> ''),
    kind TEXT NOT NULL CHECK (kind <> ''),
    session_id TEXT NOT NULL REFERENCES finny_runtime_bindings(session_id),
    run_id TEXT NOT NULL CHECK (run_id <> ''),
    scope_id TEXT NOT NULL CHECK (scope_id <> ''),
    job_id TEXT NOT NULL REFERENCES finny_jobs(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('producer','auditor')),
    request_digest TEXT NOT NULL CHECK (request_digest <> ''),
    authority_payload JSONB NOT NULL CHECK (jsonb_typeof(authority_payload) = 'object'),
    created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS finny_runtime_dispatches(
    idempotency_key TEXT PRIMARY KEY CHECK (idempotency_key <> ''),
    scope_id TEXT NOT NULL CHECK (scope_id <> ''),
    job_id TEXT NOT NULL REFERENCES finny_jobs(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES finny_runtime_bindings(session_id),
    run_id TEXT NOT NULL CHECK (run_id <> ''),
    kind TEXT NOT NULL CHECK (kind <> ''),
    intent_digest TEXT NOT NULL CHECK (intent_digest <> ''),
    delivered_at BIGINT,
    created_at BIGINT NOT NULL
  )`,
];

function rowToBinding(row: Record<string, unknown>): FinnyRuntimeBinding {
  return {
    scopeId: row.scope_id as string,
    jobId: row.job_id as string,
    sessionId: row.session_id as string,
    runId: row.run_id as string,
    role: row.role as FinnyRuntimeRole,
    principalId: row.principal_id as string,
    epoch: Number(row.epoch),
    active: row.active as boolean,
  };
}

interface FinnyRuntimeActionInput {
  idempotencyKey: string;
  kind: string;
  sessionId: string;
  runId: string;
  scopeId: string;
  jobId: string;
  role: FinnyWorkerRole;
  requestDigest: string;
}

export function createPostgresFinnyRuntimeStore(connectionString: string) {
  const { q, pool } = createPgPool(connectionString, [{ id: "finny/runtime/0001", statements: SCHEMA }]);
  return {
    async bindInitial(input: InitialFinnyRuntimeBindings): Promise<void> {
      const bindings: Array<[string, string, FinnyRuntimeRole, string, number]> = [
        [input.parentSessionId, input.parentRunId, "parent", input.producerPrincipalId, 0],
        [input.producerSessionId, input.producerRunId, "producer", input.producerPrincipalId, 0],
        [input.auditorSessionId, input.auditorRunId, "auditor", input.auditorPrincipalId, 1],
      ];
      await withPgTransaction(await pool(), async (db) => {
        for (const [sessionId, runId, role, principalId, epoch] of bindings) {
          await db.query(
            `INSERT INTO finny_runtime_bindings(
              session_id,run_id,scope_id,job_id,role,principal_id,epoch,created_at
             ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT(session_id) DO NOTHING`,
            [sessionId, runId, input.scopeId, input.jobId, role, principalId, epoch, Date.now()],
          );
          const { rows } = await db.query("SELECT * FROM finny_runtime_bindings WHERE session_id=$1", [sessionId]);
          const binding = rows[0] ? rowToBinding(rows[0] as Record<string, unknown>) : undefined;
          if (
            !binding ||
            binding.scopeId !== input.scopeId ||
            binding.jobId !== input.jobId ||
            binding.runId !== runId ||
            binding.role !== role ||
            binding.principalId !== principalId ||
            binding.epoch !== epoch
          ) {
            throw new Error("Finny runtime binding idempotency conflict");
          }
        }
      });
    },
    async currentBinding(sessionId: string): Promise<FinnyRuntimeBinding | null> {
      const rows = await q("SELECT * FROM finny_runtime_bindings WHERE session_id=$1 AND active=TRUE", [sessionId]);
      return rows[0] ? rowToBinding(rows[0]) : null;
    },
    async currentRoleBinding(
      scopeId: string,
      jobId: string,
      role: FinnyRuntimeRole,
    ): Promise<FinnyRuntimeBinding | null> {
      const rows = await q(
        "SELECT * FROM finny_runtime_bindings WHERE scope_id=$1 AND job_id=$2 AND role=$3 AND active=TRUE ORDER BY epoch DESC LIMIT 1",
        [scopeId, jobId, role],
      );
      return rows[0] ? rowToBinding(rows[0]) : null;
    },
    async bindAuditor(input: {
      scopeId: string;
      jobId: string;
      sessionId: string;
      runId: string;
      principalId: string;
    }): Promise<FinnyRuntimeBinding> {
      return withPgTransaction(await pool(), async (db) => {
        await db.query("SELECT id FROM finny_jobs WHERE id=$1 AND scope_id=$2 FOR UPDATE", [
          input.jobId,
          input.scopeId,
        ]);
        const active = await db.query(
          "SELECT * FROM finny_runtime_bindings WHERE job_id=$1 AND role='auditor' AND active=TRUE",
          [input.jobId],
        );
        if (active.rows[0]) {
          const binding = rowToBinding(active.rows[0] as Record<string, unknown>);
          if (binding.sessionId !== input.sessionId || binding.runId !== input.runId) {
            throw new Error("Finny runtime already has a current Auditor");
          }
          return binding;
        }
        const epochs = await db.query(
          "SELECT COALESCE(MAX(epoch),0) AS epoch FROM finny_runtime_bindings WHERE job_id=$1 AND role='auditor'",
          [input.jobId],
        );
        const epoch = Number(epochs.rows[0]?.epoch) + 1;
        await db.query(
          `INSERT INTO finny_runtime_bindings(
            session_id,run_id,scope_id,job_id,role,principal_id,epoch,created_at
           ) VALUES($1,$2,$3,$4,'auditor',$5,$6,$7) ON CONFLICT(session_id) DO NOTHING`,
          [input.sessionId, input.runId, input.scopeId, input.jobId, input.principalId, epoch, Date.now()],
        );
        const inserted = await db.query("SELECT * FROM finny_runtime_bindings WHERE session_id=$1", [input.sessionId]);
        const binding = inserted.rows[0] ? rowToBinding(inserted.rows[0] as Record<string, unknown>) : undefined;
        if (
          !binding ||
          binding.scopeId !== input.scopeId ||
          binding.jobId !== input.jobId ||
          binding.runId !== input.runId ||
          binding.role !== "auditor" ||
          binding.principalId !== input.principalId ||
          !binding.active
        ) {
          throw new Error("Finny runtime Auditor binding idempotency conflict");
        }
        return binding;
      });
    },
    async retireWorkers(scopeId: string, jobId: string): Promise<void> {
      await q(
        "UPDATE finny_runtime_bindings SET active=FALSE WHERE scope_id=$1 AND job_id=$2 AND role IN ('producer','auditor')",
        [scopeId, jobId],
      );
    },
    async retireBinding(input: { sessionId: string; runId: string; role: FinnyRuntimeRole }): Promise<void> {
      const rows = await q(
        "UPDATE finny_runtime_bindings SET active=FALSE WHERE session_id=$1 AND run_id=$2 AND role=$3 RETURNING session_id",
        [input.sessionId, input.runId, input.role],
      );
      if (!rows[0]) {
        const existing = await q(
          "SELECT session_id FROM finny_runtime_bindings WHERE session_id=$1 AND run_id=$2 AND role=$3 AND active=FALSE",
          [input.sessionId, input.runId, input.role],
        );
        if (!existing[0]) throw new Error("Finny runtime binding is not current");
      }
    },
    async prepareAction(
      input: FinnyRuntimeActionInput,
    ): Promise<{ binding: FinnyRuntimeBinding; authorityPayload?: unknown }> {
      return withPgTransaction(await pool(), async (db) => {
        const existing = await db.query("SELECT * FROM finny_runtime_actions WHERE idempotency_key=$1", [
          input.idempotencyKey,
        ]);
        if (existing.rows[0]) {
          const action = existing.rows[0] as Record<string, unknown>;
          if (
            action.kind !== input.kind ||
            action.session_id !== input.sessionId ||
            action.run_id !== input.runId ||
            action.scope_id !== input.scopeId ||
            action.job_id !== input.jobId ||
            action.role !== input.role ||
            action.request_digest !== input.requestDigest
          ) {
            throw new Error("Finny runtime action idempotency conflict");
          }
          const historical = await db.query("SELECT * FROM finny_runtime_bindings WHERE session_id=$1", [
            input.sessionId,
          ]);
          if (!historical.rows[0]) throw new Error("Finny runtime action binding is missing");
          return {
            binding: rowToBinding(historical.rows[0] as Record<string, unknown>),
            authorityPayload: action.authority_payload,
          };
        }
        const current = await db.query(
          `SELECT * FROM finny_runtime_bindings
           WHERE session_id=$1 AND run_id=$2 AND scope_id=$3 AND job_id=$4 AND role=$5 AND active=TRUE`,
          [input.sessionId, input.runId, input.scopeId, input.jobId, input.role],
        );
        if (!current.rows[0]) throw new Error(`Finny action requires the current ${input.role} session and run`);
        return { binding: rowToBinding(current.rows[0] as Record<string, unknown>) };
      });
    },
    async authorizeAction(
      input: FinnyRuntimeActionInput & { authorityPayload: Record<string, unknown> },
    ): Promise<{ binding: FinnyRuntimeBinding; authorityPayload: unknown }> {
      return withPgTransaction(await pool(), async (db) => {
        const existing = await db.query("SELECT * FROM finny_runtime_actions WHERE idempotency_key=$1", [
          input.idempotencyKey,
        ]);
        if (existing.rows[0]) {
          const action = existing.rows[0] as Record<string, unknown>;
          if (
            action.kind !== input.kind ||
            action.session_id !== input.sessionId ||
            action.run_id !== input.runId ||
            action.scope_id !== input.scopeId ||
            action.job_id !== input.jobId ||
            action.role !== input.role ||
            action.request_digest !== input.requestDigest
          ) {
            throw new Error("Finny runtime action idempotency conflict");
          }
          const historical = await db.query("SELECT * FROM finny_runtime_bindings WHERE session_id=$1", [
            input.sessionId,
          ]);
          if (!historical.rows[0]) throw new Error("Finny runtime action binding is missing");
          return {
            binding: rowToBinding(historical.rows[0] as Record<string, unknown>),
            authorityPayload: action.authority_payload,
          };
        }
        const current = await db.query(
          `SELECT * FROM finny_runtime_bindings
           WHERE session_id=$1 AND run_id=$2 AND scope_id=$3 AND job_id=$4 AND role=$5 AND active=TRUE FOR UPDATE`,
          [input.sessionId, input.runId, input.scopeId, input.jobId, input.role],
        );
        if (!current.rows[0]) throw new Error(`Finny action requires the current ${input.role} session and run`);
        await db.query(
          `INSERT INTO finny_runtime_actions(
            idempotency_key,kind,session_id,run_id,scope_id,job_id,role,request_digest,authority_payload,created_at
          ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            input.idempotencyKey,
            input.kind,
            input.sessionId,
            input.runId,
            input.scopeId,
            input.jobId,
            input.role,
            input.requestDigest,
            JSON.stringify(input.authorityPayload),
            Date.now(),
          ],
        );
        return {
          binding: rowToBinding(current.rows[0] as Record<string, unknown>),
          authorityPayload: input.authorityPayload,
        };
      });
    },
    async isDispatched(idempotencyKey: string): Promise<boolean> {
      const rows = await q(
        "SELECT delivered_at IS NOT NULL AS delivered FROM finny_runtime_dispatches WHERE idempotency_key=$1",
        [idempotencyKey],
      );
      return rows[0]?.delivered === true;
    },
    async dispatchOnce(
      input: {
        idempotencyKey: string;
        scopeId: string;
        jobId: string;
        sessionId: string;
        runId: string;
        kind: string;
        intent: string;
      },
      send: () => Promise<void>,
    ): Promise<void> {
      const intentDigest = createHash("sha256").update(input.intent).digest("base64url");
      await withPgTransaction(await pool(), async (db) => {
        await db.query(
          `INSERT INTO finny_runtime_dispatches(
            idempotency_key,scope_id,job_id,session_id,run_id,kind,intent_digest,created_at
          ) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(idempotency_key) DO NOTHING`,
          [
            input.idempotencyKey,
            input.scopeId,
            input.jobId,
            input.sessionId,
            input.runId,
            input.kind,
            intentDigest,
            Date.now(),
          ],
        );
        const result = await db.query("SELECT * FROM finny_runtime_dispatches WHERE idempotency_key=$1 FOR UPDATE", [
          input.idempotencyKey,
        ]);
        const row = result.rows[0] as Record<string, unknown> | undefined;
        if (
          !row ||
          row.scope_id !== input.scopeId ||
          row.job_id !== input.jobId ||
          row.session_id !== input.sessionId ||
          row.run_id !== input.runId ||
          row.kind !== input.kind ||
          row.intent_digest !== intentDigest
        ) {
          throw new Error("Finny runtime dispatch idempotency conflict");
        }
        if (row.delivered_at !== null) return;
        await send();
        await db.query("UPDATE finny_runtime_dispatches SET delivered_at=$2 WHERE idempotency_key=$1", [
          input.idempotencyKey,
          Date.now(),
        ]);
      });
    },
  };
}

export type FinnyRuntimeStore = ReturnType<typeof createPostgresFinnyRuntimeStore>;
