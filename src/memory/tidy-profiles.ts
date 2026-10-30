import type { ManagedCronClaim, ManagedCronProfiles } from "../cron/managed.ts";
import { keyValueConversion } from "../persistence/kv-conversion.ts";
import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";

export type MemoryTidyProfile = ManagedCronClaim;

export const MEMORY_TIDY_PROFILES_MIGRATION = keyValueConversion({
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

export function createPostgresMemoryTidyProfiles(connectionString: string): ManagedCronProfiles<MemoryTidyProfile> {
  const { q, pool } = createPgPool(connectionString, [MEMORY_TIDY_PROFILES_MIGRATION]);
  return {
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
  const profiles = new Map<string, MemoryTidyProfile>();
  return {
    async get(scopeId) {
      const profile = profiles.get(scopeId);
      return profile ? { ...profile } : null;
    },
    async insertIfAbsent(scopeId, initial) {
      if (!profiles.has(scopeId)) profiles.set(scopeId, { ...initial });
      return { ...profiles.get(scopeId)! };
    },
    async update(scopeId, apply) {
      const current = profiles.get(scopeId);
      if (!current) return null;
      const next = apply({ ...current });
      profiles.set(scopeId, { ...next });
      return next;
    },
  };
}
