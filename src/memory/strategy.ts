import type { ScopeId } from "../types.ts";
import type { MemoryCaptureTurn } from "./capture-context.ts";
import { createMemoryCaptureQueue } from "./capture-queue.ts";
import { classifiedMemory } from "./classification.ts";
import type { ModelUtilities } from "../agent/agent.ts";
import type { MemoryService } from "./memory-service.ts";
import {
  createPerTurnStrategy,
  captureMemoryTurns,
  DEFAULT_CAPTURE_QUIET_MS,
  DEFAULT_CAPTURE_MAX_TURNS,
} from "./strategies/per-turn.ts";
import { createAgentOnlyStrategy } from "./strategies/agent-only.ts";
import { withModelRequestContext } from "../model/request-context.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import type { Tenant } from "../tenants/context.ts";

export interface MemoryStrategy {
  onTurnEnd?(tenant: Tenant, ctx: MemoryCaptureTurn): Promise<void>;
  enqueueTurnEnd?(tenant: Tenant, ctx: MemoryCaptureTurn): Promise<void>;
  start?(): Promise<void>;
  stopClaims?(): Promise<void>;
  stop?(): Promise<void>;
  promptLines?(): string[];
}

export type MemoryStrategyKind = "per-turn" | "agent-only";

export const DEFAULT_MEMORY_STRATEGY: MemoryStrategyKind = "per-turn";

export function parseMemoryStrategyKind(value: string | undefined): MemoryStrategyKind {
  return value === "agent-only" ? value : DEFAULT_MEMORY_STRATEGY;
}

export interface MemoryStrategyDeps {
  databaseUrl?: string;
  agent: ModelUtilities;
  memory: MemoryService;
  sessions?: Pick<SessionStore, "get" | "inheritedOrigin">;
  captureQuietMs?: number;
  captureMaxTurns?: number;
  onCaptureError?: (e: unknown, scopeId: ScopeId) => void;
}

export function createMemoryStrategy(
  kind: MemoryStrategyKind,
  deps: MemoryStrategyDeps,
): { strategy: MemoryStrategy; memory: MemoryService } {
  const memory = classifiedMemory(deps.memory, deps.agent);
  if (kind === "agent-only") return { strategy: createAgentOnlyStrategy(), memory };
  if (!deps.databaseUrl) {
    if (deps.captureQuietMs && deps.captureQuietMs > 0) throw new Error("Buffered memory capture requires Postgres");
    return { strategy: createPerTurnStrategy({ agent: deps.agent, memory }), memory };
  }
  const queue = createMemoryCaptureQueue({
    databaseUrl: deps.databaseUrl,
    quietMs: deps.captureQuietMs ?? DEFAULT_CAPTURE_QUIET_MS,
    maxTurns: deps.captureMaxTurns ?? DEFAULT_CAPTURE_MAX_TURNS,
    capture: async (tenant, turns, id, signal) => {
      try {
        const first = turns[0]!;
        const session = first.sessionId ? await deps.sessions?.get(first.sessionId) : undefined;
        await withModelRequestContext(
          {
            sessionId: first.sessionId,
            actorId: first.actorId,
            scopeId: first.conversationScopeId ?? first.scopeId,
            origin: session ? await deps.sessions!.inheritedOrigin(session) : undefined,
          },
          () => captureMemoryTurns(tenant, { agent: deps.agent, memory }, turns, id, signal),
        );
      } catch (error) {
        if (!signal.aborted) deps.onCaptureError?.(error, turns[0]!.scopeId);
        throw error;
      }
    },
  });
  return {
    strategy: { enqueueTurnEnd: queue.enqueue, start: queue.start, stopClaims: queue.stopClaims, stop: queue.stop },
    memory,
  };
}
