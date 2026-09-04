import type { ScopeId } from "../types.ts";
import type { HarnessModelUtilities } from "../harness/harness.ts";
import type { MemoryService } from "./memory-service.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { createPerTurnStrategy } from "./strategies/per-turn.ts";
import { createScratchPromote } from "./strategies/scratch-promote.ts";
import {
  createConsolidatingMemory,
  createConsolidator,
  DEFAULT_CONSOLIDATE_AFTER,
} from "./strategies/consolidation.ts";
import { createAgentOnlyStrategy } from "./strategies/agent-only.ts";

export interface MemoryStrategy {
  onTurnEnd?(ctx: {
    scopeId: ScopeId;
    input: string;
    reply: string;
    actorId?: string;
    autonomous?: boolean;
    conversationScopeId?: ScopeId;
    conversationLabel?: string;
  }): Promise<void>;
  maintain?(scopeId: ScopeId): Promise<void>;
  promptLines?(): string[];
}

export type MemoryStrategyKind = "per-turn" | "scratch-promote" | "agent-only";

export const DEFAULT_MEMORY_STRATEGY: MemoryStrategyKind = "per-turn";

export function parseMemoryStrategyKind(value: string | undefined): MemoryStrategyKind {
  return value === "agent-only" || value === "scratch-promote" ? value : DEFAULT_MEMORY_STRATEGY;
}

export interface MemoryStrategyDeps {
  harness: HarnessModelUtilities;
  memory: MemoryService;
  workspace: WorkspaceStore;
  consolidateAfter?: number;
  captureQuietMs?: number;
  captureMaxTurns?: number;
  onCaptureError?: (e: unknown, scopeId: ScopeId) => void;
}

export function createMemoryStrategy(
  kind: MemoryStrategyKind,
  deps: MemoryStrategyDeps,
): { strategy: MemoryStrategy; memory: MemoryService } {
  if (kind === "scratch-promote") {
    return createScratchPromote({
      harness: deps.harness,
      memory: deps.memory,
      workspace: deps.workspace,
      consolidateAfter: deps.consolidateAfter ?? DEFAULT_CONSOLIDATE_AFTER,
      ...(deps.captureQuietMs !== undefined ? { captureQuietMs: deps.captureQuietMs } : {}),
      ...(deps.captureMaxTurns !== undefined ? { captureMaxTurns: deps.captureMaxTurns } : {}),
      ...(deps.onCaptureError ? { onCaptureError: deps.onCaptureError } : {}),
    });
  }
  const consolidator = createConsolidator({
    harness: deps.harness,
    memory: deps.memory,
    ...(deps.consolidateAfter !== undefined ? { afterN: deps.consolidateAfter } : {}),
  });
  const { memory, maintain } = createConsolidatingMemory(deps.memory, consolidator);
  if (kind === "agent-only") {
    return {
      strategy: {
        ...createAgentOnlyStrategy(),
        ...(maintain ? { maintain } : {}),
      },
      memory,
    };
  }
  return {
    strategy: createPerTurnStrategy({
      harness: deps.harness,
      memory,
      ...(maintain ? { maintain } : {}),
      ...(deps.captureQuietMs !== undefined ? { captureQuietMs: deps.captureQuietMs } : {}),
      ...(deps.captureMaxTurns !== undefined ? { captureMaxTurns: deps.captureMaxTurns } : {}),
      ...(deps.onCaptureError ? { onCaptureError: deps.onCaptureError } : {}),
    }),
    memory,
  };
}
