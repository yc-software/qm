import { disclosedMemory, MemoryRecallWithheld } from "./disclosure.ts";
import { isSystemActor, parseScopeId, type ScopeId, type ScopeKind } from "../types.ts";
import type { McpEnvelope } from "../mcp/mcp-client.ts";
import {
  brainActsAsPerson,
  changesNotebookOnly,
  type MemoryProviderOutcome,
  type MemoryRecallContext,
  type MemoryService,
  resolveIds,
} from "./memory-service.ts";
import { MemoryForgetRefused, type MemoryCandidate } from "./facts.ts";
import {
  changeFailure,
  failedOutcome,
  forgetKnown,
  problemLine,
  problemOf,
  strictFailure,
  withEnvelope,
} from "./provider-outcome.ts";
import { errMessage } from "../util/errors.ts";
import { quotedData } from "../util/text.ts";
import { OutsideAudience } from "../directory/person.ts";

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

export const providerRef = (provider: string, ref: string) => `${provider}:${ref}`;

export const brainRefused = (reason: string) => new Error(`[brain_refused] ${reason} Nothing was sent.`);

function parseProviderRef(value: string): { provider: string; ref: string } | undefined {
  const at = value.indexOf(":");
  return at < 0 ? undefined : { provider: value.slice(0, at), ref: value.slice(at + 1) };
}

function captureAllowed(policy: MemoryCapturePolicy | undefined, mode: "explicit" | "automatic"): boolean {
  if (policy === "automatic") return true;
  return policy === "explicit" && mode === "explicit";
}

function settleChange(added: unknown, envelope: McpEnvelope): Pick<MemoryProviderOutcome, "outcome" | "added"> {
  return {
    outcome: envelope.status === "pending" ? "pending" : "committed",
    ...(typeof added === "number" ? { added } : {}),
  };
}

export function createRoutedMemoryService(opts: {
  providers: Readonly<Record<string, MemoryService>>;
  routes: readonly MemoryProviderRoute[];
  onError?: (error: unknown, provider: string, operation: "recall" | "query" | "capture" | "forget" | "lookup") => void;
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
      : rows.map(({ ref, ...row }) => ({
          ...row,
          ...(ref === undefined || !opts.providers[route.provider]?.delete
            ? {}
            : { ref: providerRef(route.provider, ref) }),
          source: { provider: route.provider, label: route.label ?? route.provider },
        }));
  const brainRoutes = (scopeId: ScopeId): MemoryProviderRoute[] =>
    routesFor(scopeId)
      .filter((route) => route.recall !== false && opts.providers[route.provider]?.lookup)
      .filter((route, index, all) => all.findIndex((other) => other.provider === route.provider) === index);
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
              settleChange,
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

    async brains(scopeId, reader) {
      return Promise.all(
        brainRoutes(scopeId).map(async ({ provider, label }) => ({
          id: provider,
          label: label ?? provider,
          tools: await opts.providers[provider]!.lookupTools!(scopeId, reader).catch((error: unknown) => {
            opts.onError?.(error, provider, "lookup");
            return [];
          }),
        })),
      );
    },

    async lookup(scopeId, tool, args, by, context) {
      if (!brainActsAsPerson(by, scopeId, context?.audienceScopeId))
        throw brainRefused(
          "Only the person, on a turn they sent in their own DM with QM, can look things up in their brain.",
        );
      const ref = parseProviderRef(tool);
      const route = ref && brainRoutes(scopeId).find((candidate) => candidate.provider === ref.provider);
      if (!ref || !route) throw brainRefused(`${tool} isn't a tool of a brain connected to this conversation.`);
      const started = Date.now();
      try {
        return await opts.providers[route.provider]!.lookup!(scopeId, ref.ref, args, by, context);
      } catch (error) {
        opts.onError?.(error, route.provider, "lookup");
        const problem = problemOf(
          {
            provider: route.provider,
            scope: scopeId,
            ms: Date.now() - started,
            ...failedOutcome(error),
            refs: [ref.ref],
          },
          "lookup",
        )!;
        throw new Error(`${problemLine(problem)}\n${quotedData(errMessage(error))}`, { cause: error });
      }
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
      const refs = ids.flatMap((ref) => {
        const parsed = parseProviderRef(ref);
        if (!parsed) return [];
        const route =
          parsed.provider === "default"
            ? undefined
            : routesFor(scopeId).find((candidate) => candidate.provider === parsed.provider);
        const provider = route && opts.providers[parsed.provider];
        if (!route || !provider)
          throw new MemoryForgetRefused(
            `Memory provider ${parsed.provider} doesn't serve this conversation's memory here, so QM can't forget ${ref}. Nothing was changed.`,
          );
        if (!provider.delete)
          throw new MemoryForgetRefused(
            `Memory provider ${parsed.provider} has no forget operation; only registry brains forget by ref. Nothing was changed.`,
          );
        return [{ ref, brain: parsed.provider, factId: parsed.ref, route, provider }];
      });
      if (refs.length && !brainActsAsPerson(by, scopeId, context?.audienceScopeId))
        throw new MemoryForgetRefused(
          "Only the person, on a turn they sent in their own DM with QM, can forget a brain fact; admin, maintenance, self-service, bot, automation and ambient changes reach the notebook only. Nothing was changed.",
        );
      const notebookIds = ids.filter((id) => !parseProviderRef(id));
      const manager = notebookIds.length ? managerFor(scopeId) : undefined;
      if (notebookIds.length && !manager?.delete) throw new Error(`memory for ${scopeId} is not directly editable`);
      if (refs.length && manager?.facts) resolveIds(await manager.facts(scopeId), notebookIds);
      const settled: MemoryProviderOutcome[] = [];
      for (const { ref, brain, factId, route, provider } of refs) {
        const { error } = await attempt(
          route,
          scopeId,
          "forget",
          {
            report: (outcome) => {
              settled.push(outcome);
              context?.report?.({ ...outcome, ref });
            },
          },
          () => provider.delete!(scopeId, [factId], by, context),
          settleChange,
          undefined,
        );
        if (error) opts.onError?.(error, brain, "forget");
      }
      if (manager?.delete && forgetKnown(settled)) await manager.delete(scopeId, notebookIds, by, context);
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
