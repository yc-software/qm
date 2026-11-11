import { perTenant } from "../tenants/cache.ts";
import type { Item } from "../sessions/items.ts";
import { SCOPE_KINDS } from "../types.ts";
import { reportFailure } from "../util/errors.ts";
import { publicFetch, type AddressFetch } from "../util/network.ts";
import { disclosedMemory, type MemoryDisclosure } from "./disclosure.ts";
import type { MemoryService } from "./memory-service.ts";
import type { MemoryProviderConfig } from "./provider-config.ts";
import { createMemoryProviders, logMemoryProviderError } from "./provider-factory.ts";
import { MemoryProviderDisabled } from "./provider-outcome.ts";
import { createRoutedMemoryService, type MemoryProviderRoute } from "./provider-router.ts";
import {
  readRegistry,
  resolveMemoryRegistry,
  type DisabledRegistryRoute,
  type MemoryRegistryStore,
} from "./registry.ts";

const NOTEBOOK_ROUTE: MemoryProviderRoute = {
  provider: "default",
  scopes: [...SCOPE_KINDS],
  capture: "automatic",
  manage: true,
  failOpen: false,
};

interface Snapshot {
  version?: string;
  service: MemoryService;
  disabled: MemoryService[];
}

function disabledRoute({ provider, scopes, recall, capture, code }: DisabledRegistryRoute): MemoryService {
  const refuse = async (): Promise<never> => {
    throw new MemoryProviderDisabled(code);
  };
  return createRoutedMemoryService({
    providers: {
      [provider]: { attestActor: true, recall: refuse, query: refuse, capture: refuse, read: async () => "" },
    },
    routes: [{ provider, scopes, recall, capture, manage: false, failOpen: true }],
  });
}

const alongside = async <T>(served: Promise<T>, disabled: Promise<unknown>[]): Promise<T> =>
  (await Promise.all([served, Promise.all(disabled)]))[0];

export function createRegistryMemoryService(opts: {
  defaultMemory: MemoryService;
  overlay?: MemoryProviderConfig;
  registry: Pick<MemoryRegistryStore, "current" | "overlayIds" | "key">;
  sessionItems?: (sessionId: string) => Promise<Item[]>;
  registryFetch?: AddressFetch;
  onError?: (error: unknown, provider: string, operation: "recall" | "query" | "capture" | "forget") => void;
}): MemoryService {
  const overlayProviders = createMemoryProviders(opts.overlay?.providers ?? [], opts);
  const onError = opts.onError ?? logMemoryProviderError;
  const routed = (routes: readonly MemoryProviderRoute[], providers: Record<string, MemoryService> = {}) =>
    createRoutedMemoryService({
      providers: { default: opts.defaultMemory, ...overlayProviders, ...providers },
      routes,
      onError,
    });
  const overlayOnly = opts.overlay ? routed(opts.overlay.routes) : opts.defaultMemory;
  const snapshots = perTenant<{ snapshot: Snapshot }>(() => ({ snapshot: { service: overlayOnly, disabled: [] } }));

  async function current(): Promise<Snapshot> {
    const slot = snapshots();
    const { version, record } = await opts.registry.current();
    if (version === slot.snapshot.version) return slot.snapshot;
    try {
      const registry = readRegistry(record);
      const { config, disabled } = resolveMemoryRegistry(registry, opts.registry);
      slot.snapshot = {
        version,
        disabled: disabled.filter(({ code }) => code !== "id_taken").map(disabledRoute),
        service: config.routes.length
          ? routed(
              [...(opts.overlay?.routes ?? [NOTEBOOK_ROUTE]), ...config.routes],
              createMemoryProviders(config.providers, { fetch: opts.registryFetch ?? publicFetch }),
            )
          : overlayOnly,
      };
    } catch (error) {
      reportFailure(`memory registry: version ${version} is invalid, so the last valid one keeps serving`, error);
      slot.snapshot = { ...slot.snapshot, version };
    }
    return slot.snapshot;
  }

  function view(accesses: readonly MemoryDisclosure[] = []): MemoryService {
    const views = new WeakMap<MemoryService, MemoryService>();
    const disclose = (service: MemoryService): MemoryService => {
      if (!accesses.length) return service;
      let disclosed = views.get(service);
      if (!disclosed)
        views.set(service, (disclosed = accesses.reduce((memory, access) => disclosedMemory(memory, access), service)));
      return disclosed;
    };
    const serve = async (): Promise<Snapshot> => {
      const { service, disabled } = await current();
      return { service: disclose(service), disabled: disabled.map(disclose) };
    };
    return {
      withDisclosure: (next) => view([...accesses, next]),
      async recall(scopeId, context) {
        const { service, disabled } = await serve();
        return alongside(
          service.recall(scopeId, context),
          disabled.map((route) => route.recall(scopeId, context)),
        );
      },
      async query(scopeId, q, limit, context) {
        const { service, disabled } = await serve();
        return alongside(
          service.query(scopeId, q, limit, context),
          disabled.map((route) => route.query(scopeId, q, limit, context)),
        );
      },
      async capture(scopeId, facts, at, by, context) {
        const { service, disabled } = await serve();
        return alongside(
          service.capture(scopeId, facts, at, by, context),
          disabled.map((route) => route.capture(scopeId, facts, at, by, context)),
        );
      },
      read: async (scopeId) => (await serve()).service.read(scopeId),
      brains: async (scopeId) => (await (await serve()).service.brains?.(scopeId)) ?? [],
      facts: async (scopeId) => (await (await serve()).service.facts?.(scopeId)) ?? [],
      async edit(scopeId, edits, by, context) {
        const { service } = await serve();
        if (!service.edit) throw new Error(`memory for ${scopeId} is not directly editable`);
        await service.edit(scopeId, edits, by, context);
      },
      async delete(scopeId, ids, by, context) {
        const { service } = await serve();
        if (!service.delete) throw new Error(`memory for ${scopeId} is not directly editable`);
        await service.delete(scopeId, ids, by, context);
      },
      metadata: async () => (await (await serve()).service.metadata?.()) ?? new Map(),
    };
  }

  return view();
}
