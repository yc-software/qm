import type { SlackCoreClient } from "../api/slack-core-client.ts";
import { boundTenant, currentTenant, withTenant, withoutTenant } from "../tenants/context.ts";
import { reportFailureAs } from "../util/errors.ts";
import type { SlackPluginConfig } from "./config.ts";
import { createDeliveryPoller, type DeliveryTenant } from "./deliveries.ts";
import type { SlackAccountRuntime } from "./index.ts";
import type { DueEnvelope } from "./slack-tables.ts";

export class SlackPluginStartCleanupError extends AggregateError {
  readonly cleanup: () => Promise<void>;

  constructor(startError: unknown, cleanupError: unknown, cleanup: () => Promise<void>) {
    super([startError, cleanupError], "Slack startup failed and socket cleanup remains incomplete");
    this.cleanup = cleanup;
  }
}

export interface SlackTenantConfig {
  version: string;
  accounts: SlackPluginConfig[];
}

export interface SlackTenantClaims {
  installedTenants(): Promise<string[]>;
  dueEnvelopes(accounts: ReadonlyArray<{ tenantId: string; account: string }>): Promise<DueEnvelope[]>;
  statusAccounts(): Promise<Array<{ tenant_id: string; account: string }>>;
  ackTenants(): Promise<Array<{ tenant_id: string }>>;
}

interface Entry {
  version: string;
  configs: SlackPluginConfig[];
  accounts: SlackAccountRuntime[];
  failure?: { version: string; failures: number; retryAt: number; cleanup?: () => Promise<void> };
}

const report = reportFailureAs("slack tenant runtimes", undefined);

export function createSlackTenants(deps: {
  core: SlackCoreClient;
  claims: SlackTenantClaims;
  load(): Promise<SlackTenantConfig | null>;
  start(config: SlackPluginConfig): Promise<SlackAccountRuntime>;
  intervalMs?: number;
  sweepMs?: number;
  retryMs?: number;
  maxRetryMs?: number;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const intervalMs = deps.intervalMs ?? 10_000;
  const sweepMs = deps.sweepMs ?? 60_000;
  const retryMs = deps.retryMs ?? 5_000;
  const maxRetryMs = deps.maxRetryMs ?? 5 * 60_000;
  const entries = new Map<string, Entry>();
  const building = new Map<string, Promise<SlackAccountRuntime[] | undefined>>();
  let running = false;
  let stopping: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let ticking: Promise<void> | undefined;
  let lastSweep = Number.NEGATIVE_INFINITY;
  let deliveriesDue = false;
  let draining = false;
  let drainAgain = false;

  const accountsOf = (tenant: string): SlackAccountRuntime[] | undefined => {
    const accounts = entries.get(tenant)?.accounts;
    return accounts?.length ? accounts : undefined;
  };
  const main = (tenant: string): SlackAccountRuntime | undefined => {
    const accounts = accountsOf(tenant) ?? [];
    return accounts.find((account) => account.coreSingleton) ?? accounts[0];
  };
  const deliveryTenant = (tenant: string): DeliveryTenant | undefined => {
    const accounts = accountsOf(tenant) ?? [];
    return (accounts.find((account) => account.coreSingleton && account.delivery) ?? accounts.find((a) => a.delivery))
      ?.delivery;
  };
  const poller = createDeliveryPoller({ core: deps.core, tenant: deliveryTenant });

  const stopAccounts = async (accounts: readonly SlackAccountRuntime[]): Promise<void> => {
    for (const account of accounts) await account.stop().catch(report);
  };
  const contextSubscriptions = new Map<string, () => void>();
  const keep = (tenant: string, entry: Entry): void => {
    entries.set(tenant, entry);
    if (!entry.accounts.length || contextSubscriptions.has(tenant)) return;
    const unsubscribe = deps.core.onContextRequest((request) => {
      for (const account of accountsOf(tenant) ?? []) account.serviceContextRequest(request);
    });
    contextSubscriptions.set(tenant, unsubscribe);
  };
  const discard = async (tenant: string): Promise<void> => {
    const entry = entries.get(tenant);
    entries.delete(tenant);
    contextSubscriptions.get(tenant)?.();
    contextSubscriptions.delete(tenant);
    await entry?.failure?.cleanup?.();
    if (entry) await stopAccounts(entry.accounts);
  };
  const startAll = async (configs: readonly SlackPluginConfig[]): Promise<SlackAccountRuntime[]> => {
    const started: SlackAccountRuntime[] = [];
    try {
      for (const config of configs) started.push(await deps.start(config));
    } catch (error) {
      await stopAccounts(started);
      throw error;
    }
    return started;
  };

  function drainDeliveries(): void {
    if (!running) return;
    if (draining) {
      drainAgain = true;
      return;
    }
    draining = true;
    void withoutTenant(() => poller.pollDeliveries())
      .then((ranAsLeader) => {
        if (!ranAsLeader) deliveriesDue = true;
      })
      .catch(report)
      .finally(() => {
        draining = false;
        if (drainAgain) {
          drainAgain = false;
          drainDeliveries();
        }
      });
  }

  async function build(tenant: string): Promise<SlackAccountRuntime[] | undefined> {
    const desired = await deps.load();
    const current = entries.get(tenant);
    if (current?.accounts.length && desired?.version === current.version) return current.accounts;
    if (desired && current?.failure?.version === desired.version && now() < current.failure.retryAt)
      return accountsOf(tenant);
    await discard(tenant);
    if (!desired || !running) return undefined;
    try {
      const accounts = await startAll(desired.accounts);
      if (!running) {
        await stopAccounts(accounts);
        return undefined;
      }
      keep(tenant, { version: desired.version, configs: desired.accounts, accounts });
      drainDeliveries();
      return accounts;
    } catch (error) {
      report(error);
      const failures = current?.failure?.version === desired.version ? current.failure.failures + 1 : 1;
      const restore = current?.accounts.length && running ? current : undefined;
      const previous = restore ? await startAll(restore.configs).catch((e: unknown) => void report(e)) : undefined;
      keep(tenant, {
        version: previous && restore ? restore.version : desired.version,
        configs: previous && restore ? restore.configs : desired.accounts,
        accounts: previous ?? [],
        failure: {
          version: desired.version,
          failures,
          retryAt: now() + Math.min(retryMs * 2 ** (failures - 1), maxRetryMs),
          ...(error instanceof SlackPluginStartCleanupError ? { cleanup: error.cleanup } : {}),
        },
      });
      return accountsOf(tenant);
    }
  }

  function ensure(tenant: string): Promise<SlackAccountRuntime[] | undefined> {
    const pending = building.get(tenant);
    if (pending) return pending;
    const next = withTenant(tenant, () => build(tenant)).finally(() => building.delete(tenant));
    building.set(tenant, next);
    return next;
  }

  const inTenants = <T>(rows: readonly T[], tenantOf: (row: T) => string, fn: (row: T) => Promise<unknown>) =>
    Promise.allSettled(rows.map((row) => withTenant(tenantOf(row), () => fn(row)).catch(report)));

  async function sweep(at: number): Promise<void> {
    const staged = [...entries.keys()].flatMap((tenantId) =>
      (accountsOf(tenantId) ?? [])
        .filter((account) => account.staging)
        .map((account) => ({ tenantId, account: account.stagingAccount })),
    );
    const due = Map.groupBy(await deps.claims.dueEnvelopes(staged), (row) => row.tenantId);
    await inTenants(
      [...due.keys()],
      (tenant) => tenant,
      async (tenant) => {
        for (const row of due.get(tenant) ?? [])
          await accountsOf(tenant)
            ?.find((account) => account.stagingAccount === row.account)
            ?.replay(row);
      },
    );
    await inTenants(
      await deps.claims.statusAccounts(),
      (row) => row.tenant_id,
      async (row) =>
        accountsOf(row.tenant_id)
          ?.find((account) => account.statusAccount === row.account)
          ?.reconcileStatus(),
    );
    await inTenants(
      await deps.claims.ackTenants(),
      (row) => row.tenant_id,
      async (row) => main(row.tenant_id)?.reconcileAcks(),
    );
    await inTenants(
      [...entries.keys()],
      (tenant) => tenant,
      async (tenant) => {
        for (const account of accountsOf(tenant) ?? []) account.refreshEmoji(at);
      },
    );
  }

  async function tick(): Promise<void> {
    const tenants = new Set([...(await deps.claims.installedTenants()), ...entries.keys()]);
    await Promise.allSettled([...tenants].map((tenant) => ensure(tenant).catch(report)));
    const at = now();
    const sweepDue = at - lastSweep >= sweepMs;
    if (deliveriesDue || sweepDue) {
      deliveriesDue = false;
      drainDeliveries();
    }
    if (!sweepDue) return;
    lastSweep = at;
    await sweep(at);
  }

  function tickOnce(): Promise<void> {
    if (!running) return Promise.resolve();
    ticking ??= (stopping ?? Promise.resolve())
      .then(tick)
      .catch(report)
      .finally(() => {
        ticking = undefined;
      });
    return ticking;
  }

  const forBound = (fn: (account: SlackAccountRuntime) => void): void => {
    const tenant = boundTenant();
    for (const account of (tenant && accountsOf(tenant)) || []) fn(account);
  };
  deps.core.onDeliveryEnqueued(drainDeliveries);
  deps.core.onScopeModelChanged((scope) => forBound((account) => account.scopeModelChanged(scope)));
  deps.core.onChannelHeaderPinChanged((scope) => forBound((account) => account.channelHeaderPinChanged(scope)));

  return {
    start(): void {
      if (running) return;
      running = true;
      timer = setInterval(() => void tickOnce(), intervalMs);
      timer.unref();
      void tickOnce();
    },
    reconcile: tickOnce,
    current: (): SlackAccountRuntime[] => accountsOf(currentTenant()) ?? [],
    async accounts(): Promise<SlackAccountRuntime[]> {
      const tenant = currentTenant();
      return accountsOf(tenant) ?? (running ? ((await ensure(tenant)) ?? []) : []);
    },
    async refresh(): Promise<void> {
      if (running) await ensure(currentTenant());
    },
    stop(): Promise<void> {
      running = false;
      if (timer) clearInterval(timer);
      timer = undefined;
      stopping ??= (async () => {
        await ticking;
        await Promise.allSettled(building.values());
        for (const tenant of entries.keys()) await withTenant(tenant, () => discard(tenant));
      })().finally(() => {
        stopping = undefined;
      });
      return stopping;
    },
  };
}
