import type * as Sentry from "@sentry/node";

export type TransactionEvent = Sentry.Event & { type: "transaction" };

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

const NAME = /^[A-Z]{3,7} (\/(v[0-9]{1,3}|[a-z][a-z-]{0,31}|:[a-zA-Z]{1,32}|\*)){1,10}$|^(run|pageload)$/;
const TAG_KEYS = new Set(["service", "deployment"]);
const DATA_KEYS = new Set(["surface", "origin", "http_status", "page"]);
const TAG_VALUE = /^[a-zA-Z0-9_.:-]{1,64}$/;
const MEASUREMENTS = new Set(["queue_wait", "ttfb", "dom_content_loaded", "load", "fcp", "lcp"]);
const HEX = /^[a-f0-9]+$/;

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
  if (result.name) span.updateName(result.name);
  span.setStatus(
    result.status === "ok" ? { code: SPAN_STATUS_OK } : { code: SPAN_STATUS_ERROR, message: result.status },
  );
  for (const [key, value] of Object.entries(result.data ?? {})) if (value !== undefined) span.setAttribute(key, value);
  for (const [key, value] of Object.entries(result.measurements ?? {}))
    if (value !== undefined && Number.isFinite(value) && value >= 0)
      sdk.setMeasurement(key, Math.round(value), "millisecond", span);
  span.end(result.endMs ?? Date.now());
}

function allowlisted(entries: Record<string, unknown>, keys: Set<string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(entries).filter(
      ([key, value]) => keys.has(key) && typeof value === "string" && TAG_VALUE.test(value),
    ),
  ) as Record<string, string>;
}

export function sanitizeTransactionEvent(
  event: TransactionEvent,
  platform: "node" | "javascript",
): TransactionEvent | null {
  const trace = event.contexts?.trace;
  const measurements: NonNullable<Sentry.Event["measurements"]> = event.measurements ?? {};
  const start = event.start_timestamp;
  const end = event.timestamp;
  if (
    !NAME.test(event.transaction ?? "") ||
    typeof start !== "number" ||
    typeof end !== "number" ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end < start ||
    !trace ||
    !HEX.test(trace.trace_id ?? "") ||
    !HEX.test(trace.span_id ?? "")
  )
    return null;
  return {
    type: "transaction",
    event_id: HEX.test(event.event_id ?? "") ? event.event_id : undefined,
    transaction: event.transaction,
    transaction_info: { source: "route" },
    start_timestamp: start,
    timestamp: end,
    platform,
    environment: event.environment,
    release: event.release,
    tags: { ...allowlisted(event.tags ?? {}, TAG_KEYS), ...allowlisted(trace.data ?? {}, DATA_KEYS) },
    contexts: {
      trace: { trace_id: trace.trace_id, span_id: trace.span_id, op: trace.op, status: trace.status, origin: "manual" },
    },
    measurements: Object.fromEntries(
      Object.entries(measurements).filter(
        ([key, measurement]) =>
          MEASUREMENTS.has(key) && Number.isFinite(measurement.value) && measurement.unit === "millisecond",
      ),
    ),
    spans: [],
  };
}
