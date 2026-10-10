import type * as Sentry from "@sentry/node";
import { finishTiming, parseSampleRate, type TimingResult } from "./timing.ts";
import { swallow } from "./errors.ts";

const FLUSH_MS = 2_000;
let client: typeof Sentry | undefined;
let tracing = false;

export async function initializeErrorReporting(
  loadSdk: () => Promise<typeof Sentry>,
  service: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!env.SENTRY_DSN || client) return;
  const sdk = await loadSdk();
  const tracesSampleRate = parseSampleRate(env.SENTRY_TRACES_SAMPLE_RATE);
  sdk.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV ?? "development",
    release: env.SENTRY_RELEASE ?? env.GIT_SHA,
    serverName: "",
    defaultIntegrations: false,
    integrations: [
      sdk.onUncaughtExceptionIntegration(),
      sdk.linkedErrorsIntegration(),
      sdk.extraErrorDataIntegration({ depth: 8 }),
    ],
    skipOpenTelemetrySetup: tracesSampleRate === 0,
    ...(tracesSampleRate > 0 ? { tracesSampleRate } : {}),
    tracePropagationTargets: [],
    attachStacktrace: true,
    sendClientReports: false,
    initialScope: { tags: { service, deployment: env.SENTRY_DEPLOYMENT ?? env.ORG_ID ?? env.CORE_ORG_ID } },
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

export function reportBackendError(error: unknown, code?: string, extra?: Record<string, unknown>): string | undefined {
  return client?.captureException(error, {
    ...(code ? { tags: { error_code: code }, fingerprint: ["{{ default }}", code] } : {}),
    ...(extra ? { extra } : {}),
  });
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
