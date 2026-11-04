import { LRUCache } from "lru-cache";
import type { PgPool } from "../persistence/pg-pool.ts";
import { isTenantId, withTenant } from "./context.ts";
import { replaceLoadedTenantSettings, tenantSettingsSchema, type TenantSettings } from "./settings.ts";
import { createSweeper, type Sweeper } from "../util/sweeper.ts";

interface HostTenant {
  tenant?: string;
  multi: boolean;
  retired?: boolean;
}

export type RowTable = "webhooks" | "loop_ingress" | "oauth_flows" | "deployments" | "session_shares";

type SettingsUpdate =
  | { ok: true; keys: string[] }
  | { ok: false; error: "unknown_tenant" }
  | { ok: false; error: "invalid_settings"; message: string };

export interface Tenancy {
  hostTenant(host: string): Promise<HostTenant>;
  multi(): Promise<boolean>;
  soleTenant(): Promise<string | undefined>;
  settings(tenant: string): Promise<TenantSettings>;
  refreshSettings(): Promise<void>;
  keepSettingsFresh(): Sweeper;
  hosts(tenant: string): Promise<string[] | undefined>;
  mapHost(tenant: string, host: string): Promise<"mapped" | "taken" | "unknown_tenant">;
  unmapHost(tenant: string, host: string): Promise<boolean>;
  updateSettings(tenant: string, patch: Record<string, unknown>): Promise<SettingsUpdate>;
  rowTenant(table: RowTable, id: string): Promise<string | undefined>;
}

const CACHE_TTL_MS = 30_000;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export function requestHost(raw: string | undefined): string {
  const host = (raw ?? "").trim().toLowerCase();
  const bare = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : (host.split(":")[0] ?? "");
  return bare.endsWith(".") ? bare.slice(0, -1) : bare;
}

export function isHostname(host: string): boolean {
  return HOSTNAME.test(host);
}

function parsedSettings(value: unknown): TenantSettings {
  const parsed = tenantSettingsSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : {};
}

export function createTenancy(pool: PgPool, owner: PgPool = pool): Tenancy {
  const hostCache = new LRUCache<string, HostTenant>({ max: 10_000, ttl: CACHE_TTL_MS });
  const settingsCache = new LRUCache<string, TenantSettings>({ max: 1_000, ttl: CACHE_TTL_MS });
  const knownTenant = async (tenant: string): Promise<boolean> =>
    isTenantId(tenant) && (await owner.q("SELECT 1 FROM tenants WHERE id = $1", [tenant])).length > 0;

  const hostTenant = async (host: string): Promise<HostTenant> => {
    const cached = hostCache.get(host);
    if (cached) return cached;
    const row = (await pool.q("SELECT tenant_id::text AS tenant, multi, retired FROM qm_host_tenant($1)", [host]))[0];
    const tenant = typeof row?.tenant === "string" ? row.tenant : undefined;
    const resolved: HostTenant = {
      ...(tenant ? { tenant } : {}),
      multi: row?.multi === true,
      ...(!tenant && row?.retired === true ? { retired: true } : {}),
    };
    hostCache.set(host, resolved);
    return resolved;
  };

  const refreshSettings = async (): Promise<void> => {
    const rows = await owner.q("SELECT id::text AS id, settings FROM tenants");
    const all = new Map(rows.map((row) => [String(row.id), parsedSettings(row.settings)]));
    for (const [tenant, settings] of all) settingsCache.set(tenant, settings);
    replaceLoadedTenantSettings(all);
  };

  return {
    hostTenant,
    multi: async () => (await hostTenant("")).multi,
    async soleTenant() {
      const sole = (await pool.q("SELECT sole::text AS sole FROM qm_sole_tenant()"))[0]?.sole;
      return typeof sole === "string" ? sole : undefined;
    },
    async settings(tenant) {
      const cached = settingsCache.get(tenant);
      if (cached) return cached;
      const rows = await withTenant(tenant, () => pool.q("SELECT qm_tenant_settings() AS settings"));
      const settings = parsedSettings(rows[0]?.settings);
      settingsCache.set(tenant, settings);
      return settings;
    },
    refreshSettings,
    keepSettingsFresh() {
      const sweeper = createSweeper(refreshSettings, CACHE_TTL_MS, { label: "tenant settings" });
      sweeper.start();
      return sweeper;
    },
    async hosts(tenant) {
      if (!(await knownTenant(tenant))) return undefined;
      const rows = await owner.q("SELECT host FROM tenant_hosts WHERE tenant_id = $1 ORDER BY host", [tenant]);
      return rows.map((row) => String(row.host));
    },
    async mapHost(tenant, host) {
      if (!(await knownTenant(tenant))) return "unknown_tenant";
      await owner.q("DELETE FROM retired_tenant_hosts WHERE host = $1", [host]);
      const rows = await owner.q(
        `INSERT INTO tenant_hosts(host, tenant_id) VALUES ($1, $2)
         ON CONFLICT (host) DO UPDATE SET host = EXCLUDED.host WHERE tenant_hosts.tenant_id = EXCLUDED.tenant_id
         RETURNING tenant_id::text AS tenant`,
        [host, tenant],
      );
      hostCache.clear();
      return rows.length ? "mapped" : "taken";
    },
    async unmapHost(tenant, host) {
      const rows = await owner.q("DELETE FROM tenant_hosts WHERE host = $1 AND tenant_id = $2 RETURNING host", [
        host,
        tenant,
      ]);
      hostCache.clear();
      return rows.length > 0;
    },
    async updateSettings(tenant, patch) {
      if (!(await knownTenant(tenant))) return { ok: false, error: "unknown_tenant" };
      const current = parsedSettings(
        (await owner.q("SELECT settings FROM tenants WHERE id = $1", [tenant]))[0]?.settings,
      );
      const merged: Record<string, unknown> = { ...current };
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete merged[key];
        else merged[key] = value;
      }
      const parsed = tenantSettingsSchema.safeParse(merged);
      if (!parsed.success)
        return { ok: false, error: "invalid_settings", message: parsed.error.issues[0]?.message ?? "" };
      await owner.q("UPDATE tenants SET settings = $2 WHERE id = $1", [tenant, JSON.stringify(parsed.data)]);
      settingsCache.delete(tenant);
      return { ok: true, keys: Object.keys(parsed.data).sort() };
    },
    async rowTenant(table, id) {
      const rows = await owner.q(`SELECT tenant_id::text AS tenant FROM ${table} WHERE id = $1 LIMIT 2`, [id]);
      return rows.length === 1 && typeof rows[0]?.tenant === "string" ? rows[0].tenant : undefined;
    },
  };
}
