import type { Cron } from "../types.ts";
import type { RuntimeChoice } from "../harness/harness.ts";
import { THINKING_LEVELS, isHarnessId } from "../model/pi-models.ts";
import { isObj } from "../util/objects.ts";

export function isCronRuntime(value: unknown): value is RuntimeChoice | null | undefined {
  if (value === undefined || value === null) return true;
  return (
    isObj(value) &&
    Object.keys(value).every((key) => ["harnessId", "modelId", "effortLevel", "fastMode"].includes(key)) &&
    isHarnessId(value.harnessId) &&
    typeof value.modelId === "string" &&
    value.modelId.trim().length > 0 &&
    (value.effortLevel === undefined ||
      (typeof value.effortLevel === "string" &&
        value.effortLevel !== "auto" &&
        (THINKING_LEVELS as readonly string[]).includes(value.effortLevel))) &&
    (value.fastMode === undefined || typeof value.fastMode === "boolean")
  );
}

export function assertCronRuntime(cron: Pick<Cron, "runtime" | "loopId" | "action" | "message">): void {
  if (!isCronRuntime(cron.runtime))
    throw new Error(
      "runtime requires harnessId, modelId and optional explicit effortLevel/fastMode; null inherits defaults",
    );
  if (cron.runtime && (cron.loopId || !cron.action?.trim() || cron.message !== undefined))
    throw new Error("runtime overrides require an agent cron task, not a loop or exact-message cron");
}
