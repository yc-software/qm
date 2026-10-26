import type { ScopeId } from "../types.ts";
import type { MemoryCaptureMetadata } from "./facts.ts";
import { classifiedMemory } from "./classification.ts";
import type { HarnessModelUtilities } from "../harness/harness.ts";
import type { MemoryService } from "./memory-service.ts";
import { createPerTurnStrategy } from "./strategies/per-turn.ts";
import { createAgentOnlyStrategy } from "./strategies/agent-only.ts";

export interface MemoryStrategy {
  onTurnEnd?(
    ctx: MemoryCaptureMetadata & {
      scopeId: ScopeId;
      input: string;
      reply: string;
      actorId?: string;
      autonomous?: boolean;
      conversationScopeId?: ScopeId;
      sessionId?: string;
      idempotencyKey?: string;
    },
  ): Promise<void>;
  promptLines?(): string[];
}

export type MemoryStrategyKind = "per-turn" | "agent-only";

export const DEFAULT_MEMORY_STRATEGY: MemoryStrategyKind = "per-turn";

export interface MemoryStrategyDeps {
  harness: HarnessModelUtilities;
  memory: MemoryService;
  captureQuietMs?: number;
  captureMaxTurns?: number;
  onCaptureError?: (e: unknown, scopeId: ScopeId) => void;
}

export function createMemoryStrategy(
  kind: MemoryStrategyKind,
  deps: MemoryStrategyDeps,
): { strategy: MemoryStrategy; memory: MemoryService } {
  const memory = classifiedMemory(deps.memory, deps.harness);
  if (kind === "agent-only") return { strategy: createAgentOnlyStrategy(), memory };
  return {
    strategy: createPerTurnStrategy({
      harness: deps.harness,
      memory,
      ...(deps.captureQuietMs !== undefined ? { captureQuietMs: deps.captureQuietMs } : {}),
      ...(deps.captureMaxTurns !== undefined ? { captureMaxTurns: deps.captureMaxTurns } : {}),
      ...(deps.onCaptureError ? { onCaptureError: deps.onCaptureError } : {}),
    }),
    memory,
  };
}
