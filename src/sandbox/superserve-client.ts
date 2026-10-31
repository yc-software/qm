import { errMessage } from "../util/errors.ts";

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

export function createSdkSuperserveClient(opts: SdkSuperserveClientOptions): SuperserveClient {
  const maxCommandMs = opts.maxCommandMs ?? DEFAULT_MAX_COMMAND_MS;
  const connection = { apiKey: opts.apiKey, ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}) };

  type Sdk = typeof import("@superserve/sdk");
  let sdk: Promise<Sdk> | null = null;
  const loadSdk = (): Promise<Sdk> =>
    (sdk ??= import("@superserve/sdk").catch((e: unknown) => {
      sdk = null;
      throw e;
    }));

  type SdkSandbox = Awaited<ReturnType<Sdk["Sandbox"]["create"]>>;

  const gone = (id: string, err: unknown): never => {
    throw new SuperserveSandboxGoneError(id, errMessage(err));
  };

  const wrap = (sbx: SdkSandbox): SuperserveSession => ({
    id: sbx.id,
    async run(command, runOpts): Promise<SuperserveCommandResult> {
      const timeoutMs = runOpts?.timeoutMs ?? maxCommandMs;
      const cap = runOpts?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
      try {
        const r = await sbx.commands.run(command, {
          timeoutMs,
          onStdout: () => undefined,
        });
        return {
          stdout: clampUtf8(r.stdout, cap),
          stderr: clampUtf8(r.stderr, cap),
          exitCode: r.exitCode,
          ...(r.truncated || Buffer.byteLength(r.stdout, "utf8") > cap || Buffer.byteLength(r.stderr, "utf8") > cap
            ? { truncated: true }
            : {}),
        };
      } catch (err) {
        if (isGoneError(err)) gone(sbx.id, err);
        throw err;
      }
    },
    async readFileBytes(absPath): Promise<Uint8Array | null> {
      try {
        return await sbx.files.read(absPath);
      } catch (err) {
        if (hasStatus(err, 404)) {
          let status: string;
          try {
            status = (await sbx.getInfo()).status;
          } catch (infoErr) {
            if (isGoneError(infoErr)) gone(sbx.id, infoErr);
            throw infoErr;
          }
          if (GONE_STATES.has(status)) gone(sbx.id, err);
          return null;
        }
        if (isGoneError(err)) gone(sbx.id, err);
        throw err;
      }
    },
    async writeFileBytes(absPath, data): Promise<void> {
      try {
        await sbx.files.write(absPath, data);
      } catch (err) {
        if (isGoneError(err)) gone(sbx.id, err);
        throw err;
      }
    },
    async update(patch): Promise<void> {
      try {
        await sbx.update(patch);
      } catch (err) {
        if (isGoneError(err)) gone(sbx.id, err);
        throw err;
      }
    },
    async pause(): Promise<void> {
      try {
        await sbx.pause();
      } catch (err) {
        if (isGoneError(err)) gone(sbx.id, err);
        throw err;
      }
    },
    async kill(): Promise<void> {
      await sbx.kill().catch((err) => {
        if (!isGoneError(err)) throw err;
      });
    },
  });

  const toInfo = (i: {
    id: string;
    name: string;
    status: SuperserveSandboxState;
    metadata: Record<string, string>;
    vcpuCount?: number;
    memoryMib?: number;
    timeoutSeconds?: number;
    autoDeleteAt?: Date;
    network?: SuperserveNetwork;
  }): SuperserveSandboxInfo => ({
    id: i.id,
    name: i.name,
    status: i.status,
    metadata: i.metadata ?? {},
    ...(i.network ? { network: i.network } : {}),
    ...(i.vcpuCount !== undefined ? { vcpuCount: i.vcpuCount } : {}),
    ...(i.memoryMib !== undefined ? { memoryMib: i.memoryMib } : {}),
    ...(i.timeoutSeconds !== undefined ? { timeoutSeconds: i.timeoutSeconds } : {}),
    ...(i.autoDeleteAt ? { autoDeleteAtMs: i.autoDeleteAt.getTime() } : {}),
  });

  return {
    async create(createOpts): Promise<SuperserveSession> {
      const { Sandbox } = await loadSdk();
      const sbx = await Sandbox.create({
        ...connection,
        name: createOpts.name,
        metadata: createOpts.metadata,
        ...((createOpts.template ?? opts.template) ? { fromTemplate: createOpts.template ?? opts.template } : {}),
        ...(createOpts.timeoutSeconds !== undefined ? { timeoutSeconds: createOpts.timeoutSeconds } : {}),
        ...(createOpts.autoDeleteSeconds !== undefined ? { autoDeleteSeconds: createOpts.autoDeleteSeconds } : {}),
        ...(createOpts.network ? { network: createOpts.network } : {}),
        previewAccess: "private",
      });
      return wrap(sbx);
    },
    async update(sandboxId, patch): Promise<void> {
      const { Sandbox } = await loadSdk();
      try {
        await Sandbox.updateById(sandboxId, patch, connection);
      } catch (err) {
        if (isGoneError(err)) gone(sandboxId, err);
        throw err;
      }
    },
    async connect(sandboxId): Promise<SuperserveSession> {
      const { Sandbox } = await loadSdk();
      try {
        return wrap(await Sandbox.connect(sandboxId, connection));
      } catch (err) {
        if (isGoneError(err)) gone(sandboxId, err);
        throw err;
      }
    },
    async info(sandboxId, scopeMetadata): Promise<SuperserveSandboxInfo> {
      const { Sandbox } = await loadSdk();
      const scoped = scopeMetadata && Object.keys(scopeMetadata).length ? scopeMetadata : undefined;
      try {
        const listed = await Sandbox.list({ ...connection, ...(scoped ? { metadata: scoped } : {}) });
        const hit = listed.find((s) => s.id === sandboxId);
        if (!hit || GONE_STATES.has(hit.status)) throw new SuperserveSandboxGoneError(sandboxId, "not listed");
        return toInfo(hit);
      } catch (err) {
        if (isGoneError(err)) gone(sandboxId, err);
        throw err;
      }
    },
    async list(metadata): Promise<SuperserveSandboxSummary[]> {
      const { Sandbox } = await loadSdk();
      const listed = await Sandbox.list({ ...connection, ...(Object.keys(metadata).length ? { metadata } : {}) });
      return listed
        .filter((s) => !GONE_STATES.has(s.status))
        .map((s) => ({ id: s.id, name: s.name, status: s.status, metadata: s.metadata ?? {} }));
    },
    async kill(sandboxId): Promise<void> {
      const { Sandbox } = await loadSdk();
      await Sandbox.killById(sandboxId, connection).catch((err) => {
        if (!isGoneError(err)) throw err;
      });
    },
  };
}
