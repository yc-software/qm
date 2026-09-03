import { randomUUID } from "node:crypto";
import { createPgPool } from "../persistence/pg-pool.ts";
import type { ScopeId } from "../types.ts";
import type { UpdateJob, UpdateJobState, UpdateJobStore } from "./update-job-store.ts";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS update_jobs(
    id TEXT PRIMARY KEY,
    scope_id TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    current_version TEXT NOT NULL,
    target_version TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('dispatching', 'queued', 'running', 'succeeded', 'failed')),
    detail TEXT,
    run_url TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS update_jobs_one_open_per_scope
    ON update_jobs(scope_id) WHERE state IN ('dispatching', 'queued', 'running')`,
  `CREATE INDEX IF NOT EXISTS update_jobs_scope_created ON update_jobs(scope_id, created_at DESC)`,
];

function rowToJob(row: Record<string, unknown>): UpdateJob {
  return {
    id: String(row.id),
    scopeId: row.scope_id as ScopeId,
    requestedBy: String(row.requested_by),
    currentVersion: String(row.current_version),
    targetVersion: String(row.target_version),
    state: row.state as UpdateJobState,
    ...(row.detail === null ? {} : { detail: String(row.detail) }),
    ...(row.run_url === null ? {} : { runUrl: String(row.run_url) }),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function createPostgresUpdateJobStore(connectionString: string, now: () => number = Date.now): UpdateJobStore {
  const pg = createPgPool(connectionString, SCHEMA);
  const q = pg.query;
  const latestOpen = async (scopeId: ScopeId): Promise<UpdateJob | null> => {
    const { rows } = await q(
      `SELECT * FROM update_jobs
       WHERE scope_id = $1 AND state IN ('dispatching', 'queued', 'running')
       ORDER BY created_at DESC LIMIT 1`,
      [scopeId],
    );
    return rows[0] ? rowToJob(rows[0]) : null;
  };

  return {
    async create(input) {
      const at = now();
      try {
        const { rows } = await q(
          `INSERT INTO update_jobs(
             id, scope_id, requested_by, current_version, target_version, state, created_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5,'dispatching',$6,$6) RETURNING *`,
          [randomUUID(), input.scopeId, input.requestedBy, input.currentVersion, input.targetVersion, at],
        );
        return { job: rowToJob(rows[0]!), created: true };
      } catch (error) {
        if ((error as { code?: string }).code !== "23505") throw error;
        const existing = await latestOpen(input.scopeId);
        if (!existing) throw error;
        return { job: existing, created: false };
      }
    },
    async get(scopeId, id) {
      const { rows } = await q("SELECT * FROM update_jobs WHERE scope_id = $1 AND id = $2", [scopeId, id]);
      return rows[0] ? rowToJob(rows[0]) : null;
    },
    async latest(scopeId) {
      const { rows } = await q(
        "SELECT * FROM update_jobs WHERE scope_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1",
        [scopeId],
      );
      return rows[0] ? rowToJob(rows[0]) : null;
    },
    async update(scopeId, id, expectedState, patch) {
      const { rows } = await q(
        `UPDATE update_jobs
         SET state = $4, detail = COALESCE($5, detail), run_url = COALESCE($6, run_url), updated_at = $7
         WHERE scope_id = $1 AND id = $2 AND state = $3 RETURNING *`,
        [scopeId, id, expectedState, patch.state, patch.detail ?? null, patch.runUrl ?? null, now()],
      );
      return rows[0] ? rowToJob(rows[0]) : null;
    },
    close: pg.close,
  };
}
