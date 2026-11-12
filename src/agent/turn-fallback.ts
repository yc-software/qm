import { documentStub, type DocumentInput } from "../core/documents.ts";
import { isProviderDecision, ProviderTurnError } from "../core/turn-error.ts";
import { errMessage } from "../util/errors.ts";
import { routeLabel, type ModelRoute } from "../model/model-route.ts";

export const FALLBACK_CODES = new Set(["refusal", "model_unavailable", "model_budget", "auth", "account"]);
export const DOCUMENT_REJECTION_CODES = new Set(["context_too_long", "bad_request"]);

export function documentsDroppedNote(documents: readonly DocumentInput[]): string {
  return (
    `The model provider rejected an earlier request in this task while it carried these attachments inline ` +
    `(most likely they exceed the model's context), so they were removed from model input. ` +
    documents.map((document) => documentStub(document)).join(" ") +
    ` If the file matters to the request, tell the person it could not be read in full here and read only the parts you need.`
  );
}

export function fallbackFailed(failure: ProviderTurnError, fallback: ModelRoute, error: unknown): ProviderTurnError {
  const own = error instanceof ProviderTurnError ? error.code : "unknown";
  const code = isProviderDecision(error) ? failure.code : own;
  return new ProviderTurnError(
    `${failure.message} — the fallback ${routeLabel(fallback)} also failed: ${errMessage(error)}`,
    {
      code,
      retryable: false,
      status: failure.status,
      raw: `${failure.raw}\n${error instanceof ProviderTurnError ? error.raw : errMessage(error)}`,
      modelName: failure.modelName,
    },
  );
}

export function routeFailed(failure: ProviderTurnError, route: ModelRoute): ProviderTurnError {
  return new ProviderTurnError(`${routeLabel(route)}: ${failure.message}`, {
    code: failure.code,
    retryable: failure.retryable,
    status: failure.status,
    raw: failure.raw,
    modelName: failure.modelName,
  });
}

export function refusalFallbackNote(fromModel: string, toModel: string, refusal: string): string {
  return (
    `[system] Your previous response was blocked or failed at the model provider before it reached the user ` +
    `— these failures can fire spuriously; the user did nothing wrong. ` +
    `The provider's stated reason was: "${refusal}". ` +
    `The turn has been switched from ${fromModel} to ${toModel}. Start your reply by briefly ` +
    `telling the user that ${fromModel} could not answer this request and why (paraphrase the provider's ` +
    `stated reason in plain words), and that you are answering as ${toModel} instead — then answer ` +
    `their message.`
  );
}
