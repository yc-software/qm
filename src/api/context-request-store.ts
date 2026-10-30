import type { SurfaceContextRequest, SurfaceContextResult } from "../types.ts";
import { createMemoryMap } from "../persistence/durable-map.ts";
import { createPgPool, type Rows } from "../persistence/pg-pool.ts";
import { keyValueConversion } from "../persistence/kv-conversion.ts";
import { TENANT } from "../tenants/migrations.ts";
import { pgJsonText, pgTextSafe } from "../util/text.ts";

export type ContextRequestOutcome =
  { status: "done"; result: SurfaceContextResult } | { status: "failed"; error: string };

export function contextOutcome(outcome: { result?: SurfaceContextResult; error?: string }): ContextRequestOutcome {
  return outcome.error !== undefined
    ? { status: "failed", error: outcome.error }
    : { status: "done", result: outcome.result ?? { messages: [] } };
}

export interface ContextRequestStore {
  create(request: SurfaceContextRequest): Promise<void>;
  get(id: string): Promise<SurfaceContextRequest | null>;
  delete(id: string): Promise<void>;
  settle(id: string, outcome: ContextRequestOutcome): Promise<boolean>;
  pending(source: string, createdSince: number): Promise<SurfaceContextRequest[]>;
  expirePending(createdBefore: number): Promise<string[]>;
  close?(): Promise<void>;
}

export const CONTEXT_REQUESTS_MIGRATION = keyValueConversion({
  table: "context_requests",
  columns: [
    "id TEXT NOT NULL",
    "source TEXT NOT NULL",
    "created_at BIGINT NOT NULL",
    "status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed'))",
    "query JSONB NOT NULL",
    "result JSONB",
    "error TEXT",
  ],
  primaryKey: ["id"],
  backfill: {
    id: "id",
    source: "json->>'source'",
    created_at: "(json->>'createdAt')::numeric::bigint",
    status: "json->>'status'",
    query: "json->'query'",
    result: "json->'result'",
    error: "json->>'error'",
  },
  where: `json->>'source' IS NOT NULL AND json->>'createdAt' IS NOT NULL
    AND json->>'status' IN ('pending', 'done', 'failed') AND jsonb_typeof(json->'query') = 'object'`,
  indexes: [
    `CREATE INDEX context_requests_pending ON context_requests(tenant_id, source, created_at)
       WHERE status = 'pending'`,
  ],
});

export function createContextRequestStore(): ContextRequestStore {
  const map = createMemoryMap<SurfaceContextRequest>();
  const pendingRows = async () => (await map.all()).filter((r) => r.status === "pending");
  return {
    create: (request) => map.put(request.id, request),
    get: (id) => map.get(id),
    delete: (id) => map.delete(id),
    async settle(id, outcome) {
      const current = await map.get(id);
      if (!current) return false;
      const { result: _result, error: _error, ...rest } = current;
      await map.put(id, { ...rest, ...outcome });
      return true;
    },
    async pending(source, createdSince) {
      return (await pendingRows()).filter((r) => r.source === source && r.createdAt >= createdSince);
    },
    async expirePending(createdBefore) {
      const stale = (await pendingRows()).filter((r) => r.createdAt < createdBefore);
      await Promise.all(stale.map((r) => map.delete(r.id)));
      return stale.map((r) => r.id);
    },
  };
}

const COLUMNS = "id, source, created_at, status, query, result, error";

function fromRow(row: Rows[number]): SurfaceContextRequest {
  return {
    id: String(row.id),
    source: String(row.source),
    createdAt: Number(row.created_at),
    status: row.status as SurfaceContextRequest["status"],
    query: row.query as SurfaceContextRequest["query"],
    ...(row.result == null ? {} : { result: row.result as SurfaceContextResult }),
    ...(row.error == null ? {} : { error: String(row.error) }),
  };
}

export function createPostgresContextRequestStore(connectionString: string): ContextRequestStore {
  const { q, query, close } = createPgPool(connectionString, [CONTEXT_REQUESTS_MIGRATION]);
  return {
    async create(r) {
      await q(
        `INSERT INTO context_requests(${COLUMNS}) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
         ON CONFLICT (tenant_id, id) DO UPDATE SET source = EXCLUDED.source, created_at = EXCLUDED.created_at,
           status = EXCLUDED.status, query = EXCLUDED.query, result = EXCLUDED.result, error = EXCLUDED.error`,
        [
          r.id,
          r.source,
          r.createdAt,
          r.status,
          pgJsonText(r.query),
          r.result === undefined ? null : pgJsonText(r.result),
          r.error === undefined ? null : pgTextSafe(r.error),
        ],
      );
    },
    async get(id) {
      const rows = await q(`SELECT ${COLUMNS} FROM context_requests WHERE tenant_id = ${TENANT} AND id = $1`, [id]);
      return rows[0] ? fromRow(rows[0]) : null;
    },
    async delete(id) {
      await q(`DELETE FROM context_requests WHERE tenant_id = ${TENANT} AND id = $1`, [id]);
    },
    async settle(id, outcome) {
      const { rowCount } = await query(
        `UPDATE context_requests SET status = $2, result = $3::jsonb, error = $4
          WHERE tenant_id = ${TENANT} AND id = $1`,
        [
          id,
          outcome.status,
          outcome.status === "done" ? pgJsonText(outcome.result) : null,
          outcome.status === "failed" ? pgTextSafe(outcome.error) : null,
        ],
      );
      return rowCount > 0;
    },
    async pending(source, createdSince) {
      const rows = await q(
        `SELECT ${COLUMNS} FROM context_requests
          WHERE tenant_id = ${TENANT} AND source = $1 AND status = 'pending' AND created_at >= $2
          ORDER BY created_at, id`,
        [source, createdSince],
      );
      return rows.map(fromRow);
    },
    async expirePending(createdBefore) {
      const rows = await q(
        `DELETE FROM context_requests
          WHERE tenant_id = ${TENANT} AND status = 'pending' AND created_at < $1 RETURNING id`,
        [createdBefore],
      );
      return rows.map((row) => String(row.id));
    },
    close,
  };
}
