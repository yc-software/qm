import type { Cron } from "../types.ts";
import { isModelSelector, type ModelSelector } from "../harness/model-selector.ts";
import { isHarnessId, thinkingLevelsForHarness } from "../model/pi-models.ts";
import { isObj } from "../util/objects.ts";

export type CronRuntimeRequest<T> = Omit<T, "runtime"> & { runtime?: ModelSelector | "inherit" | null };

export interface CronComputeEstimate {
  workload: "routine" | "analysis" | "deep";
  reason: string;
}

export function isCronComputeEstimate(value: unknown): value is CronComputeEstimate | null | undefined {
  return (
    value === undefined ||
    value === null ||
    (isObj(value) &&
      Object.keys(value).every((key) => ["workload", "reason"].includes(key)) &&
      ["routine", "analysis", "deep"].includes(value.workload as string) &&
      typeof value.reason === "string" &&
      value.reason.trim().length > 0 &&
      value.reason.length <= 400)
  );
}

export function isCronRuntime(value: unknown): value is ModelSelector | "inherit" | null | undefined {
  return value === undefined || value === null || value === "inherit" || isModelSelector(value);
}

export function assertCronRuntime(
  cron: Pick<Cron, "runtime" | "computeEstimate" | "loopId" | "action" | "message">,
): void {
  if (
    !isCronRuntime(cron.runtime) ||
    (cron.runtime &&
      (!isHarnessId(cron.runtime.harnessId) ||
        (cron.runtime.effortLevel !== undefined &&
          (cron.runtime.effortLevel === "auto" ||
            !thinkingLevelsForHarness(cron.runtime.harnessId).includes(cron.runtime.effortLevel)))))
  )
    throw new Error(
      "runtime requires a resolved harnessId and modelId with supported effortLevel/fastMode; null inherits defaults",
    );
  if (!isCronComputeEstimate(cron.computeEstimate))
    throw new Error(
      "computeEstimate requires workload (routine/analysis/deep) and a non-empty reason of at most 400 characters",
    );
  if ((cron.runtime || cron.computeEstimate) && (cron.loopId || !cron.action?.trim() || cron.message !== undefined))
    throw new Error("runtime overrides require an agent cron task, not a loop or exact-message cron");
}
