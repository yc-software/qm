import type * as Browser from "@sentry/browser";
import type { init, ErrorEvent, StackFrame } from "@sentry/browser";
import type { Me } from "./shell-state";
import { parseDeepLink, UI_BASE } from "./deep-link.ts";
import {
  finishTiming,
  sanitizeTransactionEvent,
  traceStatus,
  type TimingResult,
  type TransactionEvent,
} from "../../chassis/src/timing.ts";

const ERROR_TYPES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "AggregateError",
  "UnhandledRejection",
]);
const MAX_TIMINGS_PER_PAGE = 200;
const API_RESOURCES = new Set([
  "approvals",
  "blobs",
  "channel-header-pin",
  "composio",
  "connectors",
  "contexts",
  "crons",
  "deliveries",
  "deployments",
  "directory",
  "files",
  "inbox",
  "keychain",
  "loops",
  "memory",
  "playgrounds",
  "projects",
  "resources",
  "runs",
  "runtime-config",
  "scope-resources",
  "search",
  "sessions",
  "skills",
  "slack-installation",
  "suggested-activities",
  "surface-config",
  "turn",
  "ui-state",
  "user-model-auth",
  "webhooks",
]);
let client: ReturnType<typeof init>;
let sdk: typeof Browser | undefined;
let generation = 0;
let timingBudget = 0;
let largestContentfulPaint: number | undefined;
let pageLoadReported = false;

function safeFrame(frame: StackFrame, origin: string): StackFrame[] {
  try {
    const url = new URL(frame.filename ?? "", origin);
    const filename = url.pathname.match(/\/assets\/([a-zA-Z0-9_-]{1,100}-[a-zA-Z0-9_-]{8}\.js)$/)?.[1];
    if (url.origin !== origin || !filename) return [];
    const position = (value: number | undefined) => (Number.isSafeInteger(value) && value! > 0 ? value : undefined);
    return [{ filename, lineno: position(frame.lineno), colno: position(frame.colno), in_app: true }];
  } catch {
    return [];
  }
}

export function sanitizeBrowserError(event: ErrorEvent, origin: string, release?: string): ErrorEvent {
  const sanitized: ErrorEvent = {
    type: undefined,
    event_id: /^[a-f0-9]{32}$/.test(event.event_id ?? "") ? event.event_id : undefined,
    timestamp: Number.isFinite(event.timestamp) ? event.timestamp : undefined,
    platform: "javascript",
    level: "error",
    release,
    tags: { service: "web-ui-browser" },
    exception: {
      values: (event.exception?.values?.slice(-5) ?? [{}]).map((exception) => ({
        type: ERROR_TYPES.has(exception.type ?? "") ? exception.type : "Error",
        value: "Browser error; details omitted",
        stacktrace: {
          frames: exception.stacktrace?.frames?.slice(-50).flatMap((frame) => safeFrame(frame, origin)) ?? [],
        },
        mechanism: {
          handled: false,
          type:
            exception.mechanism?.type === "auto.browser.global_handlers.onunhandledrejection"
              ? "onunhandledrejection"
              : "onerror",
        },
      })),
    },
  };
  sanitized.fingerprint = [
    "web-ui-browser-v1",
    ...(sanitized.exception?.values ?? []).flatMap((exception) => {
      const frame = exception.stacktrace?.frames?.at(-1);
      return [
        exception.type ?? "Error",
        exception.mechanism?.type ?? "onerror",
        frame ? `${frame.filename}:${frame.lineno ?? 0}:${frame.colno ?? 0}` : "no-app-frame",
      ];
    }),
  ];
  return sanitized;
}

function timing(op: string, name: string, startMs: number, result: TimingResult): void {
  if (!client || !sdk || timingBudget <= 0) return;
  timingBudget--;
  try {
    sdk.getCurrentScope().setPropagationContext({ traceId: hex(16), sampleRand: Math.random() });
    const span = sdk.startInactiveSpan({ op, name, startTime: startMs, attributes: { "sentry.source": "route" } });
    finishTiming(sdk, span, result);
  } catch {
    return;
  }
}

function hex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function apiRouteName(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  const api = segments.indexOf("api");
  const resource = segments[api + 1];
  if (api < 0 || !resource || !API_RESOURCES.has(resource)) return "/*";
  return `/api/${resource}${segments.length > api + 2 ? "/*" : ""}`;
}

export function reportRequestTiming(url: string, method: string, startMs: number, status: number | null): void {
  if (!client) return;
  let target: URL;
  try {
    target = new URL(url, window.location.origin);
  } catch {
    return;
  }
  if (target.origin !== window.location.origin) return;
  timing("http.client", `${/^[A-Z]{3,7}$/.test(method) ? method : "GET"} ${apiRouteName(target.pathname)}`, startMs, {
    status: status === null ? "internal_error" : traceStatus(status),
    data: { http_status: status === null ? "network" : String(status) },
  });
}

function reportPageLoad(): void {
  try {
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    if (!navigation?.loadEventEnd) return;
    const paint = (name: string) => performance.getEntriesByName(name)[0]?.startTime;
    const { view } = parseDeepLink(UI_BASE, window.location.pathname, "");
    timing("pageload", "pageload", performance.timeOrigin, {
      status: "ok",
      endMs: performance.timeOrigin + navigation.loadEventEnd,
      data: { page: view ?? "other" },
      measurements: {
        ttfb: navigation.responseStart,
        dom_content_loaded: navigation.domContentLoadedEventEnd,
        load: navigation.loadEventEnd,
        fcp: paint("first-contentful-paint"),
        lcp: largestContentfulPaint,
      },
    });
  } catch {
    return;
  }
}

function startTiming(rate: number): void {
  timingBudget = rate > 0 ? MAX_TIMINGS_PER_PAGE : 0;
  if (!timingBudget || pageLoadReported) return;
  pageLoadReported = true;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) largestContentfulPaint = entry.startTime;
    }).observe({ type: "largest-contentful-paint", buffered: true });
  } catch {
    largestContentfulPaint = undefined;
  }
  try {
    const report = () => setTimeout(reportPageLoad, 500);
    if (document.readyState === "complete") report();
    else window.addEventListener("load", report, { once: true });
  } catch {
    return;
  }
}

export function stopBrowserErrors(): void {
  generation++;
  timingBudget = 0;
  if (client) client.getOptions().enabled = false;
  client = undefined;
}

export async function initializeBrowserErrors(me: Me): Promise<void> {
  stopBrowserErrors();
  if (!me.browserErrors?.dsn || me.impersonatedBy) return;
  const current = generation;
  const { dsn, release, tracesSampleRate } = me.browserErrors;
  const rate = tracesSampleRate && tracesSampleRate > 0 && tracesSampleRate <= 1 ? tracesSampleRate : 0;
  try {
    const browser = await import("@sentry/browser");
    if (current !== generation) return;
    sdk = browser;
    const safeEvents = new WeakSet<ErrorEvent | TransactionEvent>();
    client = browser.init({
      dsn,
      release,
      defaultIntegrations: false,
      integrations: [browser.globalHandlersIntegration()],
      sendDefaultPii: false,
      maxBreadcrumbs: 0,
      attachStacktrace: true,
      sendClientReports: false,
      enableLogs: false,
      tracesSampleRate: rate,
      tracePropagationTargets: [],
      transportOptions: { fetchOptions: { credentials: "omit", referrerPolicy: "no-referrer" } },
      transport: (options) => {
        const transport = browser.makeFetchTransport(options);
        return {
          flush: (timeout) => transport.flush(timeout),
          send: (envelope) => {
            const [item] = envelope[1];
            if (
              current !== generation ||
              envelope[1].length !== 1 ||
              (item?.[0].type !== "event" && item?.[0].type !== "transaction") ||
              !safeEvents.has(item[1] as ErrorEvent | TransactionEvent)
            )
              return Promise.resolve({});
            return transport.send(envelope);
          },
        };
      },
      beforeSend: (event, hint) => {
        if (current !== generation) return null;
        hint.attachments = [];
        const sanitized = sanitizeBrowserError(event, window.location.origin, release);
        safeEvents.add(sanitized);
        return sanitized;
      },
      beforeSendTransaction: (event) => {
        if (current !== generation) return null;
        const sanitized = sanitizeTransactionEvent(event, "javascript");
        if (sanitized) safeEvents.add(sanitized);
        return sanitized;
      },
    });
  } catch {
    if (current === generation) client = undefined;
  }
  if (client) startTiming(rate);
}
