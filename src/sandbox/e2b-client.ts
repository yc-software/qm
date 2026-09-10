export interface E2bCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface E2bRunOpts {
  timeoutMs?: number;
}

export interface E2bSession {
  readonly sandboxId: string;
  runCommand(command: string, opts?: E2bRunOpts): Promise<E2bCommandResult>;

  readFileBytes(absPath: string): Promise<Uint8Array | null>;
  writeFileBytes(absPath: string, data: Uint8Array): Promise<void>;
  pause(): Promise<void>;
  kill(): Promise<void>;
}

interface E2bSandboxSummary {
  sandboxId: string;
  state: string;
  metadata?: Record<string, string>;
}

export class E2bSandboxGoneError extends Error {
  constructor(sandboxId: string, detail: string) {
    super(`e2b sandbox ${sandboxId} is gone: ${detail}`);
    this.name = "E2bSandboxGoneError";
  }
}

interface E2bCreateOpts {
  metadata: Record<string, string>;
  timeoutMs?: number;
  autoPause?: boolean;
}

export interface E2bClient {
  readonly nativePause?: boolean;
  info?(sandboxId: string): Promise<{ state: string; expiresAtMs: number; onTimeout?: string }>;

  create(opts: E2bCreateOpts): Promise<E2bSession>;

  connect(sandboxId: string): Promise<E2bSession>;

  list(metadata: Record<string, string>): Promise<E2bSandboxSummary[]>;

  kill(sandboxId: string): Promise<void>;
}

export interface SdkE2bClientOptions {
  apiKey: string;
  templateId?: string;

  sandboxTtlMs?: number;

  proxy?: string;

  maxCommandMs?: number;
}

interface SdkCommandResultLike {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

const DEFAULT_TEMPLATE = "base";
const DEFAULT_TTL_MS = 15 * 60_000;
const DEFAULT_MAX_COMMAND_MS = 3600_000;

function commandResultFrom(value: unknown): E2bCommandResult | null {
  const r = value as SdkCommandResultLike & { result?: SdkCommandResultLike };
  let source: SdkCommandResultLike | null = null;
  if (typeof r?.exitCode === "number") source = r;
  else if (typeof r?.result?.exitCode === "number") source = r.result;
  if (!source) return null;
  return { stdout: source.stdout ?? "", stderr: source.stderr ?? "", exitCode: source.exitCode ?? -1 };
}

function isGoneError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  const name = String((err as Error)?.name ?? "");
  return (
    name.endsWith("NotFoundError") ||
    /not found|not running anymore|does not exist|invalid sandbox id|sandbox was not found|410|expired/i.test(msg)
  );
}

function isSandboxGoneError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  const name = String((err as Error)?.name ?? "");
  if (name === "SandboxNotFoundError") return true;
  return /not running anymore|sandbox (was )?not found|invalid sandbox id|sandbox.*(does not exist|expired)/i.test(msg);
}

export function createSdkE2bClient(opts: SdkE2bClientOptions): E2bClient {
  const templateId = opts.templateId ?? DEFAULT_TEMPLATE;
  const sandboxTtlMs = opts.sandboxTtlMs ?? DEFAULT_TTL_MS;
  const maxCommandMs = opts.maxCommandMs ?? DEFAULT_MAX_COMMAND_MS;
  const common = {
    apiKey: opts.apiKey,
    ...(opts.proxy ? { proxy: opts.proxy } : {}),
  };

  type E2bSdk = typeof import("e2b");
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

  const wrap = (sbx: SdkSandbox): E2bSession => ({
    sandboxId: sbx.sandboxId,
    async runCommand(command, runOpts): Promise<E2bCommandResult> {
      const timeoutMs = runOpts?.timeoutMs ?? maxCommandMs;
      try {
        const r = await sbx.commands.run(command, {
          timeoutMs,

          requestTimeoutMs: timeoutMs + 30_000,
        });
        return commandResultFrom(r) ?? { stdout: "", stderr: "", exitCode: -1 };
      } catch (err) {
        const asResult = commandResultFrom(err);
        if (asResult) return asResult;
        if (isGoneError(err)) throw new E2bSandboxGoneError(sbx.sandboxId, String((err as Error).message));
        throw err;
      }
    },
    async readFileBytes(absPath): Promise<Uint8Array | null> {
      try {
        const data = await sbx.files.read(absPath, { format: "bytes" });
        return data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
      } catch (err) {
        if (isSandboxGoneError(err)) throw new E2bSandboxGoneError(sbx.sandboxId, String((err as Error).message));
        if (
          String((err as Error)?.name) === "NotFoundError" ||
          /not found|no such file/i.test(String((err as Error)?.message))
        )
          return null;
        throw err;
      }
    },
    async writeFileBytes(absPath, data): Promise<void> {
      const buf = new ArrayBuffer(data.byteLength);
      new Uint8Array(buf).set(data);
      try {
        await sbx.files.write(absPath, buf);
      } catch (err) {
        if (isSandboxGoneError(err)) throw new E2bSandboxGoneError(sbx.sandboxId, String((err as Error).message));
        throw err;
      }
    },
    async pause(): Promise<void> {
      await sbx.pause({ keepMemory: true });
    },
    async kill(): Promise<void> {
      await sbx.kill().catch((err) => {
        if (!isGoneError(err)) throw err;
      });
    },
  });

  return {
    nativePause: true,
    async info(sandboxId) {
      const { Sandbox } = await loadSdk();
      try {
        const info = await Sandbox.getInfo(sandboxId, common);
        return { state: info.state, expiresAtMs: info.endAt.getTime(), onTimeout: info.lifecycle?.onTimeout };
      } catch (err) {
        if (isGoneError(err)) throw new E2bSandboxGoneError(sandboxId, String((err as Error).message));
        throw err;
      }
    },
    async create(createOpts): Promise<E2bSession> {
      const { Sandbox } = await loadSdk();
      const sbx = await Sandbox.create(templateId, {
        ...common,
        timeoutMs: createOpts.timeoutMs ?? sandboxTtlMs,
        metadata: createOpts.metadata,
        lifecycle: { onTimeout: createOpts.autoPause ? "pause" : "kill", autoResume: false },
      });
      return wrap(sbx);
    },
    async connect(sandboxId): Promise<E2bSession> {
      const { Sandbox } = await loadSdk();
      try {
        const sbx = await Sandbox.connect(sandboxId, { ...common, timeoutMs: sandboxTtlMs });
        return wrap(sbx);
      } catch (err) {
        if (isGoneError(err)) throw new E2bSandboxGoneError(sandboxId, String((err as Error).message));
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
      const { Sandbox } = await loadSdk();
      await Sandbox.kill(sandboxId, common).catch((err) => {
        if (!isGoneError(err)) throw err;
      });
    },
  };
}
