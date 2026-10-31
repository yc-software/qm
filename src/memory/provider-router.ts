import { disclosedMemory } from "./disclosure.ts";
import { parseScopeId, type ScopeId, type ScopeKind } from "../types.ts";
import type { MemoryProviderOutcome, MemoryService } from "./memory-service.ts";
import { failedOutcome } from "./provider-outcome.ts";

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

type Sinks = { report?: (outcome: MemoryProviderOutcome) => void };

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
  async function attempt<T>(
    route: MemoryProviderRoute,
    scopeId: ScopeId,
    operation: "recall" | "query" | "capture",
    context: Sinks | undefined,
    run: (envelope: (envelope: { code?: string; status?: string }) => void) => Promise<T>,
    settle: (
      value: T,
      envelope: { code?: string; status?: string },
    ) => Pick<MemoryProviderOutcome, "outcome" | "added">,
    fallback: T,
  ): Promise<{ value: T; error?: unknown }> {
    const started = Date.now();
    const report = (fields: Omit<MemoryProviderOutcome, "provider" | "scope" | "ms">) =>
      context?.report?.({ provider: route.provider, scope: scopeId, ms: Date.now() - started, ...fields });
    let received: { code?: string; status?: string } = {};
    try {
      const value = await run((envelope) => void (received = envelope));
      report({ ...settle(value, received), ...(received.code ? { code: received.code } : {}) });
      return { value };
    } catch (error) {
      const failed = failedOutcome(error);
      report(operation === "capture" && failed.outcome === "timed_out" ? { ...failed, outcome: "unknown" } : failed);
      if (failed.code === "withheld") return { value: fallback };
      if (!route.failOpen) return { value: fallback, error };
      opts.onError?.(error, route.provider, operation);
      return { value: fallback };
    }
  }
  const strict = <T>(results: readonly { value: T; error?: unknown }[]): T[] => {
    const failure = results.find((result) => result.error !== undefined);
    if (failure) throw failure.error;
    return results.map((result) => result.value);
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
      const batches = strict(
        await Promise.all(
          routes.map((route) =>
            attempt(
              route,
              scopeId,
              "recall",
              context,
              (envelope) => providerFor(route).recall(scopeId, { ...context, envelope }),
              (rows) => ({ outcome: rows.length ? "ok" : "empty" }),
              [],
            ),
          ),
        ),
      );
      return routes.flatMap((route, index) =>
        batches[index]!.map((row) =>
          route.provider === "default"
            ? row
            : { ...row, source: { provider: route.provider, label: route.label ?? route.provider } },
        ),
      );
    },

    async capture(scopeId, facts, at, author, context) {
      const mode = context?.mode ?? "explicit";
      const routes = routesFor(scopeId).filter((route) => captureAllowed(route.capture, mode));
      const counts = strict(
        await Promise.all(
          routes.map((route) => {
            const provider = providerFor(route);
            if (context?.conversationScopeId && context.conversationScopeId !== scopeId && !provider.facts)
              return { value: 0 };
            return attempt(
              route,
              scopeId,
              "capture",
              context,
              (envelope) => provider.capture(scopeId, facts, at, author, { ...context, mode, envelope }),
              (added, envelope) => ({ outcome: envelope.status === "pending" ? "pending" : "committed", added }),
              0,
            );
          }),
        ),
      );
      return counts.length ? Math.max(...counts) : 0;
    },

    async query(scopeId, q, limit = 20, context) {
      const routes = routesFor(scopeId).filter((route) => route.recall !== false);
      const rows = strict(
        await Promise.all(
          routes.map((route) =>
            attempt(
              route,
              scopeId,
              "query",
              context,
              (envelope) => providerFor(route).query(scopeId, q, limit, { ...context, envelope }),
              (hits) => ({ outcome: hits.length ? "ok" : "empty" }),
              [],
            ),
          ),
        ),
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
