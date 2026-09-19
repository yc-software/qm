export interface E2bCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface E2bRunOpts {
  timeoutMs?: number;
}

export interface E2bMetrics {
  cpuUsedPct: number;
  cpuCount: number;
  memUsedBytes: number;
  memTotalBytes: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
}

export interface E2bSession {
  readonly sandboxId: string;
  runCommand(command: string, opts?: E2bRunOpts): Promise<E2bCommandResult>;

  readFileBytes(absPath: string): Promise<Uint8Array | null>;
  writeFileBytes(absPath: string, data: Uint8Array): Promise<void>;
  keepAlive(ms: number): Promise<void>;
  pause(): Promise<void>;
  createSnapshot(): Promise<{ snapshotId: string }>;
  metrics(): Promise<E2bMetrics | null>;
  kill(): Promise<void>;
}

interface E2bSandboxSummary {
  sandboxId: string;
  state: string;
  metadata?: Record<string, string>;
}

export interface E2bSandboxInfo {
  state: string;
  expiresAtMs: number;
  onTimeout?: string;
  cpuCount?: number;
  memoryMb?: number;
}

export class E2bSandboxGoneError extends Error {
  constructor(sandboxId: string, detail: string) {
    super(`e2b sandbox ${sandboxId} is gone: ${detail}`);
    this.name = "E2bSandboxGoneError";
  }
}

export class E2bCommandLostError extends Error {
  constructor(sandboxId: string, detail: string) {
    super(
      `e2b sandbox ${sandboxId} was lost while a command was running (${detail}); the command may have partially executed and was not retried`,
    );
    this.name = "E2bCommandLostError";
  }
}

interface E2bCreateOpts {
  metadata: Record<string, string>;
  timeoutMs?: number;
  autoPause?: boolean;
  fromSnapshot?: string;
}

export interface E2bClient {
  readonly nativePause?: boolean;
  info?(sandboxId: string): Promise<E2bSandboxInfo>;

  create(opts: E2bCreateOpts): Promise<E2bSession>;

  connect(sandboxId: string): Promise<E2bSession>;

  list(metadata: Record<string, string>): Promise<E2bSandboxSummary[]>;

  kill(sandboxId: string): Promise<void>;

  deleteSnapshot(snapshotId: string): Promise<void>;
}

export interface SdkE2bClientOptions {
  apiKey: string;
  templateId?: string;

  sandboxTtlMs?: number;

  maxLifetimeMs?: number;

  proxy?: string;

  maxCommandMs?: number;

  egressProxyUrl?: string;
}

interface SdkCommandResultLike {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

export interface E2bEgressNetwork {
  allowOut: string[];
  denyOut: string[];
}

const DEFAULT_TEMPLATE = "base";
const DEFAULT_TTL_MS = 15 * 60_000;
const DEFAULT_MAX_COMMAND_MS = 3600_000;
export const E2B_PRO_MAX_LIFETIME_MS = 24 * 3600_000;
export const E2B_EXEC_MARGIN_MS = 60_000;
const ALL_TRAFFIC = "0.0.0.0/0";

const HOSTNAME_MATCHED_PORTS: Record<string, string> = { "http:": "80", "https:": "443" };

export function e2bEgressNetwork(egressProxyUrl: string): E2bEgressNetwork {
  const url = new URL(egressProxyUrl);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = url.port || HOSTNAME_MATCHED_PORTS[url.protocol] || "";
  const ipLiteral = /^[\d.]+$/.test(host) || host.includes(":");
  if (!ipLiteral && port !== "80" && port !== "443")
    throw new Error(
      `E2B egress proxy ${egressProxyUrl}: E2B matches allowed hostnames only on ports 80 and 443; give the proxy on one of those ports or by IP address`,
    );
  return { allowOut: [host], denyOut: [ALL_TRAFFIC] };
}

export function e2bSandboxTtlMs(opts: Pick<SdkE2bClientOptions, "sandboxTtlMs" | "maxLifetimeMs" | "maxCommandMs">): {
  sandboxTtlMs: number;
  maxLifetimeMs: number;
  maxCommandMs: number;
} {
  const maxLifetimeMs = opts.maxLifetimeMs ?? E2B_PRO_MAX_LIFETIME_MS;
  if (!Number.isFinite(maxLifetimeMs) || maxLifetimeMs <= E2B_EXEC_MARGIN_MS)
    throw new Error(`e2b maxLifetimeMs must be a finite number of milliseconds above ${E2B_EXEC_MARGIN_MS}`);
  const maxCommandMs = Math.min(opts.maxCommandMs ?? DEFAULT_MAX_COMMAND_MS, maxLifetimeMs - E2B_EXEC_MARGIN_MS);
  const requested = opts.sandboxTtlMs ?? Math.max(DEFAULT_TTL_MS, maxCommandMs + E2B_EXEC_MARGIN_MS);
  return { sandboxTtlMs: Math.min(maxLifetimeMs, requested), maxLifetimeMs, maxCommandMs };
}

function commandResultFrom(value: unknown): E2bCommandResult | null {
  const r = value as SdkCommandResultLike & { result?: SdkCommandResultLike };
  let source: SdkCommandResultLike | null = null;
  if (typeof r?.exitCode === "number") source = r;
  else if (typeof r?.result?.exitCode === "number") source = r.result;
  if (!source) return null;
  return { stdout: source.stdout ?? "", stderr: source.stderr ?? "", exitCode: source.exitCode ?? -1 };
}

type E2bSdk = typeof import("e2b");

const SANDBOX_TIMEOUT_MESSAGE = /sandbox timeout|end of life|not running anymore/i;

function isSandboxGone(sdk: E2bSdk, err: unknown): boolean {
  if (err instanceof sdk.SandboxNotFoundError) return true;
  return err instanceof sdk.TimeoutError && SANDBOX_TIMEOUT_MESSAGE.test(err.message);
}

export function createSdkE2bClient(opts: SdkE2bClientOptions): E2bClient {
  const templateId = opts.templateId ?? DEFAULT_TEMPLATE;
  const { sandboxTtlMs, maxLifetimeMs, maxCommandMs } = e2bSandboxTtlMs(opts);
  const network = opts.egressProxyUrl ? e2bEgressNetwork(opts.egressProxyUrl) : undefined;
  const common = {
    apiKey: opts.apiKey,
    ...(opts.proxy ? { proxy: opts.proxy } : {}),
  };

  let sdk: Promise<E2bSdk> | null = null;
  const loadSdk = (): Promise<E2bSdk> => {
    const loaded = (sdk ??= import("e2b").then(
      (m) => m as unknown as E2bSdk,
      (e) => {
        sdk = null;
        throw new Error(`the e2b SDK is not installed: ${String((e as Error)?.message ?? e)}`);
      },
    ));
    return loaded;
  };

  type SdkSandbox = Awaited<ReturnType<E2bSdk["Sandbox"]["create"]>>;

  const wrap = (lib: E2bSdk, sbx: SdkSandbox, ttlMs: number): E2bSession => {
    let expiresAtMs = Date.now() + ttlMs;
    const gone = (err: unknown): unknown =>
      isSandboxGone(lib, err) ? new E2bSandboxGoneError(sbx.sandboxId, String((err as Error).message)) : err;
    const extend = async (ms: number): Promise<void> => {
      const bounded = Math.min(maxLifetimeMs, Math.max(ms, expiresAtMs - Date.now()));
      const at = Date.now() + bounded;
      try {
        await sbx.setTimeout(bounded);
      } catch (err) {
        throw gone(err);
      }
      expiresAtMs = at;
    };
    const cover = async (commandMs: number): Promise<void> => {
      const needed = Math.min(commandMs, maxCommandMs) + E2B_EXEC_MARGIN_MS;
      if (Date.now() + needed <= expiresAtMs) return;
      await extend(Math.max(ttlMs, needed));
    };
    return {
      sandboxId: sbx.sandboxId,
      async runCommand(command, runOpts): Promise<E2bCommandResult> {
        const timeoutMs = runOpts?.timeoutMs ?? maxCommandMs;
        await cover(timeoutMs);
        let handle: Awaited<ReturnType<SdkSandbox["commands"]["run"]>>;
        try {
          handle = await sbx.commands.run(command, { background: true, timeoutMs });
        } catch (err) {
          throw gone(err);
        }
        try {
          return commandResultFrom(await handle.wait()) ?? { stdout: "", stderr: "", exitCode: -1 };
        } catch (err) {
          const asResult = commandResultFrom(err);
          if (asResult) return asResult;
          if (isSandboxGone(lib, err)) throw new E2bCommandLostError(sbx.sandboxId, String((err as Error).message));
          throw err;
        }
      },
      async readFileBytes(absPath): Promise<Uint8Array | null> {
        try {
          const data = await sbx.files.read(absPath, { format: "bytes" });
          return data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
        } catch (err) {
          if (err instanceof lib.FileNotFoundError) return null;
          throw gone(err);
        }
      },
      async writeFileBytes(absPath, data): Promise<void> {
        const buf = new ArrayBuffer(data.byteLength);
        new Uint8Array(buf).set(data);
        try {
          await sbx.files.write(absPath, buf);
        } catch (err) {
          throw gone(err);
        }
      },
      keepAlive: (ms) => extend(ms),
      async pause(): Promise<void> {
        try {
          await sbx.pause({ keepMemory: true });
        } catch (err) {
          throw gone(err);
        }
      },
      async createSnapshot(): Promise<{ snapshotId: string }> {
        try {
          const info = await sbx.createSnapshot();
          return { snapshotId: info.snapshotId };
        } catch (err) {
          throw gone(err);
        }
      },
      async metrics(): Promise<E2bMetrics | null> {
        const rows = await sbx.getMetrics();
        const last = rows.at(-1);
        if (!last) return null;
        return {
          cpuUsedPct: last.cpuUsedPct,
          cpuCount: last.cpuCount,
          memUsedBytes: last.memUsed,
          memTotalBytes: last.memTotal,
          diskUsedBytes: last.diskUsed,
          diskTotalBytes: last.diskTotal,
        };
      },
      async kill(): Promise<void> {
        await sbx.kill().catch((err) => {
          if (!isSandboxGone(lib, err)) throw err;
        });
      },
    };
  };

  return {
    nativePause: true,
    async info(sandboxId) {
      const lib = await loadSdk();
      try {
        const info = await lib.Sandbox.getInfo(sandboxId, common);
        return {
          state: info.state,
          expiresAtMs: info.endAt.getTime(),
          onTimeout: info.lifecycle?.onTimeout,
          cpuCount: info.cpuCount,
          memoryMb: info.memoryMB,
        };
      } catch (err) {
        if (isSandboxGone(lib, err)) throw new E2bSandboxGoneError(sandboxId, String((err as Error).message));
        throw err;
      }
    },
    async create(createOpts): Promise<E2bSession> {
      const lib = await loadSdk();
      const timeoutMs = Math.min(maxLifetimeMs, createOpts.timeoutMs ?? sandboxTtlMs);
      const sbx = await lib.Sandbox.create(createOpts.fromSnapshot ?? templateId, {
        ...common,
        timeoutMs,
        metadata: createOpts.metadata,
        lifecycle: { onTimeout: createOpts.autoPause ? "pause" : "kill", autoResume: false },
        ...(network ? { network } : {}),
      });
      return wrap(lib, sbx, timeoutMs);
    },
    async connect(sandboxId): Promise<E2bSession> {
      const lib = await loadSdk();
      try {
        const sbx = await lib.Sandbox.connect(sandboxId, { ...common, timeoutMs: sandboxTtlMs });
        if (network) await sbx.updateNetwork(network);
        return wrap(lib, sbx, sandboxTtlMs);
      } catch (err) {
        if (isSandboxGone(lib, err)) throw new E2bSandboxGoneError(sandboxId, String((err as Error).message));
        throw err;
      }
    },
    async list(metadata): Promise<E2bSandboxSummary[]> {
      const { Sandbox } = await loadSdk();
      const paginator = Sandbox.list({
        ...common,
        ...(Object.keys(metadata).length ? { query: { metadata } } : {}),
      });
      const out: E2bSandboxSummary[] = [];
      while (paginator.hasNext) {
        const items = await paginator.nextItems();
        for (const s of items) {
          out.push({ sandboxId: s.sandboxId, state: String(s.state), ...(s.metadata ? { metadata: s.metadata } : {}) });
        }
      }
      return out;
    },
    async kill(sandboxId): Promise<void> {
      const lib = await loadSdk();
      await lib.Sandbox.kill(sandboxId, common).catch((err) => {
        if (!isSandboxGone(lib, err)) throw err;
      });
    },
    async deleteSnapshot(snapshotId): Promise<void> {
      const { Sandbox } = await loadSdk();
      await Sandbox.deleteSnapshot(snapshotId, common);
    },
  };
}
