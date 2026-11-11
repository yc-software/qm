import { disclosedMemory, MemoryRecallWithheld } from "./disclosure.ts";
import { isSystemActor, parseScopeId, type ScopeId, type ScopeKind } from "../types.ts";
import type { McpEnvelope } from "../mcp/mcp-client.ts";
import {
  changesBrainAsPerson,
  changesNotebookOnly,
  type BrainCall,
  type MemoryProviderOutcome,
  type MemoryRecallContext,
  type MemoryService,
} from "./memory-service.ts";
import { MemoryForgetRefused, type MemoryCandidate } from "./facts.ts";
import { changeFailure, failedOutcome, strictFailure, withEnvelope } from "./provider-outcome.ts";
import { OutsideAudience, ownPrivateConversation } from "../directory/person.ts";

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
  onError?: (error: unknown, provider: string, operation: "recall" | "query" | "capture" | "forget") => void;
}): MemoryService {
  const routesFor = (scopeId: ScopeId): MemoryProviderRoute[] => opts.routes.filter((route) => matches(route, scopeId));
  const providerFor = (route: MemoryProviderRoute): MemoryService => {
    const provider = opts.providers[route.provider];
    if (!provider) throw new Error(`unknown memory provider: ${route.provider}`);
    return provider;
  };
  const tagged = (route: MemoryProviderRoute, rows: MemoryCandidate[]): MemoryCandidate[] =>
    route.provider === "default"
      ? rows
      : rows.map((row) => ({
          ...row,
          ...(row.ref === undefined ? {} : { ref: `${route.provider}:${row.ref}` }),
          source: { provider: route.provider, label: route.label ?? route.provider },
        }));
  const managerFor = (scopeId: ScopeId): MemoryService | undefined => {
    const route = routesFor(scopeId).find((candidate) => candidate.manage !== false);
    return route ? providerFor(route) : undefined;
  };
  async function attempt<T>(
    route: MemoryProviderRoute,
    scopeId: ScopeId,
    operation: "recall" | "query" | "capture" | "forget",
    context: Pick<MemoryRecallContext, "report"> | undefined,
    run: () => Promise<T>,
    settle: (value: T, envelope: McpEnvelope) => Pick<MemoryProviderOutcome, "outcome" | "added">,
    fallback: T,
  ): Promise<{ value: T; error?: unknown }> {
    const started = Date.now();
    const report = (fields: Omit<MemoryProviderOutcome, "provider" | "scope" | "ms">) =>
      context?.report?.({ provider: route.provider, scope: scopeId, ms: Date.now() - started, ...fields });
    try {
      const { value, envelope } = await withEnvelope(run);
      report({ ...settle(value, envelope), ...(envelope.code ? { code: envelope.code } : {}) });
      return { value };
    } catch (error) {
      if (error instanceof MemoryRecallWithheld) return { value: fallback };
      const failed = failedOutcome(error);
      if (error instanceof OutsideAudience) {
        report(failed);
        opts.onError?.(error, route.provider, operation);
        return { value: fallback };
      }
      report(operation === "capture" || operation === "forget" ? changeFailure(error) : failed);
      if (!route.failOpen) return { value: fallback, error };
      opts.onError?.(error, route.provider, operation);
      return { value: fallback };
    }
  }
  const strict = <T>(results: readonly { value: T; error?: unknown }[]): T[] => {
    const failure = results.find((result) => result.error !== undefined);
    if (failure) throw strictFailure(failure.error);
    return results.map((result) => result.value);
  };

  return {
    withDisclosure(access) {
      return createRoutedMemoryService({
        ...opts,
        providers: Object.fromEntries(
          Object.entries(opts.providers).map(([name, provider]) => [name, disclosedMemory(provider, access)]),
        ),
        routes: access.notebookOnly
          ? opts.routes.filter((route) => opts.providers[route.provider]?.facts)
          : opts.routes,
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
              () => providerFor(route).recall(scopeId, context),
              (rows) => ({ outcome: rows.length ? "ok" : "empty" }),
              [],
            ),
          ),
        ),
      );
      return routes.flatMap((route, index) => tagged(route, batches[index]!));
    },

    async capture(scopeId, facts, at, by, context) {
      const mode = context?.mode ?? "explicit";
      const routes = routesFor(scopeId).filter((route) => captureAllowed(route.capture, mode));
      const notebookOnly =
        changesNotebookOnly(by) ||
        (context?.conversationScopeId !== undefined && context.conversationScopeId !== scopeId);
      const counts = strict(
        await Promise.all(
          routes.map((route) => {
            const provider = providerFor(route);
            if (notebookOnly && !provider.facts) return { value: 0 };
            if (provider.attestActor && isSystemActor(by?.actorId)) return { value: 0 };
            return attempt(
              route,
              scopeId,
              "capture",
              context,
              () => provider.capture(scopeId, facts, at, by, context),
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
      const batches = strict(
        await Promise.all(
          routes.map((route) =>
            attempt(
              route,
              scopeId,
              "query",
              context,
              () => providerFor(route).query(scopeId, q, limit, context),
              (hits) => ({ outcome: hits.length ? "ok" : "empty" }),
              [],
            ),
          ),
        ),
      );
      return routes.flatMap((route, index) => tagged(route, batches[index]!));
    },

    async brains(scopeId) {
      const routes = routesFor(scopeId).filter(
        (route, index, all) => all.findIndex((other) => other.provider === route.provider) === index,
      );
      return routes.flatMap(({ provider, label }) => {
        const operations = opts.providers[provider]?.operations;
        if (!operations) return [];
        return [
          {
            id: provider,
            label: label ?? provider,
            tools: (context: BrainCall) => operations.tools(scopeId, context),
            call: (op: string, args: Record<string, unknown>, context: BrainCall) =>
              operations.call(scopeId, op, args, context),
          },
        ];
      });
    },

    async read(scopeId) {
      const manager = managerFor(scopeId);
      return manager ? manager.read(scopeId) : "";
    },

    async facts(scopeId) {
      return (await managerFor(scopeId)?.facts?.(scopeId)) ?? [];
    },

    async edit(scopeId, edits, by, context) {
      const manager = managerFor(scopeId);
      if (!manager?.edit) throw new Error(`memory for ${scopeId} is not directly editable`);
      await manager.edit(scopeId, edits, by, context);
    },

    async delete(scopeId, ids, by, context) {
      const refs = ids
        .filter((id) => id.includes(":"))
        .map((ref) => {
          const brain = ref.slice(0, ref.indexOf(":"));
          const route = routesFor(scopeId).find((candidate) => candidate.provider === brain);
          const provider = route && opts.providers[brain];
          if (!route || !provider?.delete)
            throw new MemoryForgetRefused(
              `Memory provider ${brain} can't forget ${ref} here: it doesn't serve this conversation's notebook, or it has no forget operation. Nothing was changed.`,
            );
          return { ref, brain, route, provider };
        });
      if (
        refs.length &&
        (!changesBrainAsPerson(by) || !ownPrivateConversation(by!.actorId, scopeId, context?.audienceScopeId))
      )
        throw new MemoryForgetRefused(
          "Only the person, on a turn they sent in their own DM with QM, can forget a brain fact; admin, maintenance, self-service, bot, automation and ambient changes reach the notebook only. Nothing was changed.",
        );
      const notebookIds = ids.filter((id) => !id.includes(":"));
      if (notebookIds.length) {
        const manager = managerFor(scopeId);
        if (!manager?.delete) throw new Error(`memory for ${scopeId} is not directly editable`);
        await manager.delete(scopeId, notebookIds, by, context);
      }
      for (const { ref, brain, route, provider } of refs) {
        const { error } = await attempt(
          route,
          scopeId,
          "forget",
          { report: (outcome) => context?.report?.({ ...outcome, ref }) },
          () => provider.delete!(scopeId, [ref.slice(brain.length + 1)], by, context),
          (_, envelope) => ({ outcome: envelope.status === "pending" ? "pending" : "committed" }),
          undefined,
        );
        if (error) opts.onError?.(error, brain, "forget");
      }
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
