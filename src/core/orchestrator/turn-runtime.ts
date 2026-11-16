import type { RuntimeChoice, SessionRoute } from "../../agent/agent.ts";
import type { ScopeId, Session } from "../../types.ts";
import { loadPersonalModelAuth } from "../individual-auth-routing.ts";
import { NonRetryableTurnError } from "../turn-error.ts";
import { turnRuntimePurpose } from "../turn-options.ts";
import { reportFailureAs } from "../../util/errors.ts";
import type { OrchestratorDeps, OrchestratorInput } from "./types.ts";

export interface TurnRuntimeAuthTurn {
  deps: OrchestratorDeps;
  input: OrchestratorInput;
  actor: OrchestratorInput["actor"];
  session: Session;
  scopeId: ScopeId;
  external: boolean;
  strictReadOnly: boolean;
  allInternal: boolean;
  automatedTurn: boolean;
  humanInput: boolean;
  swarmBinding: Awaited<ReturnType<NonNullable<OrchestratorDeps["swarms"]>["binding"]>> | undefined;
  connectorEnv: Record<string, string>;
}

export async function resolveTurnRuntimeAuth(turn: TurnRuntimeAuthTurn) {
  const {
    deps,
    input,
    actor,
    session,
    scopeId,
    external,
    strictReadOnly,
    allInternal,
    automatedTurn,
    humanInput,
    swarmBinding,
    connectorEnv,
  } = turn;
  const runtimePurpose = turnRuntimePurpose(
    { surface: input.surface, triggered: automatedTurn, infrequentCron: input.infrequentCron },
    !!session.parentSessionId || !!swarmBinding?.member.parentId,
  );
  const purposeDefault = runtimePurpose ? await deps.config.getPurposeRuntimeDurable(runtimePurpose) : undefined;
  const loadRuntimeAuth = async (runtime: Partial<RuntimeChoice>) => {
    const userCredStore = external ? undefined : deps.userModelCredentials;
    const account = external
      ? "company"
      : (input.modelAccount ?? (await deps.config.getModelAccountDurable(actor.id)) ?? "company");
    if (!userCredStore || !humanInput || account === "company")
      return {
        userProviderKeys: undefined,
        userModelOverride: undefined,
        personalAuth: false,
        authLabel: "api-key",
        account: "company" as const,
      };
    const personal = await loadPersonalModelAuth(
      userCredStore,
      actor.id,
      account,
      account === "personal" || input.surface === "web"
        ? (runtime.modelId ?? input.model ?? purposeDefault?.modelId)
        : (runtime.modelId ?? purposeDefault?.modelId),
    );
    if (!personal)
      throw new NonRetryableTurnError(
        "Your personal AI account is unavailable. Open Settings → AI access to reconnect Claude or ChatGPT / Codex, or choose company access. The chat cannot continue on company access.",
      );
    return {
      userProviderKeys: personal.keys,
      userModelOverride: personal.modelId,
      personalAuth: true,
      authLabel: personal.subscription ? `${personal.subscription}-subscription` : "api-key",
      account,
    };
  };
  const initialRuntimeAuth = loadRuntimeAuth({});
  const sessionAuth = await initialRuntimeAuth.catch(() => undefined);
  const sessionModel = sessionAuth?.userModelOverride ?? input.model;
  const sessionRoute: SessionRoute | undefined = sessionAuth && {
    ...(sessionModel ? { runtime: { modelId: sessionModel } } : {}),
    ...(sessionAuth.userProviderKeys ? { providerKeys: sessionAuth.userProviderKeys, runtimePinned: true } : {}),
    ...(runtimePurpose ? { runtimePurpose } : {}),
  };
  const browserModel =
    !strictReadOnly && allInternal && sessionRoute
      ? (
          await deps
            .resolveSessionRuntime?.({ ...sessionRoute, scopeLabel: scopeId })
            .catch(reportFailureAs("browser model: session runtime", undefined, scopeId))
        )?.modelId
      : undefined;
  if (browserModel) {
    connectorEnv.BROWSE_LAB_MODEL_PROVIDER = "managed";
    connectorEnv.BROWSE_LAB_MODEL = browserModel;
  }
  return {
    runtimePurpose,
    purposeDefault,
    loadRuntimeAuth,
    initialRuntimeAuth,
    sessionAuth,
    sessionModel,
    sessionRoute,
    browserModel,
  };
}
