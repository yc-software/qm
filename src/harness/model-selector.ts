import { Type } from "typebox";
import type { RuntimeChoice } from "./harness.ts";
import { validateRuntimeChoice } from "../api/runtime-config.ts";
import { HARNESS_IDS, isHarnessId, type HarnessId } from "../model/pi-models.ts";
import { isObj } from "../util/objects.ts";

export interface ModelSelector {
  modelId: string;
  harnessId?: HarnessId;
  effortLevel?: string;
  fastMode?: boolean;
}

export const modelSelectorSchema = Type.Object(
  {
    modelId: Type.String({
      minLength: 1,
      pattern: "\\S",
      description: "Model ID or exact display name from runtime get.",
    }),
    harnessId: Type.Optional(Type.Union(HARNESS_IDS.map((id) => Type.Literal(id)))),
    effortLevel: Type.Optional(
      Type.String({
        minLength: 1,
        pattern: "\\S",
        description: "Effort supported by the selected model and harness; see runtime get.",
      }),
    ),
    fastMode: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

interface ModelSelectorCatalog {
  approvedHarnesses: readonly HarnessId[];
  modelsByHarness: Record<string, readonly string[]>;
  modelCatalog: Record<string, { name?: string; label?: string; buttonLabel?: string }>;
}

type ModelSelectorResult = { ok: true; choice: RuntimeChoice } | { ok: false; error: string; candidates?: string[] };

export function isModelSelector(value: unknown): value is ModelSelector {
  return (
    isObj(value) &&
    Object.keys(value).every((key) => ["modelId", "harnessId", "effortLevel", "fastMode"].includes(key)) &&
    typeof value.modelId === "string" &&
    value.modelId.trim().length > 0 &&
    (value.harnessId === undefined || isHarnessId(value.harnessId)) &&
    (value.effortLevel === undefined ||
      (typeof value.effortLevel === "string" && value.effortLevel.trim().length > 0)) &&
    (value.fastMode === undefined || typeof value.fastMode === "boolean")
  );
}

export function resolveModelSelector(
  selector: "inherit" | ModelSelector,
  inherited: RuntimeChoice,
  catalog: ModelSelectorCatalog,
): ModelSelectorResult {
  if (selector !== "inherit" && !isModelSelector(selector)) return { ok: false, error: "invalid_model_selector" };
  const requested = selector === "inherit" ? inherited : selector;
  const harnessId = requested.harnessId ?? inherited.harnessId;
  if (!catalog.approvedHarnesses.includes(harnessId))
    return { ok: false, error: "harness_not_approved", candidates: [...catalog.approvedHarnesses] };
  const candidates = catalog.modelsByHarness[harnessId] ?? [];
  let modelId = requested.modelId;
  if (!candidates.includes(modelId)) {
    const query = modelId.toLowerCase();
    const matches =
      selector === "inherit"
        ? []
        : candidates.filter((id) => {
            const metadata = catalog.modelCatalog[id];
            return [id, metadata?.name, metadata?.label, metadata?.buttonLabel].some(
              (label) => label?.toLowerCase() === query,
            );
          });
    if (matches.length !== 1)
      return {
        ok: false,
        error: matches.length ? "model_ambiguous" : "model_unavailable",
        candidates: matches.length ? matches : [...candidates],
      };
    modelId = matches[0]!;
  }
  const choice: RuntimeChoice = {
    ...inherited,
    harnessId,
    modelId,
    ...(requested.effortLevel !== undefined ? { effortLevel: requested.effortLevel } : {}),
    ...(requested.fastMode !== undefined ? { fastMode: requested.fastMode } : {}),
  };
  const error = validateRuntimeChoice(choice);
  return error ? { ok: false, error } : { ok: true, choice };
}
