import type { Item } from "../sessions/items.ts";
import { SCOPE_KINDS, type ScopeId } from "../types.ts";
import { reportFailure } from "../util/errors.ts";
import { disclosedMemory, type MemoryDisclosure } from "./disclosure.ts";
import type { MemoryRecallContext, MemoryService } from "./memory-service.ts";
import type { MemoryProviderConfig } from "./provider-config.ts";
import { createMemoryProviders, logMemoryProviderError } from "./provider-factory.ts";
import {
  captureAllowed,
  createRoutedMemoryService,
  routeMatches,
  type MemoryProviderRoute,
} from "./provider-router.ts";
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
  disabled: DisabledRegistryRoute[];
}

export function createRegistryMemoryService(opts: {
  defaultMemory: MemoryService;
  overlay?: MemoryProviderConfig;
  registry: Pick<MemoryRegistryStore, "current" | "overlayIds" | "key">;
  sessionItems?: (sessionId: string) => Promise<Item[]>;
  onError?: (error: unknown, provider: string, operation: "recall" | "query" | "capture") => void;
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
  let snapshot: Snapshot = { service: overlayOnly, disabled: [] };

  async function current(): Promise<Snapshot> {
    const { version, record } = await opts.registry.current();
    if (version === snapshot.version) return snapshot;
    try {
      const { config, disabled } = resolveMemoryRegistry(readRegistry(record), opts.registry);
      snapshot = {
        version,
        disabled,
        service: config.routes.length
          ? routed(
              [...(opts.overlay?.routes ?? [NOTEBOOK_ROUTE]), ...config.routes],
              createMemoryProviders(config.providers),
            )
          : overlayOnly,
      };
    } catch (error) {
      reportFailure(`memory registry: version ${version} is invalid, so the last valid one keeps serving`, error);
      snapshot = { ...snapshot, version };
    }
    return snapshot;
  }

  function flag(
    disabled: readonly DisabledRegistryRoute[],
    scopeId: ScopeId,
    context: Pick<MemoryRecallContext, "report"> | undefined,
    serves: (route: DisabledRegistryRoute) => boolean,
  ): void {
    for (const route of disabled)
      if (serves(route) && routeMatches(route, scopeId))
        context?.report?.({ provider: route.provider, scope: scopeId, ms: 0, outcome: "disabled", code: route.code });
  }

  function view(access?: MemoryDisclosure): MemoryService {
    const views = new WeakMap<MemoryService, MemoryService>();
    const serve = async (): Promise<Snapshot> => {
      const served = await current();
      if (!access) return served;
      let disclosed = views.get(served.service);
      if (!disclosed) views.set(served.service, (disclosed = disclosedMemory(served.service, access)));
      return { ...served, service: disclosed };
    };
    const reads = (route: DisabledRegistryRoute) => route.recall !== false;
    return {
      withDisclosure: (next) => view(next),
      async recall(scopeId, context) {
        const { service, disabled } = await serve();
        flag(disabled, scopeId, context, reads);
        return service.recall(scopeId, context);
      },
      async query(scopeId, q, limit, context) {
        const { service, disabled } = await serve();
        flag(disabled, scopeId, context, reads);
        return service.query(scopeId, q, limit, context);
      },
      async capture(scopeId, facts, at, author, context) {
        const { service, disabled } = await serve();
        flag(disabled, scopeId, context, (route) => captureAllowed(route.capture, context?.mode ?? "explicit"));
        return service.capture(scopeId, facts, at, author, context);
      },
      read: async (scopeId) => (await serve()).service.read(scopeId),
      facts: async (scopeId) => (await (await serve()).service.facts?.(scopeId)) ?? [],
      async edit(scopeId, edits, author, context) {
        const { service } = await serve();
        if (!service.edit) throw new Error(`memory for ${scopeId} is not directly editable`);
        await service.edit(scopeId, edits, author, context);
      },
      async delete(scopeId, ids, author) {
        const { service } = await serve();
        if (!service.delete) throw new Error(`memory for ${scopeId} is not directly editable`);
        await service.delete(scopeId, ids, author);
      },
      metadata: async () => (await (await serve()).service.metadata?.()) ?? new Map(),
    };
  }

  return view();
}
