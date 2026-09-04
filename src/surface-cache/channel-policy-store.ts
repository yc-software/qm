import { orgId as configOrgId } from "../config.ts";
import { createPgPool } from "../persistence/pg-pool.ts";

export const BOT_MODES = ["ignore", "rollup", "action", "user"] as const;
export const DEFAULT_ROLLUP_HOURS = 24;
export type BotPolicy = { mode: (typeof BOT_MODES)[number]; rollupHours?: number };

const MAX_LEDGER_BOTS = 200;

export function parseBotLedger(input: unknown): { bots: Record<string, BotPolicy> } | { error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return { error: "bots must be an object keyed by bot author name" };
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > MAX_LEDGER_BOTS) return { error: `bot ledger is capped at ${MAX_LEDGER_BOTS} entries` };
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

export interface ChannelPolicy {
  container: string;
  orders: string;
  bots: Record<string, BotPolicy>;
  ambientEnabled?: boolean;
  setBy?: string;
  updatedAt: number;
}

interface ChannelPolicyRevision {
  container: string;
  orders: string;
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
    orders: string,
    opts?: { setBy?: string; bots?: Record<string, BotPolicy>; sessionId?: string; ambientEnabled?: boolean | null },
  ): Promise<ChannelPolicy>;
  history(container: string, limit?: number): Promise<ChannelPolicyRevision[]>;
  list(): Promise<ChannelPolicy[]>;
  close(): Promise<void>;
}

const HISTORY_DEFAULT_LIMIT = 50;

export function createPostgresChannelPolicyStore(connectionString: string): ChannelPolicyStore {
  const orgId = configOrgId();
  const { q, close } = createPgPool(connectionString, [
    `CREATE TABLE IF NOT EXISTS channel_policy(
        org_id TEXT NOT NULL, container TEXT NOT NULL,
        orders TEXT NOT NULL DEFAULT '', bots JSONB NOT NULL DEFAULT '{}'::jsonb,
        set_by TEXT, updated_at BIGINT NOT NULL,
        PRIMARY KEY(org_id, container)
      )`,
    `ALTER TABLE channel_policy ADD COLUMN IF NOT EXISTS bots JSONB NOT NULL DEFAULT '{}'::jsonb`,
    `ALTER TABLE channel_policy ADD COLUMN IF NOT EXISTS ambient_enabled BOOLEAN`,
    `ALTER TABLE channel_policy ALTER COLUMN ambient_enabled DROP NOT NULL`,
    `ALTER TABLE channel_policy ALTER COLUMN ambient_enabled DROP DEFAULT`,
    `CREATE TABLE IF NOT EXISTS channel_policy_history(
        id BIGSERIAL PRIMARY KEY,
        org_id TEXT NOT NULL, container TEXT NOT NULL,
        orders TEXT NOT NULL, set_by TEXT, session_id TEXT,
        created_at BIGINT NOT NULL
      )`,
    `ALTER TABLE channel_policy_history ADD COLUMN IF NOT EXISTS bots JSONB`,
    `ALTER TABLE channel_policy_history ADD COLUMN IF NOT EXISTS ambient_enabled BOOLEAN`,
    `CREATE INDEX IF NOT EXISTS channel_policy_history_container
        ON channel_policy_history(org_id, container, id DESC)`,
  ]);
  const row = (r: Record<string, unknown>): ChannelPolicy => ({
    container: r.container as string,
    orders: (r.orders as string) ?? "",
    bots: (r.bots as Record<string, BotPolicy>) ?? {},
    ...(r.ambient_enabled != null ? { ambientEnabled: r.ambient_enabled as boolean } : {}),
    ...(r.set_by != null ? { setBy: r.set_by as string } : {}),
    updatedAt: Number(r.updated_at),
  });
  const revision = (r: Record<string, unknown>): ChannelPolicyRevision => ({
    container: r.container as string,
    orders: (r.orders as string) ?? "",
    ...(r.bots != null ? { bots: r.bots as Record<string, BotPolicy> } : {}),
    ...(r.ambient_enabled != null ? { ambientEnabled: r.ambient_enabled as boolean } : {}),
    ...(r.set_by != null ? { setBy: r.set_by as string } : {}),
    ...(r.session_id != null ? { sessionId: r.session_id as string } : {}),
    createdAt: Number(r.created_at),
  });
  return {
    async get(container) {
      const rows = await q("SELECT * FROM channel_policy WHERE org_id = $1 AND container = $2", [orgId, container]);
      return rows[0] ? row(rows[0]) : null;
    },
    async set(container, orders, opts) {
      const now = Date.now();
      const rows = await q(
        `WITH up AS (
           INSERT INTO channel_policy(org_id, container, orders, bots, ambient_enabled, set_by, updated_at)
           VALUES ($1,$2,$3,COALESCE($4::jsonb,'{}'::jsonb),CASE WHEN $9 THEN $8::boolean END,$5,$6)
           ON CONFLICT (org_id, container) DO UPDATE SET orders = EXCLUDED.orders,
             bots = COALESCE($4::jsonb, channel_policy.bots),
             ambient_enabled = CASE WHEN $9 THEN $8::boolean ELSE channel_policy.ambient_enabled END,
             set_by = EXCLUDED.set_by, updated_at = EXCLUDED.updated_at
           RETURNING *
         ), hist AS (
           INSERT INTO channel_policy_history(org_id, container, orders, bots, ambient_enabled, set_by, session_id, created_at)
           SELECT $1, $2, $3, up.bots, up.ambient_enabled, $5, $7, $6 FROM up
         )
         SELECT * FROM up`,
        [
          orgId,
          container,
          orders,
          opts?.bots ? JSON.stringify(opts.bots) : null,
          opts?.setBy ?? null,
          now,
          opts?.sessionId ?? null,
          opts?.ambientEnabled ?? null,
          opts?.ambientEnabled !== undefined,
        ],
      );
      return row(rows[0]!);
    },
    async history(container, limit = HISTORY_DEFAULT_LIMIT) {
      const rows = await q(
        "SELECT * FROM channel_policy_history WHERE org_id = $1 AND container = $2 ORDER BY id DESC LIMIT $3",
        [orgId, container, limit],
      );
      return rows.map(revision);
    },
    async list() {
      const rows = await q("SELECT * FROM channel_policy WHERE org_id = $1 ORDER BY updated_at DESC", [orgId]);
      return rows.map(row);
    },
    close,
  };
}

export function createMemoryChannelPolicyStore(): ChannelPolicyStore {
  const policies = new Map<string, ChannelPolicy>();
  const history: ChannelPolicyRevision[] = [];
  return {
    async get(container) {
      return policies.get(container) ?? null;
    },
    async set(container, orders, opts) {
      const existing = policies.get(container);
      const now = Date.now();
      const ambientEnabled =
        opts?.ambientEnabled === undefined ? existing?.ambientEnabled : (opts.ambientEnabled ?? undefined);
      const p: ChannelPolicy = {
        container,
        orders,
        bots: opts?.bots ?? existing?.bots ?? {},
        ...(ambientEnabled !== undefined ? { ambientEnabled } : {}),
        ...(opts?.setBy ? { setBy: opts.setBy } : {}),
        updatedAt: now,
      };
      policies.set(container, p);
      history.push({
        container,
        orders,
        bots: p.bots,
        ...(p.ambientEnabled !== undefined ? { ambientEnabled: p.ambientEnabled } : {}),
        ...(opts?.setBy ? { setBy: opts.setBy } : {}),
        ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}),
        createdAt: now,
      });
      return p;
    },
    async history(container, limit = HISTORY_DEFAULT_LIMIT) {
      return history
        .filter((r) => r.container === container)
        .slice(-limit)
        .reverse();
    },
    async list() {
      return [...policies.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async close() {},
  };
}
