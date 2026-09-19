import {
  AuthenticationError,
  NotFoundError,
  RateLimitError,
  SandboxError,
  SandboxTimeoutError,
  ServerError,
  type StatusResponse,
} from "porter-sandbox";
import { getOperationSignal } from "../util/async.ts";
import { errMessage } from "../util/errors.ts";
import type { PorterClientLike, PorterSandboxLike } from "./porter-client.ts";

export function createPorterTransport(opts: {
  token?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): PorterClientLike {
  const token = opts.token;
  if (!opts.baseUrl) throw new Error("Porter API base URL is missing from resolved configuration");
  const baseUrl = opts.baseUrl.replace(/\/$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: URLSearchParams,
    timeoutMs = 30_000,
  ): Promise<T> {
    const operation = getOperationSignal();
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = operation ? AbortSignal.any([operation, deadline]) : deadline;
    const headers = new Headers({ Accept: "application/json", "User-Agent": "qm-porter-transport" });
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (body !== undefined) headers.set("Content-Type", "application/json");
    let url = new URL(`${baseUrl}${path}`);
    if (query) url.search = query.toString();
    try {
      for (let hop = 0; hop <= 5; hop++) {
        signal.throwIfAborted();
        const response = await fetchImpl(url, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: "manual",
          signal,
        });
        const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
        if (location) {
          await response.body?.cancel();
          const next = new URL(location, url);
          if (next.origin !== url.origin) headers.delete("Authorization");
          url = next;
          continue;
        }
        const text = await response.text();
        signal.throwIfAborted();
        let decoded: unknown = text || null;
        if (text && response.headers.get("content-type")?.includes("application/json")) {
          try {
            decoded = JSON.parse(text);
          } catch {
            decoded = text;
          }
        }
        if (response.ok) return decoded as T;
        let message = `HTTP ${response.status}`;
        if (decoded && typeof decoded === "object" && "error" in decoded && typeof decoded.error === "string")
          message = decoded.error;
        let ErrorType = SandboxError;
        if (response.status === 401) ErrorType = AuthenticationError;
        if (response.status === 404) ErrorType = NotFoundError;
        if (response.status === 429) ErrorType = RateLimitError;
        if (response.status >= 500 && response.status < 600) ErrorType = ServerError;
        throw new ErrorType(message, { statusCode: response.status, body: decoded });
      }
      throw new SandboxError("Too many Porter API redirects");
    } catch (error) {
      operation?.throwIfAborted();
      if (deadline.aborted) throw new SandboxTimeoutError(`request timed out after ${timeoutMs}ms`);
      if (error instanceof SandboxError) throw error;
      throw new SandboxError(`Network error: ${errMessage(error)}`);
    }
  }
  const pathFor = (kind: "sandbox" | "volume", id: string) => `/v1/${kind}/${encodeURIComponent(id)}`;
  const lookup = (kind: "sandbox" | "volume", name: string) =>
    request<{ id: string }>("GET", `/v1/${kind}/lookup`, undefined, new URLSearchParams({ name }));
  const statusFor = (id: string) => request<StatusResponse>("GET", pathFor("sandbox", id));
  const handle = (id: string, initial: StatusResponse | null = null): PorterSandboxLike => {
    let status = initial;
    return {
      id,
      get phase() {
        return status?.phase ?? null;
      },
      get tags() {
        return status?.tags ?? null;
      },
      async refresh() {
        status = await statusFor(id);
        return status;
      },
      terminate: () => request<void>("DELETE", pathFor("sandbox", id)),
    };
  };
  return {
    sandboxes: {
      async create(spec) {
        return handle((await request<{ id: string }>("POST", "/v1/sandbox/run", spec)).id);
      },
      async get(name) {
        const { id } = await lookup("sandbox", name);
        return handle(id, await statusFor(id));
      },
      async list(options) {
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(options?.tags ?? {})) query.append("tag", `${key}=${value}`);
        if (options?.page !== undefined) query.set("page", String(options.page));
        const response = await request<{ sandboxes: StatusResponse[] }>("GET", "/v1/sandbox", undefined, query);
        return response.sandboxes.map((status) => handle(status.id, status));
      },
      raw: {
        get: statusFor,
        exec: (id, body, options) =>
          request("POST", `${pathFor("sandbox", id)}/exec`, body, undefined, options?.timeoutMs),
      },
    },
    volumes: {
      create: (body) => request("POST", "/v1/volume", body),
      async get(name) {
        const { id } = await lookup("volume", name);
        return request("GET", pathFor("volume", id));
      },
      async delete(name) {
        const { id } = await lookup("volume", name);
        await request("DELETE", pathFor("volume", id));
      },
    },
  };
}
