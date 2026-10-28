import { fetchWithRetry } from "../util/async.ts";
import { httpFailure } from "../util/errors.ts";

const REQUEST_TIMEOUT_MS = 60_000;

export class RenderApiError extends Error {
  readonly status: number;

  constructor(method: string, path: string, status: number, detail = `http ${status}`) {
    super(`Render ${method} ${path.split("?")[0]}: ${detail}`);
    this.status = status;
  }

  get rejected(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429;
  }
}

export interface RenderApi {
  request<T>(method: string, path: string, body?: unknown, allowMissing?: boolean): Promise<T | null>;
}

export async function list<T>(
  api: RenderApi,
  path: string,
  key: string,
  query: Record<string, string> = {},
): Promise<T[]> {
  const rows: T[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const params = new URLSearchParams({ ...query, limit: "100", ...(cursor ? { cursor } : {}) });
    const page = await api.request<Array<Record<string, unknown> & { cursor?: string }>>("GET", `${path}?${params}`);
    if (!Array.isArray(page)) throw new Error(`Render returned an invalid ${key} list`);
    rows.push(...page.map((row) => row[key] as T));
    if (page.length < 100) return rows;
    cursor = page.at(-1)?.cursor;
    if (!cursor || cursors.has(cursor)) throw new Error(`Render ${key} pagination did not advance`);
    cursors.add(cursor);
  }
}

export function createRenderApi(opts: { apiKey: string; fetchImpl?: typeof fetch }): RenderApi {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    async request<T>(method: string, path: string, body?: unknown, allowMissing = false): Promise<T | null> {
      const response = await fetchWithRetry(
        (signal) =>
          fetchImpl(`https://api.render.com/v1${path}`, {
            method,
            headers: {
              authorization: `Bearer ${opts.apiKey}`,
              ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            redirect: "error",
            signal,
          }),
        method === "POST" ? "refused" : "idempotent",
        { timeoutMs: REQUEST_TIMEOUT_MS },
      );
      if (allowMissing && response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      if (!response.ok) throw new RenderApiError(method, path, response.status, await httpFailure(response));
      const text = await response.text();
      return text ? (JSON.parse(text) as T) : null;
    },
  };
}
