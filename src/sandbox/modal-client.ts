export interface ModalCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface ModalRunOpts {
  timeoutMs?: number;
}

export interface ModalSession {
  readonly sandboxId: string;
  runCommand(command: string, opts?: ModalRunOpts): Promise<ModalCommandResult>;
  readFileBytes(absPath: string): Promise<Uint8Array | null>;
  writeFileBytes(absPath: string, data: Uint8Array): Promise<void>;
  snapshotHome?(): Promise<{ imageId: string; expiresAtMs: number }>;
  restoreHome?(imageId: string): Promise<void>;
  terminate(): Promise<void>;
}
export class ModalSandboxGoneError extends Error {
  constructor(sandboxId: string, detail: string) {
    super(`modal sandbox ${sandboxId} is gone: ${detail}`);
    this.name = "ModalSandboxGoneError";
  }
}
export class ModalNameConflictError extends Error {
  constructor(name: string, detail: string) {
    super(`modal sandbox name ${name} already taken: ${detail}`);
    this.name = "ModalNameConflictError";
  }
}

interface ModalCreateOpts {
  name?: string;
}

export interface ModalClient {
  readonly lifetimeMs?: number;
  readonly nativeSnapshots?: boolean;
  create(opts: ModalCreateOpts): Promise<ModalSession>;
  fromId(sandboxId: string): Promise<ModalSession>;
  fromName(name: string): Promise<ModalSession | null>;
  terminate(sandboxId: string): Promise<void>;
}

export interface SdkModalClientOptions {
  tokenId: string;
  tokenSecret: string;
  appName: string;
  image: string;
  imageSetupCommands?: string[];
  environment?: string;
  cpus?: number;
  memoryMb?: number;
  regions?: string[];
  sandboxTimeoutMs?: number;
  maxCommandMs?: number;
  snapshotRetentionMs?: number;
}

const MAX_LIFETIME_MS = 24 * 3600_000;
const DEFAULT_MAX_COMMAND_MS = 3600_000;

function errName(err: unknown): string {
  return String((err as Error)?.name ?? "");
}

function errText(err: unknown): string {
  return String((err as Error)?.message ?? err);
}

function isFileNotFoundError(err: unknown): boolean {
  return errName(err) === "SandboxFilesystemNotFoundError" || /no such file or directory/i.test(errText(err));
}

function isSandboxGoneError(err: unknown): boolean {
  if (isFileNotFoundError(err)) return false;
  const name = errName(err);
  if (name === "NotFoundError" || name === "ClientClosedError") return true;
  return /(sandbox|task).*(not found|has been terminated|already (terminated|finished|completed)|does not exist|is not running)|detached sandbox/i.test(
    errText(err),
  );
}

const GRPC_INVALID_ARGUMENT = 3;

function isSandboxIdLookupGone(err: unknown): boolean {
  if (isSandboxGoneError(err)) return true;
  if (errName(err) === "InvalidError") return true;
  if ((err as { code?: unknown }).code === GRPC_INVALID_ARGUMENT) return true;
  return /INVALID_ARGUMENT/.test(errText(err));
}

function isNameConflictError(err: unknown): boolean {
  return errName(err) === "AlreadyExistsError" || /already exists|already in use/i.test(errText(err));
}

function isDeadlineError(err: unknown): boolean {
  return /timeouterror$/i.test(errName(err)) || /deadline exceeded/i.test(errText(err));
}

export function createSdkModalClient(opts: SdkModalClientOptions): ModalClient {
  const sandboxTimeoutMs = Math.min(opts.sandboxTimeoutMs ?? MAX_LIFETIME_MS, MAX_LIFETIME_MS);
  const maxCommandMs = opts.maxCommandMs ?? DEFAULT_MAX_COMMAND_MS;
  const snapshotRetentionMs = opts.snapshotRetentionMs ?? 30 * 24 * 3600_000;
  if (!Number.isFinite(snapshotRetentionMs) || snapshotRetentionMs <= 0)
    throw new Error("Modal snapshot retention must be a positive finite duration");
  type ModalSdk = typeof import("modal");
  type SdkClient = InstanceType<ModalSdk["ModalClient"]>;
  type SdkApp = Awaited<ReturnType<SdkClient["apps"]["fromName"]>>;
  type SdkImage = ReturnType<SdkClient["images"]["fromRegistry"]>;
  type SdkSandbox = Awaited<ReturnType<SdkClient["sandboxes"]["fromId"]>>;

  let ctx: Promise<{ client: SdkClient; app: SdkApp; image: SdkImage }> | null = null;
  const buildCtx = async (): Promise<{ client: SdkClient; app: SdkApp; image: SdkImage }> => {
    let sdk: ModalSdk;
    try {
      sdk = (await import("modal")) as unknown as ModalSdk;
    } catch (e) {
      throw new Error(`the modal SDK is not installed: ${errText(e)}`, { cause: e });
    }
    const client = new sdk.ModalClient({
      tokenId: opts.tokenId,
      tokenSecret: opts.tokenSecret,
      ...(opts.environment ? { environment: opts.environment } : {}),
    });
    const app = await client.apps.fromName(opts.appName, { createIfMissing: true });
    let image = client.images.fromRegistry(opts.image);
    if (opts.imageSetupCommands?.length) image = image.dockerfileCommands(opts.imageSetupCommands);
    return { client, app, image };
  };
  const loadCtx = (): Promise<{ client: SdkClient; app: SdkApp; image: SdkImage }> =>
    (ctx ??= buildCtx().catch((e) => {
      ctx = null;
      throw e;
    }));

  const wrap = (sbx: SdkSandbox): ModalSession => ({
    sandboxId: sbx.sandboxId,
    async runCommand(command, runOpts): Promise<ModalCommandResult> {
      const timeoutMs = runOpts?.timeoutMs ?? maxCommandMs;
      try {
        const p = await sbx.exec(["sh", "-c", command], { mode: "text", timeoutMs: timeoutMs + 30_000 });
        const [stdout, stderr, exitCode] = await Promise.all([p.stdout.readText(), p.stderr.readText(), p.wait()]);
        return { stdout, stderr, exitCode };
      } catch (err) {
        if (isDeadlineError(err)) return { stdout: "", stderr: errText(err), exitCode: 124 };
        if (isSandboxGoneError(err)) throw new ModalSandboxGoneError(sbx.sandboxId, errText(err));
        throw err;
      }
    },
    async readFileBytes(absPath): Promise<Uint8Array | null> {
      try {
        return await sbx.filesystem.readBytes(absPath);
      } catch (err) {
        if (isSandboxGoneError(err)) throw new ModalSandboxGoneError(sbx.sandboxId, errText(err));
        if (isFileNotFoundError(err)) return null;
        throw err;
      }
    },
    async writeFileBytes(absPath, data): Promise<void> {
      try {
        await sbx.filesystem.writeBytes(data, absPath);
      } catch (err) {
        if (isSandboxGoneError(err)) throw new ModalSandboxGoneError(sbx.sandboxId, errText(err));
        throw err;
      }
    },
    async snapshotHome() {
      const expiresAtMs = Date.now() + snapshotRetentionMs;
      const image = await sbx.snapshotDirectory("/root", { ttlMs: snapshotRetentionMs });
      return { imageId: image.imageId, expiresAtMs };
    },
    async restoreHome(imageId): Promise<void> {
      const { client } = await loadCtx();
      await sbx.mountImage("/root", await client.images.fromId(imageId));
    },
    async terminate(): Promise<void> {
      await sbx.terminate().catch((err) => {
        if (!isSandboxGoneError(err)) throw err;
      });
    },
  });

  return {
    lifetimeMs: sandboxTimeoutMs,
    nativeSnapshots: true,
    async create(createOpts): Promise<ModalSession> {
      const { client, app, image } = await loadCtx();
      try {
        const sbx = await client.sandboxes.create(app, image, {
          ...(createOpts.name ? { name: createOpts.name } : {}),
          timeoutMs: sandboxTimeoutMs,
          ...(opts.cpus !== undefined ? { cpu: opts.cpus } : {}),
          ...(opts.memoryMb !== undefined ? { memoryMiB: opts.memoryMb } : {}),
          ...(opts.regions?.length ? { regions: opts.regions } : {}),
        });
        return wrap(sbx);
      } catch (err) {
        if (isNameConflictError(err)) throw new ModalNameConflictError(createOpts.name ?? "(unnamed)", errText(err));
        throw err;
      }
    },
    async fromId(sandboxId): Promise<ModalSession> {
      const { client } = await loadCtx();
      try {
        const sbx = await client.sandboxes.fromId(sandboxId);
        const exited = await sbx.poll();
        if (exited !== null) throw new ModalSandboxGoneError(sandboxId, `exited with code ${exited}`);
        return wrap(sbx);
      } catch (err) {
        if (err instanceof ModalSandboxGoneError) throw err;
        if (isSandboxIdLookupGone(err)) throw new ModalSandboxGoneError(sandboxId, errText(err));
        throw err;
      }
    },
    async fromName(name): Promise<ModalSession | null> {
      const { client } = await loadCtx();
      let sbx: SdkSandbox;
      try {
        sbx = await client.sandboxes.fromName(opts.appName, name);
      } catch (err) {
        if (isSandboxGoneError(err)) return null;
        throw err;
      }
      try {
        const exited = await sbx.poll();
        if (exited !== null) return null;
      } catch (err) {
        if (isSandboxGoneError(err)) return null;
      }
      return wrap(sbx);
    },
    async terminate(sandboxId): Promise<void> {
      const { client } = await loadCtx();
      let sbx: SdkSandbox;
      try {
        sbx = await client.sandboxes.fromId(sandboxId);
      } catch (err) {
        if (isSandboxIdLookupGone(err)) return;
        throw err;
      }
      try {
        await sbx.terminate();
      } catch (err) {
        if (isSandboxGoneError(err)) return;
        throw err;
      }
    },
  };
}
