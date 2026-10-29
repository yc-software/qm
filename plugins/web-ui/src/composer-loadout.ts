import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelMetadata } from "./pi-models.ts";
import { EFFORT_LEVELS, type EffortLevel, type ModelOption } from "./model-options.ts";

export interface LoadoutEntry {
  value: string;
  effort: EffortLevel;
  fast: boolean;
}

export const LOADOUT_CAP = 8;

const ULTRAFAST_BASE_MODELS = new Map([
  ["gpt-6-astra-ultrafast", "gpt-6-astra"],
  ["gpt-6.1-sol-ultrafast", "gpt-6.1-sol"],
]);

export function isUltrafastModel(modelId: string): boolean {
  return ULTRAFAST_BASE_MODELS.has(modelId);
}

export function presetModelId(value: string): string {
  return ULTRAFAST_BASE_MODELS.get(value) ?? value;
}

export function ultrafastChoice(options: readonly ModelOption[], selected: ModelOption): ModelOption | undefined {
  const id = selected.model.id;
  const target = ULTRAFAST_BASE_MODELS.get(id) ?? [...ULTRAFAST_BASE_MODELS].find(([, base]) => base === id)?.[0];
  return options.find((option) => option.model.id === target);
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
  const next = uniqueLoadout(entries).filter((entry) => available.has(entry.value));
  return available.has(active.value) ? upsertLoadout(next, active) : next.slice(0, LOADOUT_CAP);
}

export function effortLevelsForModel(model?: Model<Api>): Array<{ value: EffortLevel; label: string }> {
  const advertised = (model as ModelMetadata | undefined)?.effortLevels;
  const levels = EFFORT_LEVELS.filter(({ value }) => {
    if (value === "auto") return false;
    if (advertised) return advertised.includes(value);
    return value !== "adaptive" && value !== "default";
  });
  return [EFFORT_LEVELS.find(({ value }) => value === "auto")!, ...levels];
}

export function modelLoadoutOptions(options: readonly ModelOption[], entries: readonly LoadoutEntry[]): ModelOption[] {
  const saved = new Map(uniqueLoadout(entries).map((entry) => [presetModelId(entry.value), entry.value]));
  return [...new Set(options.map((option) => presetModelId(option.value)))].flatMap((modelId) => {
    const compatible = options.filter((option) => presetModelId(option.value) === modelId);
    const preferred =
      compatible.find(({ value }) => value === saved.get(modelId)) ??
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

export function loadoutActions(
  options: () => readonly ModelOption[],
  current: () => LoadoutEntry,
  choose: (option: ModelOption, entry: LoadoutEntry) => void,
  supportsFast: (modelId: string) => boolean,
) {
  const apply = (entry: LoadoutEntry) => {
    const option = options().find((candidate) => candidate.value === entry.value);
    if (!option) return;
    const levels = effortLevelsForModel(option.model);
    choose(option, {
      value: option.value,
      effort: levels.some((level) => level.value === entry.effort) ? entry.effort : levels[0]!.value,
      fast: entry.fast && supportsFast(option.model.id),
    });
  };
  const selected = () => options().find((option) => option.value === current().value);
  return {
    apply,
    selectEffort: (effort: EffortLevel) => apply({ ...current(), effort }),
    toggleFastMode: () => {
      const option = selected();
      const target = option && isUltrafastModel(option.model.id) ? ultrafastChoice(options(), option) : undefined;
      apply({ ...current(), ...(target ? { value: target.value } : {}), fast: !current().fast });
    },
  };
}
