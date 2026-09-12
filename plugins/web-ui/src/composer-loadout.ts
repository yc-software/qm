import { EFFORT_LEVELS, type EffortLevel, type ModelOption } from "./model-options.ts";

export interface LoadoutEntry {
  value: string;
  effort: EffortLevel;
  fast: boolean;
}

const LOADOUT_CAP = 5;

function uniqueLoadout(entries: readonly LoadoutEntry[]): LoadoutEntry[] {
  const seen = new Set<string>();
  return entries.filter(({ value }) => {
    if (seen.has(value)) return false;
    seen.add(value);
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
  const index = next.findIndex(({ value }) => value === entry.value);
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
  const next = uniqueLoadout(entries).filter(({ value }) => available.has(value));
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

const PEAK_EFFORTS: ReadonlySet<string> = new Set(["xhigh", "max", "ultracode"]);

export function isPeakEffort(level: EffortLevel | string | undefined): boolean {
  return typeof level === "string" && PEAK_EFFORTS.has(level);
}

export function harnessTarget<T extends { value: string; model: { id: string } }>(
  options: readonly T[],
  currentModelId: string,
  loadout: ReadonlyArray<{ value: string }>,
): T | undefined {
  const sameModel = options.find((option) => option.model.id === currentModelId);
  if (sameModel) return sameModel;
  const saved = loadout.find((entry) => options.some((option) => option.value === entry.value));
  return options.find((option) => option.value === saved?.value) ?? options[0];
}
