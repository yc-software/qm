import { createPgPool } from "../persistence/pg-pool.ts";
import type { ScopeId } from "../types.ts";
import type { AuditEvent, AuditLog } from "../audit/audit-log.ts";
import { reportFailureAs } from "../util/errors.ts";
import { likeContains } from "../persistence/like.ts";

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
  const pg = createPgPool(connectionString);

  const pendingWrites = new Set<Promise<void>>();
  const log: AuditLog = {
    record(tenant, e) {
      const write = pg
        .forTenant(tenant)
        .q(`INSERT INTO audit_log(${COLS}, tenant_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
          e.at,
          e.principalId,
          e.action,
          e.resource,
          e.scopeLabel,
          e.status ?? null,
          e.detail ?? null,
          tenant.id,
        ])
        .then(() => undefined)
        .catch(reportFailureAs("audit: persist event", undefined));
      pendingWrites.add(write);
      void write.finally(() => pendingWrites.delete(write));
    },
    async recordOnce(tenant, key, e) {
      await pg.forTenant(tenant).q(
        `INSERT INTO audit_log(${COLS}, idempotency_key, tenant_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
        [e.at, e.principalId, e.action, e.resource, e.scopeLabel, e.status ?? null, e.detail ?? null, key, tenant.id],
      );
    },
    async events(tenant) {
      await Promise.allSettled(pendingWrites);
      const rows = await pg
        .forTenant(tenant)
        .q(`SELECT ${COLS} FROM audit_log WHERE tenant_id = $1 ORDER BY at DESC, id DESC LIMIT $2`, [tenant.id, MAX]);
      return rows.map(rowToEvent).reverse();
    },
    async tail(tenant, { limit, scopeLabel, action, since, resourceContains }) {
      await Promise.allSettled(pendingWrites);
      if (Array.isArray(action) && action.length !== 1) {
        const batches = await Promise.all(
          action.map((a) => log.tail(tenant, { limit, scopeLabel, action: a, since, resourceContains })),
        );
        return batches
          .flat()
          .sort((a, b) => b.at - a.at)
          .slice(0, limit);
      }
      const params: unknown[] = [tenant.id];
      const conds: string[] = ["tenant_id = $1"];
      if (scopeLabel !== undefined) {
        params.push(scopeLabel);
        conds.push(`scope_label = $${params.length}`);
      }
      if (action !== undefined) {
        params.push(typeof action === "string" ? action : action[0]);
        conds.push(`action = $${params.length}`);
      }
      if (since !== undefined) {
        params.push(since);
        conds.push(`at >= $${params.length}`);
      }
      if (resourceContains !== undefined) {
        params.push(likeContains(resourceContains));
        conds.push(`resource LIKE $${params.length} ESCAPE '\\'`);
      }
      params.push(limit);
      const rows = await pg
        .forTenant(tenant)
        .q(
          `SELECT ${COLS} FROM audit_log WHERE ${conds.join(" AND ")} ORDER BY at DESC, id DESC LIMIT $${params.length}`,
          params,
        );
      return rows.map(rowToEvent);
    },
  };
  return log;
}
