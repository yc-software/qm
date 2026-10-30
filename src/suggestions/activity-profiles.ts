import type { SuggestedActivity } from "../../plugins/chassis/src/suggested-activities.ts";
import type { ManagedCronClaim, ManagedCronProfiles } from "../cron/managed.ts";
import { keyValueConversion } from "../persistence/kv-conversion.ts";
import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import { jsonbStringify, pgTextSafe } from "../util/text.ts";

export interface DismissedActivity {
  id: string;
  title: string;
  at: number;
}

export interface SuggestedActivityProfile extends ManagedCronClaim {
  timezone: string;
  lastSeenAt: number;
  lastBootstrapAt?: number;
  managedAction?: string;
  seeds?: SuggestedActivity[];
  dismissed?: DismissedActivity[];
}

export const SUGGESTED_ACTIVITY_PROFILES_MIGRATION = keyValueConversion({
  table: "suggested_activity_profiles",
  columns: [
    "principal_id TEXT NOT NULL",
    "cron_id TEXT",
    "arming BOOLEAN NOT NULL DEFAULT false",
    "timezone TEXT NOT NULL",
    "last_seen_at BIGINT NOT NULL",
    "last_bootstrap_at BIGINT",
    "managed_action TEXT",
    "seeds JSONB",
    "dismissed JSONB",
  ],
  primaryKey: ["principal_id"],
  backfill: {
    principal_id: "id",
    cron_id: "json->>'cronId'",
    arming: "COALESCE((json->>'arming')::boolean, false)",
    timezone: "COALESCE(json->>'timezone', 'UTC')",
    last_seen_at: "COALESCE((json->>'lastSeenAt')::numeric::bigint, 0)",
    last_bootstrap_at: "(json->>'lastBootstrapAt')::numeric::bigint",
    managed_action: "json->>'managedAction'",
    seeds: "NULLIF(json->'seeds', 'null'::jsonb)",
    dismissed: "NULLIF(json->'dismissed', 'null'::jsonb)",
  },
});

const COLUMNS = "cron_id, arming, timezone, last_seen_at, last_bootstrap_at, managed_action, seeds, dismissed";

const SELECT = `SELECT ${COLUMNS} FROM suggested_activity_profiles WHERE tenant_id = qm_tenant_id() AND principal_id = $1`;

function toProfile(r: Record<string, unknown>): SuggestedActivityProfile {
  return {
    ...(r.cron_id !== null ? { cronId: r.cron_id as string } : {}),
    ...(r.arming ? { arming: true } : {}),
    timezone: r.timezone as string,
    lastSeenAt: Number(r.last_seen_at),
    ...(r.last_bootstrap_at !== null ? { lastBootstrapAt: Number(r.last_bootstrap_at) } : {}),
    ...(r.managed_action !== null ? { managedAction: r.managed_action as string } : {}),
    ...(r.seeds !== null ? { seeds: r.seeds as SuggestedActivity[] } : {}),
    ...(r.dismissed !== null ? { dismissed: r.dismissed as DismissedActivity[] } : {}),
  };
}

const profileParams = (principalId: string, p: SuggestedActivityProfile): unknown[] => [
  principalId,
  p.cronId ?? null,
  p.arming === true,
  p.timezone,
  p.lastSeenAt,
  p.lastBootstrapAt ?? null,
  p.managedAction === undefined ? null : pgTextSafe(p.managedAction),
  p.seeds === undefined ? null : jsonbStringify(p.seeds),
  p.dismissed === undefined ? null : jsonbStringify(p.dismissed),
];

export function createPostgresSuggestedActivityProfiles(
  connectionString: string,
): ManagedCronProfiles<SuggestedActivityProfile> {
  const { q, pool } = createPgPool(connectionString, [SUGGESTED_ACTIVITY_PROFILES_MIGRATION]);
  return {
    async get(principalId) {
      const rows = await q(SELECT, [principalId]);
      return rows[0] ? toProfile(rows[0]) : null;
    },
    async insertIfAbsent(principalId, initial) {
      const rows = await q(
        `INSERT INTO suggested_activity_profiles(principal_id, ${COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
         ON CONFLICT (tenant_id, principal_id) DO UPDATE SET principal_id = suggested_activity_profiles.principal_id
         RETURNING ${COLUMNS}`,
        profileParams(principalId, initial),
      );
      return toProfile(rows[0]!);
    },
    async update(principalId, apply) {
      return withPgTransaction(await pool(), async (client) => {
        const current = await client.query(`${SELECT} FOR UPDATE`, [principalId]);
        if (!current.rows[0]) return null;
        const next = apply(toProfile(current.rows[0]));
        await client.query(
          `UPDATE suggested_activity_profiles SET (${COLUMNS}) = ($2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
            WHERE tenant_id = qm_tenant_id() AND principal_id = $1`,
          profileParams(principalId, next),
        );
        return next;
      });
    },
  };
}

export function createMemorySuggestedActivityProfiles(): ManagedCronProfiles<SuggestedActivityProfile> {
  const profiles = new Map<string, SuggestedActivityProfile>();
  return {
    async get(principalId) {
      const profile = profiles.get(principalId);
      return profile ? structuredClone(profile) : null;
    },
    async insertIfAbsent(principalId, initial) {
      if (!profiles.has(principalId)) profiles.set(principalId, structuredClone(initial));
      return structuredClone(profiles.get(principalId)!);
    },
    async update(principalId, apply) {
      const current = profiles.get(principalId);
      if (!current) return null;
      const next = apply(structuredClone(current));
      profiles.set(principalId, structuredClone(next));
      return next;
    },
  };
}
