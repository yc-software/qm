import { reportBackendError } from "../../plugins/chassis/src/error-reporting.ts";
import { WorkAdmissionClosed } from "./admitted-work.ts";
import { tenantState } from "../tenancy/context.ts";

const CAUSE_DEPTH = 5;

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return String(value);
  if ("message" in value && typeof value.message === "string") return value.message;
  return "Unknown error";
}

function describeCause(cause: unknown): string {
  if (!(cause instanceof Error)) return errorText(cause);
  const code = (cause as { code?: unknown }).code;
  const label = code !== undefined && code !== null && code !== "" ? `${cause.name} ${errorText(code)}` : cause.name;
  return cause.message ? `${label}: ${cause.message}` : label;
}

export function errMessage(e: unknown): string {
  if (!(e instanceof Error)) return errorText(e);
  const parts = [e.message];
  const seen = new Set<unknown>([e]);
  const messages = new Set([e.message]);
  let cause: unknown = e.cause;
  while (cause !== undefined && cause !== null && !seen.has(cause) && parts.length <= CAUSE_DEPTH) {
    seen.add(cause);
    const causeMessage = cause instanceof Error ? cause.message : errorText(cause);
    if (!messages.has(causeMessage)) parts.push(describeCause(cause));
    messages.add(causeMessage);
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return parts.join(" <- ");
}

export function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(errorText(e));
}

export function swallow(context: string, e: unknown): void {
  console.warn(`[swallowed] ${context}: ${errMessage(e)}`);
}

export function swallowAs<T>(context: string, fallback: T): (e: unknown) => T {
  return (e) => {
    swallow(context, e);
    return fallback;
  };
}

const reportedErrorsKey = Symbol("reported errors");
const reportedErrors = () => tenantState(reportedErrorsKey, () => new WeakSet<object>());

export function markErrorReported(e: unknown): void {
  if (typeof e === "object" && e !== null) reportedErrors().add(e);
}

export function errorAlreadyReported(e: unknown): boolean {
  return typeof e === "object" && e !== null && reportedErrors().has(e);
}

function isExpectedInterruption(e: unknown): boolean {
  return (e instanceof Error && e.name === "AbortError") || e instanceof WorkAdmissionClosed;
}

export function failureCode(context: string): string {
  return context
    .toLowerCase()
    .replace(/\s*:\s*/g, ":")
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

export function reportFailure(context: string, e: unknown, detail?: string): void {
  console.error(`[failed] ${context}${detail ? ` (${detail})` : ""}: ${errMessage(e)}`);
  if (isExpectedInterruption(e) || errorAlreadyReported(e)) return;
  markErrorReported(e);
  reportBackendError(asError(e), failureCode(context));
}

export function reportFailureAs<T>(context: string, fallback: T, detail?: string): (e: unknown) => T {
  return (e) => {
    reportFailure(context, e, detail);
    return fallback;
  };
}
