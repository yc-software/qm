import { AsyncResource } from "node:async_hooks";
import { normalizeHost, routeForHost, type HostRoute } from "../../plugins/chassis/src/tenant-hosts.ts";
import { tenantSandboxPrefix } from "../../plugins/chassis/src/tenant-settings.ts";
import type { PgPool } from "../persistence/pg-pool.ts";
import { subscribePostgresChannel } from "../persistence/postgres-listener.ts";
import { perTenant, registerTenantSettings, tenant, tenantFor, withTenant, type Tenant } from "../tenant.ts";
import { reportFailure, reportFailureAs } from "../util/errors.ts";
import { homeTenantId, listTenants, type TenantRecord } from "./registry.ts";

const FRESH_MS = 60_000;
const MISS_RELOAD_MS = 1_000;
const PREPARE_RETRY_MS = 30_000;

export type HomeHosts = Omit<HostRoute<Tenant>, "target">;

export interface TenantDirectory {
  byHost(host: string | undefined): Promise<Tenant | undefined>;
  homeHosts(): HomeHosts;
  active(): Promise<Tenant[]>;
  owner(id: string | undefined, wait?: boolean): Promise<Tenant | "retired" | undefined>;
  watch(listener: (active: Tenant[]) => void): void;
  close(): Promise<void>;
}

interface Snapshot {
  at: number;
  home: HomeHosts;
  routes: HostRoute<Tenant>[];
  tenants: Tenant[];
  homeId: string;
  byId: Map<string, Tenant>;
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
  const prefixes = new Set<string>();
  const kept: TenantRecord[] = [];
  for (const rec of records) {
    if (rec.id === homeId || rec.status !== "active") continue;
    const prefix = tenantSandboxPrefix(opts.homeSandboxPrefix, rec.id);
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

function tenantPreparation(prepare: (() => Promise<void>) | undefined, now: () => number) {
  const readiness = perTenant(() => ({
    done: false,
    pending: undefined as Promise<void> | undefined,
    failedAt: -Infinity,
  }));
  const isReady = (t: Tenant) => !prepare || t.id === undefined || withTenant(t, () => readiness().done);
  const ready = (t: Tenant): Promise<void> => {
    if (!prepare || isReady(t)) return Promise.resolve();
    return withTenant(t, () => {
      const r = readiness();
      if (r.pending) return r.pending;
      if (now() - r.failedAt < PREPARE_RETRY_MS)
        return Promise.reject(new Error(`tenant ${t.slug ?? t.id}: preparation failed recently`));
      r.pending = Promise.resolve()
        .then(prepare)
        .then(
          () => {
            r.done = true;
          },
          (error: unknown) => {
            r.failedAt = now();
            reportFailure(`tenant ${t.slug ?? t.id}: preparation failed`, error);
            throw error;
          },
        )
        .finally(() => {
          r.pending = undefined;
        });
      return r.pending;
    });
  };
  return { isReady, ready };
}

export function createTenantDirectory(opts: DirectoryOptions): TenantDirectory {
  const now = opts.now ?? Date.now;
  let current: Snapshot | undefined;
  let loading: Promise<Snapshot> | null = null;
  const listeners: Array<(active: Tenant[]) => void> = [];

  const notify = () => {
    const active = current?.tenants ?? [opts.home];
    for (const listener of listeners) listener(active);
  };

  const { isReady, ready } = tenantPreparation(opts.prepare, now);

  async function load(): Promise<Snapshot> {
    const [homeId, records] = await Promise.all([homeTenantId(opts.pool), listTenants(opts.pool, opts.secretsKey)]);
    registerTenantSettings(records.filter((rec) => rec.id !== homeId));
    const homeRecord = records.find((rec) => rec.id === homeId);
    const others = servable(records, homeId, opts).map((rec) => ({
      rec,
      t: tenantFor(rec.orgId, rec.id, rec.slug),
    }));
    const home = homeHostsOf(homeRecord?.hosts ?? []);
    const routes = others.map(({ rec, t }) => ({
      hosts: rec.hosts,
      ...(rec.appsDomain ? { appsDomain: rec.appsDomain } : {}),
      target: t,
    }));
    return {
      at: now(),
      home,
      routes: [{ ...home, target: opts.home }, ...routes],
      tenants: [opts.home, ...others.map(({ t }) => t)],
      homeId,
      byId: new Map([[homeId, opts.home], ...others.map(({ rec, t }) => [rec.id, t] as const)]),
    };
  }

  function homeHostsOf(registered: readonly string[]): HomeHosts {
    return {
      hosts: [...new Set([...opts.homeHosts, ...registered])],
      ...(opts.homeAppsDomain ? { appsDomain: opts.homeAppsDomain } : {}),
    };
  }

  let attemptedAt = Number.NEGATIVE_INFINITY;
  let lastFailure: unknown;
  const attemptedRecently = () => now() - attemptedAt < MISS_RELOAD_MS;

  function reload(): Promise<Snapshot> {
    if (!loading) attemptedAt = now();
    return (loading ??= load()
      .then((next) => {
        current = next;
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
    homeHosts() {
      return current?.home ?? homeHostsOf([]);
    },
    async active() {
      return (await snapshot()).tenants;
    },
    async owner(id, wait = false) {
      const found = id === undefined ? opts.home : ((await snapshot()).byId.get(id) ?? (await fresher()).byId.get(id));
      if (!found) {
        if (id === undefined) return undefined;
        return (await opts.pool.q("SELECT 1 FROM tenants WHERE id = $1::uuid", [id])).length > 0
          ? undefined
          : "retired";
      }
      if (isReady(found)) return found;
      const preparing = ready(found).then(
        () => found,
        () => undefined,
      );
      return wait ? preparing : undefined;
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

export function homeTenantHosts(): HomeHosts {
  return directory ? directory.homeHosts() : { hosts: [] };
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

export async function taskTenant(id: string | undefined, wait = false): Promise<Tenant | "retired" | undefined> {
  if (directory) return directory.owner(id, wait);
  return id === undefined ? tenant() : undefined;
}

export function retiredTenantReason(id: string | undefined): string {
  return `tenant ${id ?? "home"} no longer exists`;
}
