import { createPgPool } from "../persistence/pg-pool.ts";
import type { ScopeId } from "../types.ts";
import type { AuditEvent, AuditLog } from "../audit/audit-log.ts";
import { errMessage } from "../util/errors.ts";

function rowToEvent(r: Record<string, unknown>): AuditEvent {
  return {
    at: Number(r.at),
    principalId: String(r.principal_id),
    action: String(r.action),
    resource: String(r.resource),
    scopeLabel: r.scope_label as ScopeId,
    ...(r.status == null ? {} : { status: String(r.status) }),
    ...(r.detail == null ? {} : { detail: String(r.detail) }),
  };
}

const COLS = "at, principal_id, action, resource, scope_label, status, detail";
const MAX = 50000;

export function createPostgresAuditLog(connectionString: string): AuditLog {
  const { q } = createPgPool(connectionString, [
    `CREATE TABLE IF NOT EXISTS audit_log(
        id BIGSERIAL PRIMARY KEY,
        at BIGINT NOT NULL,
        principal_id TEXT NOT NULL,
        action TEXT NOT NULL,
        resource TEXT NOT NULL,
        scope_label TEXT NOT NULL,
        status TEXT,
        detail TEXT
      )`,
    `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS idempotency_key TEXT`,
    `CREATE INDEX IF NOT EXISTS audit_log_by_at ON audit_log(at DESC)`,
    `CREATE INDEX IF NOT EXISTS audit_log_by_scope_at ON audit_log(scope_label, at DESC)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS audit_log_by_idempotency_key ON audit_log(idempotency_key) WHERE idempotency_key IS NOT NULL`,
    `DO $$
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('agent-platform:audit-log-migrate'));
        IF to_regclass('public.audit_events') IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM audit_log LIMIT 1) THEN
          INSERT INTO audit_log (at, principal_id, action, resource, scope_label, status, detail)
          SELECT (json->>'at')::bigint, json->>'principalId', json->>'action', json->>'resource',
                 json->>'scopeLabel', json->>'status', json->>'detail'
          FROM audit_events
          WHERE json ? 'at'
          ORDER BY (json->>'at')::bigint ASC;
        END IF;
      END $$`,
  ]);

  const pendingWrites = new Set<Promise<void>>();
  return {
    record(e) {
      const write = q(`INSERT INTO audit_log(${COLS}) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
        e.at,
        e.principalId,
        e.action,
        e.resource,
        e.scopeLabel,
        e.status ?? null,
        e.detail ?? null,
      ])
        .then(() => undefined)
        .catch((err) => console.error("[audit] failed to persist event to durable store:", errMessage(err)));
      pendingWrites.add(write);
      void write.finally(() => pendingWrites.delete(write));
    },
    async recordOnce(key, e) {
      await q(
        `INSERT INTO audit_log(${COLS}, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
        [e.at, e.principalId, e.action, e.resource, e.scopeLabel, e.status ?? null, e.detail ?? null, key],
      );
    },
    async events() {
      await Promise.allSettled(pendingWrites);
      const rows = await q(`SELECT ${COLS} FROM audit_log ORDER BY at DESC, id DESC LIMIT $1`, [MAX]);
      return rows.map(rowToEvent).reverse();
    },
    async tail({ limit, scopeLabel, action, since }) {
      await Promise.allSettled(pendingWrites);
      const params: unknown[] = [];
      const conds: string[] = [];
      if (scopeLabel !== undefined) {
        params.push(scopeLabel);
        conds.push(`scope_label = $${params.length}`);
      }
      if (action !== undefined) {
        params.push(action);
        conds.push(`action = $${params.length}`);
      }
      if (since !== undefined) {
        params.push(since);
        conds.push(`at >= $${params.length}`);
      }
      const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
      params.push(limit);
      const rows = await q(
        `SELECT ${COLS} FROM audit_log ${where} ORDER BY at DESC, id DESC LIMIT $${params.length}`,
        params,
      );
      return rows.map(rowToEvent);
    },
  };
}
