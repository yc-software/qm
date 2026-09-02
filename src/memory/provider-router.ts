import { parseScopeId, type ScopeId, type ScopeKind } from "../types.ts";
import type { MemoryRevision, MemoryService } from "./memory-service.ts";

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
    async recall(scopeId, context) {
      const routes = routesFor(scopeId).filter((route) => route.recall !== false);
      const recalled = await Promise.all(
        routes.map(async (route) => {
          try {
            return { route, body: (await providerFor(route).recall(scopeId, context)).trim() };
          } catch (error) {
            if (!route.failOpen) throw error;
            opts.onError?.(error, route.provider, "recall");
            return { route, body: "" };
          }
        }),
      );
      const present = recalled.filter(({ body }) => body);
      if (present.length === 0) return "";
      if (present.length === 1) {
        const { route, body } = present[0]!;
        return route.label ? `### ${route.label}\n${body}` : body;
      }
      return present.map(({ route, body }) => `### ${route.label ?? route.provider}\n${body}`).join("\n\n");
    },

    async capture(scopeId, facts, at, author, context) {
      const mode = context?.mode ?? "explicit";
      const routes = routesFor(scopeId).filter((route) => captureAllowed(route.capture, mode));
      const counts = await Promise.all(
        routes.map(async (route) => {
          try {
            return await providerFor(route).capture(scopeId, facts, at, author, context);
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

    async replace(scopeId, content, author) {
      const manager = managerFor(scopeId);
      if (!manager) throw new Error(`memory for ${scopeId} is not directly editable`);
      await manager.replace(scopeId, content, author);
    },

    async readHead(scopeId) {
      const manager = managerFor(scopeId);
      if (!manager) return { content: "", revision: "" };
      if (manager.readHead) return manager.readHead(scopeId);
      return { content: await manager.read(scopeId), revision: "" };
    },

    async replaceIfRevision(scopeId, content, revision, author) {
      const manager = managerFor(scopeId);
      if (!manager?.replaceIfRevision) return false;
      return manager.replaceIfRevision(scopeId, content, revision, author);
    },

    async history(scopeId, limit): Promise<MemoryRevision[]> {
      return (await managerFor(scopeId)?.history?.(scopeId, limit)) ?? [];
    },

    async restore(scopeId, revision, expectedRevision, author) {
      return (await managerFor(scopeId)?.restore?.(scopeId, revision, expectedRevision, author)) ?? false;
    },

    async updatedAt(scopeId) {
      return managerFor(scopeId)?.updatedAt?.(scopeId);
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
