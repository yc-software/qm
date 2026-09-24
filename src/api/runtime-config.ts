import { resolveIndividualAuthRouting } from "../core/individual-auth-routing.ts";
import { gatewayModelCatalog } from "../model/gateway-models.ts";
import type { AppDeps } from "./app-types.ts";
import type { ScopeId } from "../types.ts";
import { orgScope } from "../config.ts";
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
  codexProviderModelId,
  codexSubscriptionModelId,
  type HarnessId,
} from "../model/pi-models.ts";
import { builtInModelCatalog, selectableCatalogForHarness, selectableModelCatalog } from "../model/model-catalog.ts";
import type { RuntimeChoice } from "../harness/harness.ts";

export type RuntimeDeps = Partial<
  Pick<
    AppDeps,
    | "config"
    | "harnessId"
    | "providerKeys"
    | "modelCredentials"
    | "modelCredentialFetch"
    | "refreshModels"
    | "userModelCredentials"
  >
> & { baseModelDefault?: string };

export function runtimeFallback(ctx: { deps: RuntimeDeps }): { harnessId: HarnessId; modelId: string } {
  const harnessId = isHarnessId(ctx.deps.harnessId) ? ctx.deps.harnessId : "pi";
  const gatewayIds = gatewayModelCatalog(true).map((model) => model.id);
  const providers =
    gatewayIds.length && ctx.deps.providerKeys
      ? { ...ctx.deps.providerKeys, modelIds: new Set(gatewayIds) }
      : undefined;
  return { harnessId, modelId: ctx.deps.baseModelDefault ?? defaultModelForHarness(harnessId, undefined, providers) };
}

export async function userRuntimeConfigBody(ctx: { deps: RuntimeDeps }, scope: ScopeId, actorId: string) {
  const account = await ctx.deps.config?.getModelAccountDurable(actorId);
  const store = ctx.deps.userModelCredentials;
  if (!store || !account || account === "company") return runtimeConfigBody(ctx, scope);
  const [anthropic, openai] = await Promise.all([
    account === "openai" ? null : store.get(actorId, "anthropic"),
    account === "anthropic" ? null : store.get(actorId, "openai"),
  ]);
  const snapshot = await runtimeConfigBody(ctx, scope, async (choice) => {
    const route = resolveIndividualAuthRouting(anthropic, openai, choice.modelId, choice.harnessId);
    return route?.harness === choice.harnessId && route.model === choice.modelId ? null : "account_runtime_unavailable";
  });
  const route = resolveIndividualAuthRouting(
    anthropic,
    openai,
    snapshot.effective.modelId,
    snapshot.effective.harnessId,
  );
  if (!route?.model || !snapshot.modelsByHarness[route.harness]?.includes(route.model)) return snapshot;
  const { unavailableReason: _, ...available } = snapshot;
  return {
    ...available,
    effective: {
      ...snapshot.effective,
      harnessId: route.harness,
      modelId: route.model,
      effortLevel: thinkingLevelsForHarness(route.harness, route.model).includes(
        snapshot.effective.effortLevel ?? "auto",
      )
        ? snapshot.effective.effortLevel
        : "auto",
      fastMode:
        snapshot.effective.fastMode === true &&
        harnessSupportsFastMode(route.harness) &&
        fastModeModelIds().includes(route.model),
    },
  };
}

export async function runtimeConfigBody(
  ctx: { deps: RuntimeDeps },
  scope: ScopeId,
  authorizeChoice?: (choice: RuntimeChoice) => Promise<string | null>,
) {
  if (authorizeChoice)
    ctx = { deps: { ...ctx.deps, providerKeys: ALL_PROVIDERS_AVAILABLE, modelCredentials: undefined } };
  const config = ctx.deps.config!;
  const configuredKeys = ctx.deps.providerKeys ?? ALL_PROVIDERS_AVAILABLE;
  const managedKeys = ctx.deps.modelCredentials ? await ctx.deps.modelCredentials.availability() : configuredKeys;
  const fallback = runtimeFallback(ctx);
  const org = orgScope();
  const approvedHarnesses = ((await config.getApprovedHarnessesDurable()) ?? [fallback.harnessId]).filter(isHarnessId);
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
          (!authorizeChoice ||
            !allowlist ||
            choice.modelId === orgDefault.modelId ||
            allowlist.includes(codexProviderModelId(choice.modelId))) &&
          choice.harnessId === harnessId &&
          modelSupportedByHarness(choice.modelId, harnessId) &&
          !ids.includes(choice.modelId)
        )
          ids.push(choice.modelId);
      }
      return [harnessId, serviceableModelIds(ids, providersFor(harnessId))];
    }),
  );
  if (authorizeChoice) {
    const piModels = modelsByHarness.pi ?? [];
    for (const id of piModels) {
      const subscriptionId = codexSubscriptionModelId(id);
      if (modelSupportedByHarness(subscriptionId, "pi") && !piModels.includes(subscriptionId))
        piModels.push(subscriptionId);
    }
    for (const harnessId of approvedHarnesses) {
      const candidates = modelsByHarness[harnessId] ?? [];
      const allowed = await Promise.all(
        candidates.map((modelId) => authorizeChoice({ harnessId, modelId, effortLevel: "auto", fastMode: false })),
      );
      modelsByHarness[harnessId] = candidates.filter((_, index) => !allowed[index]);
    }
  }
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
  if (
    choice.effortLevel !== undefined &&
    !thinkingLevelsForHarness(choice.harnessId, choice.modelId).includes(choice.effortLevel)
  )
    return "effort_not_supported";
  if (choice.fastMode !== undefined && typeof choice.fastMode !== "boolean") return "fast_mode_invalid";
  if (choice.fastMode && (!harnessSupportsFastMode(choice.harnessId) || !fastModeModelIds().includes(choice.modelId)))
    return "fast_mode_not_supported";
  return null;
}

export async function webuiModelEnabled(ctx: { deps: RuntimeDeps }, modelId: string): Promise<boolean> {
  modelId = codexProviderModelId(modelId);
  const config = ctx.deps.config!;
  const picker = await config.getWebuiModelsDurable(orgScope());
  if (picker == null || picker.includes(modelId)) return true;
  if (picker.length === 0) return false;
  const org = orgScope();
  const stored = await config.getRuntimeSelectionDurable(org);
  const orgModel = stored?.modelId ?? (await config.getBaseModelOwnDurable(org)) ?? runtimeFallback(ctx).modelId;
  return modelId === orgModel;
}

export async function availableRuntimeError(
  ctx: { deps: RuntimeDeps },
  scope: ScopeId,
  choice: RuntimeChoice,
): Promise<string | null> {
  await ctx.deps.refreshModels?.();
  const choices = await runtimeConfigBody(ctx, scope);
  if (
    !choices.modelsByHarness[choice.harnessId]?.includes(choice.modelId) ||
    !(await webuiModelEnabled(ctx, choice.modelId))
  )
    return "runtime is no longer available or enabled on this deployment";
  return validateRuntimeChoice({
    ...choice,
    effortLevel: choice.effortLevel === "adaptive" || choice.effortLevel === "default" ? choice.effortLevel : undefined,
  });
}
