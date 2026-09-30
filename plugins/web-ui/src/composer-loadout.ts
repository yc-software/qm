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

export const ULTRAFAST_MODEL_ID = "gpt-6-astra-ultrafast";
export const ULTRAFAST_BASE_MODEL_ID = "gpt-6-astra";

export function presetModelId(value: string): string {
  const id = loadoutModelId(value);
  return id === ULTRAFAST_MODEL_ID ? ULTRAFAST_BASE_MODEL_ID : id;
}

export function ultrafastChoice(options: readonly ModelOption[], selected: ModelOption): ModelOption | undefined {
  if (selected.harnessId !== "pi") return undefined;
  const id = selected.model.id;
  if (id !== ULTRAFAST_BASE_MODEL_ID && id !== ULTRAFAST_MODEL_ID) return undefined;
  return options.find(
    (option) =>
      option.harnessId === selected.harnessId &&
      option.model.id === (id === ULTRAFAST_MODEL_ID ? ULTRAFAST_BASE_MODEL_ID : ULTRAFAST_MODEL_ID),
  );
}

function uniqueLoadout(entries: readonly LoadoutEntry[]): LoadoutEntry[] {
  const seen = new Set<string>();
  return entries.filter(({ value }) => {
    const modelId = presetModelId(value);
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
  const index = next.findIndex(({ value }) => presetModelId(value) === presetModelId(entry.value));
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
  const advertised = (model as ModelMetadata | undefined)?.effortLevelsByHarness?.[harnessId] ?? [];
  const [unset, ...levels] = EFFORT_LEVELS;
  return [unset!, ...levels.filter(({ value }) => advertised.includes(value))];
}

export function isPeakEffort(harnessId: string, model: Model<Api> | undefined, level: string): boolean {
  return level === "ultracode" && effortLevelsForHarness(harnessId, model).some(({ value }) => value === level);
}

export function resolveEffort(harnessId: string, model: Model<Api> | undefined, effort: EffortLevel): EffortLevel {
  return effortLevelsForHarness(harnessId, model).some(({ value }) => value === effort) ? effort : "auto";
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
  const saved = new Map(uniqueLoadout(entries).map((entry) => [presetModelId(entry.value), entry.value]));
  return [...new Set(options.map((option) => presetModelId(option.value)))].flatMap((modelId) => {
    const compatible = options.filter((option) => presetModelId(option.value) === modelId);
    const preferred =
      compatible.find(({ value }) => value === saved.get(modelId)) ??
      compatible.find(({ harnessId, model }) => harnessId === preferredHarnessId && model.id === modelId) ??
      compatible.find(({ model }) => model.id === modelId) ??
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
