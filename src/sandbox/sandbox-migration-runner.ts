import type { DurableMap } from "../persistence/durable-map.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import { sleep } from "../util/async.ts";
import { shq } from "../util/shell.ts";
import { copyHome, type CopyHomeResult } from "./sandbox-migrate.ts";
import type { SandboxBackendName, SandboxRoute } from "./sandbox-routing.ts";
import { capabilitiesLostMovingTo, type ProvisionOptions, type Sandbox, type SandboxHandle } from "./sandbox.ts";
import type { WorkspaceLayer } from "../types.ts";

export interface SandboxMigrationOptions {
  backends: Partial<Record<SandboxBackendName, Sandbox>>;
  routes: DurableMap<SandboxRoute>;
  defaultBackend: SandboxBackendName;
  advisoryLock?: AdvisoryLock;
  provisionOptions?: (scopeId: string) => Promise<ProvisionOptions>;
  settleMs?: number;
  hasLiveWork?: (scopeId: string) => Promise<boolean>;
}

interface MigrateScopeResult extends CopyHomeResult {
  scopeId: string;
  from: SandboxBackendName;
  to: SandboxBackendName;
  resynced: boolean;
  capabilitiesLost: string[];
}

interface MigrateScopeOptions {
  force?: boolean;
}

export interface SandboxMigrationRunner {
  migrateScope(
    scopeId: string,
    to: SandboxBackendName,
    reason?: string,
    opts?: MigrateScopeOptions,
  ): Promise<MigrateScopeResult>;
  listRoutes(): Promise<Array<[string, SandboxRoute]>>;
  availableBackends(): SandboxBackendName[];
  defaultBackend: SandboxBackendName;
}

const scopeLayers = (scopeId: string): WorkspaceLayer[] => [
  { scopeId: scopeId as WorkspaceLayer["scopeId"], mountPath: "/", mode: "rw" },
];

export function createSandboxMigrationRunner(opts: SandboxMigrationOptions): SandboxMigrationRunner {
  const { backends, routes, defaultBackend } = opts;

  async function migrate(
    scopeId: string,
    to: SandboxBackendName,
    reason?: string,
    migrateOpts?: MigrateScopeOptions,
  ): Promise<MigrateScopeResult> {
    const toSandbox = backends[to];
    if (!toSandbox) throw new Error(`cannot migrate to ${to}: that backend is not constructed on this deployment`);
    const route = await routes.get(scopeId);
    const from = route?.backend ?? defaultBackend;
    if (from === to) throw new Error(`scope is already on ${to}`);
    const fromSandbox = backends[from];
    if (!fromSandbox) throw new Error(`scope lives on ${from}, which is not constructed on this deployment`);
    if (route?.pinned)
      throw new Error(`scope is pinned to ${from}${route.reason ? ` (${route.reason})` : ""}; unpin before migrating`);
    if (opts.hasLiveWork && (await opts.hasLiveWork(scopeId))) {
      throw new Error("scope has live background work; wait for it to finish or stop it before migrating");
    }
    const capabilitiesLost = capabilitiesLostMovingTo(fromSandbox, toSandbox);
    if (capabilitiesLost.length && !migrateOpts?.force) {
      throw new Error(
        `cannot migrate to ${to}: it has no ${capabilitiesLost.join(", no ")}, which the scope has on ${from} today. ` +
          `Migrate with force to accept the loss.`,
      );
    }
    const provOpts = (await opts.provisionOptions?.(scopeId)) ?? {};
    const fromHandle = await fromSandbox.provision(scopeLayers(scopeId), provOpts);
    const toHandle = await toSandbox.provision(scopeLayers(scopeId), provOpts);
    const fromHome = fromHandle.homeDir ?? fromSandbox.profile.spec?.homeDir ?? "/root";
    const toHome = toHandle.homeDir ?? toSandbox.profile.spec?.homeDir ?? "/root";
    const startedAtIso = new Date().toISOString();
    let copied = await copyHome({ fromSandbox, fromHandle, fromHome, toSandbox, toHandle, toHome });
    const routeRow = (): SandboxRoute => ({
      backend: to,
      migratedAt: new Date().toISOString(),
      migrationSha: copied.sha,
      ...(reason ? { reason } : {}),
      ...(capabilitiesLost.length ? { capabilitiesLost } : {}),
    });
    await routes.put(scopeId, routeRow());
    if (opts.settleMs) await sleep(opts.settleMs);
    let resynced = false;
    const changed = await fromSandbox.run(
      fromHandle,
      `find ${shq(fromHome)} -type f -newermt ${shq(startedAtIso)} 2>/dev/null | head -1`,
      { timeoutMs: 60_000 },
    );
    if (changed.stdout.trim() !== "") {
      copied = await copyHome({ fromSandbox, fromHandle, fromHome, toSandbox, toHandle, toHome });
      await routes.put(scopeId, routeRow());
      resynced = true;
    }
    await Promise.all([park(fromSandbox, fromHandle), park(toSandbox, toHandle)]);
    return { scopeId, from, to, resynced, capabilitiesLost, ...copied };
  }

  const park = (s: Sandbox, h: SandboxHandle) => s.teardown(h).catch(() => {});

  return {
    migrateScope: (scopeId, to, reason?, migrateOpts?) =>
      opts.advisoryLock
        ? opts.advisoryLock.withLock(`sandbox-migration:${scopeId}`, () => migrate(scopeId, to, reason, migrateOpts))
        : migrate(scopeId, to, reason, migrateOpts),
    listRoutes: () => routes.entries(),
    availableBackends: () =>
      Object.entries(backends)
        .filter(([, s]) => !!s)
        .map(([n]) => n as SandboxBackendName),
    defaultBackend,
  };
}
