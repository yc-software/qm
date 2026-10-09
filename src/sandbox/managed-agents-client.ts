import { fileURLToPath } from "node:url";
import { fetchWithRetry } from "../util/async.ts";
import { errMessage, withRequestId } from "../util/errors.ts";
import { openManagedAgentsTunnel, SANDBOX_AGENT_PORT, type ManagedAgentsTunnel } from "./managed-agents-tunnel.ts";

export interface ManagedAgentsCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  hitlRejected?: boolean;
}

interface ManagedAgentsRunOpts {
  timeoutMs?: number;
  workdir?: string;
  env?: Record<string, string>;
}

export type ManagedAgentsSessionState =
  "unspecified" | "provisioning" | "ready" | "detached" | "destroying" | "destroyed" | "failed" | "paused";

export interface ManagedAgentsSessionSummary {
  sessionId: string;
  sandboxId: string;
  name: string;
  state: ManagedAgentsSessionState;
}

export interface ManagedAgentsSessionInfo extends ManagedAgentsSessionSummary {
  createdAtMs?: number;
  errorMessage?: string;
  sizeSlug?: string;
  template?: string;
}

export interface ManagedAgentsCheckpoint {
  checkpointId: string;
  status: string;
  createdAtMs?: number;
}

export interface ManagedAgentsSession {
  readonly sessionId: string;
  readonly sandboxId: string;
  runCommand(command: string, opts?: ManagedAgentsRunOpts): Promise<ManagedAgentsCommandResult>;
  readFileBytes(absPath: string): Promise<Uint8Array | null>;
  writeFileBytes(absPath: string, data: Uint8Array): Promise<void>;
  createCheckpoint(label?: string): Promise<ManagedAgentsCheckpoint>;
  deleteCheckpoint(checkpointId: string): Promise<void>;
  close(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  kill(): Promise<void>;
}

export class ManagedAgentsSandboxGoneError extends Error {
  constructor(sessionId: string, detail: string) {
    super(`do-managed-agents session ${sessionId} is gone: ${detail}`);
    this.name = "ManagedAgentsSandboxGoneError";
  }
}

export class ManagedAgentsCommandLostError extends Error {
  constructor(sessionId: string, detail: string) {
    super(
      `do-managed-agents session ${sessionId} was lost while a command was running (${detail}); the command may have partially executed and was not retried`,
    );
    this.name = "ManagedAgentsCommandLostError";
  }
}

export class ManagedAgentsHitlRejectedError extends Error {
  constructor(sessionId: string) {
    super(
      `do-managed-agents rejected a command in session ${sessionId} at its own approval gate; set the session permissions to allow bash so qm's approval gates stay authoritative`,
    );
    this.name = "ManagedAgentsHitlRejectedError";
  }
}

interface ManagedAgentsCreateOpts {
  name: string;
  egressAllow?: string[];
}

export interface ManagedAgentsClient {
  readonly nativePause?: boolean;
  info(sessionId: string): Promise<ManagedAgentsSessionInfo>;
  create(opts: ManagedAgentsCreateOpts): Promise<ManagedAgentsSession>;
  connect(sessionId: string): Promise<ManagedAgentsSession>;
  list(name: string): Promise<ManagedAgentsSessionSummary[]>;
  rollback(sessionId: string, checkpointId: string): Promise<ManagedAgentsSessionInfo>;
  kill(sessionId: string): Promise<void>;
}

export interface SdkManagedAgentsClientOptions {
  apiToken: string;
  apiBaseUrl?: string;
  template?: string;
  agent?: string;
  sizeSlug?: string;
  idleTimeoutSec?: number;
  maxCommandMs?: number;
  stallProbeMs?: number;
  egressProxyUrl?: string;
}

const DEFAULT_API_BASE_URL = "https://api.digitalocean.com";
const DEFAULT_TEMPLATE = "";
const DEFAULT_AGENT = "none";
const DEFAULT_MAX_COMMAND_MS = 3600_000;
const CREATE_TIMEOUT_MS = 120_000;
const CHECKPOINT_TIMEOUT_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 300_000;
const ROLLBACK_TIMEOUT_MS = READY_TIMEOUT_MS;
const READY_POLL_MS = 2_000;
const READY_FAST_POLL_MS = 250;
const READY_FAST_WINDOW_MS = 10_000;
const STALL_PROBE_MS = 45_000;
const READY_TRANSIENT_LIMIT = 5;
const UPLOAD_CHUNK_BYTES = 256 * 1024;
const DOWNLOAD_CHUNK_BYTES = 256 * 1024;
const MAX_EXEC_OUTPUT_BYTES = 16 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 30_000;
const GRPC_NOT_FOUND = 5;
const GRPC_INTERNAL = 13;
const GRPC_UNAVAILABLE = 14;

const PROTO_PATH = fileURLToPath(new URL("./managed-agents-sandbox-agent.proto", import.meta.url));

const STATE_BY_WIRE: Record<string, ManagedAgentsSessionState> = {
  SESSION_STATUS_UNSPECIFIED: "unspecified",
  SESSION_STATUS_PROVISIONING: "provisioning",
  SESSION_STATUS_READY: "ready",
  SESSION_STATUS_DETACHED: "detached",
  SESSION_STATUS_DESTROYING: "destroying",
  SESSION_STATUS_DESTROYED: "destroyed",
  SESSION_STATUS_FAILED: "failed",
  SESSION_STATUS_PAUSED: "paused",
};

const GONE_STATES: ReadonlySet<ManagedAgentsSessionState> = new Set<ManagedAgentsSessionState>([
  "destroying",
  "destroyed",
  "failed",
]);

const USABLE_STATES: ReadonlySet<ManagedAgentsSessionState> = new Set<ManagedAgentsSessionState>(["ready", "detached"]);

export const managedAgentsSessionState = (wire: string | undefined): ManagedAgentsSessionState =>
  STATE_BY_WIRE[wire ?? ""] ?? "unspecified";

export function managedAgentsEgressAllow(egressProxyUrl: string): string[] {
  const host = new URL(egressProxyUrl).hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new Error(`DO_AGENTS_EGRESS_PROXY_URL ${egressProxyUrl} has no host to put on the egress allowlist`);
  return [host];
}

export function managedAgentsManifest(opts: {
  name: string;
  template: string;
  agent?: string;
  sizeSlug?: string;
  idleTimeoutSec?: number;
  egressAllow?: readonly string[];
}): string {
  const lines = [`name: ${JSON.stringify(opts.name)}`, `agent: ${JSON.stringify(opts.agent ?? DEFAULT_AGENT)}`];
  if (opts.template) lines.push(`template: ${JSON.stringify(opts.template)}`);
  if (opts.sizeSlug) lines.push(`size: ${JSON.stringify(opts.sizeSlug)}`);
  if (opts.idleTimeoutSec) lines.push(`idle_timeout: ${JSON.stringify(`${opts.idleTimeoutSec}s`)}`);
  if (opts.egressAllow?.length) {
    lines.push("egress:");
    for (const host of opts.egressAllow) lines.push(`  - ${JSON.stringify(host)}`);
  }
  lines.push("permissions:", "  default: allow", "  rules:", "    - tool: bash", "      action: allow");
  return `${lines.join("\n")}\n`;
}

interface WireSession {
  id?: string;
  session_id?: string;
  sandbox_id?: string;
  name?: string;
  status?: string;
  template?: string;
  size_slug?: string;
  error_message?: string;
  created_at?: string;
}

interface WireCheckpoint {
  checkpoint_id?: string;
  status?: string;
  error_message?: string;
  created_at?: string;
}

const toSummary = (s: WireSession): ManagedAgentsSessionSummary => ({
  sessionId: s.session_id ?? s.id ?? "",
  sandboxId: s.sandbox_id ?? "",
  name: s.name ?? "",
  state: managedAgentsSessionState(s.status),
});

const toInfo = (s: WireSession): ManagedAgentsSessionInfo => {
  const createdAtMs = s.created_at ? Date.parse(s.created_at) : Number.NaN;
  return {
    ...toSummary(s),
    ...(Number.isFinite(createdAtMs) ? { createdAtMs } : {}),
    ...(s.error_message ? { errorMessage: s.error_message } : {}),
    ...(s.size_slug ? { sizeSlug: s.size_slug } : {}),
    ...(s.template ? { template: s.template } : {}),
  };
};

interface GrpcCallError {
  code?: number;
  details?: string;
  message?: string;
}

const grpcCode = (err: unknown): number | undefined =>
  typeof err === "object" && err !== null ? (err as GrpcCallError).code : undefined;

const isGuestGone = (err: unknown): boolean => {
  const code = grpcCode(err);
  return code === GRPC_NOT_FOUND || code === GRPC_UNAVAILABLE;
};

const isMissingPath = (err: unknown): boolean => {
  const code = grpcCode(err);
  if (code === GRPC_NOT_FOUND) return true;
  if (code !== GRPC_INTERNAL) return false;
  const e = err as GrpcCallError;
  return /\b404\b|does not exist|no such file/i.test(`${e.details ?? ""} ${e.message ?? ""}`);
};

type ProtoLoader = typeof import("@grpc/proto-loader");
type Grpc = typeof import("@grpc/grpc-js");

interface GrpcDuplex {
  write(msg: unknown): void;
  end(): void;
  cancel(): void;
  on(event: string, cb: (arg: never) => void): void;
}

type GrpcWritable = Pick<GrpcDuplex, "write" | "end" | "on">;
type GrpcReadable = Pick<GrpcDuplex, "on" | "cancel">;

interface SandboxAgent {
  Exec(): GrpcDuplex;
  Upload(cb: (err: unknown, res?: { bytes_written?: string }) => void): GrpcWritable;
  Download(req: unknown): GrpcReadable;
  waitForReady(deadline: Date, cb: (err?: Error) => void): void;
  close(): void;
}

interface ExecOutputFrame {
  output?: "stdout" | "stderr" | "exit";
  stdout?: Buffer;
  stderr?: Buffer;
  exit?: { exit_code?: number; hitl_rejected?: boolean; timed_out?: boolean };
}

interface DownloadFrame {
  output?: "header" | "chunk" | "end";
  chunk?: Buffer;
}

let grpcModules: Promise<[ProtoLoader, Grpc]> | null = null;

function loadGrpc(): Promise<[ProtoLoader, Grpc]> {
  grpcModules ??= Promise.all([
    import("@grpc/proto-loader").catch((e: unknown) => {
      throw new Error(`@grpc/proto-loader is not installed: ${errMessage(e)}`);
    }),
    import("@grpc/grpc-js").catch((e: unknown) => {
      throw new Error(`@grpc/grpc-js is not installed: ${errMessage(e)}`);
    }),
  ]) as Promise<[ProtoLoader, Grpc]>;
  return grpcModules;
}

async function dialSandboxAgent(localPort: number, readyTimeoutMs: number): Promise<SandboxAgent> {
  const [loader, grpc] = await loadGrpc();
  const definition = loader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const pkg = grpc.loadPackageDefinition(definition) as unknown as {
    do: {
      teams: {
        hosted_agents: {
          runtime: {
            sandbox_agent: {
              v1: {
                SandboxAgentService: new (
                  addr: string,
                  creds: ReturnType<Grpc["credentials"]["createInsecure"]>,
                  options: Record<string, number>,
                ) => SandboxAgent;
              };
            };
          };
        };
      };
    };
  };
  const Service = pkg.do.teams.hosted_agents.runtime.sandbox_agent.v1.SandboxAgentService;
  const agent = new Service(`127.0.0.1:${localPort}`, grpc.credentials.createInsecure(), {
    "grpc.max_receive_message_length": MAX_EXEC_OUTPUT_BYTES,
    "grpc.max_send_message_length": MAX_EXEC_OUTPUT_BYTES,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      agent.waitForReady(new Date(Date.now() + readyTimeoutMs), (err?: Error) => (err ? reject(err) : resolve()));
    });
  } catch (e) {
    agent.close();
    throw e;
  }
  return agent;
}

export function createSdkManagedAgentsClient(opts: SdkManagedAgentsClientOptions): ManagedAgentsClient {
  const apiBaseUrl = (opts.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
  const template = opts.template ?? DEFAULT_TEMPLATE;
  const maxCommandMs = opts.maxCommandMs ?? DEFAULT_MAX_COMMAND_MS;
  const stallProbeMs = opts.stallProbeMs ?? STALL_PROBE_MS;
  const egressAllow = opts.egressProxyUrl ? managedAgentsEgressAllow(opts.egressProxyUrl) : undefined;

  function send(method: string, path: string, body?: string, contentType?: string, signal?: AbortSignal) {
    return fetch(`${apiBaseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${opts.apiToken}`,
        accept: "application/json",
        ...(contentType ? { "content-type": contentType } : {}),
      },
      ...(body !== undefined ? { body } : {}),
      signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  function call(
    method: string,
    path: string,
    body?: string,
    contentType?: string,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    const operation = (signal?: AbortSignal): Promise<Response> => send(method, path, body, contentType, signal);
    return method === "GET" || method === "DELETE"
      ? fetchWithRetry((signal) => operation(signal), "idempotent", { timeoutMs })
      : operation(AbortSignal.timeout(timeoutMs));
  }

  async function failure(action: string, sessionId: string, res: Response): Promise<Error> {
    const raw = await res.text().catch(() => "");
    let message = raw.slice(0, 200);
    try {
      const parsed = JSON.parse(raw) as { error?: { message?: string } };
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      message = raw.slice(0, 200);
    }
    const detail = withRequestId(`http ${res.status} ${message}`, res.headers);
    if (res.status === 404 || res.status === 410) return new ManagedAgentsSandboxGoneError(sessionId, detail);
    return new Error(`do-managed-agents ${action}: ${detail}`);
  }

  async function callJson<T>(
    method: string,
    path: string,
    sessionId: string,
    body?: string,
    contentType?: string,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    const res = await call(method, path, body, contentType, timeoutMs);
    if (!res.ok) throw await failure(`${method} ${path}`, sessionId, res);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  const getInfo = async (sessionId: string): Promise<ManagedAgentsSessionInfo> => {
    const body = await callJson<{ session?: WireSession }>("GET", `/v2/agents/sessions/${sessionId}`, sessionId);
    if (!body.session) throw new ManagedAgentsSandboxGoneError(sessionId, "response carried no session");
    return toInfo(body.session);
  };

  async function awaitUsable(sessionId: string): Promise<ManagedAgentsSessionInfo> {
    const started = Date.now();
    const deadline = started + READY_TIMEOUT_MS;
    let resumed = false;
    let strikes = 0;
    const tolerate = (err: unknown): void => {
      if (err instanceof ManagedAgentsSandboxGoneError) throw err;
      if (++strikes > READY_TRANSIENT_LIMIT) throw err;
    };
    for (;;) {
      let info: ManagedAgentsSessionInfo | undefined;
      try {
        info = await getInfo(sessionId);
        strikes = 0;
      } catch (err) {
        tolerate(err);
      }
      if (info) {
        if (USABLE_STATES.has(info.state)) return info;
        if (GONE_STATES.has(info.state))
          throw new ManagedAgentsSandboxGoneError(sessionId, info.errorMessage ?? `status ${info.state}`);
        if (info.state === "paused" && !resumed) {
          try {
            await callJson<void>("POST", `/v2/agents/sessions/${sessionId}/resume`, sessionId);
            resumed = true;
            strikes = 0;
          } catch (err) {
            tolerate(err);
          }
        }
      }
      if (Date.now() >= deadline)
        throw new Error(`do-managed-agents session ${sessionId} did not become ready within ${READY_TIMEOUT_MS}ms`);
      await new Promise((resolve) =>
        setTimeout(resolve, Date.now() - started < READY_FAST_WINDOW_MS ? READY_FAST_POLL_MS : READY_POLL_MS),
      );
    }
  }

  async function rollbackToCheckpoint(sessionId: string, checkpointId: string): Promise<ManagedAgentsSessionInfo> {
    const body = await callJson<{ session?: WireSession }>(
      "POST",
      `/v2/agents/sessions/${sessionId}/checkpoints/${encodeURIComponent(checkpointId)}/rollback`,
      sessionId,
      undefined,
      undefined,
      ROLLBACK_TIMEOUT_MS,
    );
    if (!body.session) throw new Error(`do-managed-agents rollback ${sessionId}: response carried no session`);
    const restored = toInfo(body.session);
    if (!restored.sandboxId)
      throw new Error(`do-managed-agents rollback ${sessionId}: response carried no sandbox id`);
    if (GONE_STATES.has(restored.state))
      throw new ManagedAgentsSandboxGoneError(sessionId, restored.errorMessage ?? `status ${restored.state}`);
    return restored;
  }

  function buildSession(info: ManagedAgentsSessionInfo): ManagedAgentsSession {
    const sessionId = info.sessionId;
    let guest: Promise<{ tunnel: ManagedAgentsTunnel; agent: SandboxAgent }> | null = null;
    let lastTunnel: ManagedAgentsTunnel | null = null;

    const connect = (): Promise<{ tunnel: ManagedAgentsTunnel; agent: SandboxAgent }> =>
      (guest ??= (async () => {
        const tunnel = await openManagedAgentsTunnel({
          apiBaseUrl,
          sessionId,
          remotePort: SANDBOX_AGENT_PORT,
          getToken: async () => opts.apiToken,
        });
        lastTunnel = tunnel;
        try {
          const dial = dialSandboxAgent(tunnel.localPort, CONNECT_TIMEOUT_MS);
          const abort = tunnel.whenFailed().then((detail) => {
            throw new Error(detail);
          });
          dial.catch(() => undefined);
          abort.catch(() => undefined);
          return { tunnel, agent: await Promise.race([dial, abort]) };
        } catch (e) {
          const detail = tunnel.lastFailure() ?? errMessage(e);
          await tunnel.close();
          throw new ManagedAgentsSandboxGoneError(sessionId, `guest unreachable over the port-forward: ${detail}`);
        }
      })().catch((e: unknown) => {
        guest = null;
        throw e;
      }));

    async function disconnect(): Promise<void> {
      const pending = guest;
      guest = null;
      if (!pending) return;
      await pending
        .then(async ({ tunnel, agent }) => {
          agent.close();
          await tunnel.close();
        })
        .catch(() => undefined);
    }

    const guestDetail = (err: unknown): string => lastTunnel?.lastFailure() ?? errMessage(err);

    return {
      sessionId,
      sandboxId: info.sandboxId,

      async runCommand(command, runOpts): Promise<ManagedAgentsCommandResult> {
        const { agent } = await connect();
        const timeoutMs = Math.min(runOpts?.timeoutMs ?? maxCommandMs, maxCommandMs);
        return new Promise<ManagedAgentsCommandResult>((resolve, reject) => {
          const stream = agent.Exec();
          const out: Buffer[] = [];
          const errOut: Buffer[] = [];
          let outBytes = 0;
          let errBytes = 0;
          let exit: { exit_code?: number; hitl_rejected?: boolean } | undefined;
          let settled = false;
          let quietSince = Date.now();
          const settle = (fn: () => void): void => {
            if (settled) return;
            settled = true;
            clearInterval(watchdog);
            fn();
          };

          const watchdog = setInterval(() => {
            if (settled || Date.now() - quietSince < stallProbeMs) return;
            void getInfo(sessionId).then(
              (live) => {
                quietSince = Date.now();
                if (settled || USABLE_STATES.has(live.state)) return;
                settle(() => {
                  void disconnect();
                  reject(
                    GONE_STATES.has(live.state)
                      ? new ManagedAgentsSandboxGoneError(sessionId, `status ${live.state}`)
                      : new ManagedAgentsCommandLostError(sessionId, `the session became ${live.state} mid-command`),
                  );
                });
              },
              () => undefined,
            );
          }, stallProbeMs);
          watchdog.unref();

          stream.on("data", ((frame: ExecOutputFrame) => {
            quietSince = Date.now();
            if (frame.stdout && outBytes < MAX_EXEC_OUTPUT_BYTES) {
              out.push(frame.stdout);
              outBytes += frame.stdout.length;
            }
            if (frame.stderr && errBytes < MAX_EXEC_OUTPUT_BYTES) {
              errOut.push(frame.stderr);
              errBytes += frame.stderr.length;
            }
            if (frame.exit) exit = frame.exit;
          }) as (arg: never) => void);

          stream.on("error", ((err: unknown) => {
            settle(() => {
              const detail = guestDetail(err);
              void disconnect();
              reject(
                isGuestGone(err)
                  ? new ManagedAgentsCommandLostError(sessionId, detail)
                  : new Error(`do-managed-agents exec failed: ${detail}`),
              );
            });
          }) as (arg: never) => void);

          stream.on("end", (() => {
            settle(() => {
              if (exit?.hitl_rejected) {
                reject(new ManagedAgentsHitlRejectedError(sessionId));
                return;
              }
              resolve({
                stdout: Buffer.concat(out).toString("utf8"),
                stderr: Buffer.concat(errOut).toString("utf8"),
                exitCode: exit?.exit_code ?? -1,
              });
            });
          }) as (arg: never) => void);

          stream.write({
            start: {
              argv: ["/bin/bash", "-c", command],
              ...(runOpts?.workdir ? { workdir: runOpts.workdir } : {}),
              ...(runOpts?.env ? { env: runOpts.env } : {}),
              timeout_seconds: Math.ceil(timeoutMs / 1000),
            },
          });
          stream.end();
        });
      },

      async readFileBytes(absPath): Promise<Uint8Array | null> {
        const { agent } = await connect();
        return new Promise<Uint8Array | null>((resolve, reject) => {
          const chunks: Buffer[] = [];
          const stream = agent.Download({ path: absPath, as_archive: false, chunk_size_bytes: DOWNLOAD_CHUNK_BYTES });
          let settled = false;
          const settle = (fn: () => void): void => {
            if (settled) return;
            settled = true;
            fn();
          };
          stream.on("data", ((frame: DownloadFrame) => {
            if (frame.chunk?.length) chunks.push(frame.chunk);
          }) as (arg: never) => void);
          stream.on("error", ((err: unknown) => {
            settle(() => {
              if (isMissingPath(err)) {
                resolve(null);
                return;
              }
              const detail = guestDetail(err);
              void disconnect();
              reject(
                grpcCode(err) === GRPC_UNAVAILABLE
                  ? new ManagedAgentsSandboxGoneError(sessionId, detail)
                  : new Error(`do-managed-agents download ${absPath} failed: ${detail}`),
              );
            });
          }) as (arg: never) => void);
          stream.on("end", (() => settle(() => resolve(new Uint8Array(Buffer.concat(chunks))))) as (
            arg: never,
          ) => void);
        });
      },

      async writeFileBytes(absPath, data): Promise<void> {
        const { agent } = await connect();
        await new Promise<void>((resolve, reject) => {
          const stream = agent.Upload((err: unknown) => {
            if (!err) {
              resolve();
              return;
            }
            const detail = guestDetail(err);
            void disconnect();
            reject(
              isGuestGone(err)
                ? new ManagedAgentsSandboxGoneError(sessionId, detail)
                : new Error(`do-managed-agents upload ${absPath} failed: ${detail}`),
            );
          });
          stream.write({ header: { path: absPath, mode: 0o644, is_archive: false } });
          for (let offset = 0; offset < data.length; offset += UPLOAD_CHUNK_BYTES)
            stream.write({ chunk: Buffer.from(data.subarray(offset, offset + UPLOAD_CHUNK_BYTES)) });
          stream.write({ end: {} });
          stream.end();
        });
      },

      async createCheckpoint(label?: string): Promise<ManagedAgentsCheckpoint> {
        const body = await callJson<{ checkpoint?: WireCheckpoint }>(
          "POST",
          `/v2/agents/sessions/${sessionId}/checkpoints`,
          sessionId,
          JSON.stringify(label ? { label } : {}),
          "application/json",
          CHECKPOINT_TIMEOUT_MS,
        );
        const captured = body.checkpoint;
        if (!captured?.checkpoint_id)
          throw new Error(`do-managed-agents create checkpoint ${sessionId}: response carried no checkpoint id`);
        if (captured.status !== "READY") {
          const detail = captured.error_message ? `: ${captured.error_message}` : "";
          throw new Error(
            `do-managed-agents create checkpoint ${sessionId}: status ${captured.status ?? "missing"}${detail}`,
          );
        }
        const createdAtMs = captured.created_at ? Date.parse(captured.created_at) : Number.NaN;
        return {
          checkpointId: captured.checkpoint_id,
          status: captured.status,
          ...(Number.isFinite(createdAtMs) ? { createdAtMs } : {}),
        };
      },

      async deleteCheckpoint(checkpointId: string): Promise<void> {
        await callJson<void>(
          "DELETE",
          `/v2/agents/sessions/${sessionId}/checkpoints/${encodeURIComponent(checkpointId)}`,
          sessionId,
        );
      },

      async close(): Promise<void> {
        await disconnect();
      },

      async pause(): Promise<void> {
        await disconnect();
        await callJson<void>("POST", `/v2/agents/sessions/${sessionId}/pause`, sessionId);
      },

      async resume(): Promise<void> {
        await callJson<void>("POST", `/v2/agents/sessions/${sessionId}/resume`, sessionId);
      },

      async kill(): Promise<void> {
        await disconnect();
        await callJson<void>("DELETE", `/v2/agents/sessions/${sessionId}`, sessionId);
      },
    };
  }

  return {
    nativePause: true,

    info: getInfo,

    async create(createOpts): Promise<ManagedAgentsSession> {
      const manifest = managedAgentsManifest({
        name: createOpts.name,
        template,
        ...(opts.agent ? { agent: opts.agent } : {}),
        ...(opts.sizeSlug ? { sizeSlug: opts.sizeSlug } : {}),
        ...(opts.idleTimeoutSec ? { idleTimeoutSec: opts.idleTimeoutSec } : {}),
        ...((createOpts.egressAllow ?? egressAllow) ? { egressAllow: createOpts.egressAllow ?? egressAllow } : {}),
      });
      const body = await callJson<{ session?: WireSession }>(
        "POST",
        "/v2/agents/sessions",
        createOpts.name,
        manifest,
        "application/x-yaml",
        CREATE_TIMEOUT_MS,
      );
      const created = body.session ? toSummary(body.session) : null;
      if (!created?.sessionId) throw new Error("do-managed-agents create session: response carried no session id");
      return buildSession(await awaitUsable(created.sessionId));
    },

    async connect(sessionId): Promise<ManagedAgentsSession> {
      return buildSession(await awaitUsable(sessionId));
    },

    async rollback(sessionId, checkpointId): Promise<ManagedAgentsSessionInfo> {
      return rollbackToCheckpoint(sessionId, checkpointId);
    },

    async list(name): Promise<ManagedAgentsSessionSummary[]> {
      const body = await callJson<{ sessions?: WireSession[] }>(
        "GET",
        `/v2/agents/sessions?name=${encodeURIComponent(name)}`,
        name,
      );
      return (body.sessions ?? []).map(toSummary).filter((s) => s.name === name && !GONE_STATES.has(s.state));
    },

    async kill(sessionId): Promise<void> {
      await callJson<void>("DELETE", `/v2/agents/sessions/${sessionId}`, sessionId);
    },
  };
}
