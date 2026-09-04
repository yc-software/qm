import {
  codexSubscriptionModelId,
  DEFAULT_AGENT_MODEL_ID,
  DEFAULT_CODEX_MODEL_ID,
  DEFAULT_GROK_MODEL_ID,
  defaultModelForHarness,
  defaultModelForProvider,
  modelServiceable,
  modelSupportedByHarness,
  resolveModel,
  type ModelProvider,
  type ModelProviderAvailability,
} from "../model/pi-models.ts";
import type { UserModelCredential } from "../model/user-model-credential-store.ts";

const INDIVIDUAL_AUTH_MODEL_ROUTES = [
  { provider: "anthropic", harness: "pi" },
  { provider: "anthropic", harness: "claude" },
  { provider: "openai", harness: "pi" },
  { provider: "openai", harness: "codex" },
  { provider: "xai", harness: "pi" },
  { provider: "xai", harness: "grok" },
] as const;

export type IndividualAuthRouting =
  | { kind: "apikey"; provider: ModelProvider; harness: "pi"; model: string | undefined; apiKey: string }
  | { kind: "oauth"; provider: "anthropic"; harness: "claude"; model: string }
  | { kind: "oauth"; provider: "openai"; harness: "codex"; model: string }
  | { kind: "oauth"; provider: "openai"; harness: "pi"; model: string }
  | { kind: "oauth"; provider: "xai"; harness: "grok"; model: string }
  | null;

export function individualAuthModelConnectable(modelId: string, harness: string): boolean {
  const provider = resolveModel(modelId)?.provider;
  return (
    modelSupportedByHarness(modelId, harness) &&
    INDIVIDUAL_AUTH_MODEL_ROUTES.some((route) => route.harness === harness && route.provider === provider)
  );
}

export function deploymentModelServiceable(
  modelId: string,
  harness: string,
  providers: ModelProviderAvailability,
  individualModelAuth: boolean,
): boolean {
  return (
    modelServiceable(modelId, providers) || (individualModelAuth && individualAuthModelConnectable(modelId, harness))
  );
}

export function resolveIndividualAuthRouting(
  anthCred: UserModelCredential | null,
  oaiCred: UserModelCredential | null,
  requestedModel: string | undefined,
  preferredHarness?: string,
  xaiCred: UserModelCredential | null = null,
): IndividualAuthRouting {
  const requestedProvider = requestedModel ? resolveModel(requestedModel)?.provider : undefined;
  const pick = ((): { provider: "anthropic" | "openai" | "xai"; cred: UserModelCredential } | null => {
    if (requestedProvider === "anthropic" && anthCred) return { provider: "anthropic", cred: anthCred };
    if (requestedProvider === "openai" && oaiCred) return { provider: "openai", cred: oaiCred };
    if (requestedProvider === "xai" && xaiCred) return { provider: "xai", cred: xaiCred };
    if (preferredHarness === "grok" && xaiCred) return { provider: "xai", cred: xaiCred };
    if (anthCred) return { provider: "anthropic", cred: anthCred };
    if (oaiCred) return { provider: "openai", cred: oaiCred };
    if (xaiCred) return { provider: "xai", cred: xaiCred };
    return null;
  })();
  if (!pick) return null;
  if (pick.cred.kind === "apikey" && pick.cred.apiKey) {
    return {
      kind: "apikey",
      provider: pick.provider,
      harness: "pi",
      apiKey: pick.cred.apiKey,
      model:
        requestedModel && requestedProvider === pick.provider
          ? requestedModel
          : defaultModelForProvider("pi", pick.provider),
    };
  }
  if (pick.cred.kind === "oauth" && pick.cred.oauth) {
    if (pick.provider === "anthropic") {
      return {
        kind: "oauth",
        provider: "anthropic",
        harness: "claude",
        model: defaultModelForHarness("claude", DEFAULT_AGENT_MODEL_ID),
      };
    }
    if (pick.provider === "xai") {
      return {
        kind: "oauth",
        provider: "xai",
        harness: "grok",
        model:
          requestedModel && requestedProvider === "xai"
            ? requestedModel
            : defaultModelForHarness("grok", DEFAULT_GROK_MODEL_ID),
      };
    }
    if (preferredHarness === "pi") {
      // pi-on-ChatGPT: the org runs the pi harness, so serve the
      // subscription through pi-ai's Codex provider instead of switching
      // the person onto the codex harness.
      return {
        kind: "oauth",
        provider: "openai",
        harness: "pi",
        model: codexSubscriptionModelId(
          requestedModel && requestedProvider === "openai" ? requestedModel : DEFAULT_CODEX_MODEL_ID,
        ),
      };
    }
    return {
      kind: "oauth",
      provider: "openai",
      harness: "codex",
      model: defaultModelForHarness("codex", DEFAULT_CODEX_MODEL_ID),
    };
  }
  return null;
}
