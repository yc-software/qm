import type { RuntimeChoice } from "./harness.ts";
import type { SessionEntry } from "../types.ts";
import { isHarnessId } from "../model/pi-models.ts";
import { isObj } from "../util/objects.ts";

export function recoveredRuntime(
  entries: readonly SessionEntry[],
  runId: string,
  actorId: string,
): { choice: RuntimeChoice; lifetime: "task" | "scope" } | undefined {
  for (const entry of [...entries].reverse()) {
    const p = entry.payload;
    if (
      entry.type !== "tool_result" ||
      !isObj(p) ||
      p.tool !== "runtime" ||
      p.runId !== runId ||
      p.actorId !== actorId ||
      !isObj(p.runtimeHandoff)
    )
      continue;
    const choice = p.runtimeHandoff.choice;
    if (
      isObj(choice) &&
      isHarnessId(choice.harnessId) &&
      typeof choice.modelId === "string" &&
      (choice.effortLevel === undefined || typeof choice.effortLevel === "string") &&
      (choice.fastMode === undefined || typeof choice.fastMode === "boolean")
    )
      return {
        choice: choice as unknown as RuntimeChoice,
        lifetime: p.runtimeHandoff.lifetime === "scope" ? "scope" : "task",
      };
  }
  return undefined;
}
