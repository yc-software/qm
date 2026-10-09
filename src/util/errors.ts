import { reportBackendError } from "../../plugins/chassis/src/error-reporting.ts";
import { errChain as errMessage, errDetail, failureCode } from "../../plugins/chassis/src/errors.ts";
import { WorkAdmissionClosed } from "./admitted-work.ts";

export { errChain as errMessage, failureCode, swallow, swallowAs } from "../../plugins/chassis/src/errors.ts";

export function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(errMessage(e), { cause: e });
}

const reportedErrors = new WeakSet<object>();

export function markErrorReported(e: unknown): void {
  if (typeof e === "object" && e !== null) reportedErrors.add(e);
}

export function errorAlreadyReported(e: unknown): boolean {
  return typeof e === "object" && e !== null && reportedErrors.has(e);
}

function isExpectedInterruption(e: unknown): boolean {
  return (e instanceof Error && e.name === "AbortError") || e instanceof WorkAdmissionClosed;
}

export function reportFailure(context: string, e: unknown, detail?: string): void {
  const reportable = !isExpectedInterruption(e) && !errorAlreadyReported(e);
  if (reportable) markErrorReported(e);
  const eventId = reportable
    ? reportBackendError(asError(e), failureCode(context), detail ? { detail } : undefined)
    : undefined;
  console.error(
    `[failed] ${context}${detail ? ` (${detail})` : ""}${eventId ? ` [sentry=${eventId}]` : ""}: ${errDetail(e)}`,
  );
}

export function reportFailureAs<T>(context: string, fallback: T, detail?: string): (e: unknown) => T {
  return (e) => {
    reportFailure(context, e, detail);
    return fallback;
  };
}

const REQUEST_ID_HEADERS = ["x-request-id", "x-amzn-requestid", "fly-request-id"];

export function withRequestId(message: string, headers: Headers): string {
  for (const name of REQUEST_ID_HEADERS) {
    const value = headers.get(name);
    if (value) return `${message} [request id ${value}]`;
  }
  return message;
}

export async function httpFailure(res: Response, bodyChars = 200): Promise<string> {
  const body = (await res.text().catch(() => "")).slice(0, bodyChars);
  return withRequestId(`http ${res.status} ${body}`, res.headers);
}
