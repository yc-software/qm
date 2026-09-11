import {
  codexSubscriptionModelId,
  CODEX_SUBSCRIPTION_PROVIDER,
  DEFAULT_AGENT_MODEL_ID,
  DEFAULT_CODEX_MODEL_ID,
  defaultModelForHarness,
  defaultModelForProvider,
  resolveModel,
  isOverlayModel,
  modelUnavailableReason,
  type ModelProvider,
} from "../model/pi-models.ts";
import type { UserModelCredential } from "../model/user-model-credential-store.ts";

export type IndividualAuthRouting =
  | { kind: "apikey"; provider: ModelProvider; harness: "pi"; model: string | undefined; apiKey: string }
  | { kind: "oauth"; provider: "anthropic"; harness: "claude"; model: string }
  | { kind: "oauth"; provider: "openai"; harness: "codex"; model: string }
  | { kind: "oauth"; provider: "openai"; harness: "pi"; model: string }
  | null;

export function resolveIndividualAuthRouting(
  anthCred: UserModelCredential | null,
  oaiCred: UserModelCredential | null,
  requestedModel: string | undefined,
  preferredHarness?: string,
): IndividualAuthRouting {
  if (requestedModel && (modelUnavailableReason(requestedModel) || !resolveModel(requestedModel))) return null;
  const rawProvider = requestedModel ? resolveModel(requestedModel)?.provider : undefined;
  const requestedProvider = rawProvider === CODEX_SUBSCRIPTION_PROVIDER ? "openai" : rawProvider;
  const pick = ((): { provider: "anthropic" | "openai"; cred: UserModelCredential } | null => {
    if (requestedProvider === "anthropic" && anthCred) return { provider: "anthropic", cred: anthCred };
    if (requestedProvider === "openai" && oaiCred) return { provider: "openai", cred: oaiCred };
    if (anthCred) return { provider: "anthropic", cred: anthCred };
    if (oaiCred) return { provider: "openai", cred: oaiCred };
    return null;
  })();
  if (!pick) return null;
  if (
    requestedModel &&
    isOverlayModel(requestedModel) &&
    (pick.cred.kind !== "apikey" || requestedProvider !== pick.provider)
  )
    return null;
  if (pick.cred.kind === "apikey" && rawProvider === CODEX_SUBSCRIPTION_PROVIDER) return null;
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
        model:
          requestedModel && requestedProvider === "anthropic"
            ? requestedModel
            : defaultModelForHarness("claude", DEFAULT_AGENT_MODEL_ID),
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
      model:
        requestedModel && requestedProvider === "openai"
          ? requestedModel.replace(/^codex\//, "")
          : defaultModelForHarness("codex", DEFAULT_CODEX_MODEL_ID),
    };
  }
  return null;
}
