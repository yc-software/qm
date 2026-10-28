import { CliError, errMessage } from "./log.ts";
import { sleep } from "./util.ts";

export type ServiceType = "web_service" | "private_service";
export interface RenderService {
  id: string;
  name: string;
  type: ServiceType;
  ownerId: string;
  environmentId: string;
  slug: string;
  imagePath?: string;
  repo?: string;
  branch?: string;
  rootDir?: string;
  autoDeploy: string;
  suspended: string;
  serviceDetails: {
    url?: string;
    region: string;
    plan: string;
    numInstances: number;
    runtime: string;
    healthCheckPath?: string;
    maxShutdownDelaySeconds?: number;
    envSpecificDetails: { dockerCommand?: string; dockerfilePath?: string; dockerContext?: string };
    disk?: { id: string; mountPath: string; sizeGB: number };
  };
}
export type RenderRequest = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
export interface RenderLog {
  timestamp: string;
  message: string;
}
export class RenderApiError extends CliError {
  readonly status: number;
  constructor(status: number, path: string, method: string, detail: string, requestId: string | null) {
    super(
      `Render ${method} ${path.split("?")[0]} failed (HTTP ${status})${detail ? `: ${detail}` : ""}${requestId ? ` [request id ${requestId}]` : ""}`,
    );
    this.status = status;
  }
  get rejected(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429;
  }
}
const RENDER_ATTEMPTS = 4;
const RENDER_TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);
function retryDelayMs(attempt: number, response?: Response): number {
  const raw = response?.headers.get("retry-after")?.trim();
  if (raw) {
    const seconds = Number(raw);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Math.max(0, Date.parse(raw) - Date.now());
    if (Number.isFinite(delay) && delay >= 0) return Math.min(delay, 30_000);
  }
  return Math.round(Math.min(8_000, 500 * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2));
}
export function renderClient(apiKey: string): RenderRequest {
  return async <T>(path: string, method = "GET", body?: unknown): Promise<T> => {
    const idempotent = method !== "POST";
    let attempt = 1;
    let response: Response;
    for (; ; attempt++) {
      try {
        response = await fetch(`https://api.render.com/v1${path}`, {
          method,
          headers: {
            authorization: `Bearer ${apiKey}`,
            accept: "application/json",
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(60_000),
          redirect: "error",
        });
      } catch (error) {
        if (!idempotent || attempt >= RENDER_ATTEMPTS) throw error;
        await sleep(retryDelayMs(attempt));
        continue;
      }
      const transient = response.status === 429 || (idempotent && RENDER_TRANSIENT_STATUSES.has(response.status));
      if (!transient || attempt >= RENDER_ATTEMPTS) break;
      await response.body?.cancel().catch(() => undefined);
      await sleep(retryDelayMs(attempt, response));
    }
    if (method === "DELETE" && attempt > 1 && response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return undefined as T;
    }
    if (!response.ok)
      throw new RenderApiError(
        response.status,
        path,
        method,
        (await response.text().catch(() => "")).slice(0, 200),
        response.headers.get("render-request-id"),
      );
    const text = await response.text();
    if (!text) return undefined as T;
    return (response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text) as T;
  };
}
export async function streamRenderLogs(
  apiKey: string,
  query: URLSearchParams,
  onLog: (log: RenderLog) => void,
): Promise<void> {
  const socket = new WebSocket(`wss://api.render.com/v1/logs/subscribe?${query}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  socket.binaryType = "arraybuffer";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((_, reject) => {
      timer = setTimeout(() => reject(new CliError("Render log subscription did not connect in 60 seconds")), 60_000);
      socket.addEventListener("open", () => clearTimeout(timer));
      socket.addEventListener("message", (event) => {
        try {
          const log = JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data));
          if (!log || typeof log.timestamp !== "string" || typeof log.message !== "string")
            throw new CliError("Render log subscription returned an invalid log");
          onLog(log);
        } catch (error) {
          reject(error);
        }
      });
      socket.addEventListener("error", (event) => {
        reject(
          new CliError(`Render log subscription failed: ${errMessage(event.error ?? event.message)}`, {
            cause: event.error,
          }),
        );
      });
      socket.addEventListener("close", (event) => {
        reject(
          new CliError(`Render log subscription closed (${event.code})${event.reason ? `: ${event.reason}` : ""}`),
        );
      });
    });
  } finally {
    clearTimeout(timer);
    socket.close();
  }
}
export async function requestArray<T>(request: RenderRequest, path: string): Promise<T[]> {
  const page = await request<unknown>(path);
  if (page === null) return [];
  if (!Array.isArray(page)) throw new CliError(`Render GET ${path.split("?")[0]} returned an invalid list response`);
  return page as T[];
}
export async function list<T>(request: RenderRequest, path: string, key: string): Promise<T[]> {
  const out: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const url = new URL(path, "https://api.render.com");
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const page = await requestArray<Record<string, unknown>>(request, `${url.pathname}${url.search}`);
    out.push(...page.map((item) => item[key] as T));
    if (page.length < 100) return out;
    const next = page.at(-1)?.cursor;
    if (typeof next !== "string" || seen.has(next)) throw new CliError("Render pagination did not advance");
    seen.add(next);
    cursor = next;
  }
}
