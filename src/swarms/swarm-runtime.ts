import type { OrchestratorInput } from "../core/orchestrator.ts";
import {
  modelSupportedByHarness,
  modelUnavailableReason,
  thinkingLevelsForHarness,
  THINKING_LEVELS,
} from "../model/pi-models.ts";

export type SwarmMemberRuntime = Pick<OrchestratorInput, "model" | "thinkingLevel" | "fastMode">;
export type SwarmTemplate = Omit<OrchestratorInput, keyof SwarmMemberRuntime | "harness">;

const SERVING_HARNESSES = ["pi", "claude"] as const;

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
  if (runtime.model) {
    const model = runtime.model;
    const harnesses = SERVING_HARNESSES.filter((harness) => modelSupportedByHarness(model, harness));
    if (!harnesses.length) throw new Error(`unknown model ${model}`);
    const unavailable = modelUnavailableReason(model);
    if (unavailable) throw new Error(`${model}: ${unavailable}`);
    const effort = runtime.thinkingLevel;
    if (effort && !harnesses.some((harness) => thinkingLevelsForHarness(harness, model).includes(effort)))
      throw new Error(`${effort} reasoning is not supported by ${model}`);
  }
  return Object.keys(runtime).length ? runtime : undefined;
}
