import {
  AuthenticationError,
  ConflictError,
  NotFoundError,
  RateLimitError,
  SandboxError,
  ServerError,
  TimeoutError,
  ValidationError,
  resolveConfig,
} from "@superserve/sdk";
import { errMessage } from "../util/errors.ts";
import { getOperationSignal } from "../util/async.ts";

export interface SuperserveCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated?: boolean;
}

export interface SuperserveNetwork {
  allowOut?: string[];
  denyOut?: string[];
}

export type SuperserveSandboxState = "starting" | "active" | "pausing" | "paused" | "resuming" | "failed" | "deleted";

interface SuperserveSandboxSummary {
  id: string;
  name: string;
  status: SuperserveSandboxState;
  metadata: Record<string, string>;
}

export interface SuperserveSandboxInfo extends SuperserveSandboxSummary {
  vcpuCount?: number;
  memoryMib?: number;
  timeoutSeconds?: number;
  autoDeleteAtMs?: number;
  network?: SuperserveNetwork;
}

interface SuperserveRunOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface SuperserveUpdate {
  network?: SuperserveNetwork;
  metadata?: Record<string, string>;
  timeoutSeconds?: number | null;
  autoDeleteSeconds?: number | null;
}

export interface SuperserveSession {
  readonly id: string;
  run(command: string, opts?: SuperserveRunOptions): Promise<SuperserveCommandResult>;
  readFileBytes(absPath: string): Promise<Uint8Array | null>;
  writeFileBytes(absPath: string, data: Uint8Array): Promise<void>;
  update(patch: SuperserveUpdate): Promise<void>;
  pause(): Promise<void>;
  kill(): Promise<void>;
}

export interface SuperserveCreateOptions {
  name: string;
  metadata: Record<string, string>;
  template?: string;
  timeoutSeconds?: number;
  autoDeleteSeconds?: number;
  network?: SuperserveNetwork;
}

export class SuperserveSandboxGoneError extends Error {
  constructor(sandboxId: string, detail: string) {
    super(`superserve sandbox ${sandboxId} is gone: ${detail}`);
    this.name = "SuperserveSandboxGoneError";
  }
}

export interface SuperserveClient {
  create(opts: SuperserveCreateOptions): Promise<SuperserveSession>;
  connect(sandboxId: string): Promise<SuperserveSession>;
  update(sandboxId: string, patch: SuperserveUpdate): Promise<void>;
  info(sandboxId: string, scopeMetadata?: Record<string, string>): Promise<SuperserveSandboxInfo>;
  list(metadata: Record<string, string>): Promise<SuperserveSandboxSummary[]>;
  kill(sandboxId: string): Promise<void>;
}

export interface SdkSuperserveClientOptions {
  apiKey: string;
  baseUrl?: string;
  template?: string;
  maxCommandMs?: number;
}

const DEFAULT_MAX_COMMAND_MS = 3600_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export const clampUtf8 = (text: string, maxBytes: number): string => {
  if (maxBytes <= 0) return "";
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return encoded.subarray(0, end).toString("utf8");
};
const GONE_STATES: ReadonlySet<string> = new Set(["deleted", "failed"]);

function hasStatus(err: unknown, statusCode: number): boolean {
  return typeof err === "object" && err !== null && (err as { statusCode?: unknown }).statusCode === statusCode;
}

function isGoneError(err: unknown): boolean {
  return hasStatus(err, 404) || hasStatus(err, 410);
}

interface SuperserveWireInfo {
  id: string;
  name?: string;
  status: SuperserveSandboxState;
  created_at: string;
  metadata?: Record<string, string>;
  access_token?: string;
  vcpu_count?: number;
  memory_mib?: number;
  timeout_seconds?: number | null;
  auto_delete_at?: string;
  network?: { allow_out?: string[]; deny_out?: string[] };
}

export function createSdkSuperserveClient(opts: SdkSuperserveClientOptions): SuperserveClient {
  const config = resolveConfig(opts);
  const maxCommandMs = opts.maxCommandMs ?? DEFAULT_MAX_COMMAND_MS;
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const headers = { "X-API-Key": config.apiKey };
  const sandboxPath = (id: string) => `/sandboxes/${encodeURIComponent(id)}`;

  async function request<T>(
    url: string,
    init: RequestInit,
    read: (response: Response) => Promise<T>,
    timeoutMs = 30_000,
  ): Promise<T> {
    const operation = getOperationSignal();
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = operation ? AbortSignal.any([operation, deadline]) : deadline;
    signal.throwIfAborted();
    try {
      const response = await fetch(url, { ...init, signal });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string; code?: string };
        } | null;
        signal.throwIfAborted();
        const message = body?.error?.message ?? `API error (${response.status})`;
        const code = body?.error?.code;
        switch (response.status) {
          case 400:
            throw new ValidationError(message, code);
          case 401:
          case 403:
            throw new AuthenticationError(message, code, response.status);
          case 404:
            throw new NotFoundError(message, code);
          case 409:
            throw new ConflictError(message, code);
          case 429:
            throw new RateLimitError(message, code);
          default:
            if (response.status >= 500) throw new ServerError(message, code, response.status);
            throw new SandboxError(message, response.status, code);
        }
      }
      const value = await read(response);
      signal.throwIfAborted();
      return value;
    } catch (error) {
      operation?.throwIfAborted();
      if (deadline.aborted) throw new TimeoutError(`Request timed out after ${timeoutMs}ms`);
      if (error instanceof SandboxError) throw error;
      throw new SandboxError(`Network error: ${errMessage(error)}`, undefined, undefined, { cause: error });
    }
  }

  const json = async <T>(response: Response): Promise<T> => {
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  };
  const control = <T>(method: string, path: string, body?: unknown): Promise<T> =>
    request(
      `${baseUrl}${path}`,
      {
        method,
        headers: { ...headers, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      json<T>,
    );

  const toInfo = (raw: SuperserveWireInfo): SuperserveSandboxInfo => {
    if (!raw.id || !raw.status || !raw.created_at)
      throw new SandboxError("Invalid API response: missing sandbox identity");
    return {
      id: raw.id,
      name: raw.name ?? "",
      status: raw.status,
      metadata: raw.metadata ?? {},
      vcpuCount: raw.vcpu_count ?? 0,
      memoryMib: raw.memory_mib ?? 0,
      ...(raw.timeout_seconds == null ? {} : { timeoutSeconds: raw.timeout_seconds }),
      ...(raw.auto_delete_at ? { autoDeleteAtMs: new Date(raw.auto_delete_at).getTime() } : {}),
      ...(raw.network ? { network: { allowOut: raw.network.allow_out, denyOut: raw.network.deny_out } } : {}),
    };
  };
  const updateBody = (patch: SuperserveUpdate) => ({
    ...(patch.metadata === undefined ? {} : { metadata: patch.metadata }),
    ...(patch.timeoutSeconds === undefined ? {} : { timeout_seconds: patch.timeoutSeconds }),
    ...(patch.autoDeleteSeconds === undefined ? {} : { auto_delete_seconds: patch.autoDeleteSeconds }),
    ...(patch.network ? { network: { allow_out: patch.network.allowOut, deny_out: patch.network.denyOut } } : {}),
  });
  const gone = (id: string, error: unknown): never => {
    throw new SuperserveSandboxGoneError(id, errMessage(error));
  };
  const existing = async <T>(id: string, work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (isGoneError(error)) gone(id, error);
      throw error;
    }
  };
  const kill = async (id: string): Promise<void> => {
    try {
      await control("DELETE", sandboxPath(id));
    } catch (error) {
      if (!isGoneError(error)) throw error;
    }
  };
  const update = (id: string, patch: SuperserveUpdate): Promise<void> =>
    existing(id, () => control("PATCH", sandboxPath(id), updateBody(patch)));
  const list = async (metadata: Record<string, string>): Promise<SuperserveSandboxInfo[]> => {
    const query = new URLSearchParams(
      Object.entries(metadata).map(([key, value]): [string, string] => [`metadata.${key}`, value]),
    );
    return (await control<SuperserveWireInfo[]>("GET", `/sandboxes${query.size ? `?${query}` : ""}`)).map(toInfo);
  };

  const wrap = (raw: SuperserveWireInfo): SuperserveSession => {
    const info = toInfo(raw);
    if (!raw.access_token) throw new SandboxError("Invalid API response: missing access_token");
    let token = raw.access_token;
    let refreshing: Promise<void> | undefined;
    const sharedHost = ["sandbox.superserve.ai", "staging-sandbox.superserve.ai", "usw-sandbox.superserve.ai"].includes(
      config.sandboxHost.toLowerCase(),
    );
    const dataUrl = `https://${sharedHost ? "" : `boxd-${info.id}.`}${config.sandboxHost.toLowerCase()}`;
    const routing: Record<string, string> = sharedHost ? { "X-Superserve-Sandbox-Id": info.id } : {};
    const refresh = (): Promise<void> =>
      (refreshing ??= control<SuperserveWireInfo>("POST", `${sandboxPath(info.id)}/activate`)
        .then((next) => {
          if (!next.access_token) throw new SandboxError("Invalid activate response: missing access_token");
          token = next.access_token;
        })
        .finally(() => {
          refreshing = undefined;
        }));
    async function data<T>(
      path: string,
      init: RequestInit,
      read: (response: Response) => Promise<T>,
      timeoutMs?: number,
    ): Promise<T> {
      const send = () =>
        request(
          `${dataUrl}${path}`,
          {
            ...init,
            headers: { ...routing, "X-Access-Token": token, ...init.headers },
          },
          read,
          timeoutMs,
        );
      try {
        return await send();
      } catch (error) {
        if (!(error instanceof AuthenticationError) && !(error instanceof ServerError && error.statusCode === 503))
          throw error;
        await refresh();
        return send();
      }
    }
    const filePath = (path: string): string => {
      if (!path.startsWith("/")) throw new ValidationError(`Path must start with "/": ${path}`);
      if (path.split("/").includes("..")) throw new ValidationError(`Path must not contain ".." segments: ${path}`);
      return `/files?path=${encodeURIComponent(path)}`;
    };
    return {
      id: info.id,
      async run(command, runOpts) {
        const timeoutMs = runOpts?.timeoutMs ?? maxCommandMs;
        const cap = runOpts?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
        return existing(info.id, () =>
          data(
            "/exec/stream",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ command, timeout_s: Math.ceil(timeoutMs / 1000) }),
            },
            async (response) => {
              if (!response.body) throw new SandboxError("Expected streaming response but got empty body");
              let stdout = "",
                stderr = "",
                pending = "";
              let exitCode = 0,
                finished = false,
                stdoutTruncated = false,
                stderrTruncated = false;
              const decoder = new TextDecoder();
              const event = (line: string) => {
                if (!line.startsWith("data:")) return;
                const text = line.slice(5).trim();
                if (!text || text === "[DONE]") return;
                let value: { stdout?: string; stderr?: string; finished?: boolean; exit_code?: number; error?: string };
                try {
                  value = JSON.parse(text);
                } catch {
                  return;
                }
                if (!stdoutTruncated) {
                  const out = stdout + (value.stdout ?? "");
                  stdoutTruncated = Buffer.byteLength(out) > cap;
                  stdout = clampUtf8(out, cap);
                }
                if (!stderrTruncated) {
                  const err = stderr + (value.stderr ?? "") + (value.finished ? (value.error ?? "") : "");
                  stderrTruncated = Buffer.byteLength(err) > cap;
                  stderr = clampUtf8(err, cap);
                }
                if (value.finished) {
                  finished = true;
                  exitCode = value.exit_code ?? 0;
                }
              };
              for await (const chunk of response.body) {
                pending += decoder.decode(chunk, { stream: true });
                const lines = pending.split("\n");
                pending = lines.pop() ?? "";
                for (const line of lines) event(line);
              }
              event(pending + decoder.decode());
              if (!finished)
                throw new SandboxError("Command stream ended without a finished event (possible network disconnect)");
              return { stdout, stderr, exitCode, ...(stdoutTruncated || stderrTruncated ? { truncated: true } : {}) };
            },
            timeoutMs + 5_000,
          ),
        );
      },
      async readFileBytes(path) {
        try {
          return await data(filePath(path), { method: "GET" }, async (response) => {
            const parts: Uint8Array[] = [];
            let size = 0;
            if (response.body)
              for await (const chunk of response.body) {
                size += chunk.byteLength;
                if (size > 2 * 1024 ** 3) throw new ValidationError("Response body exceeds the maximum size");
                parts.push(chunk);
              }
            return new Uint8Array(Buffer.concat(parts));
          });
        } catch (error) {
          if (hasStatus(error, 404)) {
            const current = await existing(info.id, () => control<SuperserveWireInfo>("GET", sandboxPath(info.id)));
            if (GONE_STATES.has(current.status)) gone(info.id, error);
            return null;
          }
          if (isGoneError(error)) gone(info.id, error);
          throw error;
        }
      },
      writeFileBytes: (path, bytes) =>
        existing(info.id, () =>
          data(
            filePath(path),
            {
              method: "POST",
              headers: { "Content-Type": "application/octet-stream" },
              body: Buffer.from(bytes),
            },
            async (response) => {
              await response.arrayBuffer();
            },
          ),
        ),
      update: (patch) => update(info.id, patch),
      pause: () => existing(info.id, () => control("POST", `${sandboxPath(info.id)}/pause`)),
      kill: () => kill(info.id),
    };
  };
  return {
    async create(options) {
      return wrap(
        await control<SuperserveWireInfo>("POST", "/sandboxes", {
          ...updateBody(options),
          name: options.name,
          preview_access: "private",
          ...((options.template ?? opts.template) ? { from_template: options.template ?? opts.template } : {}),
        }),
      );
    },
    connect: (id) =>
      existing(id, async () => wrap(await control<SuperserveWireInfo>("POST", `${sandboxPath(id)}/activate`))),
    update,
    async info(id, metadata) {
      const found = (await list(metadata ?? {})).find((entry) => entry.id === id);
      if (!found || GONE_STATES.has(found.status)) throw new SuperserveSandboxGoneError(id, "not listed");
      return found;
    },
    list: async (metadata) => (await list(metadata)).filter((entry) => !GONE_STATES.has(entry.status)),
    kill,
  };
}
