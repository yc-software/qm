import { randomUUID } from "node:crypto";
import { egressProxyHost } from "./sandbox-env.ts";
import { isIP } from "node:net";
import { resolveModalImage } from "./modal-image.ts";
import { swallow } from "../util/errors.ts";
import { withTimeout } from "../util/async.ts";
import { perTenant } from "../tenant.ts";

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
  snapshotHome(): Promise<string>;
  restoreHome(imageId: string): Promise<void>;
  terminate(): Promise<void>;
}
export class ModalSandboxGoneError extends Error {
  constructor(sandboxId: string, detail: string, options?: ErrorOptions) {
    super(`modal sandbox ${sandboxId} is gone: ${detail}`, options);
    this.name = "ModalSandboxGoneError";
  }
}
export class ModalNameConflictError extends Error {
  constructor(name: string, detail: string, options?: ErrorOptions) {
    super(`modal sandbox name ${name} already taken: ${detail}`, options);
    this.name = "ModalNameConflictError";
  }
}

interface ModalCreateOpts {
  name?: string;
  tags?: Record<string, string>;
}

export interface ModalClient {
  readonly lifetimeMs: number;
  create(opts: ModalCreateOpts): Promise<ModalSession>;
  fromId(sandboxId: string): Promise<ModalSession>;
  fromName(name: string): Promise<ModalSession | null>;
  terminate(sandboxId: string): Promise<void>;
  listRunning?(tags: Record<string, string>): AsyncIterable<string>;
}

interface ModalApp {
  name: string;
  environment?: string;
}

export interface SdkModalClientOptions {
  tokenId: string;
  tokenSecret: string;
  app: () => ModalApp;
  image?: string;
  cpus?: number;
  memoryMb?: number;
  sandboxTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxCommandMs?: number;
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
const TERMINATE_WAIT_MS = 60_000;
export const MODAL_CHECKPOINT_RETENTION_MS = 30 * 24 * 3600_000;

function wholeSeconds(ms: number): number {
  return Math.max(1000, Math.ceil(ms / 1000) * 1000);
}

function errText(err: unknown): string {
  return String((err as Error)?.message ?? err);
}

type ModalSdk = typeof import("modal");

const GRPC_INVALID_ARGUMENT = 3;
const GRPC_NOT_FOUND = 5;

function grpcCode(err: unknown): unknown {
  return (err as { code?: unknown } | null)?.code;
}

function isSandboxGoneError(sdk: ModalSdk, err: unknown): boolean {
  return err instanceof sdk.NotFoundError || err instanceof sdk.ClientClosedError || grpcCode(err) === GRPC_NOT_FOUND;
}

function isSandboxIdLookupGone(sdk: ModalSdk, err: unknown): boolean {
  return isSandboxGoneError(sdk, err) || err instanceof sdk.InvalidError || grpcCode(err) === GRPC_INVALID_ARGUMENT;
}

async function stop(
  sdk: ModalSdk,
  sbx: { sandboxId: string; terminate(): Promise<unknown>; wait(): Promise<unknown> },
): Promise<void> {
  try {
    await sbx.terminate();
  } catch (err) {
    if (isSandboxGoneError(sdk, err)) return;
    throw err;
  }
  const label = `modal-client: wait for ${sbx.sandboxId} to stop`;
  await withTimeout(() => sbx.wait(), TERMINATE_WAIT_MS, label).catch((err: unknown) => {
    if (!isSandboxGoneError(sdk, err)) swallow(label, err);
  });
}

async function hasExited(
  sdk: ModalSdk,
  sbx: { sandboxId: string; poll(): Promise<number | null> },
  err: unknown,
): Promise<boolean> {
  if (isSandboxGoneError(sdk, err)) return true;
  try {
    return (await sbx.poll()) !== null;
  } catch (pollErr) {
    if (isSandboxGoneError(sdk, pollErr)) return true;
    swallow(`modal-client: poll ${sbx.sandboxId} after a failed call`, pollErr);
    return false;
  }
}

export function modalEgressAllowlist(
  egressProxyUrl: string,
): { outboundDomainAllowlist: string[] } | { outboundCidrAllowlist: string[] } {
  const url = new URL(egressProxyUrl);
  const host = egressProxyHost(egressProxyUrl);
  const ipVersion = isIP(host);
  if (ipVersion) return { outboundCidrAllowlist: [`${host}/${ipVersion === 4 ? 32 : 128}`] };
  if (url.protocol === "https:" && (url.port === "" || url.port === "443")) return { outboundDomainAllowlist: [host] };
  throw new Error(
    "SANDBOX_EGRESS_PROXY_URL must be an https URL on port 443 or an IP address: Modal domain allowlists pass only TLS traffic on port 443",
  );
}

type SdkClient = InstanceType<ModalSdk["ModalClient"]>;
type SdkApp = Awaited<ReturnType<SdkClient["apps"]["fromName"]>>;
type SdkImage = ReturnType<SdkClient["images"]["fromRegistry"]>;
type SdkSandbox = Awaited<ReturnType<SdkClient["sandboxes"]["fromId"]>>;

type Ctx = { sdk: ModalSdk; client: SdkClient; app: SdkApp; image: SdkImage };

const wrap = (sdk: ModalSdk, sbx: SdkSandbox, maxCommandMs: number, loadCtx: () => Promise<Ctx>): ModalSession => ({
  sandboxId: sbx.sandboxId,
  async runCommand(command, runOpts): Promise<ModalCommandResult> {
    const commandMs = wholeSeconds(runOpts?.timeoutMs ?? maxCommandMs);
    const timeoutMs = commandMs + MODAL_EXEC_GRACE_MS;
    try {
      let args = ["timeout", String(commandMs / 1000), "sh", "-c", command];
      if (Buffer.byteLength(command, "utf8") > MODAL_MAX_EXEC_ARG_BYTES) {
        const spooled = `/tmp/.qm-exec-${randomUUID()}.sh`;
        await sbx.filesystem.writeBytes(Buffer.from(command, "utf8"), spooled);
        args = ["sh", "-c", `timeout ${commandMs / 1000} sh ${spooled}; rc=$?; rm -f ${spooled}; exit $rc`];
      }
      const p = await sbx.exec(args, {
        mode: "text",
        timeoutMs,
        ...(runOpts?.env && Object.keys(runOpts.env).length ? { env: runOpts.env } : {}),
      });
      const [stdout, stderr, exitCode] = await Promise.all([p.stdout.readText(), p.stderr.readText(), p.wait()]);
      return { stdout, stderr, exitCode };
    } catch (err) {
      if (await hasExited(sdk, sbx, err)) throw new ModalSandboxGoneError(sbx.sandboxId, errText(err), { cause: err });
      if (err instanceof sdk.TimeoutError) return { stdout: "", stderr: errText(err), exitCode: 124 };
      throw err;
    }
  },
  async readFileBytes(absPath): Promise<Uint8Array | null> {
    try {
      return await sbx.filesystem.readBytes(absPath);
    } catch (err) {
      if (err instanceof sdk.SandboxFilesystemNotFoundError) return null;
      if (err instanceof sdk.SandboxFilesystemFileTooLargeError)
        throw new Error(
          `modal read ${absPath}: the file exceeds Modal's filesystem read limit; move it with blob staging or split it`,
          { cause: err },
        );
      if (await hasExited(sdk, sbx, err)) throw new ModalSandboxGoneError(sbx.sandboxId, errText(err), { cause: err });
      throw err;
    }
  },
  async writeFileBytes(absPath, data): Promise<void> {
    try {
      await sbx.filesystem.writeBytes(data, absPath);
    } catch (err) {
      if (await hasExited(sdk, sbx, err)) throw new ModalSandboxGoneError(sbx.sandboxId, errText(err), { cause: err });
      throw err;
    }
  },
  async snapshotHome() {
    const image = await sbx.snapshotDirectory("/root", {
      ttlMs: MODAL_CHECKPOINT_RETENTION_MS,
      timeoutMs: SNAPSHOT_CALL_TIMEOUT_MS,
    });
    return image.imageId;
  },
  async restoreHome(imageId): Promise<void> {
    const { client } = await loadCtx();
    await sbx.mountImage("/root", await client.images.fromId(imageId));
  },
  terminate: () => stop(sdk, sbx),
});

export function createSdkModalClient(opts: SdkModalClientOptions): ModalClient {
  const sandboxTimeoutMs = wholeSeconds(Math.min(opts.sandboxTimeoutMs ?? MAX_LIFETIME_MS, MAX_LIFETIME_MS));
  const idleTimeoutMs = wholeSeconds(Math.min(opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS, sandboxTimeoutMs));
  const maxCommandMs = opts.maxCommandMs ?? DEFAULT_MAX_COMMAND_MS;
  const network = opts.egressProxyUrl ? modalEgressAllowlist(opts.egressProxyUrl) : {};
  const ctxByTenant = perTenant(
    () => ({ ctx: null as Promise<Ctx> | null }),
    (slot) => slot.ctx?.then(({ client }) => client.close()).catch(() => {}),
  );
  const buildCtx = async (): Promise<Ctx> => {
    let sdk: ModalSdk;
    try {
      sdk = (await import("modal")) as unknown as ModalSdk;
    } catch (e) {
      throw new Error(`the modal SDK is not installed: ${errText(e)}`, { cause: e });
    }
    const { name, environment } = opts.app();
    const client = new sdk.ModalClient({
      tokenId: opts.tokenId,
      tokenSecret: opts.tokenSecret,
      ...(environment ? { environment } : {}),
    });
    const app = await client.apps.fromName(name, { createIfMissing: true });
    const image = await resolveModalImage(client, opts.image);
    return { sdk, client, app, image };
  };
  const loadCtx = (): Promise<Ctx> => {
    const slot = ctxByTenant();
    return (slot.ctx ??= buildCtx().catch((e) => {
      slot.ctx = null;
      throw e;
    }));
  };

  return {
    lifetimeMs: sandboxTimeoutMs,
    async create(createOpts): Promise<ModalSession> {
      const { sdk, client, app, image } = await loadCtx();
      try {
        const sbx = await client.sandboxes.create(app, image, {
          ...(createOpts.name ? { name: createOpts.name } : {}),
          ...(createOpts.tags ? { tags: createOpts.tags } : {}),
          timeoutMs: sandboxTimeoutMs,
          idleTimeoutMs,
          cpu: opts.cpus ?? DEFAULT_CPUS,
          memoryMiB: opts.memoryMb ?? DEFAULT_MEMORY_MB,
          ...network,
        });
        return wrap(sdk, sbx, maxCommandMs, loadCtx);
      } catch (err) {
        if (err instanceof sdk.AlreadyExistsError)
          throw new ModalNameConflictError(createOpts.name ?? "(unnamed)", errText(err), { cause: err });
        throw err;
      }
    },
    async fromId(sandboxId): Promise<ModalSession> {
      const { sdk, client } = await loadCtx();
      try {
        const sbx = await client.sandboxes.fromId(sandboxId);
        const exited = await sbx.poll();
        if (exited !== null) throw new ModalSandboxGoneError(sandboxId, `exited with code ${exited}`);
        return wrap(sdk, sbx, maxCommandMs, loadCtx);
      } catch (err) {
        if (err instanceof ModalSandboxGoneError) throw err;
        if (isSandboxIdLookupGone(sdk, err)) throw new ModalSandboxGoneError(sandboxId, errText(err), { cause: err });
        throw err;
      }
    },
    async fromName(name): Promise<ModalSession | null> {
      const { sdk, client } = await loadCtx();
      let sbx: SdkSandbox;
      try {
        sbx = await client.sandboxes.fromName(opts.app().name, name);
      } catch (err) {
        if (isSandboxGoneError(sdk, err)) return null;
        throw err;
      }
      try {
        const exited = await sbx.poll();
        if (exited !== null) return null;
      } catch (err) {
        if (isSandboxGoneError(sdk, err)) return null;
        throw err;
      }
      return wrap(sdk, sbx, maxCommandMs, loadCtx);
    },
    async terminate(sandboxId): Promise<void> {
      const { sdk, client } = await loadCtx();
      let sbx: SdkSandbox;
      try {
        sbx = await client.sandboxes.fromId(sandboxId);
      } catch (err) {
        if (isSandboxIdLookupGone(sdk, err)) return;
        throw err;
      }
      await stop(sdk, sbx);
    },
    async *listRunning(tags): AsyncIterable<string> {
      const { sdk, client, app } = await loadCtx();
      for await (const sbx of client.sandboxes.list({ appId: app.appId, tags })) {
        let exited: number | null;
        try {
          exited = await sbx.poll();
        } catch (err) {
          if (isSandboxGoneError(sdk, err)) continue;
          throw err;
        }
        if (exited === null) yield sbx.sandboxId;
      }
    },
  };
}
