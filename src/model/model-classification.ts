import { builtinRegistryEntry } from "./pi-models.ts";

export const MODEL_STATUSES = ["active", "legacy", "deprecated", "hidden"] as const;
export type ModelStatus = (typeof MODEL_STATUSES)[number];

export function isModelStatus(value: unknown): value is ModelStatus {
  return typeof value === "string" && (MODEL_STATUSES as readonly string[]).includes(value);
}

export function isHiddenStatus(status: ModelStatus | undefined): boolean {
  return status === "hidden" || status === "deprecated";
}

export function derivedStatus(entry: { webui?: boolean; base?: boolean } | undefined): ModelStatus {
  return entry && entry.webui === false && entry.base === false ? "hidden" : "active";
}

export function effectiveStatus(id: string, statuses: Record<string, ModelStatus>): ModelStatus {
  return statuses[id] ?? derivedStatus(builtinRegistryEntry(id));
}

export function dropHidden(ids: string[], statuses: Record<string, ModelStatus>, keep: Iterable<string>): string[] {
  const keepSet = new Set(keep);
  return ids.filter((id) => keepSet.has(id) || !isHiddenStatus(effectiveStatus(id, statuses)));
}
