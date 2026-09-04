import type { Api, Model } from "@earendil-works/pi-ai";
import { getBaseModel, type ModelMetadata } from "./pi-models.ts";

export type ModelOptionValue = string;
export interface ModelOption {
  value: ModelOptionValue;
  harnessId: string;
  harnessLabel: string;
  model: Model<Api>;
  label: string;
  buttonLabel: string;
  groupLabel: string;
}

const HARNESS_LABELS: Record<string, string> = {
  pi: "Pi",
  opencode: "OpenCode",
  codex: "Codex",
  claude: "Claude Code",
  mock: "Mock",
};

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  google: "Google",
  "arcee-ai": "Arcee AI",
  "meta-llama": "Meta",
  mistralai: "Mistral AI",
};

function providerLabel(id: string, name: string, provider: string): string {
  if (provider === "openrouter") {
    const namedProvider = /^([^:]{2,40}):\s/.exec(name)?.[1]?.trim();
    if (namedProvider) return namedProvider;
  }
  const key = provider === "openrouter" ? (id.split("/", 1)[0] ?? provider) : provider;
  return (
    PROVIDER_LABELS[key] ??
    key
      .split(/[-_]/)
      .filter(Boolean)
      .map((part) => part[0]!.toUpperCase() + part.slice(1))
      .join(" ")
  );
}

function buildOption(
  id: string,
  harnessId = "pi",
  qualified = false,
  catalog: Readonly<Record<string, ModelMetadata>> = {},
): ModelOption | null {
  try {
    const dynamic = catalog[id];
    const meta = dynamic ? { label: dynamic.label, buttonLabel: dynamic.buttonLabel } : null;
    if (!meta) return null;
    const model = getBaseModel(id, dynamic);
    return {
      value: qualified ? `${harnessId}:${id}` : id,
      harnessId,
      harnessLabel: HARNESS_LABELS[harnessId] ?? harnessId,
      model,
      ...meta,
      groupLabel: providerLabel(id, meta.label, dynamic?.provider ?? String(model?.provider ?? model?.api ?? "other")),
    };
  } catch {
    return null;
  }
}

function buildOptions(
  ids: readonly string[],
  harnessId = "pi",
  qualified = false,
  catalog: Readonly<Record<string, ModelMetadata>> = {},
): ModelOption[] {
  const seen = new Set<string>();
  const out: ModelOption[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const opt = buildOption(id, harnessId, qualified, catalog);
    if (opt) out.push(opt);
  }
  return out;
}

interface RuntimeOptions {
  options: ModelOption[];
  defaultValue: string | null;
}

const FALLBACK: RuntimeOptions = { options: [], defaultValue: null };
const byScope = new Map<string, RuntimeOptions>();
let lastApplied: RuntimeOptions = FALLBACK;

function runtimeFor(scopeKey?: string | null): RuntimeOptions {
  if (scopeKey === undefined) return lastApplied;
  return (scopeKey !== null ? byScope.get(scopeKey) : undefined) ?? FALLBACK;
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

export function runtimeModelOptions(
  approvedHarnesses: readonly string[],
  modelsByHarness: Readonly<Record<string, readonly string[]>>,
  catalog: Readonly<Record<string, ModelMetadata>> = {},
): ModelOption[] {
  return approvedHarnesses.flatMap((harnessId) =>
    buildOptions(modelsByHarness[harnessId] ?? [], harnessId, true, catalog),
  );
}

export function applyRuntimeOptions(
  scopeKey: string | null,
  approvedHarnesses: readonly string[],
  modelsByHarness: Readonly<Record<string, readonly string[]>>,
  effective: { harnessId: string; modelId: string },
  catalog: Readonly<Record<string, ModelMetadata>> = {},
): void {
  const options = runtimeModelOptions(approvedHarnesses, modelsByHarness, catalog);
  const applied = { options, defaultValue: `${effective.harnessId}:${effective.modelId}` };
  lastApplied = applied;
  if (scopeKey !== null) byScope.set(scopeKey, applied);
}

export function defaultModelValue(scopeKey?: string | null): ModelOptionValue {
  return runtimeFor(scopeKey).defaultValue ?? "";
}

export function transcriptModel(scopeKey?: string | null): Model<Api> | undefined {
  const { options, defaultValue } = runtimeFor(scopeKey);
  return options.find((o) => o.value === defaultValue)?.model;
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

export function defaultEffortForModel(model: Model<Api> | undefined): EffortLevel {
  const provider = String(model?.provider ?? model?.api ?? "").toLowerCase();
  return provider.includes("anthropic") ? "low" : "auto";
}
