import type { AssistantMessage } from "@earendil-works/pi-ai";
import { ProviderTurnError, TRANSIENT_ERROR_CODES, type ProviderErrorCode } from "../core/turn-error.ts";

const AUTH_TYPES = new Set(["authentication_error", "permission_error", "invalid_api_key"]);
const TRANSIENT_TYPES = new Set(["overloaded_error", "api_error", "timeout_error"]);
const CONTEXT_CODES = new Set(["context_length_exceeded"]);
const QUOTA_CODES = new Set(["insufficient_quota"]);
const NOT_FOUND_CODES = new Set(["model_not_found"]);
const RETRYABLE_CODES = new Set<ProviderErrorCode>([...TRANSIENT_ERROR_CODES, "unknown"]);

export interface ContextUsage {
  contextWindow?: number | undefined;
  lastInputTokens?: number | undefined;
}

const NEAR_WINDOW_RATIO = 0.9;

function nearWindow(usage: ContextUsage | undefined): boolean {
  const { contextWindow, lastInputTokens } = usage ?? {};
  return !!contextWindow && !!lastInputTokens && lastInputTokens >= contextWindow * NEAR_WINDOW_RATIO;
}

type ProviderFailure = Pick<AssistantMessage, "providerError" | "rawStopReason" | "errorMessage">;

function providerErrorCode(failed: ProviderFailure, usage?: ContextUsage): ProviderErrorCode {
  if (failed.rawStopReason === "refusal") return "refusal";
  const { status, type, code } = failed.providerError ?? {};
  if (type === "model_unavailable") return "model_unavailable";
  if (type === "request_too_large" || status === 413) return "context_too_long";
  if (type === "invalid_request_error" && status === 400 && nearWindow(usage)) return "context_too_long";
  if (type === "budget_exceeded" || (code && QUOTA_CODES.has(code))) return "model_budget";
  if (code && CONTEXT_CODES.has(code)) return "context_too_long";
  if ((type && AUTH_TYPES.has(type)) || status === 401 || status === 403) return "auth";
  if (type === "rate_limit_error" || status === 429) return "rate_limit";
  if (type === "not_found_error" || (code && NOT_FOUND_CODES.has(code)) || status === 404) return "not_found";
  if ((type && TRANSIENT_TYPES.has(type)) || status === 408 || status === 409 || (status ?? 0) >= 500)
    return "transient";
  if (type === "invalid_request_error" || status === 400 || status === 422) return "bad_request";
  return "unknown";
}

function providerBodyMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as { message?: unknown; error?: unknown };
  const nested = record.error && typeof record.error === "object" ? (record.error as { message?: unknown }) : record;
  return typeof nested.message === "string" && nested.message.trim() ? nested.message.trim() : undefined;
}

export function providerTurnError(failed: ProviderFailure, usage?: ContextUsage): ProviderTurnError {
  const raw = failed.errorMessage?.trim() ?? "";
  const code = providerErrorCode(failed, usage);
  const status = failed.providerError?.status;
  const type = failed.providerError?.type;
  const bodyMessage = providerBodyMessage(failed.providerError?.body);
  const message = bodyMessage
    ? `Model provider API error${type ? ` (${type})` : ""}: ${bodyMessage}`
    : raw || "The agent stopped with an error";
  const retryable =
    RETRYABLE_CODES.has(code) && !(code === "unknown" && (status !== undefined || failed.rawStopReason));
  return new ProviderTurnError(message, { code, retryable, status, raw });
}
