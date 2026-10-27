import { createPgPool, tenantCols } from "../persistence/pg-pool.ts";
import { tenant } from "../tenant.ts";

export const BOT_MODES = ["ignore", "rollup", "action", "user"] as const;
export const DEFAULT_ROLLUP_HOURS = 24;
export type BotPolicy = { mode: (typeof BOT_MODES)[number]; rollupHours?: number };

export function parseBotLedger(input: unknown): { bots: Record<string, BotPolicy> } | { error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return { error: "bots must be an object keyed by bot author name" };
  const entries = Object.entries(input as Record<string, unknown>);
  const bots: Record<string, BotPolicy> = Object.create(null);
  const seen = new Set<string>();
  for (const [name, v] of entries) {
    const key = name.trim();
    if (!key) return { error: "bot name must be non-empty" };
    if (seen.has(key.toLowerCase())) return { error: `duplicate bot "${key}" — names match case-insensitively` };
    seen.add(key.toLowerCase());
    const pv = (v ?? {}) as { mode?: unknown; rollupHours?: unknown };
    if (!BOT_MODES.includes(pv.mode as (typeof BOT_MODES)[number])) {
      return { error: `bot "${key}": mode must be one of ${BOT_MODES.join(" | ")}` };
    }
    if (
      pv.rollupHours !== undefined &&
      (typeof pv.rollupHours !== "number" || !Number.isFinite(pv.rollupHours) || pv.rollupHours <= 0)
    ) {
      return { error: `bot "${key}": rollupHours must be a positive number` };
    }
    bots[key] = {
      mode: pv.mode as BotPolicy["mode"],
      ...(pv.mode === "rollup" && pv.rollupHours !== undefined ? { rollupHours: pv.rollupHours as number } : {}),
    };
  }
  return { bots: { ...bots } };
}

/** How the agent behaves in one channel. Its instructions live with the channel scope's instructions. */
export interface ChannelPolicy {
  container: string;
  bots: Record<string, BotPolicy>;
  ambientEnabled?: boolean;
  setBy?: string;
  updatedAt: number;
}

interface ChannelPolicyRevision {
  container: string;
  bots?: Record<string, BotPolicy>;
  ambientEnabled?: boolean;
  setBy?: string;
  sessionId?: string;
  createdAt: number;
}

export interface ChannelPolicyStore {
  get(container: string): Promise<ChannelPolicy | null>;
  set(
    container: string,
    opts: {
      setBy?: string;
      bots?: Record<string, BotPolicy>;
      sessionId?: string;
      ambientEnabled?: boolean | null;
    },
  ): Promise<ChannelPolicy>;
  history(container: string, limit?: number): Promise<ChannelPolicyRevision[]>;
  list(): Promise<ChannelPolicy[]>;
  close(): Promise<void>;
}

/**
 * One-time copy of channel guidance ("orders") into the conversation scope's instructions, so a
 * scope has one instruction text. Where the scope already has instructions the guidance is
 * appended after a separator, as a new instructions revision. The orders column is left as it
 * was: this build no longer reads it, and a rollback to an older build still finds it.
 *
 * A container maps to its group scope when it is a web project's group (the `web-project-`
 * prefix, as in isProjectGroupRef) or a Slack group DM (channel_state kind 'group'); every other
 * container maps to its channel scope.
 *
 * It also re-files instructions that the retired 0002 version of this move put on
 * `channel:web-project-…`, a scope no conversation uses, onto the project's group scope.
 */
const ORDERS_INTO_INSTRUCTIONS: readonly string[] = [
  `ALTER TABLE channel_policy_history ALTER COLUMN orders SET DEFAULT ''`,
  `DO $orders_into_instructions$
DECLARE
  tenanted boolean;
  has_state boolean := to_regclass('channel_state') IS NOT NULL;
  r record;
  scope text;
  existing jsonb;
  revision jsonb;
  merged text;
  now_ms bigint := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
BEGIN
  IF to_regclass('soul_configs') IS NULL THEN RETURN; END IF;
  tenanted := EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'soul_configs' AND column_name = 'tenant_id'
  );
  FOR r IN EXECUTE format(
    $q$SELECT %1$s AS tenant, c.id AS misfiled, substr(c.id, 9) AS container,
              COALESCE(c.json->>'content', '') AS orders, c.json->>'updatedBy' AS set_by, 'group' AS kind
       FROM soul_configs c WHERE c.id LIKE 'channel:web-project-%%'
       UNION ALL
       SELECT %2$s, NULL, p.container, p.orders, p.set_by,
              CASE WHEN p.container LIKE 'web-project-%%' THEN 'group' ELSE %3$s END
       FROM channel_policy p %4$s WHERE btrim(p.orders) <> ''$q$,
    CASE WHEN tenanted THEN 'c.tenant_id' ELSE 'NULL::uuid' END,
    CASE WHEN tenanted THEN 'p.tenant_id' ELSE 'NULL::uuid' END,
    CASE WHEN has_state THEN 's.kind' ELSE 'NULL::text' END,
    CASE WHEN has_state THEN
      'LEFT JOIN channel_state s ON s.org_id = p.org_id AND s.container = p.container'
        || CASE WHEN tenanted THEN ' AND s.tenant_id = p.tenant_id' ELSE '' END
    ELSE '' END
  )
  LOOP
    IF r.misfiled IS NOT NULL THEN
      IF tenanted THEN
        EXECUTE 'DELETE FROM soul_configs WHERE tenant_id = $1 AND id = $2' USING r.tenant, r.misfiled;
      ELSE
        EXECUTE 'DELETE FROM soul_configs WHERE id = $1' USING r.misfiled;
      END IF;
      IF btrim(r.orders) = '' THEN CONTINUE; END IF;
    END IF;
    scope := CASE WHEN r.kind = 'group' THEN 'group:' ELSE 'channel:' END || r.container;
    IF tenanted THEN
      EXECUTE 'SELECT json FROM soul_configs WHERE tenant_id = $1 AND id = $2 FOR UPDATE'
        INTO existing USING r.tenant, scope;
    ELSE
      EXECUTE 'SELECT json FROM soul_configs WHERE id = $1 FOR UPDATE' INTO existing USING scope;
    END IF;
    merged := CASE
      WHEN existing IS NULL OR btrim(COALESCE(existing->>'content', '')) = '' THEN r.orders
      ELSE (existing->>'content') || E'\\n\\n---\\n\\n' || r.orders
    END;
    revision := jsonb_build_object(
      'scopeId', scope,
      'content', merged,
      'version', COALESCE((existing->>'version')::int, 0) + 1,
      'updatedAt', now_ms
    ) || CASE WHEN r.set_by IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('updatedBy', r.set_by) END;
    revision := revision || jsonb_build_object(
      'history',
      jsonb_build_array(revision) || CASE
        WHEN existing IS NULL THEN '[]'::jsonb
        WHEN jsonb_typeof(existing->'history') = 'array' THEN existing->'history'
        ELSE jsonb_build_array(
          jsonb_strip_nulls(jsonb_build_object(
            'scopeId', scope,
            'content', existing->>'content',
            'version', COALESCE((existing->>'version')::int, 0),
            'updatedAt', COALESCE((existing->>'updatedAt')::bigint, 0),
            'updatedBy', existing->>'updatedBy'
          ))
        )
      END
    );
    IF tenanted THEN
      EXECUTE 'INSERT INTO soul_configs (tenant_id, id, json) VALUES ($1, $2, $3)
               ON CONFLICT (tenant_id, id) DO UPDATE SET json = EXCLUDED.json'
        USING r.tenant, scope, revision;
    ELSE
      EXECUTE 'INSERT INTO soul_configs (id, json) VALUES ($1, $2)
               ON CONFLICT (id) DO UPDATE SET json = EXCLUDED.json'
        USING scope, revision;
    END IF;
  END LOOP;
END
$orders_into_instructions$`,
];

const HISTORY_DEFAULT_LIMIT = 50;

export function createPostgresChannelPolicyStore(connectionString: string): ChannelPolicyStore {
  const { q, close } = createPgPool(connectionString, [
    { id: "surface-cache/channel-policy/0003-orders-into-instructions", statements: ORDERS_INTO_INSTRUCTIONS },
  ]);
  const row = (r: Record<string, unknown>): ChannelPolicy => ({
    container: r.container as string,
    bots: (r.bots as Record<string, BotPolicy>) ?? {},
    ...(r.ambient_enabled != null ? { ambientEnabled: r.ambient_enabled as boolean } : {}),
    ...(r.set_by != null ? { setBy: r.set_by as string } : {}),
    updatedAt: Number(r.updated_at),
  });
  const revision = (r: Record<string, unknown>): ChannelPolicyRevision => ({
    container: r.container as string,
    ...(r.bots != null ? { bots: r.bots as Record<string, BotPolicy> } : {}),
    ...(r.ambient_enabled != null ? { ambientEnabled: r.ambient_enabled as boolean } : {}),
    ...(r.set_by != null ? { setBy: r.set_by as string } : {}),
    ...(r.session_id != null ? { sessionId: r.session_id as string } : {}),
    createdAt: Number(r.created_at),
  });
  return {
    async get(container) {
      const rows = await q("SELECT * FROM channel_policy WHERE org_id = $1 AND container = $2", [
        tenant().orgId,
        container,
      ]);
      return rows[0] ? row(rows[0]) : null;
    },
    async set(container, opts) {
      const now = Date.now();
      const rows = await q(
        `WITH up AS (
           INSERT INTO channel_policy(org_id, container, bots, ambient_enabled, set_by, updated_at)
           VALUES ($1,$2,COALESCE($3::jsonb,'{}'::jsonb),CASE WHEN $8 THEN $7::boolean END,$4,$5)
           ON CONFLICT (${tenantCols("org_id, container")}) DO UPDATE SET
             bots = COALESCE($3::jsonb, channel_policy.bots),
             ambient_enabled = CASE WHEN $8 THEN $7::boolean ELSE channel_policy.ambient_enabled END,
             set_by = EXCLUDED.set_by, updated_at = EXCLUDED.updated_at
           RETURNING *
         ), hist AS (
           INSERT INTO channel_policy_history(org_id, container, bots, ambient_enabled, set_by, session_id, created_at)
           SELECT $1, $2, up.bots, up.ambient_enabled, $4, $6, $5 FROM up
         )
         SELECT * FROM up`,
        [
          tenant().orgId,
          container,
          opts.bots ? JSON.stringify(opts.bots) : null,
          opts.setBy ?? null,
          now,
          opts.sessionId ?? null,
          opts.ambientEnabled ?? null,
          opts.ambientEnabled !== undefined,
        ],
      );
      return row(rows[0]!);
    },
    async history(container, limit = HISTORY_DEFAULT_LIMIT) {
      const rows = await q(
        "SELECT * FROM channel_policy_history WHERE org_id = $1 AND container = $2 ORDER BY id DESC LIMIT $3",
        [tenant().orgId, container, limit],
      );
      return rows.map(revision);
    },
    async list() {
      const rows = await q("SELECT * FROM channel_policy WHERE org_id = $1 ORDER BY updated_at DESC", [tenant().orgId]);
      return rows.map(row);
    },
    close,
  };
}
