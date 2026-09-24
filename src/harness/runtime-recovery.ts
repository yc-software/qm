import type { RuntimeChoice } from "./harness.ts";
import type { SessionEntry } from "../types.ts";
import { isHarnessId } from "../model/pi-models.ts";
import { isObj } from "../util/objects.ts";

export function recoveredRuntime(
  entries: readonly SessionEntry[],
  runId: string,
  actorId: string,
): RuntimeChoice | undefined {
  for (const entry of [...entries].reverse()) {
    const p = entry.payload;
    if (!isObj(p) || p.runId !== runId || p.actorId !== actorId) continue;
    let choice: unknown;
    if (entry.type === "tool_result" && p.tool === "runtime" && isObj(p.runtimeHandoff))
      choice = p.runtimeHandoff.choice;
    else if (entry.type === "system" && p.kind === "runtime_active") choice = p.choice;
    if (
      isObj(choice) &&
      isHarnessId(choice.harnessId) &&
      typeof choice.modelId === "string" &&
      (choice.effortLevel === undefined || typeof choice.effortLevel === "string") &&
      (choice.fastMode === undefined || typeof choice.fastMode === "boolean")
    )
      return choice as unknown as RuntimeChoice;
  }
  return undefined;
}

export function recoveredModelAccount(
  entries: readonly SessionEntry[],
  runId: string,
  actorId: string,
): import("../resolution/config-store.ts").ModelAccount | undefined {
  for (const entry of [...entries].reverse()) {
    const p = entry.payload;
    if (
      entry.type !== "system" ||
      !isObj(p) ||
      p.kind !== "runtime_active" ||
      p.runId !== runId ||
      p.actorId !== actorId
    )
      continue;
    if (
      p.modelAccount === "company" ||
      p.modelAccount === "personal" ||
      p.modelAccount === "anthropic" ||
      p.modelAccount === "openai"
    )
      return p.modelAccount;
  }
  return undefined;
}
