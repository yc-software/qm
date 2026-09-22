import type * as Sentry from "@sentry/node";
import { swallow } from "./errors.ts";

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
const OPS = new Set(["http.server", "http.client", "queue.task", "pageload"]);
const STATUSES = new Set<string>([
  "ok",
  "cancelled",
  "unauthenticated",
  "permission_denied",
  "not_found",
  "resource_exhausted",
  "invalid_argument",
  "internal_error",
]);
const TAG_KEYS = new Set(["service", "deployment"]);
const TAG_VALUE = /^[a-zA-Z0-9_.:-]{1,64}$/;
const HTTP_STATUS = /^([1-5][0-9]{2}|network)$/;
const setHas = (values: string[]) => {
  const set = new Set(values);
  return (value: string) => set.has(value);
};
const BUCKETS: Record<string, (value: string) => boolean> = {
  surface: setHas([
    "core",
    "cron",
    "external",
    "inbound_file",
    "keychain-ask",
    "loop",
    "monitor",
    "secret-drop",
    "shared_skill",
    "slack",
    "steer",
    "swarm",
    "web",
    "webhook",
  ]),
  origin: setHas(["direct", "human", "ambient", "automation"]),
  page: setHas([
    "calendar",
    "chats",
    "contexts",
    "crons",
    "deploys",
    "files",
    "inbox",
    "keychain",
    "loops",
    "memory",
    "settings",
    "skills",
    "webhooks",
  ]),
  http_status: (value) => HTTP_STATUS.test(value),
};
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

function scopeTags(tags: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(tags).filter(
      ([key, value]) => TAG_KEYS.has(key) && typeof value === "string" && TAG_VALUE.test(value),
    ),
  ) as Record<string, string>;
}

function bucketed(data: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(data)
      .filter(([key, value]) => Object.hasOwn(BUCKETS, key) && typeof value === "string")
      .map(([key, value]) => [key, BUCKETS[key]!(value as string) ? (value as string) : "other"]),
  );
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
    !HEX.test(trace.span_id ?? "") ||
    !OPS.has(trace.op ?? "") ||
    !STATUSES.has(trace.status ?? "")
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
    tags: { ...scopeTags(event.tags ?? {}), ...bucketed(trace.data ?? {}) },
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
