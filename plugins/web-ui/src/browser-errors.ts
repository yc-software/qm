import type { init, ErrorEvent, StackFrame } from "@sentry/browser";
import type { Me } from "./shell-state";

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
let client: ReturnType<typeof init>;
let generation = 0;

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

export function stopBrowserErrors(): void {
  generation++;
  if (client) client.getOptions().enabled = false;
  client = undefined;
}

export async function initializeBrowserErrors(me: Me): Promise<void> {
  stopBrowserErrors();
  if (!me.browserErrors?.dsn || me.impersonatedBy) return;
  const current = generation;
  const { dsn, release } = me.browserErrors;
  try {
    const sdk = await import("@sentry/browser");
    if (current !== generation) return;
    const safeEvents = new WeakSet<ErrorEvent>();
    client = sdk.init({
      dsn,
      release,
      defaultIntegrations: false,
      integrations: [sdk.globalHandlersIntegration()],
      sendDefaultPii: false,
      maxBreadcrumbs: 0,
      attachStacktrace: true,
      sendClientReports: false,
      enableLogs: false,
      tracesSampleRate: 0,
      tracePropagationTargets: [],
      transportOptions: { fetchOptions: { credentials: "omit", referrerPolicy: "no-referrer" } },
      transport: (options) => {
        const transport = sdk.makeFetchTransport(options);
        return {
          flush: (timeout) => transport.flush(timeout),
          send: (envelope) => {
            const [item] = envelope[1];
            if (
              current !== generation ||
              envelope[1].length !== 1 ||
              item?.[0].type !== "event" ||
              !safeEvents.has(item[1] as ErrorEvent)
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
    });
  } catch {
    if (current === generation) client = undefined;
  }
}
