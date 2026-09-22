import type * as Sentry from "@sentry/node";
import { basename } from "node:path";
import { finishTiming, parseSampleRate, sanitizeTransactionEvent, type TimingResult } from "./timing.ts";
import { swallow } from "./errors.ts";

const FLUSH_MS = 2_000;
const ERROR_TYPES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "AggregateError",
]);
let client: typeof Sentry | undefined;
let tracing = false;

export function sanitizeErrorEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  const frames = (items: Sentry.StackFrame[] | undefined) =>
    items?.map((frame) => ({
      filename: frame.filename ? basename(frame.filename.split("?")[0]!) : undefined,
      function: frame.function?.replace(/[^a-zA-Z0-9_.$<> [\]-]/g, "").slice(0, 160),
      lineno: frame.lineno,
      colno: frame.colno,
      in_app: frame.in_app,
    }));
  return {
    type: undefined,
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: "node",
    level: event.level,
    environment: event.environment,
    release: event.release,
    tags: { service: event.tags?.service, deployment: event.tags?.deployment, error_code: event.tags?.error_code },
    fingerprint: event.tags?.error_code ? ["{{ default }}", String(event.tags.error_code)] : undefined,
    message: event.exception?.values?.length ? undefined : "Backend error; details retained in application logs",
    exception: event.exception
      ? {
          values: event.exception.values?.map((exception) => ({
            type: ERROR_TYPES.has(exception.type ?? "") ? exception.type : "Error",
            value:
              typeof event.tags?.error_code === "string"
                ? event.tags.error_code
                : "Details retained in application logs",
            stacktrace: exception.stacktrace ? { frames: frames(exception.stacktrace.frames) } : undefined,
            mechanism: exception.mechanism
              ? {
                  type: exception.mechanism.type,
                  handled: exception.mechanism.handled,
                }
              : undefined,
          })),
        }
      : undefined,
  };
}

export function initializeErrorReporting(
  sdk: typeof Sentry,
  service: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!env.SENTRY_DSN || client) return;
  const tracesSampleRate = parseSampleRate(env.SENTRY_TRACES_SAMPLE_RATE);
  sdk.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV ?? "development",
    release: env.SENTRY_RELEASE ?? env.GIT_SHA,
    serverName: "",
    defaultIntegrations: false,
    integrations: [sdk.onUncaughtExceptionIntegration()],
    skipOpenTelemetrySetup: tracesSampleRate === 0,
    ...(tracesSampleRate > 0 ? { tracesSampleRate } : {}),
    tracePropagationTargets: [],
    sendDefaultPii: false,
    maxBreadcrumbs: 0,
    attachStacktrace: true,
    sendClientReports: false,
    initialScope: { tags: { service, deployment: env.SENTRY_DEPLOYMENT ?? env.ORG_ID ?? env.CORE_ORG_ID } },
    beforeSend: sanitizeErrorEvent,
    beforeSendTransaction: (event) => sanitizeTransactionEvent(event, "node"),
    shutdownTimeout: FLUSH_MS,
  });
  client = sdk;
  tracing = tracesSampleRate > 0;
  process.on("unhandledRejection", (reason: unknown) => {
    sdk.captureException(reason, {
      captureContext: { level: "fatal" },
      mechanism: { handled: false, type: "qm.unhandled_rejection" },
    });
    if (process.listenerCount("unhandledRejection") === 1) {
      process.exitCode = 1;
      void flushErrorReporting().finally(() => process.exit(1));
    }
  });
}

export function reportBackendError(error: unknown, code?: string): void {
  client?.captureException(error, { tags: code && /^[a-zA-Z0-9_.:-]{1,120}$/.test(code) ? { error_code: code } : {} });
}

export type FinishTiming = (result: TimingResult) => void;

export function startTiming(op: string, name: string, startMs = Date.now()): FinishTiming | undefined {
  if (!client || !tracing) return undefined;
  try {
    const span = client.startInactiveSpan({ op, name, startTime: startMs, attributes: { "sentry.source": "route" } });
    return (result) => finishTiming(client!, span, result);
  } catch (error) {
    swallow("timing", error);
    return undefined;
  }
}

export async function flushErrorReporting(): Promise<void> {
  try {
    await client?.flush(FLUSH_MS);
  } catch {
    return;
  }
}
