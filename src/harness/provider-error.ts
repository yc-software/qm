import type { AssistantMessage } from "@earendil-works/pi-ai";
import { ProviderTurnError, type ProviderErrorCode } from "../core/turn-error.ts";

// Classifies a failed pi-ai AssistantMessage from structured fields only: providerError (HTTP status
// plus the provider's documented error type/code, from our vendored pi-ai, see vendor/pi-ai/) and
// rawStopReason. errorMessage is never inspected; it is carried as `raw` for the operator log.

const AUTH_TYPES = new Set(["authentication_error", "permission_error", "invalid_api_key"]);
const TRANSIENT_TYPES = new Set(["overloaded_error", "api_error", "timeout_error"]);
const CONTEXT_CODES = new Set(["context_length_exceeded"]);
const QUOTA_CODES = new Set(["insufficient_quota"]);
const RETRYABLE_CODES = new Set<ProviderErrorCode>(["rate_limit", "transient", "unknown"]);

function providerErrorCode(failed: AssistantMessage): ProviderErrorCode {
  if (failed.rawStopReason === "refusal") return "refusal";
  const { status, type, code } = failed.providerError ?? {};
  if (type === "budget_exceeded" || (code && QUOTA_CODES.has(code))) return "model_budget";
  if (code && CONTEXT_CODES.has(code)) return "context_too_long";
  if ((type && AUTH_TYPES.has(type)) || status === 401 || status === 403) return "auth";
  if (type === "rate_limit_error" || status === 429) return "rate_limit";
  if ((type && TRANSIENT_TYPES.has(type)) || status === 408 || status === 409 || (status ?? 0) >= 500)
    return "transient";
  return "unknown";
}

function providerBodyMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as { message?: unknown; error?: unknown };
  const nested = record.error && typeof record.error === "object" ? (record.error as { message?: unknown }) : record;
  return typeof nested.message === "string" && nested.message.trim() ? nested.message.trim() : undefined;
}

export function providerTurnError(failed: AssistantMessage): ProviderTurnError {
  const raw = failed.errorMessage?.trim() ?? "";
  const code = providerErrorCode(failed);
  const status = failed.providerError?.status;
  const type = failed.providerError?.type;
  const bodyMessage = providerBodyMessage(failed.providerError?.body);
  const message = bodyMessage
    ? `Model provider API error${type ? ` (${type})` : ""}: ${bodyMessage}`
    : raw || "Pi agent stopped with an error";
  // A failure with no HTTP response or stop reason (network drop, stream cut) stays "unknown" but retryable.
  const retryable =
    RETRYABLE_CODES.has(code) && !(code === "unknown" && (status !== undefined || failed.rawStopReason));
  return new ProviderTurnError(message, { code, retryable, status, raw });
}
