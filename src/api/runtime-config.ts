import type { ServerDeps } from "./deps.ts";
import type { ScopeId } from "../types.ts";
import { orgScope } from "./routes/shared.ts";
import {
  defaultModelForHarness,
  isHarnessId,
  modelProviderAvailabilityFor,
  modelSupportedByHarness,
  serviceableModelIds,
  ALL_PROVIDERS_AVAILABLE,
  fastModeModelIds,
  safeModelMetadata,
  modelOfferedInWebui,
  modelUnavailableReason,
  thinkingLevelsForHarness,
  harnessSupportsFastMode,
  type HarnessId,
} from "../model/pi-models.ts";
import { builtInModelCatalog, selectableCatalogForHarness, selectableModelCatalog } from "../model/model-catalog.ts";
import type { RuntimeChoice } from "../harness/harness.ts";

export type RuntimeDeps = Pick<
  ServerDeps,
  | "config"
  | "harnessId"
  | "baseModelDefault"
  | "providerKeys"
  | "modelCredentials"
  | "modelCredentialFetch"
  | "refreshModels"
>;

export function runtimeFallback(ctx: { deps: RuntimeDeps }): { harnessId: HarnessId; modelId: string } {
  const harnessId = isHarnessId(ctx.deps.harnessId) ? ctx.deps.harnessId : "pi";
  return { harnessId, modelId: ctx.deps.baseModelDefault ?? defaultModelForHarness(harnessId) };
}

export async function runtimeConfigBody(ctx: { deps: RuntimeDeps }, scope: ScopeId) {
  const config = ctx.deps.config!;
  const fallback = runtimeFallback(ctx);
  const org = orgScope(ctx.deps);
  const approvedHarnesses = ((await config.getApprovedHarnessesDurable()) ?? [fallback.harnessId]).filter(isHarnessId);
  const configuredKeys = ctx.deps.providerKeys ?? ALL_PROVIDERS_AVAILABLE;
  const managedKeys = ctx.deps.modelCredentials ? await ctx.deps.modelCredentials.availability() : configuredKeys;
  const providersFor = (harnessId: string) => modelProviderAvailabilityFor(harnessId, configuredKeys, managedKeys);
  const catalog =
    ctx.deps.modelCredentials && managedKeys.openrouter
      ? await selectableModelCatalog(ctx.deps.modelCredentialFetch)
      : builtInModelCatalog();
  const orgStored = await config.getRuntimeSelectionDurable(org);
  const orgLegacyModel = orgStored ? null : await config.getBaseModelOwnDurable(org);
  let orgDefault: {
    harnessId: HarnessId;
    modelId: string;
    effortLevel?: string;
    fastMode?: boolean;
    revision: number;
  } = { ...fallback, revision: orgStored?.revision ?? 0 };
  if (orgStored && isHarnessId(orgStored.harnessId)) {
    orgDefault = {
      harnessId: orgStored.harnessId,
      modelId: orgStored.modelId,
      ...(orgStored.effortLevel ? { effortLevel: orgStored.effortLevel } : {}),
      ...(typeof orgStored.fastMode === "boolean" ? { fastMode: orgStored.fastMode } : {}),
      revision: orgStored.revision ?? 0,
    };
  } else if (orgLegacyModel) {
    orgDefault = { harnessId: fallback.harnessId, modelId: orgLegacyModel, revision: 0 };
  }
  const stored = scope === org ? orgStored : await config.getRuntimeSelectionDurable(scope);
  const legacyModel = scope === org ? null : await config.getBaseModelOwnDurable(scope);
  let scopeOverride: {
    harnessId: HarnessId;
    modelId: string;
    effortLevel?: string;
    fastMode?: boolean;
    orgRevision?: number;
  } | null = null;
  if (stored && isHarnessId(stored.harnessId)) {
    scopeOverride = {
      harnessId: stored.harnessId,
      modelId: stored.modelId,
      ...(stored.effortLevel ? { effortLevel: stored.effortLevel } : {}),
      ...(typeof stored.fastMode === "boolean" ? { fastMode: stored.fastMode } : {}),
      orgRevision: stored.orgRevision,
    };
  } else if (legacyModel) {
    scopeOverride = { harnessId: fallback.harnessId, modelId: legacyModel, orgRevision: 0 };
  }
  const effective = scopeOverride ?? orgDefault;
  const selected = [orgDefault, scopeOverride, effective].filter((choice) => choice !== null);
  const allowlist = await config.getWebuiModelsDurable(org);
  const modelsByHarness = Object.fromEntries(
    approvedHarnesses.map((harnessId) => {
      const ids =
        allowlist != null
          ? allowlist.filter((id) => modelSupportedByHarness(id, harnessId))
          : selectableCatalogForHarness(catalog, harnessId)
              .filter((model) => modelOfferedInWebui(model.id))
              .map((model) => model.id);
      for (const choice of selected) {
        if (
          allowlist?.length !== 0 &&
          choice.harnessId === harnessId &&
          modelSupportedByHarness(choice.modelId, harnessId) &&
          !ids.includes(choice.modelId)
        )
          ids.push(choice.modelId);
      }
      return [harnessId, serviceableModelIds(ids, providersFor(harnessId))];
    }),
  );
  const advertisedModelIds = new Set(Object.values(modelsByHarness).flat());
  const modelCatalog = Object.fromEntries(
    [...advertisedModelIds].flatMap((id) => {
      const metadata = safeModelMetadata(id);
      return metadata ? [[id, metadata]] : [];
    }),
  );
  return {
    scopeId: scope,
    approvedHarnesses,
    modelsByHarness,
    modelCatalog,
    orgDefault,
    scopeOverride,
    effective: {
      harnessId: effective.harnessId,
      modelId: effective.modelId,
      ...(effective.effortLevel ? { effortLevel: effective.effortLevel } : {}),
      ...(typeof effective.fastMode === "boolean" ? { fastMode: effective.fastMode } : {}),
    },
    ...(!modelsByHarness[effective.harnessId]?.includes(effective.modelId)
      ? {
          unavailableReason:
            modelUnavailableReason(effective.modelId) ?? "Selected model is unavailable; choose another model",
        }
      : {}),
    upgradeAvailable: Boolean(scopeOverride && scopeOverride.orgRevision !== orgDefault.revision),
    fastModeModelIds: fastModeModelIds(),
    interactiveFastMode: await config.getInteractiveFastModeDurable(),
  };
}

export function validateRuntimeChoice(choice: RuntimeChoice): string | null {
  if (!modelSupportedByHarness(choice.modelId, choice.harnessId)) return "model_not_supported";
  if (choice.effortLevel !== undefined && !thinkingLevelsForHarness(choice.harnessId).includes(choice.effortLevel))
    return "effort_not_supported";
  if (choice.fastMode !== undefined && typeof choice.fastMode !== "boolean") return "fast_mode_invalid";
  if (choice.fastMode && (!harnessSupportsFastMode(choice.harnessId) || !fastModeModelIds().includes(choice.modelId)))
    return "fast_mode_not_supported";
  return null;
}

export async function webuiModelEnabled(ctx: { deps: RuntimeDeps }, modelId: string): Promise<boolean> {
  modelId = modelId.replace(/^codex\//, "");
  const config = ctx.deps.config!;
  const picker = await config.getWebuiModelsDurable(orgScope(ctx.deps));
  if (picker == null || picker.includes(modelId)) return true;
  if (picker.length === 0) return false;
  const org = orgScope(ctx.deps);
  const stored = await config.getRuntimeSelectionDurable(org);
  const orgModel = stored?.modelId ?? (await config.getBaseModelOwnDurable(org)) ?? runtimeFallback(ctx).modelId;
  return modelId === orgModel;
}
