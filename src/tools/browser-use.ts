import { sleep } from "../util/async.ts";
import { errMessage, swallow } from "../util/errors.ts";

export interface BrowserUseOutcome {
  status: "completed" | "failed" | "cancelled" | "timed_out";
  result: string | null;
  error: string | null;
  liveViewUrl: string | null;
}

interface BrowserUseSecretBinding {
  alias: string;
  value: string;
  allowedDomains: string[];
}

interface BrowserUseToolSecret {
  envKey: string;
  domains: string[];
}

export interface BrowserUseRunOptions {
  signal?: AbortSignal;
  onLiveView?: (url: string) => void | Promise<void>;
  maxWallMs?: number;
  pollMs?: number;
  fetchImpl?: typeof fetch;
  secretBindings?: BrowserUseSecretBinding[];
}

export type BrowserUseRunner = (
  task: string,
  opts?: Omit<BrowserUseRunOptions, "secretBindings"> & { secrets?: BrowserUseToolSecret[] },
) => Promise<BrowserUseOutcome>;

const BASE_URL = "https://api.browser-use.com/api/v4";
const DEFAULT_POLL_MS = 3_000;
const DEFAULT_MAX_WALL_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const VALIDATE_TIMEOUT_MS = 5_000;
const MAX_CONSECUTIVE_POLL_FAILURES = 3;
const PENDING_STATUSES = new Set(["queued", "dispatching", "running"]);

async function api(
  fetchImpl: typeof fetch,
  apiKey: string,
  method: "GET" | "POST",
  path: string,
  opts?: { body?: unknown; signal?: AbortSignal; timeoutMs?: number },
): Promise<Record<string, unknown>> {
  const timeout = AbortSignal.timeout(opts?.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const res = await fetchImpl(`${BASE_URL}${path}`, {
    method,
    headers: {
      "X-Browser-Use-API-Key": apiKey,
      ...(opts?.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(opts?.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    signal: opts?.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 500);
    try {
      const parsed = JSON.parse(text) as { detail?: unknown };
      if (typeof parsed.detail === "string") detail = parsed.detail;
    } catch {
      void 0;
    }
    throw new Error(`Browser Use API ${method} ${path} failed (${res.status}): ${detail}`);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

export async function validateBrowserUseKey(apiKey: string, opts?: { fetchImpl?: typeof fetch }): Promise<string | null> {
  try {
    await api(opts?.fetchImpl ?? fetch, apiKey, "GET", "/sessions?limit=1", { timeoutMs: VALIDATE_TIMEOUT_MS });
    return null;
  } catch (error) {
    return errMessage(error);
  }
}

function bindingDomain(raw: string): string {
  const domain = raw.trim().toLowerCase();
  if (!domain || /[\s/:@?#*]/.test(domain) || !/^[^.]+(\.[^.]+)+$/.test(domain)) {
    throw new Error(`secret domains must be bare registrable hostnames like example.com, got: ${raw}`);
  }
  return domain;
}

export function createBrowserUseRunner(
  apiKey: string,
  grantedSecrets?: ReadonlyMap<string, string>,
  hooks?: { onSecretsBound?: (bindings: { alias: string; domains: string[] }[]) => void },
): BrowserUseRunner {
  return async (task, opts) => {
    const { secrets, ...rest } = opts ?? {};
    const secretBindings = (secrets ?? []).map(({ envKey, domains }) => {
      const value = grantedSecrets?.get(envKey);
      if (!value) {
        const available = [...(grantedSecrets?.keys() ?? [])].join(", ") || "(none)";
        throw new Error(
          `no credential is granted under env key ${envKey} on this turn (granted: ${available}); ` +
            "find it with the keychain (list credentials, then mint a grant for your own or send an ask for someone else's) and retry once approved",
        );
      }
      return { alias: envKey, value, allowedDomains: domains.map(bindingDomain) };
    });
    if (!secretBindings.length) return runBrowserUseTask(apiKey, task, rest);
    hooks?.onSecretsBound?.(secretBindings.map(({ alias, allowedDomains }) => ({ alias, domains: allowedDomains })));
    const scrub = (text: string | null): string | null => {
      if (!text) return text;
      let out = text;
      for (const { alias, value } of secretBindings) out = out.split(value).join(`[secret ${alias}]`);
      return out;
    };
    try {
      const outcome = await runBrowserUseTask(apiKey, task, { ...rest, secretBindings });
      return { ...outcome, result: scrub(outcome.result), error: scrub(outcome.error) };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(errMessage(error));
      err.message = scrub(err.message) ?? err.message;
      if (typeof err.stack === "string") err.stack = scrub(err.stack) ?? err.stack;
      throw err;
    }
  };
}

function liveViewUrlOf(events: unknown): string | null {
  const list = (Array.isArray(events) ? events : []) as Array<{ type?: unknown; data?: Record<string, unknown> }>;
  const ready = list.find((event) => event.type === "browser.ready");
  const url = ready?.data?.live_view_url;
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    const trusted =
      parsed.protocol === "https:" &&
      (parsed.hostname === "browser-use.com" || parsed.hostname.endsWith(".browser-use.com"));
    return trusted ? url : null;
  } catch {
    return null;
  }
}

export async function runBrowserUseTask(
  apiKey: string,
  task: string,
  opts?: BrowserUseRunOptions,
): Promise<BrowserUseOutcome> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const pollMs = opts?.pollMs ?? DEFAULT_POLL_MS;
  const deadline = Date.now() + (opts?.maxWallMs ?? DEFAULT_MAX_WALL_MS);
  const signal = opts?.signal;

  const created = await api(fetchImpl, apiKey, "POST", "/runs", {
    body: {
      task,
      ...(opts?.secretBindings?.length
        ? {
            secretBindings: opts.secretBindings.map(({ alias, value, allowedDomains }) => ({
              alias,
              source: { type: "inline", value },
              allowedDomains,
            })),
          }
        : {}),
    },
  });
  const runId = created.id;
  if (typeof runId !== "string" || !runId) throw new Error("Browser Use API returned a run without an id");
  let liveViewUrl: string | null = null;
  let pollFailures = 0;

  const cancel = async (): Promise<void> => {
    try {
      await api(fetchImpl, apiKey, "POST", `/runs/${runId}/cancel`);
    } catch (e) {
      swallow(`browser-use: cancel run ${runId}`, e);
    }
  };

  for (;;) {
    if (signal?.aborted) {
      await cancel();
      return { status: "cancelled", result: null, error: "cancelled by caller", liveViewUrl };
    }
    if (Date.now() > deadline) {
      await cancel();
      return { status: "timed_out", result: null, error: "run exceeded the wall-clock limit and was cancelled", liveViewUrl };
    }
    try {
      const [run, events] = await Promise.all([
        api(fetchImpl, apiKey, "GET", `/runs/${runId}`, { signal }),
        liveViewUrl
          ? Promise.resolve(null)
          : api(fetchImpl, apiKey, "GET", `/runs/${runId}/events?include_output=false`, { signal }),
      ]);
      pollFailures = 0;
      if (!liveViewUrl) {
        const url = liveViewUrlOf(events?.events);
        if (url) {
          liveViewUrl = url;
          await opts?.onLiveView?.(url);
        }
      }
      const status = typeof run.status === "string" ? run.status : "";
      if (!PENDING_STATUSES.has(status)) {
        const terminal = status === "completed" || status === "failed" || status === "cancelled" ? status : "failed";
        let error = typeof run.error === "string" ? run.error : null;
        if (error === null && terminal !== status) {
          error = `Browser Use API reported an unexpected run status: ${status || "(none)"}`;
        }
        return {
          status: terminal,
          result: typeof run.result === "string" ? run.result : null,
          error,
          liveViewUrl,
        };
      }
    } catch (error) {
      if (signal?.aborted) {
        await cancel();
        return { status: "cancelled", result: null, error: "cancelled by caller", liveViewUrl };
      }
      pollFailures += 1;
      if (pollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        await cancel();
        throw error;
      }
    }
    await sleep(pollMs);
  }
}
