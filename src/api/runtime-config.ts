import type { RuntimePurpose } from "../resolution/config-store.ts";
import { resolveRuntimeChoiceDurable } from "../harness/runtime-choice.ts";
import { resolveIndividualAuthRouting } from "../core/individual-auth-routing.ts";
import { gatewayModelCatalog } from "../model/gateway-models.ts";
import type { AppDeps } from "./app-types.ts";
import type { ScopeId } from "../types.ts";
import { orgScope } from "../config.ts";
import {
  defaultModel,
  modelSupported,
  serviceableModelIds,
  ALL_PROVIDERS_AVAILABLE,
  fastModeModelIds,
  modelCatalogFor,
  modelUnavailableReason,
  thinkingLevelsFor,
  codexProviderModelId,
  codexSubscriptionModelId,
} from "../model/pi-models.ts";
import { builtInModelCatalog, selectableCatalog, selectableModelCatalog } from "../model/model-catalog.ts";
import type { RuntimeChoice } from "../harness/harness.ts";

export type RuntimeDeps = Partial<
  Pick<
    AppDeps,
    "config" | "providerKeys" | "modelCredentials" | "modelCredentialFetch" | "refreshModels" | "userModelCredentials"
  >
> & { baseModelDefault?: string };

export function runtimeFallback(ctx: { deps: RuntimeDeps }): RuntimeChoice {
  const gatewayIds = gatewayModelCatalog(true).map((model) => model.id);
  const providers =
    gatewayIds.length && ctx.deps.providerKeys
      ? { ...ctx.deps.providerKeys, modelIds: new Set(gatewayIds) }
      : undefined;
  return { modelId: ctx.deps.baseModelDefault ?? defaultModel(undefined, providers) };
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
    const route = resolveIndividualAuthRouting(anthropic, openai, choice.modelId);
    return route?.model === choice.modelId ? null : "account_runtime_unavailable";
  });
  const route = resolveIndividualAuthRouting(anthropic, openai, snapshot.effective.modelId);
  if (!route?.model || !snapshot.models.includes(route.model)) return snapshot;
  const { unavailableReason: _, ...available } = snapshot;
  return {
    ...available,
    effective: {
      ...snapshot.effective,
      modelId: route.model,
      effortLevel: thinkingLevelsFor(route.model).includes(snapshot.effective.effortLevel ?? "auto")
        ? snapshot.effective.effortLevel
        : "auto",
      fastMode: snapshot.effective.fastMode === true && fastModeModelIds().includes(route.model),
    },
  };
}

function storedChoice(stored: RuntimeChoice): RuntimeChoice {
  return {
    modelId: stored.modelId,
    ...(stored.effortLevel ? { effortLevel: stored.effortLevel } : {}),
    ...(typeof stored.fastMode === "boolean" ? { fastMode: stored.fastMode } : {}),
  };
}

export async function runtimeConfigBody(
  ctx: { deps: RuntimeDeps },
  scope: ScopeId,
  authorizeChoice?: (choice: RuntimeChoice) => Promise<string | null>,
  purpose?: RuntimePurpose,
  requested?: Partial<RuntimeChoice>,
) {
  if (authorizeChoice)
    ctx = { deps: { ...ctx.deps, providerKeys: ALL_PROVIDERS_AVAILABLE, modelCredentials: undefined } };
  const config = ctx.deps.config!;
  const configuredKeys = ctx.deps.providerKeys ?? ALL_PROVIDERS_AVAILABLE;
  const managedKeys = ctx.deps.modelCredentials ? await ctx.deps.modelCredentials.availability() : configuredKeys;
  const fallback = runtimeFallback(ctx);
  const org = orgScope();
  const catalog =
    ctx.deps.modelCredentials && managedKeys.openrouter
      ? await selectableModelCatalog(ctx.deps.modelCredentialFetch)
      : builtInModelCatalog();
  const orgStored = await config.getRuntimeSelectionDurable(org);
  const orgLegacyModel = orgStored ? null : await config.getBaseModelOwnDurable(org);
  let orgDefault: RuntimeChoice & { revision: number } = { ...fallback, revision: orgStored?.revision ?? 0 };
  if (orgStored) orgDefault = { ...storedChoice(orgStored), revision: orgStored.revision ?? 0 };
  else if (orgLegacyModel) orgDefault = { modelId: orgLegacyModel, revision: 0 };
  const stored = scope === org ? orgStored : await config.getRuntimeSelectionDurable(scope);
  const legacyModel = scope === org ? null : await config.getBaseModelOwnDurable(scope);
  let scopeOverride: (RuntimeChoice & { orgRevision?: number }) | null = null;
  if (stored) scopeOverride = { ...storedChoice(stored), orgRevision: stored.orgRevision };
  else if (legacyModel) scopeOverride = { modelId: legacyModel, orgRevision: 0 };
  const effective = purpose
    ? await resolveRuntimeChoiceDurable(config, org, scope, fallback, requested, undefined, purpose)
    : (scopeOverride ?? orgDefault);
  const purposeDefault = purpose ? await config.getPurposeRuntimeDurable(purpose) : undefined;
  const selected = [orgDefault, scopeOverride, effective, purposeDefault].filter((choice) => choice != null);
  const allowlist = await config.getWebuiModelsDurable(org);
  const offered =
    allowlist != null
      ? allowlist.filter((id) => modelSupported(id))
      : selectableCatalog(catalog).map((model) => model.id);
  for (const choice of selected) {
    if (
      allowlist?.length !== 0 &&
      (!authorizeChoice ||
        !allowlist ||
        choice.modelId === orgDefault.modelId ||
        choice.modelId === purposeDefault?.modelId ||
        allowlist.includes(codexProviderModelId(choice.modelId))) &&
      modelSupported(choice.modelId) &&
      !offered.includes(choice.modelId)
    )
      offered.push(choice.modelId);
  }
  let models = serviceableModelIds(offered, managedKeys);
  if (authorizeChoice) {
    for (const id of [...models]) {
      const subscriptionId = codexSubscriptionModelId(id);
      if (modelSupported(subscriptionId) && !models.includes(subscriptionId)) models.push(subscriptionId);
    }
    const allowed = await Promise.all(
      models.map((modelId) => authorizeChoice({ modelId, effortLevel: "auto", fastMode: false })),
    );
    models = models.filter((_, index) => !allowed[index]);
  }
  const modelCatalog = modelCatalogFor(new Set(models));
  return {
    scopeId: scope,
    ...(purpose ? { executionPurpose: purpose } : {}),
    models,
    modelCatalog,
    orgDefault,
    scopeOverride,
    effective: storedChoice(effective),
    ...(!models.includes(effective.modelId)
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
  if (!modelSupported(choice.modelId)) return "model_not_supported";
  if (choice.effortLevel !== undefined && !thinkingLevelsFor(choice.modelId).includes(choice.effortLevel))
    return "effort_not_supported";
  if (choice.fastMode !== undefined && typeof choice.fastMode !== "boolean") return "fast_mode_invalid";
  if (choice.fastMode && !fastModeModelIds().includes(choice.modelId)) return "fast_mode_not_supported";
  return null;
}

export async function webuiModelEnabled(
  ctx: { deps: RuntimeDeps },
  modelId: string,
  purpose?: RuntimePurpose,
): Promise<boolean> {
  modelId = codexProviderModelId(modelId);
  const config = ctx.deps.config!;
  const picker = await config.getWebuiModelsDurable(orgScope());
  if (picker == null || picker.includes(modelId)) return true;
  if (picker.length === 0) return false;
  const org = orgScope();
  const stored = await config.getRuntimeSelectionDurable(org);
  const orgModel = stored?.modelId ?? (await config.getBaseModelOwnDurable(org)) ?? runtimeFallback(ctx).modelId;
  const purposeModel = purpose ? (await config.getPurposeRuntimeDurable(purpose))?.modelId : undefined;
  return modelId === orgModel || modelId === purposeModel;
}

export async function availableRuntimeError(
  ctx: { deps: RuntimeDeps },
  scope: ScopeId,
  choice: RuntimeChoice,
  purpose?: RuntimePurpose,
): Promise<string | null> {
  await ctx.deps.refreshModels?.();
  const choices = await runtimeConfigBody(ctx, scope, undefined, purpose, choice);
  if (!choices.models.includes(choice.modelId) || !(await webuiModelEnabled(ctx, choice.modelId, purpose)))
    return "runtime is no longer available or enabled on this deployment";
  return validateRuntimeChoice({
    ...choice,
    effortLevel: choice.effortLevel === "adaptive" || choice.effortLevel === "default" ? choice.effortLevel : undefined,
  });
}
