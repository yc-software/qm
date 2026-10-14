import { disclosedMemory } from "./disclosure.ts";
import { parseScopeId, type ScopeId, type ScopeKind } from "../types.ts";
import type { MemoryRecallContext, MemoryService } from "./memory-service.ts";
import type { MemoryCandidate } from "./facts.ts";
import { mergeCandidates, recallCandidates, MemoryRecallRetry } from "./recall-candidates.ts";

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

  async function* routeCandidates(route: MemoryProviderRoute, scope: ScopeId, context?: MemoryRecallContext) {
    try {
      yield* recallCandidates(providerFor(route), scope, context);
    } catch (error) {
      if (error instanceof MemoryRecallRetry || !route.failOpen) throw error;
      opts.onError?.(error, route.provider, "recall");
    }
  }
  async function* recallPages(scope: ScopeId, context?: MemoryRecallContext): AsyncGenerator<MemoryCandidate[]> {
    const routes = routesFor(scope).filter((route) => route.recall !== false);
    const iterators = routes.map((route) => routeCandidates(route, scope, context));
    try {
      const heads = await Promise.all(iterators.map((iterator) => iterator.next()));
      const count = heads.filter((head) => !head.done).length;
      const streams = routes.map(async function* (route, index) {
        const head = heads[index]!;
        if (head.done) return;
        const label = route.label ?? (count > 1 ? route.provider : undefined);
        const labelRow = (row: MemoryCandidate) =>
          label && row.id === undefined ? { ...row, text: `### ${label}\n${row.text}` } : row;
        yield labelRow(head.value);
        for await (const row of iterators[index]!) yield labelRow(row);
      });
      for await (const row of mergeCandidates(streams)) yield [row];
    } finally {
      await Promise.all(iterators.map((iterator) => iterator.return()));
    }
  }

  return {
    withDisclosure(access) {
      return createRoutedMemoryService({
        ...opts,
        providers: Object.fromEntries(
          Object.entries(opts.providers).map(([name, provider]) => [name, disclosedMemory(provider, access)]),
        ),
      });
    },
    recallPages,
    async recall(scope, context) {
      const result: MemoryCandidate[] = [];
      try {
        for await (const page of recallPages(scope, context)) result.push(...page);
        return result;
      } catch (error) {
        if (!(error instanceof MemoryRecallRetry)) throw error;
        const fallback: MemoryCandidate[] = [];
        for await (const page of recallPages(scope, { ...context, recencyOnly: true })) fallback.push(...page);
        return fallback;
      }
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
