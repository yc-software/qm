import type * as Sentry from "@sentry/node";
import { parseSampleRate, SPAN_STATUS_ERROR } from "./timing.ts";
import { swallow } from "./errors.ts";

const FLUSH_MS = 2_000;
const UNTRACED_PATHS = new Set(["/healthz", "/readyz"]);
const INTERNAL_SERVICE_URLS = ["CORE_API_URL", "WEB_UI_UPSTREAM", "ADMIN_UPSTREAM", "AUTH_BROKER_UPSTREAM"];
const KEPT_TRACE_DATA = new Set([
  "sentry.op",
  "sentry.origin",
  "sentry.source",
  "sentry.sample_rate",
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
  "db.postgresql.idle.timeout.millis",
  "db.postgresql.max.client",
  "messaging.system",
  "messaging.destination.name",
  "messaging.message.id",
  "messaging.message.retry.count",
  "messaging.message.receive.latency",
  "qm.surface",
  "qm.origin",
  "qm.facts",
  "qm.recalled",
  "qm.skills",
]);
const RUN_TAGS = ["messaging.message.id", "qm.surface", "qm.origin"];
const SENT_ROOTS = new Set(["http.server", "queue.process"]);
const SQL_VERBS = new Set(
  "SELECT INSERT UPDATE DELETE WITH BEGIN COMMIT ROLLBACK SAVEPOINT RELEASE CREATE ALTER DROP TRUNCATE SET RESET SHOW LISTEN UNLISTEN NOTIFY COPY LOCK VACUUM ANALYZE EXPLAIN DO CALL PREPARE EXECUTE DEALLOCATE DISCARD".split(
    " ",
  ),
);
const POOL_CHECKOUT = "pg-pool.connect";
const POOL_SPANS = new Set(["pg.connect", POOL_CHECKOUT]);
const MAX_SENT_SPANS = 500;
const IDLE_CHECKOUT_SECONDS = 0.001;
const HTTP_METHODS = new Set("GET HEAD POST PUT PATCH DELETE OPTIONS CONNECT TRACE".split(" "));
type SamplingContext = Parameters<NonNullable<Sentry.NodeOptions["tracesSampler"]>>[0];
let client: typeof Sentry | undefined;
let tracing = false;

export interface TraceCarrier {
  sentryTrace: string;
}

type TransactionEvent = Parameters<NonNullable<Sentry.NodeOptions["beforeSendTransaction"]>>[0];
type ErrorEvent = Parameters<NonNullable<Sentry.NodeOptions["beforeSend"]>>[0];
type SpanData = Record<string, unknown>;
type SpanJSON = NonNullable<TransactionEvent["spans"]>[number];

function scrubData(data: SpanData | undefined): { statement?: unknown } {
  if (!data) return {};
  const statement = data["db.statement"] ?? data["db.query.text"];
  for (const key of Object.keys(data)) if (!KEPT_TRACE_DATA.has(key)) delete data[key];
  return { statement };
}

function firstWord(text: string | undefined, allowed: Set<string>): string | undefined {
  const word = /^[A-Za-z]+/.exec(text ?? "")?.[0]?.toUpperCase();
  return word && allowed.has(word) ? word : undefined;
}

function httpClientDescription(description: string | undefined): string {
  const [method, target] = (description ?? "").split(/\s+/, 2);
  const verb = firstWord(method, HTTP_METHODS) ?? "HTTP";
  try {
    return `${verb} ${new URL(target ?? "").origin}`;
  } catch {
    return verb;
  }
}

function scrubDescription(
  op: string | undefined,
  description: string | undefined,
  statement: unknown,
): string | undefined {
  if (op === "http.client") return httpClientDescription(description);
  if (op === "db") {
    if (typeof statement !== "string" && description && POOL_SPANS.has(description)) return description;
    return firstWord(typeof statement === "string" ? statement : undefined, SQL_VERBS) ?? "query";
  }
  return op === "step.tool" ? description : op;
}

function scrubTraceContext<T extends TransactionEvent | ErrorEvent>(event: T): T {
  const metadata = event.sdkProcessingMetadata as { dynamicSamplingContext?: Record<string, unknown> } | undefined;
  if (!metadata?.dynamicSamplingContext) return event;
  const sentryClient = client?.getClient();
  const options = sentryClient?.getOptions();
  const sampleRate = event.contexts?.trace?.data?.["sentry.sample_rate"];
  metadata.dynamicSamplingContext = Object.fromEntries(
    Object.entries({
      trace_id: event.contexts?.trace?.trace_id,
      public_key: sentryClient?.getDsn()?.publicKey,
      release: options?.release,
      environment: options?.environment,
      ...(event.type === "transaction"
        ? { sampled: "true", sample_rate: typeof sampleRate === "number" ? String(sampleRate) : undefined }
        : {}),
    }).filter(([, value]) => typeof value === "string" && value),
  );
  return event;
}

function idleCheckout(span: SpanJSON, parents: Set<string | undefined>): boolean {
  return (
    span.description === POOL_CHECKOUT &&
    span.status === "ok" &&
    (span.timestamp ?? Infinity) - span.start_timestamp < IDLE_CHECKOUT_SECONDS &&
    !parents.has(span.span_id)
  );
}

function orderedSpans(spans: SpanJSON[]): SpanJSON[] {
  const parents = new Set(spans.map((span) => span.parent_span_id));
  return spans.filter((span) => !idleCheckout(span, parents)).sort((a, b) => a.start_timestamp - b.start_timestamp);
}

function duration(span: SpanJSON): number {
  return (span.timestamp ?? span.start_timestamp) - span.start_timestamp;
}

function budgetedSpans(ordered: SpanJSON[]): SpanJSON[] {
  if (ordered.length <= MAX_SENT_SPANS) return ordered;
  const byId = new Map(ordered.map((span) => [span.span_id, span]));
  const kept = new Set<string>();
  const priority = ordered.toSorted((a, b) =>
    a.op === "db" && b.op === "db" ? duration(b) - duration(a) : Number(a.op === "db") - Number(b.op === "db"),
  );
  for (const span of priority) {
    if (kept.size >= MAX_SENT_SPANS) break;
    const chain: string[] = [];
    for (let at: SpanJSON | undefined = span; at && !kept.has(at.span_id); at = byId.get(at.parent_span_id ?? ""))
      chain.push(at.span_id);
    if (kept.size + chain.length <= MAX_SENT_SPANS) for (const id of chain) kept.add(id);
  }
  return ordered.filter((span) => kept.has(span.span_id));
}

function scrubTransaction(event: TransactionEvent): TransactionEvent | null {
  const trace = event.contexts?.trace;
  if (!SENT_ROOTS.has(trace?.op ?? "") || trace?.data?.["sentry.parent_span_already_sent"]) return null;
  delete event.request;
  delete event.user;
  delete event.breadcrumbs;
  scrubData(trace?.data as SpanData | undefined);
  if (event.spans) {
    const spans = orderedSpans(event.spans);
    event.spans = budgetedSpans(spans);
    if (spans.length > event.spans.length)
      trace!.data = { ...trace!.data, "qm.truncated_spans": spans.length - event.spans.length };
  }
  for (const span of event.spans ?? []) {
    const { statement } = scrubData(span.data);
    span.description = scrubDescription(span.op, span.description, statement);
  }
  return scrubTraceContext(event);
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
  return ({ attributes, inheritOrSampleWith }: SamplingContext): number =>
    attributes?.["qm.origin"] === "human" ? 1 : inheritOrSampleWith(rate);
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
            sdk.postgresIntegration(),
          ]
        : []),
    ],
    skipOpenTelemetrySetup: !traced,
    registerEsmLoaderHooks: false,
    ...(traced
      ? {
          tracesSampler: sampler(tracesSampleRate),
          beforeSendTransaction: scrubTransaction,
          beforeSend: scrubTraceContext,
        }
      : {}),
    tracePropagationTargets: traced ? internalTraceTargets(env) : [],
    attachStacktrace: true,
    sendClientReports: false,
    initialScope: { tags: { service, deployment: env.SENTRY_DEPLOYMENT ?? env.ORG_ID ?? env.CORE_ORG_ID } },
    shutdownTimeout: FLUSH_MS,
  });
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

export function nameRequest(method: string, route: string): void {
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
        if (cancelled(result)) span.setStatus({ code: SPAN_STATUS_ERROR, message: "cancelled" });
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
        sdk.setMeasurement(name, Math.max(0, Date.now() - startedMs), "millisecond", root);
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
        measure("time_to_first_token");
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
