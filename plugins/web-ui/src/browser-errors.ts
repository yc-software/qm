import type * as Browser from "@sentry/browser";
import type { init } from "@sentry/browser";
import type { Me } from "./shell-state";
import { parseDeepLink, UI_BASE } from "./deep-link.ts";
import { finishTiming, traceStatus, type TimingResult } from "../../chassis/src/timing.ts";
import { errDetail, swallow } from "../../chassis/src/errors.ts";

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
    data: { url: target.href, http_status: status === null ? "network" : String(status) },
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
      data: { page: view ?? "other", url: navigation.name },
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

export function reportHandledError(context: string, error: unknown): void {
  console.warn(`[handled] ${context}: ${errDetail(error)}`);
  if (!client || !sdk) return;
  sdk.captureException(error, { tags: { error_code: context }, fingerprint: ["{{ default }}", context] });
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
    client = browser.init({
      dsn,
      release,
      defaultIntegrations: false,
      integrations: [
        browser.globalHandlersIntegration(),
        browser.linkedErrorsIntegration(),
        browser.extraErrorDataIntegration({ depth: 8 }),
      ],
      attachStacktrace: true,
      sendClientReports: false,
      enableLogs: false,
      tracesSampleRate: rate,
      tracePropagationTargets: [],
      initialScope: { tags: { service: "web-ui-browser", org: me.org }, user: { username: me.user } },
      beforeSend: (event, hint) => {
        const error = hint.originalException;
        return current !== generation ||
          (error instanceof Error &&
            (error.name === "AbortError" ||
              (error.name === "TypeError" &&
                ["Failed to fetch", "NetworkError when attempting to fetch resource.", "Load failed"].includes(
                  error.message,
                ))))
          ? null
          : event;
      },
      beforeSendTransaction: (event) => (current === generation ? event : null),
    });
  } catch (error) {
    swallow("browser error reporting initialization", error);
    if (current === generation) client = undefined;
  }
  if (client) startTiming(rate);
}
