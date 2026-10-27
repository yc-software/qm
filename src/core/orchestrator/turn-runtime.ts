import { surfaceHas } from "../../surfaces/surface.ts";
import { recoveredRuntime } from "../../harness/runtime-recovery.ts";
import { resolveTurnFastMode, turnRuntimePurpose } from "../turn-options.ts";
import { CONFIG_DEFAULTS } from "../../config.ts";
import { CAPABILITY_TTL_MS, type CapabilityClaims } from "../../auth/capability-token.ts";
import type { RuntimeChoice } from "../../harness/harness.ts";
import { errMessage } from "../../util/errors.ts";
import { NonRetryableTurnError } from "../turn-error.ts";
import { codexSubscriptionModelId, CODEX_SUBSCRIPTION_PROVIDER } from "../../model/pi-models.ts";
import type { ProviderKeys } from "../../harness/pi-model-runtime.ts";
import { resolveIndividualAuthRouting } from "../individual-auth-routing.ts";

import type { TurnCtx } from "./turn-context.ts";
import type { buildCredentialCatalog } from "./credential-catalog.ts";
import type { Session } from "../../types.ts";

async function purposeRuntime(ctx: TurnCtx, session: Session) {
  const { deps, input, humanInput } = ctx;
  const runtimePurpose = turnRuntimePurpose(input, !!session.parentSessionId);
  const purposeDefault = runtimePurpose ? await deps.config?.getPurposeRuntimeDurable(runtimePurpose) : undefined;
  const wantsOrgFastMode =
    typeof input.fastMode !== "boolean" &&
    !purposeDefault &&
    humanInput &&
    (await deps.config?.settingDurable("interactiveFastMode"));
  const effectiveFastMode = resolveTurnFastMode(input.fastMode, humanInput, wantsOrgFastMode === true);
  return { runtimePurpose, purposeDefault, effectiveFastMode };
}

export async function selectTurnRuntime(
  ctx: TurnCtx,
  turn: {
    session: Session;
    controlClaims: Awaited<ReturnType<typeof buildCredentialCatalog>>["controlClaims"];
    scopeAttestation: Awaited<ReturnType<typeof buildCredentialCatalog>>["scopeAttestation"];
  },
) {
  const { deps, input, actor, automatedTurn, liveAuthorTurn, scopeId, filterHistory, isRetry } = ctx;
  const { session, controlClaims, scopeAttestation } = turn;
  const effectiveTurnWallClockMs =
    typeof input.turnWallClockMs === "number" && input.turnWallClockMs > 0
      ? input.turnWallClockMs
      : (deps.defaultTurnWallClockMs ?? CONFIG_DEFAULTS.turnWallClockSec * 1000);
  const { runtimePurpose, purposeDefault, effectiveFastMode } = await purposeRuntime(ctx, session);
  const requestedModel = input.model ?? purposeDefault?.modelId;
  const { userProviderKeys, userModelOverride, personalAuth, authLabel } = await loadRuntimeAuth(
    ctx,
    purposeDefault,
    {},
  );
  if (
    (surfaceHas(input.surface, "pickModel") || purposeDefault) &&
    personalAuth &&
    requestedModel &&
    !servesModel(requestedModel, userModelOverride, userProviderKeys)
  )
    throw new NonRetryableTurnError("Your connected AI account cannot serve this model.");
  const effectiveModel = userModelOverride ?? input.model;
  if (personalAuth) {
    console.log(`[individual-auth] user=${actor.id} model=${effectiveModel} auth=${authLabel}`);
  }
  const requestedRuntime: Partial<RuntimeChoice> = {
    ...(effectiveModel ? { modelId: effectiveModel } : {}),
    ...(input.thinkingLevel ? { effortLevel: input.thinkingLevel } : {}),
    ...(typeof effectiveFastMode === "boolean" ? { fastMode: effectiveFastMode } : {}),
  };
  const runtimeDefaults = requestedRuntime;
  const runtimeClaims: CapabilityClaims = controlClaims ?? {
    ...scopeAttestation,
    exp: Date.now() + CAPABILITY_TTL_MS,
    ...(liveAuthorTurn ? { liveAuthor: true } : {}),
    ...(automatedTurn ? { triggered: true } : {}),
  };
  const restoredRuntime =
    input.runId && isRetry
      ? recoveredRuntime(filterHistory(await deps.sessions.getItems(session.id)), input.runId, actor.id)
      : undefined;
  const runtimeState: RuntimeState = { userProviderKeys, userModelOverride, personalAuth, authLabel, requestedRuntime };
  const checkRuntimeAuth = (choice: RuntimeChoice) => checkTurnRuntimeAuth(ctx, purposeDefault, choice);
  const adoptRuntime = (choice: RuntimeChoice, lifetime: "task" | "scope") =>
    adoptTurnRuntime(ctx, purposeDefault, runtimeState, choice, lifetime);
  if (restoredRuntime) await adoptRuntime(restoredRuntime.choice, restoredRuntime.lifetime);
  if (automatedTurn && input.model) {
    const error = await deps.validateScheduledRuntime?.(
      scopeId,
      {
        modelId: input.model,
        effortLevel: input.thinkingLevel,
        fastMode: input.fastMode,
      },
      runtimePurpose,
    );
    if (error) throw new NonRetryableTurnError(error);
  }
  return {
    effectiveTurnWallClockMs,
    runtimePurpose,
    purposeDefault,
    runtimeDefaults,
    runtimeClaims,
    restoredRuntime,
    checkRuntimeAuth,
    adoptRuntime,
    runtimeState,
  };
}

type PurposeDefault = Awaited<ReturnType<NonNullable<TurnCtx["deps"]["config"]>["getPurposeRuntimeDurable"]>>;
type RuntimeState = {
  userProviderKeys: ProviderKeys | undefined;
  userModelOverride: string | undefined;
  personalAuth: boolean;
  authLabel: string;
  requestedRuntime: Partial<RuntimeChoice>;
  agentSwitch?: "task" | "scope";
};

const servesModel = (requested: string, routed: string | undefined, keys: ProviderKeys | undefined) =>
  (keys?.[CODEX_SUBSCRIPTION_PROVIDER] ? codexSubscriptionModelId(requested) : requested) === routed;

async function loadRuntimeAuth(ctx: TurnCtx, purposeDefault: PurposeDefault, runtime: Partial<RuntimeChoice>) {
  const { deps, input, actor, external, humanInput } = ctx;
  let userProviderKeys: ProviderKeys | undefined;
  let userModelOverride: string | undefined;
  let personalAuth = false;
  let authLabel = "api-key";
  const userCredStore = external ? undefined : deps.userModelCredentials;
  const account = external
    ? "company"
    : (input.modelAccount ?? (await deps.config?.getModelAccountDurable(actor.id)) ?? "company");
  if (userCredStore && humanInput && account !== "company") {
    const [anthCred, oaiCred] = await Promise.all([
      account === "openai" ? null : userCredStore.get(actor.id, "anthropic"),
      account === "anthropic" ? null : userCredStore.get(actor.id, "openai"),
    ]);
    const routing = resolveIndividualAuthRouting(
      anthCred ?? null,
      oaiCred ?? null,
      account === "personal" || surfaceHas(input.surface, "pickModel")
        ? (runtime.modelId ?? input.model ?? purposeDefault?.modelId)
        : (runtime.modelId ?? purposeDefault?.modelId),
    );
    if (routing?.kind === "apikey") {
      personalAuth = true;
      userProviderKeys = { [routing.provider]: routing.apiKey };
      userModelOverride = routing.model;
    } else if (routing?.kind === "oauth" && routing.provider === "anthropic" && anthCred?.oauth) {
      const derived = await userCredStore.derivedOAuth(actor.id, "anthropic");
      if (derived) {
        userProviderKeys = { anthropic: derived.accessToken };
        authLabel = "claude-oauth-pi";
        personalAuth = true;
        userModelOverride = routing.model;
      }
    } else if (routing?.kind === "oauth" && routing.provider === "openai" && oaiCred?.oauth) {
      const derived = await userCredStore.derivedOAuth(actor.id, "openai");
      if (derived) {
        userProviderKeys = { [CODEX_SUBSCRIPTION_PROVIDER]: derived.accessToken };
        authLabel = "codex-oauth-pi";
        personalAuth = true;
        userModelOverride = routing.model;
      }
    }
    if (!personalAuth) {
      throw new NonRetryableTurnError(
        "Your personal AI account is unavailable. Open Settings → AI access to reconnect Claude or ChatGPT / Codex, or choose company access. The chat cannot continue on company access.",
      );
    }
  }
  return { userProviderKeys, userModelOverride, personalAuth, authLabel };
}

async function checkTurnRuntimeAuth(
  ctx: TurnCtx,
  purposeDefault: PurposeDefault,
  choice: RuntimeChoice,
): Promise<string | null> {
  try {
    const auth = await loadRuntimeAuth(ctx, purposeDefault, choice);
    if (auth.personalAuth && !servesModel(choice.modelId, auth.userModelOverride, auth.userProviderKeys))
      return "Your connected AI account cannot serve this model. Choose a compatible runtime from get.";
    return null;
  } catch (error) {
    return errMessage(error);
  }
}

async function adoptTurnRuntime(
  ctx: TurnCtx,
  purposeDefault: PurposeDefault,
  runtimeState: RuntimeState,
  choice: RuntimeChoice,
  lifetime: "task" | "scope",
): Promise<void> {
  const error = await checkTurnRuntimeAuth(ctx, purposeDefault, choice);
  if (error) throw new NonRetryableTurnError(error);
  runtimeState.agentSwitch = lifetime;
  Object.assign(runtimeState, await loadRuntimeAuth(ctx, purposeDefault, choice));
  runtimeState.requestedRuntime = runtimeState.userModelOverride
    ? { ...choice, modelId: runtimeState.userModelOverride }
    : choice;
}
