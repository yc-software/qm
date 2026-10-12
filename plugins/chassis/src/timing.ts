import type * as Sentry from "@sentry/node";
import { swallow } from "./errors.ts";

export type TimingStatus =
  | "ok"
  | "cancelled"
  | "unauthenticated"
  | "permission_denied"
  | "not_found"
  | "resource_exhausted"
  | "invalid_argument"
  | "internal_error";

export interface TimingResult {
  name?: string;
  status: TimingStatus;
  endMs?: number;
  data?: Record<string, string | undefined>;
  measurements?: Record<string, number | undefined>;
}

export type TimingSdk = Pick<typeof Sentry, "setMeasurement">;
const SPAN_STATUS_OK = 1;
const SPAN_STATUS_ERROR = 2;

export function parseSampleRate(value: string | undefined): number {
  const rate = Number(value ?? 0);
  return Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : 0;
}

export function traceStatus(httpStatus: number): TimingStatus {
  if (httpStatus < 400) return "ok";
  if (httpStatus === 401) return "unauthenticated";
  if (httpStatus === 403) return "permission_denied";
  if (httpStatus === 404) return "not_found";
  if (httpStatus === 429) return "resource_exhausted";
  if (httpStatus < 500) return "invalid_argument";
  return "internal_error";
}

export function finishTiming(sdk: TimingSdk, span: Sentry.Span, result: TimingResult): void {
  try {
    if (result.name) span.updateName(result.name);
    span.setStatus(
      result.status === "ok" ? { code: SPAN_STATUS_OK } : { code: SPAN_STATUS_ERROR, message: result.status },
    );
    for (const [key, value] of Object.entries(result.data ?? {}))
      if (value !== undefined) span.setAttribute(key, value);
    for (const [key, value] of Object.entries(result.measurements ?? {}))
      if (value !== undefined && Number.isFinite(value) && value >= 0)
        sdk.setMeasurement(key, Math.round(value), "millisecond", span);
    span.end(result.endMs ?? Date.now());
  } catch (error) {
    swallow("timing", error);
  }
}
