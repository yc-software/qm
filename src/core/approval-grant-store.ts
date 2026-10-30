import type { CommandApprovalGrant } from "../types.ts";
import { currentTenant } from "../tenants/context.ts";
import { createPgPool, type Rows } from "../persistence/pg-pool.ts";
import { typedTableMigration } from "../persistence/typed-table-migration.ts";
import { TENANCY_BASE, TENANT } from "../tenants/migrations.ts";
import { pgTextSafe } from "../util/text.ts";

export interface ApprovalGrantStore {
  forActors(actorIds: readonly string[]): Promise<CommandApprovalGrant[]>;
  put(id: string, grant: CommandApprovalGrant): Promise<void>;
  close?(): Promise<void>;
}

const APPROVAL_GRANTS_MIGRATION = typedTableMigration({
  table: "approval_grants",
  columns: [
    "id TEXT NOT NULL",
    "actor_id TEXT NOT NULL",
    "command TEXT NOT NULL",
    "scope TEXT NOT NULL CHECK (scope IN ('session', 'always'))",
    "created_at BIGINT NOT NULL",
    "session_id TEXT",
    "approval_key TEXT",
  ],
  primaryKey: ["id"],
  backfill: {
    id: "id",
    actor_id: "json->>'actorId'",
    command: "json->>'command'",
    scope: "json->>'scope'",
    created_at: "(json->>'createdAt')::numeric::bigint",
    session_id: "json->>'sessionId'",
    approval_key: "json->>'approvalKey'",
  },
  where: `json->>'actorId' IS NOT NULL AND json->>'command' IS NOT NULL
    AND json->>'scope' IN ('session', 'always') AND json->>'createdAt' IS NOT NULL`,
  indexes: ["CREATE INDEX approval_grants_by_actor ON approval_grants(tenant_id, lower(actor_id))"],
});

export function createApprovalGrantStore(): ApprovalGrantStore {
  const byTenant = new Map<string, Map<string, CommandApprovalGrant>>();
  const rows = () => {
    const tenant = currentTenant();
    return byTenant.get(tenant) ?? byTenant.set(tenant, new Map()).get(tenant)!;
  };
  return {
    async forActors(actorIds) {
      const wanted = new Set(actorIds.map((id) => id.toLowerCase()));
      return [...rows().values()].filter((grant) => wanted.has(grant.actorId.toLowerCase()));
    },
    put: async (id, grant) => void rows().set(id, grant),
  };
}

function fromRow(row: Rows[number]): CommandApprovalGrant {
  return {
    actorId: String(row.actor_id),
    command: String(row.command),
    scope: row.scope as CommandApprovalGrant["scope"],
    createdAt: Number(row.created_at),
    ...(row.session_id == null ? {} : { sessionId: String(row.session_id) }),
    ...(row.approval_key == null ? {} : { approvalKey: String(row.approval_key) }),
  };
}

export function createPostgresApprovalGrantStore(connectionString: string): ApprovalGrantStore {
  const { q, close } = createPgPool(connectionString, [TENANCY_BASE, APPROVAL_GRANTS_MIGRATION]);
  return {
    async forActors(actorIds) {
      if (!actorIds.length) return [];
      const rows = await q(
        `SELECT actor_id, command, scope, created_at, session_id, approval_key FROM approval_grants
          WHERE tenant_id = ${TENANT} AND lower(actor_id) = ANY($1::text[]) ORDER BY id`,
        [[...new Set(actorIds.map((id) => id.toLowerCase()))]],
      );
      return rows.map(fromRow);
    },
    async put(id, grant) {
      await q(
        `INSERT INTO approval_grants(id, actor_id, command, scope, created_at, session_id, approval_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, id) DO UPDATE SET
           actor_id = EXCLUDED.actor_id, command = EXCLUDED.command, scope = EXCLUDED.scope,
           created_at = EXCLUDED.created_at, session_id = EXCLUDED.session_id, approval_key = EXCLUDED.approval_key`,
        [
          id,
          pgTextSafe(grant.actorId),
          pgTextSafe(grant.command),
          grant.scope,
          grant.createdAt,
          grant.sessionId ?? null,
          grant.approvalKey == null ? null : pgTextSafe(grant.approvalKey),
        ],
      );
    },
    close,
  };
}
