import type { Api, Model } from "@earendil-works/pi-ai";
import { getBaseModel } from "./pi-models.ts";

export type ModelOptionValue = string;
export interface ModelOption {
  value: ModelOptionValue;
  harnessId: string;
  harnessLabel: string;
  model: Model<Api>;
  label: string;
  buttonLabel: string;
}

interface ModelMeta {
  label: string;
  buttonLabel: string;
}

const MODEL_CATALOG: Record<string, ModelMeta> = {
  "claude-opus-5": {
    label: "Opus 5",
    buttonLabel: "Opus 5",
  },
  "claude-opus-4-8": {
    label: "Opus 4.8",
    buttonLabel: "Opus 4.8",
  },
  "claude-sonnet-5": {
    label: "Sonnet 5",
    buttonLabel: "Sonnet 5",
  },
  "claude-haiku-4-5": {
    label: "Haiku 4.5",
    buttonLabel: "Haiku 4.5",
  },
  "claude-fable-5": {
    label: "Fable 5",
    buttonLabel: "Fable 5",
  },
  "gpt-5.6-sol": {
    label: "GPT-5.6 Sol",
    buttonLabel: "5.6 Sol",
  },
  "gpt-5.6-terra": {
    label: "GPT-5.6 Terra",
    buttonLabel: "5.6 Terra",
  },
  "gpt-5.6-luna": {
    label: "GPT-5.6 Luna",
    buttonLabel: "5.6 Luna",
  },
};

const DEFAULT_PICKER_MODEL_IDS: readonly string[] = [
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-haiku-4-5",
];
const DEFAULT_CODEX_MODEL_IDS: readonly string[] = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];

function defaultModelIdsForHarness(harnessId: string): readonly string[] {
  if (harnessId === "codex") return DEFAULT_CODEX_MODEL_IDS;
  if (harnessId === "claude") return DEFAULT_PICKER_MODEL_IDS;
  return [...DEFAULT_PICKER_MODEL_IDS, ...DEFAULT_CODEX_MODEL_IDS];
}

const HARNESS_LABELS: Record<string, string> = {
  pi: "Pi",
  opencode: "OpenCode",
  codex: "Codex",
  claude: "Claude Code",
  mock: "Mock",
};

function buildOption(
  id: string,
  harnessId = "pi",
  qualified = false,
  catalog: Readonly<Record<string, { name: string; provider: string }>> = {},
): ModelOption | null {
  try {
    const dynamic = catalog[id];
    const meta = MODEL_CATALOG[id] ?? (dynamic ? { label: dynamic.name, buttonLabel: dynamic.name } : null);
    if (!meta) return null;
    const model = getBaseModel(id, dynamic);
    return {
      value: qualified ? `${harnessId}:${id}` : id,
      harnessId,
      harnessLabel: HARNESS_LABELS[harnessId] ?? harnessId,
      model,
      ...meta,
    };
  } catch {
    return null;
  }
}

function buildOptions(
  ids: readonly string[],
  harnessId = "pi",
  qualified = false,
  catalog: Readonly<Record<string, { name: string; provider: string }>> = {},
): ModelOption[] {
  const seen = new Set<string>();
  const out: ModelOption[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const opt = buildOption(id, harnessId, qualified, catalog);
    if (opt) out.push(opt);
  }
  if (out.length) return out;
  return harnessId === "pi" ? buildOptions(DEFAULT_PICKER_MODEL_IDS, "pi", qualified, catalog) : [];
}

interface RuntimeOptions {
  options: ModelOption[];
  defaultValue: string | null;
}

const FALLBACK: RuntimeOptions = { options: buildOptions(DEFAULT_PICKER_MODEL_IDS), defaultValue: null };
const byScope = new Map<string, RuntimeOptions>();
let lastApplied: RuntimeOptions = FALLBACK;

function runtimeFor(scopeKey?: string | null): RuntimeOptions {
  if (scopeKey === undefined) return lastApplied;
  return (scopeKey !== null ? byScope.get(scopeKey) : undefined) ?? lastApplied;
}

export function getModelOptions(scopeKey?: string | null): ModelOption[] {
  return runtimeFor(scopeKey).options;
}

export function getHarnessOptions(scopeKey?: string | null): Array<{ value: string; label: string }> {
  const options = runtimeFor(scopeKey).options;
  return [...new Map(options.map((option) => [option.harnessId, option.harnessLabel])).entries()].map(
    ([value, label]) => ({ value, label }),
  );
}

export function getModelOptionsForHarness(harnessId: string, scopeKey?: string | null): ModelOption[] {
  return runtimeFor(scopeKey).options.filter((option) => option.harnessId === harnessId);
}

export function applyPickerModelIds(ids: readonly string[] | null | undefined, baseModelId?: string | null): void {
  lastApplied = {
    options: buildOptions(ids && ids.length ? ids : DEFAULT_PICKER_MODEL_IDS),
    defaultValue: baseModelId ?? null,
  };
}

export function runtimeModelOptions(
  approvedHarnesses: readonly string[],
  modelsByHarness: Readonly<Record<string, readonly string[]>>,
  catalog: Readonly<Record<string, { name: string; provider: string }>> = {},
): ModelOption[] {
  const options = approvedHarnesses.flatMap((harnessId) => {
    const configured = buildOptions(modelsByHarness[harnessId] ?? [], harnessId, true, catalog);
    return configured.length
      ? configured
      : buildOptions(defaultModelIdsForHarness(harnessId), harnessId, true, catalog);
  });
  return options.length ? options : buildOptions(DEFAULT_PICKER_MODEL_IDS);
}

export function applyRuntimeOptions(
  scopeKey: string | null,
  approvedHarnesses: readonly string[],
  modelsByHarness: Readonly<Record<string, readonly string[]>>,
  effective: { harnessId: string; modelId: string },
  catalog: Readonly<Record<string, { name: string; provider: string }>> = {},
): void {
  const options = runtimeModelOptions(approvedHarnesses, modelsByHarness, catalog);
  const applied = { options, defaultValue: `${effective.harnessId}:${effective.modelId}` };
  lastApplied = applied;
  if (scopeKey !== null) byScope.set(scopeKey, applied);
}

export function defaultModelValue(scopeKey?: string | null): ModelOptionValue {
  const { options, defaultValue } = runtimeFor(scopeKey);
  return options.find((o) => o.value === defaultValue)?.value ?? options[0]!.value;
}

export function transcriptModel(scopeKey?: string | null): Model<Api> {
  const { options, defaultValue } = runtimeFor(scopeKey);
  return (options.find((o) => o.value === defaultValue) ?? options[0]!).model;
}

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max" | "ultracode" | "auto";

export const EFFORT_LEVELS: Array<{ value: EffortLevel; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
  { value: "max", label: "Max" },
  { value: "ultracode", label: "Ultracode" },
];

export function effortLabel(level: EffortLevel): string {
  return EFFORT_LEVELS.find((option) => option.value === level)?.label ?? level;
}

export function harnessSupportsEffort(harnessId: string): boolean {
  return harnessId === "pi" || harnessId === "codex" || harnessId === "claude";
}

export function harnessSupportsFastMode(harnessId: string): boolean {
  return harnessId === "pi" || harnessId === "claude";
}

export function harnessSupportsSteer(harnessId: string): boolean {
  return harnessId === "pi" || harnessId === "claude" || harnessId === "codex" || harnessId === "opencode";
}

export function defaultEffortForModel(model: Model<Api>): EffortLevel {
  const provider = String(model.provider ?? model.api ?? "").toLowerCase();
  return provider.includes("anthropic") ? "low" : "auto";
}
