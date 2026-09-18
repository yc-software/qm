import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { resolveModalImage } from "./modal-image.ts";

export interface ModalCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface ModalRunOpts {
  timeoutMs?: number;
  env?: Record<string, string>;
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
  tags?: Record<string, string>;
}

export interface ModalClient {
  readonly lifetimeMs?: number;
  readonly nativeSnapshots?: boolean;
  create(opts: ModalCreateOpts): Promise<ModalSession>;
  fromId(sandboxId: string): Promise<ModalSession>;
  fromName(name: string): Promise<ModalSession | null>;
  terminate(sandboxId: string): Promise<void>;
  listRunning?(tags: Record<string, string>): AsyncIterable<string>;
}

export interface SdkModalClientOptions {
  tokenId: string;
  tokenSecret: string;
  appName: string;
  image?: string;
  environment?: string;
  cpus?: number;
  memoryMb?: number;
  regions?: string[];
  sandboxTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxCommandMs?: number;
  snapshotRetentionMs?: number;
  egressProxyUrl?: string;
}

const MAX_LIFETIME_MS = 24 * 3600_000;
const DEFAULT_IDLE_TIMEOUT_MS = 12 * 3600_000;
const DEFAULT_MAX_COMMAND_MS = 3600_000;
const DEFAULT_CPUS = 1;
const DEFAULT_MEMORY_MB = 2048;
export const MODAL_EXEC_GRACE_MS = 30_000;
export const MODAL_MAX_EXEC_ARG_BYTES = 64 * 1024;
const SNAPSHOT_CALL_TIMEOUT_MS = 600_000;

export function wholeSeconds(ms: number): number {
  return Math.max(1000, Math.ceil(ms / 1000) * 1000);
}

function errName(err: unknown): string {
  return String((err as Error)?.name ?? "");
}

function errText(err: unknown): string {
  return String((err as Error)?.message ?? err);
}

function isFileNotFoundError(err: unknown): boolean {
  return errName(err) === "SandboxFilesystemNotFoundError" || /no such file or directory/i.test(errText(err));
}

function isFileTooLargeError(err: unknown): boolean {
  return errName(err) === "SandboxFilesystemFileTooLargeError";
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

export function modalEgressAllowlist(
  egressProxyUrl: string,
): { outboundDomainAllowlist: string[] } | { outboundCidrAllowlist: string[] } {
  const url = new URL(egressProxyUrl);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const ipVersion = isIP(host);
  if (ipVersion) return { outboundCidrAllowlist: [`${host}/${ipVersion === 4 ? 32 : 128}`] };
  if (url.protocol === "https:" && (url.port === "" || url.port === "443")) return { outboundDomainAllowlist: [host] };
  throw new Error(
    "MODAL_EGRESS_PROXY_URL must be an https URL on port 443 or an IP address: Modal domain allowlists pass only TLS traffic on port 443",
  );
}

export function createSdkModalClient(opts: SdkModalClientOptions): ModalClient {
  const sandboxTimeoutMs = wholeSeconds(Math.min(opts.sandboxTimeoutMs ?? MAX_LIFETIME_MS, MAX_LIFETIME_MS));
  const idleTimeoutMs = wholeSeconds(Math.min(opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS, sandboxTimeoutMs));
  const maxCommandMs = opts.maxCommandMs ?? DEFAULT_MAX_COMMAND_MS;
  const snapshotRetentionMs = opts.snapshotRetentionMs ?? 30 * 24 * 3600_000;
  if (!Number.isFinite(snapshotRetentionMs) || snapshotRetentionMs <= 0)
    throw new Error("Modal snapshot retention must be a positive finite duration");
  const snapshotTtlMs = wholeSeconds(snapshotRetentionMs);
  const network = opts.egressProxyUrl ? modalEgressAllowlist(opts.egressProxyUrl) : {};
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
    const image = await resolveModalImage(client, opts.image);
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
      const timeoutMs = wholeSeconds(runOpts?.timeoutMs ?? maxCommandMs) + MODAL_EXEC_GRACE_MS;
      try {
        let script = command;
        if (Buffer.byteLength(command, "utf8") > MODAL_MAX_EXEC_ARG_BYTES) {
          const spooled = `/tmp/.qm-exec-${randomUUID()}.sh`;
          await sbx.filesystem.writeBytes(Buffer.from(command, "utf8"), spooled);
          script = `sh ${spooled}; rc=$?; rm -f ${spooled}; exit $rc`;
        }
        const p = await sbx.exec(["sh", "-c", script], {
          mode: "text",
          timeoutMs,
          ...(runOpts?.env && Object.keys(runOpts.env).length ? { env: runOpts.env } : {}),
        });
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
        if (isFileTooLargeError(err))
          throw new Error(
            `modal read ${absPath}: the file exceeds Modal's filesystem read limit; move it with blob staging or split it`,
            { cause: err },
          );
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
      const expiresAtMs = Date.now() + snapshotTtlMs;
      const image = await sbx.snapshotDirectory("/root", { ttlMs: snapshotTtlMs, timeoutMs: SNAPSHOT_CALL_TIMEOUT_MS });
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
          ...(createOpts.tags ? { tags: createOpts.tags } : {}),
          timeoutMs: sandboxTimeoutMs,
          idleTimeoutMs,
          cpu: opts.cpus ?? DEFAULT_CPUS,
          memoryMiB: opts.memoryMb ?? DEFAULT_MEMORY_MB,
          ...(opts.regions?.length ? { regions: opts.regions } : {}),
          ...network,
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
    async *listRunning(tags): AsyncIterable<string> {
      const { client, app } = await loadCtx();
      for await (const sbx of client.sandboxes.list({ appId: app.appId, tags })) {
        let exited: number | null;
        try {
          exited = await sbx.poll();
        } catch (err) {
          if (isSandboxGoneError(err)) continue;
          throw err;
        }
        if (exited === null) yield sbx.sandboxId;
      }
    },
  };
}
