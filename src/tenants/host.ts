import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createHostFront,
  hostOfUrl,
  proxyTarget,
  type HostRoute,
  type HostTarget,
} from "../../plugins/chassis/src/tenant-hosts.ts";
import {
  appsDomainOf,
  relocateEmbeddedAuth,
  startTenantWorker,
  tenantServiceEnv,
  type TenantWorker,
} from "../../plugins/chassis/src/tenant-workers.ts";
import type { Config } from "../config.ts";
import { createPgPool } from "../persistence/pg-pool.ts";
import { subscribePostgresChannel } from "../persistence/postgres-listener.ts";
import { registerTenantSettings, tenant, tenantFor, withTenant, type Tenant } from "../tenant.ts";
import { reportFailure } from "../util/errors.ts";
import { bootTenant, type BootedTenant } from "./boot.ts";
import {
  assertRowSecurityEnforced,
  homeTenantId,
  homeTenantSettings,
  listTenants,
  tenantSecretsKey,
  type TenantRecord,
  type TenantSettings,
} from "./registry.ts";

interface Running {
  tenant: Tenant;
  booted?: BootedTenant;
  hosts: string[];
  core?: HostRoute<HostTarget>;
  edge?: HostRoute<HostTarget>;
  workers: TenantWorker[];
  servers: Server[];
  version: string;
}

function drop<T>(list: T[], item: T | undefined): void {
  const at = item === undefined ? -1 : list.indexOf(item);
  if (at >= 0) list.splice(at, 1);
}

type Boot = typeof bootTenant;

export function tenantTarget(t: Tenant, server: Server): HostTarget {
  return {
    request: (req, res) => withTenant(t, () => void server.emit("request", req, res)),
    upgrade: (req, socket, head) => withTenant(t, () => void server.emit("upgrade", req, socket, head)),
  };
}

function configHosts(config: Config): string[] {
  return [config.publicUrl, config.apiBaseUrl, config.publicWebUrl]
    .map(hostOfUrl)
    .filter((host): host is string => Boolean(host));
}

export interface MultitenantHost {
  tenants: BootedTenant[];
  servers: Server[];
  refresh(): Promise<void>;
  stopWorkers(): Promise<void>;
}

interface HostState {
  tenants: BootedTenant[];
  servers: Server[];
  workers: TenantWorker[];
  coreRoutes: HostRoute<HostTarget>[];
  edgeRoutes: HostRoute<HostTarget>[];
  running: Map<string, Running>;
  homeCore?: HostTarget;
  homeEdge?: HostTarget;
  publicPort?: number;
}

async function startEdge(
  state: HostState,
  t: Tenant,
  deploymentEnv: NodeJS.ProcessEnv,
  rec: TenantSettings,
  target: HostTarget,
  own: Running,
): Promise<void> {
  const loopback = createHttpServer((req, res) => target.request(req, res));
  loopback.on("upgrade", (req, socket, head) => target.upgrade(req, socket, head));
  await new Promise<void>((resolve) => loopback.listen(0, "127.0.0.1", resolve));
  own.servers.push(loopback);
  state.servers.push(loopback);
  const core = { CORE_API_URL: `http://127.0.0.1:${(loopback.address() as AddressInfo).port}`, CORE_ORG_ID: t.orgId };
  const web = await startTenantWorker(new URL("../../plugins/web-ui/server/index.ts", import.meta.url), {
    ...tenantServiceEnv(deploymentEnv, rec, "web-ui"),
    ...core,
  });
  own.workers.push(web);
  state.workers.push(web);
  const webUrl = `http://127.0.0.1:${web.port}`;
  const portalBase = {
    ...tenantServiceEnv(deploymentEnv, rec, "portal"),
    ...core,
    WEB_UI_UPSTREAM: webUrl,
    ADMIN_UPSTREAM: `${webUrl}/admin`,
  };
  const portalEnv = t.id ? await relocateEmbeddedAuth(portalBase) : portalBase;
  const portal = await startTenantWorker(new URL("../../plugins/portal/src/index.ts", import.meta.url), portalEnv);
  own.workers.push(portal);
  state.workers.push(portal);
  const edge = proxyTarget(portal.port);
  if (!t.id) state.homeEdge = edge;
  const appsDomain = appsDomainOf(portalEnv);
  own.edge = { hosts: rec.hosts, ...(appsDomain ? { appsDomain } : {}), target: edge };
  state.edgeRoutes.push(own.edge);
}

async function retire(state: HostState, id: string): Promise<void> {
  const own = state.running.get(id);
  if (!own?.booted) return;
  state.running.delete(id);
  drop(state.coreRoutes, own.core);
  drop(state.edgeRoutes, own.edge);
  drop(state.tenants, own.booted);
  const booted = own.booted;
  await withTenant(own.tenant, async () => {
    booted.beginShutdown();
    await booted.stop();
  });
  await Promise.all(own.workers.map((worker) => worker.stop()));
  for (const worker of own.workers) drop(state.workers, worker);
  for (const server of own.servers) {
    server.close();
    drop(state.servers, server);
  }
  console.log(`[qm] tenant ${own.tenant.slug ?? id} (${id}) stopped`);
}

export async function startMultitenant(env: NodeJS.ProcessEnv, boot: Boot = bootTenant): Promise<MultitenantHost> {
  if (!env.DATABASE_URL) throw new Error("QM_MULTITENANT=1 needs DATABASE_URL to read the tenant registry");
  const registry = createPgPool(env.DATABASE_URL);
  const key = tenantSecretsKey(env);
  const state: HostState = {
    tenants: [],
    servers: [],
    workers: [],
    coreRoutes: [],
    edgeRoutes: [],
    running: new Map(),
  };
  const { tenants, servers, workers, coreRoutes, edgeRoutes, running } = state;
  const failed = new Map<string, string>();

  async function add(t: Tenant, tenantEnv: NodeJS.ProcessEnv, rec: TenantSettings): Promise<void> {
    const own: Running = { tenant: t, workers: [], servers: [], hosts: rec.hosts, version: JSON.stringify(rec) };
    own.booted = await withTenant(t, () =>
      boot(tenantEnv, async (server, config) => {
        const target = tenantTarget(t, server);
        if (!t.id) {
          state.homeCore = target;
          state.publicPort = config.publicPort;
        }
        own.hosts = t.id ? rec.hosts : [...new Set([...rec.hosts, ...configHosts(config)])];
        own.core = {
          hosts: own.hosts,
          ...(config.deployAppsDomain ? { appsDomain: config.deployAppsDomain } : {}),
          target,
        };
        coreRoutes.push(own.core);
        if (state.publicPort) await startEdge(state, t, env, { ...rec, hosts: own.hosts }, target, own);
      }),
    );
    tenants.push(own.booted);
    running.set(t.id ?? "", own);
    console.log(`[qm] tenant ${t.slug ?? "home"} (${t.id ?? "home"}) hosts=${own.hosts.join(",")} booted`);
  }

  async function reconcile(records: TenantRecord[], homeId: string): Promise<void> {
    registerTenantSettings(records.filter((rec) => rec.id !== homeId));
    const active = records.filter((rec) => rec.id !== homeId && rec.status === "active");
    const wanted = new Set(active.map((rec) => rec.id));
    for (const id of [...running.keys()]) {
      if (!id || wanted.has(id)) continue;
      try {
        await retire(state, id);
      } catch (error) {
        reportFailure(`tenant ${id} failed to stop`, error);
      }
    }
    for (const rec of active) {
      const version = JSON.stringify(rec);
      if (running.get(rec.id)?.version === version || failed.get(rec.id) === version) continue;
      try {
        if (running.has(rec.id)) await retire(state, rec.id);
        await add(tenantFor(rec.orgId, rec.id, rec.slug), tenantServiceEnv(env, rec, "core"), rec);
        failed.delete(rec.id);
      } catch (error) {
        failed.set(rec.id, version);
        reportFailure(`tenant ${rec.slug} failed to boot`, error);
      }
    }
  }

  await assertRowSecurityEnforced(registry);
  const home = tenant();
  await add(home, env, homeTenantSettings(env, home));
  const homeId = await homeTenantId(registry);
  await reconcile(await listTenants(registry, key), homeId);

  const homeConfig = tenants[0]!.config;
  if (state.homeCore) {
    const front = createHostFront(
      () => coreRoutes,
      () => state.homeCore,
    );
    front.requestTimeout = 0;
    front.headersTimeout = 10_000;
    front.keepAliveTimeout = 5_000;
    await new Promise<void>((resolve) => front.listen(homeConfig.port, resolve));
    servers.push(front);
    console.log(`[qm] multitenant front listening on :${homeConfig.port} for ${tenants.length} tenant(s)`);
  }
  if (state.publicPort) {
    const edge = createHostFront(
      () => edgeRoutes,
      () => state.homeEdge,
    );
    await new Promise<void>((resolve) => edge.listen(state.publicPort, resolve));
    servers.push(edge);
    console.log(`[qm] multitenant public edge listening on :${state.publicPort} for ${tenants.length} tenant(s)`);
  }

  let settled: Promise<void> = Promise.resolve();
  let pending: Promise<void> | null = null;
  const refresh = (): Promise<void> =>
    (pending ??= settled =
      settled.then(() => {
        pending = null;
        return listTenants(registry, key)
          .then((latest) => reconcile(latest, homeId))
          .catch((error: unknown) => reportFailure("tenant registry reload failed", error));
      }));
  const unsubscribe = subscribePostgresChannel(
    env.DATABASE_URL,
    "qm_tenants",
    () => void refresh(),
    () => void refresh(),
  );

  return {
    tenants,
    servers,
    refresh,
    async stopWorkers() {
      await unsubscribe();
      await Promise.all(workers.map((worker) => worker.stop()));
    },
  };
}
