import { AsyncResource } from "node:async_hooks";
import { normalizeHost, routeForHost, type HostRoute } from "../../plugins/chassis/src/tenant-hosts.ts";
import type { PgPool } from "../persistence/pg-pool.ts";
import { subscribePostgresChannel } from "../persistence/postgres-listener.ts";
import { registerTenantSettings, tenant, tenantFor, withTenant, type Tenant } from "../tenant.ts";
import { reportFailure, reportFailureAs } from "../util/errors.ts";
import { homeTenantId, listTenants, type TenantRecord } from "./registry.ts";

const FRESH_MS = 60_000;
const MISS_RELOAD_MS = 1_000;
const PREPARE_RETRY_MS = 30_000;

export interface TenantDirectory {
  byHost(host: string | undefined): Promise<Tenant | undefined>;
  active(): Promise<Tenant[]>;
  watch(listener: (active: Tenant[]) => void): void;
  close(): Promise<void>;
}

interface Snapshot {
  at: number;
  routes: HostRoute<Tenant>[];
  tenants: Tenant[];
}

interface DirectoryOptions {
  databaseUrl: string;
  pool: PgPool;
  secretsKey: Buffer | undefined;
  home: Tenant;
  homeHosts: readonly string[];
  homeAppsDomain?: string;
  homeSandboxPrefix: string;
  prepare?: () => Promise<void>;
  now?: () => number;
}

const reportedCollisions = new Set<string>();

function servable(records: TenantRecord[], homeId: string, opts: DirectoryOptions): TenantRecord[] {
  const orgs = new Set([opts.home.orgId]);
  const prefixes = new Set([opts.homeSandboxPrefix]);
  const kept: TenantRecord[] = [];
  for (const rec of records) {
    if (rec.id === homeId || rec.status !== "active") continue;
    const prefix = rec.sandboxNamePrefix ?? `qm-${rec.slug}`;
    if (orgs.has(rec.orgId) || prefixes.has(prefix)) {
      const collision = `${rec.id}:${rec.orgId}:${prefix}`;
      if (reportedCollisions.has(collision)) continue;
      reportedCollisions.add(collision);
      reportFailure(
        `tenant ${rec.slug}: not served`,
        new Error(`org id ${rec.orgId} or sandbox prefix ${prefix} is already used by another tenant`),
      );
      continue;
    }
    orgs.add(rec.orgId);
    prefixes.add(prefix);
    kept.push(rec);
  }
  return kept;
}

export function createTenantDirectory(opts: DirectoryOptions): TenantDirectory {
  const now = opts.now ?? Date.now;
  let current: Snapshot | undefined;
  let loading: Promise<Snapshot> | null = null;
  const preparing = new Map<string, Promise<void>>();
  const prepared = new Set<string>();
  const failed = new Map<string, number>();
  const listeners: Array<(active: Tenant[]) => void> = [];

  const isReady = (t: Tenant) => !opts.prepare || t.id === undefined || prepared.has(t.id);
  const readyTenants = () => (current?.tenants ?? [opts.home]).filter(isReady);
  const notify = () => {
    const active = readyTenants();
    for (const listener of listeners) listener(active);
  };

  function ready(t: Tenant): Promise<void> {
    const id = t.id;
    if (id === undefined || !opts.prepare || prepared.has(id)) return Promise.resolve();
    const failedAt = failed.get(id);
    if (failedAt !== undefined && now() - failedAt >= PREPARE_RETRY_MS) {
      failed.delete(id);
      preparing.delete(id);
    }
    let pending = preparing.get(id);
    if (!pending) {
      pending = withTenant(t, opts.prepare);
      preparing.set(id, pending);
      pending.then(
        () => {
          prepared.add(id);
          notify();
        },
        (error: unknown) => {
          failed.set(id, now());
          reportFailure(`tenant ${t.slug ?? id}: preparation failed`, error);
        },
      );
    }
    return pending;
  }

  async function load(): Promise<Snapshot> {
    const [homeId, records] = await Promise.all([homeTenantId(opts.pool), listTenants(opts.pool, opts.secretsKey)]);
    registerTenantSettings(records.filter((rec) => rec.id !== homeId));
    const homeRecord = records.find((rec) => rec.id === homeId);
    const others = servable(records, homeId, opts).map((rec) => ({
      rec,
      t: tenantFor(rec.orgId, rec.id, rec.slug),
    }));
    const homeRoute: HostRoute<Tenant> = {
      hosts: [...opts.homeHosts, ...(homeRecord?.hosts ?? [])],
      ...(opts.homeAppsDomain ? { appsDomain: opts.homeAppsDomain } : {}),
      target: opts.home,
    };
    const routes = others.map(({ rec, t }) => ({
      hosts: rec.hosts,
      ...(rec.appsDomain ? { appsDomain: rec.appsDomain } : {}),
      target: t,
    }));
    return { at: now(), routes: [homeRoute, ...routes], tenants: [opts.home, ...others.map(({ t }) => t)] };
  }

  let attemptedAt = Number.NEGATIVE_INFINITY;
  let lastFailure: unknown;
  const attemptedRecently = () => now() - attemptedAt < MISS_RELOAD_MS;

  function reload(): Promise<Snapshot> {
    if (!loading) attemptedAt = now();
    return (loading ??= load()
      .then((next) => {
        current = next;
        for (const t of next.tenants) void ready(t).catch(() => {});
        notify();
        return next;
      })
      .catch((error: unknown) => {
        lastFailure = error;
        throw error;
      })
      .finally(() => {
        loading = null;
      }));
  }

  const refresh = AsyncResource.bind(() => void reload().catch(reportFailureAs("tenant registry reload", undefined)));
  const unsubscribe = subscribePostgresChannel(opts.databaseUrl, "qm_tenants", refresh, refresh);

  async function snapshot(): Promise<Snapshot> {
    if (!current) return !loading && attemptedRecently() ? Promise.reject(lastFailure) : reload();
    if (now() - current.at >= FRESH_MS && !attemptedRecently()) refresh();
    return current;
  }

  async function fresher(): Promise<Snapshot> {
    if (current && !loading && (now() - current.at < MISS_RELOAD_MS || attemptedRecently())) return current;
    try {
      return await reload();
    } catch (error) {
      if (!current) throw error;
      reportFailure("tenant registry reload", error);
      return current;
    }
  }

  return {
    async byHost(raw) {
      const host = normalizeHost(raw);
      if (!host) return undefined;
      const found = routeForHost((await snapshot()).routes, host) ?? routeForHost((await fresher()).routes, host);
      if (found) await ready(found);
      return found;
    },
    async active() {
      await snapshot();
      return readyTenants();
    },
    watch(listener) {
      listeners.push(listener);
    },
    close: unsubscribe,
  };
}

let directory: TenantDirectory | undefined;

export function useTenantDirectory(next: TenantDirectory | undefined): void {
  directory = next;
}

export function tenantByHost(host: string | undefined): Promise<Tenant | undefined> {
  if (!directory) return Promise.reject(new Error("no tenant directory is configured"));
  return directory.byHost(host);
}

export function watchActiveTenants(listener: (active: Tenant[]) => void): void {
  directory?.watch(listener);
}

export async function activeTenants(): Promise<Tenant[]> {
  return directory ? directory.active() : [tenant()];
}

export function foreignTenant(claimed: string | undefined, credential: string): boolean {
  const serving = tenant().orgId;
  if (claimed === undefined || claimed === serving) return false;
  if (directory) return true;
  reportFailure(
    "tenant: credential issued for another tenant",
    new Error(`${credential} names tenant ${claimed}; this process serves ${serving}`),
  );
  return false;
}

export function isHomeTenant(t: Tenant): boolean {
  return t.id === undefined;
}
