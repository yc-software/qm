import type { OrchestratorInput } from "../core/orchestrator.ts";
import { THINKING_LEVELS } from "../model/pi-models.ts";

export type SwarmMemberRuntime = Pick<OrchestratorInput, "model" | "thinkingLevel" | "fastMode">;

export const SPAWN_RUNTIME_FIELDS = ["model", "effort", "fastMode"] as const;
export type SpawnRuntimeFields = Partial<Record<(typeof SPAWN_RUNTIME_FIELDS)[number], unknown>>;

export function spawnRuntime(input: SpawnRuntimeFields): SwarmMemberRuntime {
  const runtime: SwarmMemberRuntime = {};
  if (input.model !== undefined) {
    if (typeof input.model !== "string" || !input.model.trim() || input.model.length > 128)
      throw new Error("invalid model");
    runtime.model = input.model.trim();
  }
  if (input.effort !== undefined) {
    if (typeof input.effort !== "string" || !THINKING_LEVELS.includes(input.effort as never))
      throw new Error("invalid effort");
    runtime.thinkingLevel = input.effort;
  }
  if (input.fastMode !== undefined) {
    if (typeof input.fastMode !== "boolean") throw new Error("invalid fastMode");
    runtime.fastMode = input.fastMode;
  }
  return runtime;
}

export function inheritRuntime(
  parent: SwarmMemberRuntime | undefined,
  chosen: SwarmMemberRuntime,
): SwarmMemberRuntime | undefined {
  const runtime = { ...parent, ...chosen };
  return Object.keys(runtime).length ? runtime : undefined;
}
