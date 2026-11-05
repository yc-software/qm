import type { RuntimeChoice } from "./agent.ts";
import type { Item } from "../sessions/items.ts";
import { isObj } from "../util/objects.ts";

export function recoveredRuntime(
  items: readonly Item[],
  runId: string,
  actorId: string,
): { choice: RuntimeChoice; lifetime: "task" | "scope" } | undefined {
  for (const item of [...items].reverse()) {
    const p = item.body;
    if (
      item.kind !== "ToolResult" ||
      item.tool !== "runtime" ||
      item.turnId !== runId ||
      p.actorId !== actorId ||
      !isObj(p.runtimeHandoff)
    )
      continue;
    const choice = p.runtimeHandoff.choice;
    if (
      isObj(choice) &&
      typeof choice.modelId === "string" &&
      (choice.effortLevel === undefined || typeof choice.effortLevel === "string") &&
      (choice.fastMode === undefined || typeof choice.fastMode === "boolean")
    )
      return {
        choice: {
          modelId: choice.modelId,
          ...(choice.effortLevel === undefined ? {} : { effortLevel: choice.effortLevel }),
          ...(choice.fastMode === undefined ? {} : { fastMode: choice.fastMode }),
        },
        lifetime: p.runtimeHandoff.lifetime === "scope" ? "scope" : "task",
      };
  }
  return undefined;
}
