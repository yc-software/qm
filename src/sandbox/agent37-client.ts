import { randomUUID } from "node:crypto";
import { fetchWithRetry, sleep } from "../util/async.ts";
import { swallowAs, withRequestId } from "../util/errors.ts";
import { shq } from "../util/shell.ts";

const DEFAULT_BASE_URL = "https://api.agent37.com";
const WRITE_CHUNK_B64 = 64 * 1024;
const START_TIMEOUT_MS = 830_000;
const READY_TIMEOUT_MS = 300_000;
const READY_POLL_MS = 2_000;
export const AGENT37_GONE_STATES: ReadonlySet<string> = new Set(["deleting", "deleted"]);
const DEAD_STATES = new Set(["failed", ...AGENT37_GONE_STATES]);
const STARTABLE_STATES = new Set(["stopped", "sleeping"]);

export interface Agent37ExecResponse {
  exit_code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

interface Agent37ClientOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  errorPrefix?: string;
  refusalError?: (body: string) => Error | null;
}

export function createAgent37Client(opts: Agent37ClientOptions) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const errorPrefix = opts.errorPrefix ?? "agent37";

  function send(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 60_000,
    signal?: AbortSignal,
  ): Promise<Response> {
    return fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${opts.apiKey ?? ""}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    });
  }

  function api(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<Response> {
    const operation = (signal?: AbortSignal) => send(method, path, body, timeoutMs, signal);
    return method === "GET" || method === "DELETE"
      ? fetchWithRetry(operation, "idempotent", { timeoutMs })
      : operation();
  }

  async function apiFailure(action: string, res: Response): Promise<{ detail: string; error: Error }> {
    const body = await res.text().catch(() => "");
    const detail = withRequestId(`http ${res.status} ${body.slice(0, 200)}`, res.headers);
    return {
      detail,
      error: opts.refusalError?.(body) ?? new Error(`${errorPrefix} ${action}: ${detail}`),
    };
  }

  async function fail(action: string, res: Response): Promise<Error> {
    return (await apiFailure(action, res)).error;
  }

  async function apiJson<T>(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
    const res = await api(method, path, body, timeoutMs);
    if (!res.ok) throw await fail(`${method} ${path}`, res);
    return (await res.json()) as T;
  }

  async function readExecResponse(name: string, res: Response): Promise<Agent37ExecResponse> {
    if (!res.ok) throw await fail(`exec ${name}`, res);
    const parsed = (await res.json()) as Agent37ExecResponse;
    if (parsed.truncated) {
      throw new Error(`${errorPrefix} exec ${name}: output truncated by the API: chunk the read instead`);
    }
    return parsed;
  }

  async function ensureRunning(id: string): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      const info = await apiJson<{ status: string }>("GET", `/v1/instances/${encodeURIComponent(id)}`);
      if (info.status === "running") return;
      if (DEAD_STATES.has(info.status)) throw new Error(`${errorPrefix} instance ${id}: ${info.status}`);
      if (Date.now() > deadline) {
        throw new Error(
          `${errorPrefix} instance ${id}: not running after ${READY_TIMEOUT_MS}ms (status=${info.status})`,
        );
      }
      if (STARTABLE_STATES.has(info.status)) {
        const res = await api("POST", `/v1/instances/${encodeURIComponent(id)}/start`, undefined, START_TIMEOUT_MS);
        if (res.ok) continue;
        if (res.status !== 400 && res.status !== 409) throw await fail(`start ${id}`, res);
      }
      await sleep(READY_POLL_MS);
    }
  }

  return { send, api, apiJson, apiFailure, fail, readExecResponse, ensureRunning };
}

export function createAgent37FileWriter(
  exec: (name: string, script: string, timeoutSec: number) => Promise<Agent37ExecResponse>,
  errorPrefix = "agent37",
): (name: string, absPath: string, data: Uint8Array) => Promise<void> {
  return async (name, absPath, data) => {
    const part = `${absPath}.${randomUUID().slice(0, 8)}.part`;
    const b64 = Buffer.from(data).toString("base64");
    const mk = await exec(name, `mkdir -p "$(dirname ${shq(absPath)})" && : > ${shq(part)}`, 60);
    if (mk.exit_code !== 0) {
      throw new Error(
        `${errorPrefix} write ${absPath}: mkdir failed (${mk.exit_code}): ${(mk.stderr || mk.stdout).slice(0, 300)}`,
      );
    }
    try {
      for (let i = 0; i < b64.length; i += WRITE_CHUNK_B64) {
        const chunk = b64.slice(i, i + WRITE_CHUNK_B64);
        const r = await exec(name, `printf %s ${shq(chunk)} | base64 -d >> ${shq(part)}`, 120);
        if (r.exit_code !== 0) {
          throw new Error(
            `${errorPrefix} write ${absPath}: chunk ${i / WRITE_CHUNK_B64} failed (${r.exit_code}): ${(r.stderr || r.stdout).slice(0, 300)}`,
          );
        }
      }
      const fin = await exec(
        name,
        `sz=$(wc -c < ${shq(part)}) && mv -f ${shq(part)} ${shq(absPath)} && printf %s "$sz"`,
        60,
      );
      const written = Number.parseInt(fin.stdout.trim(), 10);
      if (fin.exit_code !== 0 || written !== data.length) {
        throw new Error(
          `${errorPrefix} write ${absPath} failed (rc=${fin.exit_code}, ${written}/${data.length} bytes): ${(fin.stderr || fin.stdout).slice(0, 300)}`,
        );
      }
    } catch (e) {
      await exec(name, `rm -f ${shq(part)}`, 60).catch(swallowAs(`${errorPrefix}: write part cleanup`, undefined));
      throw e;
    }
  };
}
