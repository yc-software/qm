import { EFFORT_LEVELS, type EffortLevel, type ModelOption } from "./model-options.ts";

export interface LoadoutEntry {
  value: string;
  effort: EffortLevel;
  fast: boolean;
}

export const LOADOUT_CAP = 4;

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
        !EFFORT_LEVELS.some(({ value }) => value === entry.effort)
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

export function reorderLoadout(entries: readonly LoadoutEntry[], value: string, targetValue: string): LoadoutEntry[] {
  const next = [...entries];
  const source = next.findIndex((entry) => entry.value === value);
  const target = next.findIndex((entry) => entry.value === targetValue);
  if (source < 0 || target < 0 || source === target) return next;
  const [entry] = next.splice(source, 1);
  next.splice(target, 0, entry!);
  return next;
}

export function effortLevelsForHarness(harnessId: string): Array<{ value: EffortLevel; label: string }> {
  return EFFORT_LEVELS.filter(({ value }) => {
    if (harnessId === "pi") return true;
    if (harnessId === "claude") return value !== "ultracode";
    if (harnessId === "codex") return value !== "max" && value !== "ultracode";
    return value === "auto";
  }).map((option) => ({ ...option, label: option.value === "xhigh" ? "Extra high" : option.label }));
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

export function loadLoadout(): LoadoutEntry[] {
  try {
    return parseLoadout(localStorage.getItem(LOADOUT_STORAGE_KEY));
  } catch {
    return [];
  }
}

export function saveLoadout(entries: LoadoutEntry[]): void {
  try {
    localStorage.setItem(LOADOUT_STORAGE_KEY, JSON.stringify(entries.slice(0, LOADOUT_CAP)));
  } catch {
    return;
  }
}
