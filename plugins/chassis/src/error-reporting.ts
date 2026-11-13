import type * as Sentry from "@sentry/node";
import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseSampleRate, SPAN_STATUS_ERROR, TIMING_STATUSES } from "./timing.ts";
import { swallow } from "./errors.ts";

export const FLUSH_MS = 2_000;
const UNTRACED_PATHS = new Set(["/healthz", "/readyz"]);
const INTERNAL_SERVICE_URLS = ["CORE_API_URL", "AUTH_BROKER_UPSTREAM"];
const KEPT_TRACE_DATA = new Set([
  "sentry.op",
  "sentry.origin",
  "sentry.source",
  "sentry.sample_rate",
  "sentry.trace_lifecycle",
  "sentry.segment.id",
  "sentry.segment.name",
  "sentry.segment.name.source",
  "sentry.sdk.name",
  "sentry.sdk.version",
  "sentry.sdk.integrations",
  "sentry.release",
  "sentry.environment",
  "sentry.status.message",
  "otel.kind",
  "http.request.method",
  "http.method",
  "http.response.status_code",
  "http.status_code",
  "http.route",
  "url.scheme",
  "network.protocol.name",
  "network.protocol.version",
  "db.system",
  "db.name",
  "messaging.system",
  "messaging.destination.name",
  "messaging.message.id",
  "messaging.message.retry.count",
  "messaging.message.receive.latency",
  "qm.surface",
  "qm.origin",
  "qm.cancelled",
  "qm.facts",
  "qm.recalled",
  "qm.skills",
  "service",
  "deployment",
  "time_to_model_request",
  "time_to_first_text",
]);
const RUN_TAGS = ["messaging.message.id", "qm.surface", "qm.origin"];
const SENT_ROOTS = new Set(["http.server", "queue.process"]);
const SQL_VERBS = new Set(
  "SELECT INSERT UPDATE DELETE WITH BEGIN COMMIT ROLLBACK SAVEPOINT RELEASE CREATE ALTER DROP TRUNCATE SET RESET SHOW LISTEN UNLISTEN NOTIFY COPY LOCK VACUUM ANALYZE EXPLAIN DO CALL PREPARE EXECUTE DEALLOCATE DISCARD".split(
    " ",
  ),
);
const POOL_CHECKOUT = "pg-pool.connect";
const IDLE_CHECKOUT_SECONDS = 0.001;
const HTTP_METHODS = new Set("GET HEAD POST PUT PATCH DELETE OPTIONS CONNECT TRACE".split(" "));
const STATUS_MESSAGES = new Set<unknown>(TIMING_STATUSES);
type SamplingContext = Parameters<NonNullable<Sentry.NodeOptions["tracesSampler"]>>[0];
export const REQUEST_ID_HEADERS = ["fly-request-id", "render-request-id", "x-amzn-requestid", "x-request-id"];
let client: typeof Sentry | undefined;
let tracing = false;

interface RequestContext {
  surface: string;
  method: string;
  finished: boolean;
  route?: string;
  requestId?: string;
}

const activeRequest = new AsyncLocalStorage<RequestContext>();

export interface TraceCarrier {
  sentryTrace: string;
}

type StreamedSpan = Parameters<Parameters<typeof Sentry.withStreamedSpan>[0]>[0];
type Envelope = Parameters<NonNullable<ReturnType<typeof Sentry.getClient>>["sendEnvelope"]>[0];

function firstWord(text: string | undefined, allowed: Set<string>): string | undefined {
  const word = /^[A-Za-z]+/.exec(text ?? "")?.[0]?.toUpperCase();
  return word && allowed.has(word) ? word : undefined;
}

function httpClientName(name: string): string {
  const [method, target] = name.split(/\s+/, 2);
  const verb = firstWord(method, HTTP_METHODS) ?? "HTTP";
  try {
    return `${verb} ${new URL(target ?? "").origin}`;
  } catch {
    return verb;
  }
}

function spanName(op: unknown, name: string, statement: unknown): string {
  if (op === "http.client") return httpClientName(name);
  if (op === "db") {
    if (typeof statement !== "string" && name === POOL_CHECKOUT) return name;
    return firstWord(typeof statement === "string" ? statement : undefined, SQL_VERBS) ?? "query";
  }
  if (op === "step.tool") return name;
  return typeof op === "string" ? op : "span";
}

function scrubSpan(span: StreamedSpan): StreamedSpan {
  const attributes: Record<string, unknown> = span.attributes ?? {};
  const op = attributes["sentry.op"];
  const statement = attributes["db.statement"] ?? attributes["db.query.text"];
  for (const key of Object.keys(attributes)) if (!KEPT_TRACE_DATA.has(key)) delete attributes[key];
  if ("sentry.status.message" in attributes && !STATUS_MESSAGES.has(attributes["sentry.status.message"]))
    attributes["sentry.status.message"] = "internal_error";
  if (!span.is_segment) span.name = spanName(op, span.name, statement);
  if (typeof statement === "string") attributes["db.query.text"] = span.name;
  return span;
}

function ownTraceHeader(sdk: typeof Sentry): (envelope: Envelope) => void {
  return (envelope) => {
    const header = envelope[0] as { trace?: Record<string, unknown> };
    if (!header.trace) return;
    const payload = envelope[1][0]?.[1] as
      { contexts?: { trace?: { trace_id?: string } }; items?: { trace_id?: string }[] } | undefined;
    const sentryClient = sdk.getClient();
    const options = sentryClient?.getOptions();
    const { sampled, sample_rate: sampleRate } = header.trace;
    header.trace = Object.fromEntries(
      Object.entries({
        trace_id: payload?.contexts?.trace?.trace_id ?? payload?.items?.[0]?.trace_id,
        public_key: sentryClient?.getDsn()?.publicKey,
        release: options?.release,
        environment: options?.environment,
        sampled: sampled === "true" || sampled === "false" ? sampled : undefined,
        sample_rate: typeof sampleRate === "string" && parseSampleRate(sampleRate) > 0 ? sampleRate : undefined,
      }).filter(([, value]) => typeof value === "string" && value),
    );
  };
}

function untracedRequest(
  url: string,
  request: { method?: string; headers: Record<string, string | string[] | undefined> },
): boolean {
  const path = url.split("?")[0]!;
  if (UNTRACED_PATHS.has(path)) return true;
  if (String(request.headers.accept ?? "").includes("text/event-stream")) return true;
  return request.method === "GET" && path.endsWith("/events");
}

function internalTraceTargets(env: NodeJS.ProcessEnv): RegExp[] {
  const origins = new Set<string>();
  for (const name of INTERNAL_SERVICE_URLS) {
    try {
      if (env[name]) origins.add(new URL(env[name]).origin);
    } catch {
      console.warn(`[tracing] ${name} is not a valid URL; trace context will not be sent to it`);
    }
  }
  return [...origins].map((origin) => new RegExp(`^${origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/|$)`));
}

function sampler(rate: number) {
  return ({ attributes, inheritOrSampleWith }: SamplingContext): number => {
    if (!SENT_ROOTS.has(String(attributes?.["sentry.op"]))) return 0;
    return attributes?.["qm.origin"] === "human" ? 1 : inheritOrSampleWith(rate);
  };
}

export function initializeErrorReporting(
  sdk: typeof Sentry,
  service: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!env.SENTRY_DSN || client) return;
  const tracesSampleRate = parseSampleRate(env.SENTRY_TRACES_SAMPLE_RATE);
  const traced = tracesSampleRate > 0;
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
      ...(traced
        ? [
            sdk.httpIntegration({
              breadcrumbs: false,
              maxIncomingRequestBodySize: "none",
              ignoreIncomingRequests: untracedRequest,
              incomingRequestSpanHook: (span, request) => {
                const name = `${firstWord(request.method, HTTP_METHODS) ?? "HTTP"} /*`;
                sdk.updateSpanName(span, name);
                sdk.getIsolationScope().setTransactionName(name);
              },
            }),
            sdk.nativeNodeFetchIntegration({ breadcrumbs: false }),
            sdk.postgresIntegration({ ignoreConnectSpans: true }),
            sdk.spanStreamingIntegration(),
          ]
        : []),
    ],
    skipOpenTelemetrySetup: !traced,
    registerEsmLoaderHooks: false,
    ...(traced
      ? {
          traceLifecycle: "stream",
          tracesSampler: sampler(tracesSampleRate),
          beforeSendSpan: sdk.withStreamedSpan(scrubSpan),
        }
      : {}),
    tracePropagationTargets: traced ? internalTraceTargets(env) : [],
    attachStacktrace: true,
    sendClientReports: false,
    initialScope: { tags: { service, deployment: env.SENTRY_DEPLOYMENT ?? env.ORG_ID ?? env.CORE_ORG_ID } },
    shutdownTimeout: FLUSH_MS,
  });
  sdk.addEventProcessor(tagActiveRequest);
  if (traced) {
    sdk.getGlobalScope().setAttributes({ service, deployment: env.SENTRY_DEPLOYMENT ?? env.ORG_ID ?? env.CORE_ORG_ID });
    sdk.getClient()?.on("beforeEnvelope", ownTraceHeader(sdk));
  }
  client = sdk;
  tracing = traced;
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

function requestIdOf(req: IncomingMessage): string | undefined {
  for (const name of REQUEST_ID_HEADERS) {
    const value = req.headers[name];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

export function withRequestContext<T>(surface: string, req: IncomingMessage, res: ServerResponse, work: () => T): T {
  const requestId = requestIdOf(req);
  const request: RequestContext = {
    surface,
    method: firstWord(req.method, HTTP_METHODS) ?? "HTTP",
    finished: false,
    ...(requestId ? { requestId } : {}),
  };
  res.once("close", () => {
    request.finished = true;
  });
  return activeRequest.run(request, work);
}

export function describeActiveRequest(): string | undefined {
  const request = activeRequest.getStore();
  if (!request) return undefined;
  const route = request.route ? ` ${request.route}` : "";
  const id = request.requestId ? ` (request id ${request.requestId})` : "";
  const target = `${request.surface} ${request.method}${route}${id}`;
  return request.finished ? `after ${target} finished` : `during ${target}`;
}

function tagActiveRequest<T extends { type?: string; tags?: Record<string, unknown> }>(event: T): T {
  const request = activeRequest.getStore();
  if (!request || event.type !== undefined) return event;
  event.tags = {
    ...event.tags,
    "request.surface": request.surface,
    "request.method": request.method,
    "request.finished": request.finished,
    ...(request.route ? { "request.route": request.route } : {}),
    ...(request.requestId ? { "request.id": request.requestId } : {}),
  };
  return event;
}

export function nameRequest(method: string, route: string): void {
  const request = activeRequest.getStore();
  if (request) request.route = route;
  if (!client || !tracing) return;
  try {
    const active = client.getActiveSpan();
    if (!active) return;
    const root = client.getRootSpan(active);
    const name = `${firstWord(method, HTTP_METHODS) ?? "HTTP"} ${route}`;
    client.updateSpanName(root, name);
    client.getIsolationScope().setTransactionName(name);
    root.setAttribute("http.route", route);
  } catch (error) {
    swallow("tracing", error);
  }
}

export function traceCarrier(): TraceCarrier | undefined {
  if (!client || !tracing || !client.getActiveSpan()) return undefined;
  const sentryTrace = client.getTraceData()["sentry-trace"];
  return sentryTrace ? { sentryTrace } : undefined;
}

export function traceQueued<T>(
  carrier: TraceCarrier | undefined,
  name: string,
  attributes: Record<string, string | number | undefined>,
  work: () => Promise<T>,
  cancelled: (result: T) => boolean = () => false,
): Promise<T> {
  if (!client || !tracing) return work();
  const sdk = client;
  const begin = (): Promise<T> =>
    sdk.withScope((scope) => {
      for (const key of RUN_TAGS) if (attributes[key] !== undefined) scope.setTag(key, attributes[key]);
      return sdk.startSpan({ op: "queue.process", name, forceTransaction: true, attributes }, async (span) => {
        const result = await work();
        if (cancelled(result)) span.setAttribute("qm.cancelled", true);
        return result;
      });
    });
  return carrier
    ? sdk.continueTrace({ sentryTrace: carrier.sentryTrace, baggage: undefined }, begin)
    : sdk.startNewTrace(begin);
}

export type Phase = Sentry.Span;

export function tracePhase<T>(
  op: string,
  work: () => Promise<T>,
  opts: { counts?: (result: T) => Record<string, number>; name?: string; parent?: Phase } = {},
): Promise<T> {
  if (!client || !tracing || !(opts.parent ?? client.getActiveSpan())) return work();
  return client.startSpan(
    { op, name: opts.name ?? op, onlyIfParent: true, ...(opts.parent ? { parentSpan: opts.parent } : {}) },
    async (span) => {
      const result = await work();
      if (opts.counts) span.setAttributes(opts.counts(result));
      return result;
    },
  );
}

export function startPhase(op: string): Phase | undefined {
  if (!client || !tracing || !client.getActiveSpan()) return undefined;
  return client.startInactiveSpan({ op, name: op, onlyIfParent: true });
}

export function untraced<T>(work: () => T): T {
  return client && tracing ? client.suppressTracing(work) : work();
}

export async function tracePoolCheckout<T>(checkout: () => Promise<T>): Promise<T> {
  if (!client || !tracing || !client.getActiveSpan()) return checkout();
  const sdk = client;
  const started = performance.now();
  const record = (failed: boolean): void => {
    const seconds = (performance.now() - started) / 1000;
    if (!failed && seconds < IDLE_CHECKOUT_SECONDS) return;
    const end = Date.now() / 1000;
    const span = sdk.startInactiveSpan({ op: "db", name: POOL_CHECKOUT, startTime: end - seconds, onlyIfParent: true });
    if (failed) span.setStatus({ code: SPAN_STATUS_ERROR, message: "internal_error" });
    span.end(end);
  };
  try {
    const checkedOut = await checkout();
    record(false);
    return checkedOut;
  } catch (error) {
    record(true);
    throw error;
  }
}

export interface DispatchTrace {
  modelRequest(): void;
  firstToken(): void;
  end(): void;
}

const UNTRACED_DISPATCH: DispatchTrace = { modelRequest() {}, firstToken() {}, end() {} };

export function startDispatchTrace(): DispatchTrace {
  if (!client || !tracing) return UNTRACED_DISPATCH;
  const sdk = client;
  try {
    const active = sdk.getActiveSpan();
    if (!active) return UNTRACED_DISPATCH;
    const root = sdk.getRootSpan(active);
    const startedMs = sdk.spanToJSON(root).start_timestamp * 1000;
    const dispatch = sdk.startInactiveSpan({ op: "turn.dispatch", name: "turn.dispatch", onlyIfParent: true });
    let dispatched = false;
    let firstToken = false;
    let ended = false;
    const measure = (name: string): void => {
      try {
        root.setAttribute(name, Math.max(0, Date.now() - startedMs));
      } catch (error) {
        swallow("tracing", error);
      }
    };
    const endDispatch = (): void => {
      if (dispatched) return;
      dispatched = true;
      dispatch.end();
    };
    return {
      modelRequest() {
        if (ended || dispatched) return;
        endDispatch();
        measure("time_to_model_request");
      },
      firstToken() {
        if (ended || firstToken) return;
        firstToken = true;
        endDispatch();
        measure("time_to_first_text");
      },
      end() {
        endDispatch();
        ended = true;
      },
    };
  } catch (error) {
    swallow("tracing", error);
    return UNTRACED_DISPATCH;
  }
}

export async function flushErrorReporting(): Promise<void> {
  try {
    await client?.flush(FLUSH_MS);
  } catch {
    return;
  }
}
