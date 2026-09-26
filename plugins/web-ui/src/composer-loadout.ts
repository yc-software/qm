import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelMetadata } from "./pi-models.ts";
import { EFFORT_LEVELS, type EffortLevel, type ModelOption } from "./model-options.ts";

export interface LoadoutEntry {
  value: string;
  effort: EffortLevel;
  fast: boolean;
}

export const LOADOUT_CAP = 8;

export function loadoutModelId(value: string): string {
  const separator = value.indexOf(":");
  return separator < 0 ? value : value.slice(separator + 1);
}

function uniqueLoadout(entries: readonly LoadoutEntry[]): LoadoutEntry[] {
  const seen = new Set<string>();
  return entries.filter(({ value }) => {
    const modelId = loadoutModelId(value);
    if (seen.has(modelId)) return false;
    seen.add(modelId);
    return true;
  });
}

export function parseLoadout(raw: string | null): LoadoutEntry[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(parsed)) return [];
    const entries: LoadoutEntry[] = [];
    for (const entry of parsed) {
      if (
        !entry ||
        typeof entry !== "object" ||
        typeof entry.value !== "string" ||
        !entry.value.trim() ||
        (entry.effort !== "auto" && !EFFORT_LEVELS.some(({ value }) => value === entry.effort))
      )
        continue;
      entries.push({ value: entry.value, effort: entry.effort, fast: entry.fast === true });
    }
    return uniqueLoadout(entries).slice(0, LOADOUT_CAP);
  } catch {
    return [];
  }
}

export function upsertLoadout(entries: readonly LoadoutEntry[], entry: LoadoutEntry): LoadoutEntry[] {
  const next = uniqueLoadout(entries).slice(0, LOADOUT_CAP);
  const index = next.findIndex(({ value }) => loadoutModelId(value) === loadoutModelId(entry.value));
  if (index >= 0) next[index] = { ...entry };
  else if (next.length === LOADOUT_CAP) next[LOADOUT_CAP - 1] = { ...entry };
  else next.push({ ...entry });
  return next;
}

export function reconcileLoadout(
  entries: readonly LoadoutEntry[],
  options: readonly ModelOption[],
  active: LoadoutEntry,
): LoadoutEntry[] {
  const available = new Set(options.map(({ value }) => value));
  const next = uniqueLoadout(entries).flatMap((entry) => {
    if (available.has(entry.value)) return [entry];
    const replacement = options.find(({ model }) => model.id === loadoutModelId(entry.value));
    return replacement ? [{ ...entry, value: replacement.value }] : [];
  });
  return available.has(active.value) ? upsertLoadout(next, active) : next.slice(0, LOADOUT_CAP);
}

export function effortLevelsForHarness(
  harnessId: string,
  model?: Model<Api>,
): Array<{ value: EffortLevel; label: string }> {
  const advertised = (model as ModelMetadata | undefined)?.effortLevelsByHarness?.[harnessId];
  return EFFORT_LEVELS.filter(({ value }) => {
    if (advertised) return advertised.includes(value);
    if (!["pi", "claude", "codex"].includes(harnessId) || !TIER_ORDER.includes(value)) return false;
    if (value === "ultra") return harnessId === "codex";
    if (value === "ultracode") return harnessId === "claude";
    return true;
  });
}

const TIER_ORDER: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max", "ultra", "ultracode"];
const PEAK_EFFORTS: readonly EffortLevel[] = ["max", "ultra", "ultracode"];

export function isPeakEffort(harnessId: string, model: Model<Api> | undefined, level: string): boolean {
  const top = effortLevelsForHarness(harnessId, model).at(-1)?.value;
  return top === level && PEAK_EFFORTS.includes(top);
}

export function resolveEffort(
  harnessId: string,
  model: Model<Api> | undefined,
  effort: EffortLevel,
  fallback?: EffortLevel,
): EffortLevel {
  const levels = effortLevelsForHarness(harnessId, model);
  if (effort === "auto" || levels.some(({ value }) => value === effort)) return effort;
  const rank = TIER_ORDER.indexOf(effort);
  const lower = levels
    .filter(({ value }) => rank >= 0 && TIER_ORDER.indexOf(value) >= 0 && TIER_ORDER.indexOf(value) <= rank)
    .at(-1);
  if (lower) return lower.value;
  if (fallback && levels.some(({ value }) => value === fallback)) return fallback;
  return levels[0]?.value ?? "auto";
}

export function compatibleHarnessOptions<T extends { harnessId: string; model: { id: string } }>(
  options: readonly T[],
  modelId: string,
): T[] {
  const seen = new Set<string>();
  return options.filter((option) => {
    if (option.model.id !== modelId || seen.has(option.harnessId)) return false;
    seen.add(option.harnessId);
    return true;
  });
}

export function modelLoadoutOptions(
  options: readonly ModelOption[],
  entries: readonly LoadoutEntry[],
  preferredHarnessId?: string,
): ModelOption[] {
  const saved = new Map(uniqueLoadout(entries).map((entry) => [loadoutModelId(entry.value), entry.value]));
  return [...new Set(options.map(({ model }) => model.id))].flatMap((modelId) => {
    const compatible = compatibleHarnessOptions(options, modelId);
    const preferred =
      compatible.find(({ value }) => value === saved.get(modelId)) ??
      compatible.find(({ harnessId }) => harnessId === preferredHarnessId) ??
      compatible[0];
    return preferred ? [preferred] : [];
  });
}

const LOADOUT_STORAGE_KEY = "web-ui:loadout";

export function loadLoadout(key = LOADOUT_STORAGE_KEY): LoadoutEntry[] {
  try {
    return parseLoadout(localStorage.getItem(key));
  } catch {
    return [];
  }
}

export function saveLoadout(entries: LoadoutEntry[], key = LOADOUT_STORAGE_KEY): void {
  try {
    localStorage.setItem(key, JSON.stringify(entries.slice(0, LOADOUT_CAP)));
  } catch {
    return;
  }
}
