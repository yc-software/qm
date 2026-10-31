import type { ManagedCronClaim, ManagedCronProfiles } from "../cron/managed.ts";
import { typedTableMigration } from "../persistence/typed-table-migration.ts";
import { perTenant } from "../tenants/context.ts";
import { TENANCY_BASE } from "../tenants/migrations.ts";
import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";

export type MemoryTidyProfile = ManagedCronClaim;

export const MEMORY_TIDY_PROFILES_MIGRATION = typedTableMigration({
  table: "memory_tidy_profiles",
  columns: ["scope_id TEXT NOT NULL", "cron_id TEXT", "arming BOOLEAN NOT NULL DEFAULT false"],
  primaryKey: ["scope_id"],
  backfill: {
    scope_id: "id",
    cron_id: "json->>'cronId'",
    arming: "COALESCE((json->>'arming')::boolean, false)",
  },
});

const toProfile = (r: Record<string, unknown>): MemoryTidyProfile => ({
  ...(r.cron_id !== null ? { cronId: r.cron_id as string } : {}),
  ...(r.arming ? { arming: true } : {}),
});

const SELECT = "SELECT cron_id, arming FROM memory_tidy_profiles WHERE tenant_id = qm_tenant_id() AND scope_id = $1";

export function createPostgresMemoryTidyProfiles(
  connectionString: string,
): ManagedCronProfiles<MemoryTidyProfile> & { close(): Promise<void> } {
  const { q, pool, close } = createPgPool(connectionString, [TENANCY_BASE, MEMORY_TIDY_PROFILES_MIGRATION]);
  return {
    close,
    async get(scopeId) {
      const rows = await q(SELECT, [scopeId]);
      return rows[0] ? toProfile(rows[0]) : null;
    },
    async insertIfAbsent(scopeId, initial) {
      const rows = await q(
        `INSERT INTO memory_tidy_profiles(scope_id, cron_id, arming) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, scope_id) DO UPDATE SET scope_id = memory_tidy_profiles.scope_id
         RETURNING cron_id, arming`,
        [scopeId, initial.cronId ?? null, initial.arming === true],
      );
      return toProfile(rows[0]!);
    },
    async update(scopeId, apply) {
      return withPgTransaction(await pool(), async (client) => {
        const current = await client.query(`${SELECT} FOR UPDATE`, [scopeId]);
        if (!current.rows[0]) return null;
        const next = apply(toProfile(current.rows[0]));
        await client.query(
          `UPDATE memory_tidy_profiles SET cron_id = $2, arming = $3
            WHERE tenant_id = qm_tenant_id() AND scope_id = $1`,
          [scopeId, next.cronId ?? null, next.arming === true],
        );
        return next;
      });
    },
  };
}

export function createMemoryTidyProfiles(): ManagedCronProfiles<MemoryTidyProfile> {
  const mine = perTenant(() => new Map<string, MemoryTidyProfile>());
  return {
    async get(key) {
      const profile = mine().get(key);
      return profile ? structuredClone(profile) : null;
    },
    async insertIfAbsent(key, initial) {
      const profiles = mine();
      if (!profiles.has(key)) profiles.set(key, structuredClone(initial));
      return structuredClone(profiles.get(key)!);
    },
    async update(key, apply) {
      const profiles = mine();
      const current = profiles.get(key);
      if (!current) return null;
      const next = apply(structuredClone(current));
      profiles.set(key, structuredClone(next));
      return next;
    },
  };
}
