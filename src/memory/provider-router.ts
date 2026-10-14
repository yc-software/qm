import { disclosedMemory } from "./disclosure.ts";
import { parseScopeId, type ScopeId, type ScopeKind } from "../types.ts";
import type { MemoryService } from "./memory-service.ts";

export type MemoryCapturePolicy = "off" | "explicit" | "automatic";

export interface MemoryProviderRoute {
  provider: string;
  scopes: readonly (ScopeKind | ScopeId)[];
  recall?: boolean;
  capture?: MemoryCapturePolicy;
  manage?: boolean;
  label?: string;
  failOpen?: boolean;
}

function matches(route: MemoryProviderRoute, scopeId: ScopeId): boolean {
  const kind = parseScopeId(scopeId).kind;
  return route.scopes.some((scope) => scope === scopeId || scope === kind);
}

function captureAllowed(policy: MemoryCapturePolicy | undefined, mode: "explicit" | "automatic"): boolean {
  if (policy === "automatic") return true;
  return policy === "explicit" && mode === "explicit";
}

export function createRoutedMemoryService(opts: {
  providers: Readonly<Record<string, MemoryService>>;
  routes: readonly MemoryProviderRoute[];
  onError?: (error: unknown, provider: string, operation: "recall" | "query" | "capture") => void;
}): MemoryService {
  const routesFor = (scopeId: ScopeId): MemoryProviderRoute[] => opts.routes.filter((route) => matches(route, scopeId));
  const providerFor = (route: MemoryProviderRoute): MemoryService => {
    const provider = opts.providers[route.provider];
    if (!provider) throw new Error(`unknown memory provider: ${route.provider}`);
    return provider;
  };
  const managerFor = (scopeId: ScopeId): MemoryService | undefined => {
    const route = routesFor(scopeId).find((candidate) => candidate.manage !== false);
    return route ? providerFor(route) : undefined;
  };

  return {
    withDisclosure(access) {
      return createRoutedMemoryService({
        ...opts,
        providers: Object.fromEntries(
          Object.entries(opts.providers).map(([name, provider]) => [name, disclosedMemory(provider, access)]),
        ),
      });
    },
    async recall(scopeId, context) {
      const routes = routesFor(scopeId).filter((route) => route.recall !== false);
      const batches = await Promise.all(
        routes.map(async (route) => {
          try {
            return { route, rows: await providerFor(route).recall(scopeId, context) };
          } catch (error) {
            if (!route.failOpen) throw error;
            opts.onError?.(error, route.provider, "recall");
            return { route, rows: [] };
          }
        }),
      );
      const present = batches.filter(({ rows }) => rows.length);
      return present.flatMap(({ route, rows }) => {
        const label = route.label ?? (present.length > 1 ? route.provider : undefined);
        return rows.map((row) => (label && row.id === undefined ? { ...row, text: `### ${label}\n${row.text}` } : row));
      });
    },

    async capture(scopeId, facts, at, author, context) {
      const mode = context?.mode ?? "explicit";
      const routes = routesFor(scopeId).filter((route) => captureAllowed(route.capture, mode));
      const counts = await Promise.all(
        routes.map(async (route) => {
          try {
            const provider = providerFor(route);
            if (context?.conversationScopeId && context.conversationScopeId !== scopeId && !provider.facts) return 0;
            return await provider.capture(scopeId, facts, at, author, context);
          } catch (error) {
            if (!route.failOpen) throw error;
            opts.onError?.(error, route.provider, "capture");
            return 0;
          }
        }),
      );
      return counts.length ? Math.max(...counts) : 0;
    },

    async query(scopeId, q, limit = 20, context) {
      const routes = routesFor(scopeId).filter((route) => route.recall !== false);
      const rows = await Promise.all(
        routes.map(async (route) => {
          try {
            return await providerFor(route).query(scopeId, q, limit, context);
          } catch (error) {
            if (!route.failOpen) throw error;
            opts.onError?.(error, route.provider, "query");
            return [];
          }
        }),
      );
      return [...new Set(rows.flat())].slice(0, limit);
    },

    async read(scopeId) {
      const manager = managerFor(scopeId);
      return manager ? manager.read(scopeId) : "";
    },

    async facts(scopeId) {
      return (await managerFor(scopeId)?.facts?.(scopeId)) ?? [];
    },

    async edit(scopeId, edits, author, context) {
      const manager = managerFor(scopeId);
      if (!manager?.edit) throw new Error(`memory for ${scopeId} is not directly editable`);
      await manager.edit(scopeId, edits, author, context);
    },

    async delete(scopeId, ids, author) {
      const manager = managerFor(scopeId);
      if (!manager?.delete) throw new Error(`memory for ${scopeId} is not directly editable`);
      await manager.delete(scopeId, ids, author);
    },

    async metadata() {
      const out = new Map<ScopeId, { bytes: number; updatedAt?: number }>();
      for (const provider of new Set(opts.routes.filter((route) => route.manage !== false).map(providerFor))) {
        for (const [scopeId, meta] of (await provider.metadata?.()) ?? []) out.set(scopeId, meta);
      }
      return out;
    },
  };
}
