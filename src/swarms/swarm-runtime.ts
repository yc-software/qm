import type { OrchestratorInput } from "../core/orchestrator.ts";
import { isHarnessId, THINKING_LEVELS } from "../model/pi-models.ts";

export type SwarmMemberRuntime = Pick<OrchestratorInput, "harness" | "model" | "thinkingLevel" | "fastMode">;

export const SPAWN_RUNTIME_FIELDS = ["model", "effort", "fastMode", "harness"] as const;
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
  if (input.harness !== undefined) {
    if (!isHarnessId(input.harness)) throw new Error("invalid harness");
    runtime.harness = input.harness;
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

export function workerTurnInput<T extends SwarmMemberRuntime>(
  input: T,
  runtime: SwarmMemberRuntime | undefined,
  subagentDefaultGoverns: boolean,
): T {
  const base = subagentDefaultGoverns
    ? { ...input, harness: undefined, model: undefined, thinkingLevel: undefined, fastMode: undefined }
    : input;
  return { ...base, ...runtime };
}
