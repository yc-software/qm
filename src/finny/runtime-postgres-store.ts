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
  expiresAt?: number;
}

export interface InitialFinnyRuntimeBindings {
  scopeId: string;
  jobId: string;
  parentSessionId: string;
  parentRunId: string;
  parentPrincipalId: string;
  producerExpiresAt: number;
  auditorExpiresAt: number;
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

const EXPIRY_SCHEMA = [`ALTER TABLE finny_runtime_bindings ADD COLUMN IF NOT EXISTS expires_at BIGINT`];

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
    ...(row.expires_at === null || row.expires_at === undefined ? {} : { expiresAt: Number(row.expires_at) }),
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
  const { q, pool } = createPgPool(connectionString, [
    { id: "finny/runtime/0001", statements: SCHEMA },
    { id: "finny/runtime/0002", statements: EXPIRY_SCHEMA },
  ]);
  return {
    async bindParent(input: {
      scopeId: string;
      jobId: string;
      sessionId: string;
      runId: string;
      principalId: string;
    }): Promise<void> {
      await q(
        `INSERT INTO finny_runtime_bindings(session_id,run_id,scope_id,job_id,role,principal_id,epoch,created_at)
         VALUES($1,$2,$3,$4,'parent',$5,0,$6) ON CONFLICT(session_id) DO NOTHING`,
        [input.sessionId, input.runId, input.scopeId, input.jobId, input.principalId, Date.now()],
      );
      const binding = await this.bindingForSession(input.sessionId);
      if (
        !binding ||
        binding.scopeId !== input.scopeId ||
        binding.jobId !== input.jobId ||
        binding.runId !== input.runId ||
        binding.role !== "parent" ||
        binding.principalId !== input.principalId
      )
        throw new Error("Finny parent runtime binding idempotency conflict");
    },
    async bindWorker(input: {
      scopeId: string;
      jobId: string;
      sessionId: string;
      runId: string;
      role: FinnyWorkerRole;
      principalId: string;
      epoch: number;
      expiresAt: number;
    }): Promise<void> {
      if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now())
        throw new Error("Finny worker binding expiry must be in the future");
      await q(
        `INSERT INTO finny_runtime_bindings(session_id,run_id,scope_id,job_id,role,principal_id,epoch,expires_at,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
        [
          input.sessionId,
          input.runId,
          input.scopeId,
          input.jobId,
          input.role,
          input.principalId,
          input.epoch,
          input.expiresAt,
          Date.now(),
        ],
      );
      const binding = await this.bindingForSession(input.sessionId);
      if (
        !binding ||
        binding.scopeId !== input.scopeId ||
        binding.jobId !== input.jobId ||
        binding.role !== input.role ||
        binding.principalId !== input.principalId ||
        binding.epoch !== input.epoch
      )
        throw new Error("Finny worker runtime binding idempotency conflict");
      await q("UPDATE finny_runtime_bindings SET expires_at=$2,active=TRUE WHERE session_id=$1", [
        input.sessionId,
        input.expiresAt,
      ]);
    },
    async bindInitial(input: InitialFinnyRuntimeBindings): Promise<void> {
      if (input.producerExpiresAt <= Date.now() || input.auditorExpiresAt <= Date.now())
        throw new Error("Finny initial worker binding expiry must be in the future");
      const bindings: Array<[string, string, FinnyRuntimeRole, string, number, number | null]> = [
        [input.parentSessionId, input.parentRunId, "parent", input.parentPrincipalId, 0, null],
        [
          input.producerSessionId,
          input.producerRunId,
          "producer",
          input.producerPrincipalId,
          0,
          input.producerExpiresAt,
        ],
        [input.auditorSessionId, input.auditorRunId, "auditor", input.auditorPrincipalId, 1, input.auditorExpiresAt],
      ];
      await withPgTransaction(await pool(), async (db) => {
        for (const [sessionId, runId, role, principalId, epoch, expiresAt] of bindings) {
          await db.query(
            `INSERT INTO finny_runtime_bindings(
              session_id,run_id,scope_id,job_id,role,principal_id,epoch,expires_at,created_at
             ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT(session_id) DO NOTHING`,
            [sessionId, runId, input.scopeId, input.jobId, role, principalId, epoch, expiresAt, Date.now()],
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
            binding.epoch !== epoch ||
            binding.expiresAt !== (expiresAt ?? undefined)
          ) {
            throw new Error("Finny runtime binding idempotency conflict");
          }
        }
      });
    },
    async claimParentTurn(input: {
      sessionId: string;
      runId: string;
      scopeId: string;
      principalId: string;
    }): Promise<FinnyRuntimeBinding | null> {
      const rows = await q(
        `UPDATE finny_runtime_bindings SET run_id=$2
         WHERE session_id=$1 AND scope_id=$3 AND principal_id=$4 AND role='parent' AND active=TRUE
         RETURNING *`,
        [input.sessionId, input.runId, input.scopeId, input.principalId],
      );
      return rows[0] ? rowToBinding(rows[0]) : null;
    },
    async advanceWorkerRun(input: {
      sessionId: string;
      expectedRunId: string;
      runId: string;
      scopeId: string;
      expiresAt: number;
    }): Promise<FinnyRuntimeBinding | null> {
      if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now())
        throw new Error("Finny worker run expiry must be in the future");
      const rows = await q(
        `UPDATE finny_runtime_bindings SET run_id=$3, expires_at=$5
         WHERE session_id=$1 AND run_id IN ($2,$3) AND scope_id=$4 AND role IN ('producer','auditor') AND active=TRUE
         RETURNING *`,
        [input.sessionId, input.expectedRunId, input.runId, input.scopeId, input.expiresAt],
      );
      return rows[0] ? rowToBinding(rows[0]) : null;
    },
    async bindingForSession(sessionId: string): Promise<FinnyRuntimeBinding | null> {
      const rows = await q("SELECT * FROM finny_runtime_bindings WHERE session_id=$1", [sessionId]);
      return rows[0] ? rowToBinding(rows[0]) : null;
    },
    async currentBinding(sessionId: string): Promise<FinnyRuntimeBinding | null> {
      const rows = await q(
        "SELECT * FROM finny_runtime_bindings WHERE session_id=$1 AND active=TRUE AND (role='parent' OR expires_at>$2)",
        [sessionId, Date.now()],
      );
      return rows[0] ? rowToBinding(rows[0]) : null;
    },
    async activeRoleBinding(
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
    async currentRoleBinding(
      scopeId: string,
      jobId: string,
      role: FinnyRuntimeRole,
    ): Promise<FinnyRuntimeBinding | null> {
      const rows = await q(
        "SELECT * FROM finny_runtime_bindings WHERE scope_id=$1 AND job_id=$2 AND role=$3 AND active=TRUE AND (role='parent' OR expires_at>$4) ORDER BY epoch DESC LIMIT 1",
        [scopeId, jobId, role, Date.now()],
      );
      return rows[0] ? rowToBinding(rows[0]) : null;
    },
    async bindAuditor(input: {
      scopeId: string;
      jobId: string;
      sessionId: string;
      runId: string;
      principalId: string;
      expiresAt: number;
    }): Promise<FinnyRuntimeBinding> {
      if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now())
        throw new Error("Finny Auditor binding expiry must be in the future");
      return withPgTransaction(await pool(), async (db) => {
        await db.query("SELECT id FROM finny_jobs WHERE id=$1 AND scope_id=$2 FOR UPDATE", [
          input.jobId,
          input.scopeId,
        ]);
        await db.query(
          "UPDATE finny_runtime_bindings SET active=FALSE WHERE job_id=$1 AND role='auditor' AND active=TRUE AND expires_at<=$2",
          [input.jobId, Date.now()],
        );
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
            session_id,run_id,scope_id,job_id,role,principal_id,epoch,expires_at,created_at
           ) VALUES($1,$2,$3,$4,'auditor',$5,$6,$7,$8) ON CONFLICT(session_id) DO NOTHING`,
          [
            input.sessionId,
            input.runId,
            input.scopeId,
            input.jobId,
            input.principalId,
            epoch,
            input.expiresAt,
            Date.now(),
          ],
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
    async retireJob(scopeId: string, jobId: string): Promise<void> {
      await withPgTransaction(await pool(), async (db) => {
        await db.query(
          "UPDATE finny_runtime_bindings SET active=FALSE WHERE scope_id=$1 AND job_id=$2 AND role IN ('producer','auditor')",
          [scopeId, jobId],
        );
        await db.query("DELETE FROM finny_runtime_bindings WHERE scope_id=$1 AND job_id=$2 AND role='parent'", [
          scopeId,
          jobId,
        ]);
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
           WHERE session_id=$1 AND run_id=$2 AND scope_id=$3 AND job_id=$4 AND role=$5 AND active=TRUE AND expires_at>$6`,
          [input.sessionId, input.runId, input.scopeId, input.jobId, input.role, Date.now()],
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
           WHERE session_id=$1 AND run_id=$2 AND scope_id=$3 AND job_id=$4 AND role=$5 AND active=TRUE AND expires_at>$6 FOR UPDATE`,
          [input.sessionId, input.runId, input.scopeId, input.jobId, input.role, Date.now()],
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
