import { randomUUID } from "node:crypto";
import {
  SandboxApiError,
  SandboxClient,
  SandboxGatewayError,
  SandboxProcessWaitTimeoutError,
  type Sandbox as BasetenBox,
  type SandboxInfo,
  type SandboxProcessInfo,
  type VolumeInfo,
} from "@basetenlabs/sandbox";
import { sleep } from "../util/async.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import { errMessage } from "../util/errors.ts";
import { shq } from "../util/shell.ts";
import { ephemeralCredLinkPaths, type CredentialPathSpec } from "../credentials/resident-paths.ts";
import type { LayerInstallFile } from "../deployment/load-layer.ts";
import { createLayerToolInstaller } from "./layer-tool-install.ts";
import { createExecSandboxBase, sandboxScopeName } from "./exec-sandbox-base.ts";
import { createExecProcessSessions } from "./exec-process-session.ts";
import {
  createBackendBlobStaging,
  createExecExport,
  createExecFileOps,
  type BlobStagingOptions,
} from "./exec-file-ops.ts";
import {
  SANDBOX_BASE_IMAGE_SPEC,
  visibleNotInstalled,
  visibleTools,
  type ExecResult,
  type Sandbox,
} from "./sandbox.ts";

const HOME_DIR = "/root";
const MEMORY_MB = 8192;
const HOME_VOLUME_GB = 10;
const MAX_NAME_LENGTH = 49;
const BLOCKING_REQUEST_MS = 60_000;
const KILL_AFTER_SEC = 10;
const TIMEOUT_EXIT_CODE = 124;
const TIMEOUT_KILLED_EXIT_CODE = 137;
const EXEC_GRACE_MS = 60_000;
const POLL_MS = 1_000;
const READY_TIMEOUT_MS = 300_000;
const REPLACEABLE_STATUSES = new Set(["DELETING", "TERMINATED", "FAILED"]);

export interface BasetenSandboxOptions extends BlobStagingOptions {
  apiKey?: string;
  image?: string;
  namePrefix?: string;
  defaultTimeoutSec?: number;
  egressProxyUrl?: string;
  apiUrl?: string;
  extraTools?: string[];
  credentialPaths?: CredentialPathSpec[];
  layerToolFiles?: () => readonly LayerInstallFile[];
  fetchImpl?: typeof fetch;
  advisoryLock: AdvisoryLock;
  onError?: (e: { category: string; code: string; message: string; scopeLabel?: string }) => void;
}

const notFound = (error: unknown): boolean => error instanceof SandboxApiError && error.status === 404;
const orNull = <T>(request: Promise<T>): Promise<T | null> =>
  request.catch((error: unknown) => {
    if (notFound(error)) return null;
    throw error;
  });

export function createBasetenSandbox(opts: BasetenSandboxOptions): Sandbox {
  if (!opts.apiKey) throw new Error("SANDBOX_BACKEND=baseten requires BASETEN_API_KEY");
  if (!opts.image) throw new Error("SANDBOX_BACKEND=baseten requires BASETEN_SANDBOX_IMAGE");
  const image = opts.image;
  const prefix = opts.namePrefix ?? "qm";
  const defaultTimeoutSec = opts.defaultTimeoutSec ?? 600;
  const client = new SandboxClient({
    apiKey: opts.apiKey,
    ...(opts.apiUrl ? { baseUrlOverride: opts.apiUrl } : {}),
    ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
  });
  const boxByName = new Map<string, BasetenBox>();

  const info = (name: string): Promise<SandboxInfo | null> => orNull(client.getInfo({ name }));

  async function homeVolume(name: string): Promise<VolumeInfo> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      const volume =
        (await orNull(client.volumes.getInfo({ name }))) ??
        (await client.volumes.create({ name, size: `${HOME_VOLUME_GB}Gi` }));
      if (volume.status === "DEPLOYED") return volume;
      if (volume.status === "FAILED") throw new Error(`baseten volume ${name} failed to deploy`);
      if (Date.now() > deadline)
        throw new Error(
          `baseten volume ${name}: not ready after ${READY_TIMEOUT_MS / 1000}s (status ${volume.status})`,
        );
      await sleep(POLL_MS);
    }
  }

  async function deleteHomeVolume(name: string): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      try {
        await orNull(client.volumes.delete({ name }));
        return;
      } catch (error) {
        const stillAttached = error instanceof SandboxApiError && error.status === 409;
        if (!stillAttached || Date.now() > deadline) throw error;
      }
      await sleep(POLL_MS);
    }
  }

  async function waitReady(name: string, first: SandboxInfo | null): Promise<BasetenBox> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let current = first;
    for (;;) {
      if (current?.status === "DEPLOYED" && current.url) return client.get({ info: current });
      if (current?.status === "FAILED")
        throw new Error(`baseten sandbox ${name} failed to deploy; its logs are in the Baseten dashboard`);
      if (Date.now() > deadline)
        throw new Error(
          `baseten sandbox ${name}: not ready after ${READY_TIMEOUT_MS / 1000}s (${current ? `status ${current.status}` : "not found"})`,
        );
      await sleep(POLL_MS);
      current = await info(name);
    }
  }

  function ensureSandbox(name: string, withHome: boolean, onStatus?: (text: string) => void): Promise<boolean> {
    return opts.advisoryLock.withLock(`baseten-provision:${name}`, async () => {
      const current = await info(name);
      if (current?.status === "FAILED")
        opts.onError?.({
          category: "sandbox_provision",
          code: "sandbox_failed",
          message: `baseten sandbox ${name} was FAILED and is replaced`,
        });
      const replace = !current || REPLACEABLE_STATUSES.has(current.status);
      if (replace) {
        boxByName.delete(name);
        onStatus?.("Creating the sandbox…");
        const home = withHome ? await homeVolume(name) : null;
        await client.create({
          name,
          image,
          memory: MEMORY_MB,
          createIfNotExists: true,
          ...(home ? { region: home.region, volumes: [{ name, mountPath: HOME_DIR }] } : {}),
        });
      }
      boxByName.set(name, await waitReady(name, replace ? await info(name) : current));
      return replace;
    });
  }

  async function deleteSandbox(name: string): Promise<void> {
    boxByName.delete(name);
    await orNull(client.delete({ name }));
  }

  const lockedDelete = (name: string): Promise<void> =>
    opts.advisoryLock.withLock(`baseten-provision:${name}`, async () => {
      await deleteSandbox(name);
      await deleteHomeVolume(name);
    });

  async function boxFor(name: string): Promise<BasetenBox> {
    const cached = boxByName.get(name);
    if (cached) return cached;
    const current = await info(name);
    if (!current || REPLACEABLE_STATUSES.has(current.status))
      throw new Error(
        `baseten sandbox ${name} is gone (${current ? `status ${current.status}` : "not found"}); the next provision creates a replacement`,
      );
    const box = await waitReady(name, current);
    boxByName.set(name, box);
    return box;
  }

  async function onBox<T>(name: string, call: (box: BasetenBox) => Promise<T>): Promise<T> {
    try {
      return await call(await boxFor(name));
    } catch (error) {
      if (!(error instanceof SandboxApiError) || error.status >= 500) boxByName.delete(name);
      throw error;
    }
  }

  const cutOffReason = (error: unknown): string | null => {
    if (error instanceof SandboxGatewayError) return `gateway ${error.status}`;
    if (error instanceof SandboxApiError) return null;
    if (error instanceof Error && (error.name === "TimeoutError" || error instanceof TypeError))
      return errMessage(error);
    return null;
  };

  async function runProcess(name: string, command: string, timeoutSec: number): Promise<SandboxProcessInfo> {
    const processName = `qm-${randomUUID()}`;
    const deadline = Date.now() + timeoutSec * 1000 + EXEC_GRACE_MS;
    for (;;) {
      let cutOff: string;
      let cause: unknown;
      try {
        const state = await onBox(name, (box) =>
          box.process.exec({
            name: processName,
            command,
            waitForCompletion: true,
            callOptions: { signal: AbortSignal.timeout(BLOCKING_REQUEST_MS) },
          }),
        );
        if (state.status !== "running") return state;
        cutOff = "the request returned while the command was running";
      } catch (error) {
        const reason = cutOffReason(error);
        if (reason === null) throw error;
        cutOff = reason;
        cause = error;
      }
      try {
        return await onBox(name, (box) =>
          box.process.wait({ identifier: processName, timeoutMs: Math.max(deadline - Date.now(), POLL_MS) }),
        );
      } catch (error) {
        if (!notFound(error)) {
          if (error instanceof SandboxProcessWaitTimeoutError)
            throw new Error(`baseten exec ${name}: still running at its deadline (${cutOff})`, { cause: error });
          throw error;
        }
      }
      if (Date.now() > deadline)
        throw new Error(`baseten exec ${name}: the command did not start (${cutOff})`, { cause });
      await sleep(POLL_MS);
    }
  }

  async function exec(name: string, script: string, timeoutSec: number): Promise<ExecResult> {
    const startedAt = Date.now();
    const command = `export HOME=${shq(HOME_DIR)}; timeout -k ${KILL_AFTER_SEC} ${timeoutSec} sh -c ${shq(script)}`;
    const result = await runProcess(name, command, timeoutSec);
    if (result.exitCode === undefined)
      throw new Error(
        `baseten exec ${name}: process ended with status ${result.status} and no exit code; stdout: ${result.stdout ?? ""}; stderr: ${result.stderr ?? ""}`,
      );
    const code = result.exitCode;
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      code,
      timedOut:
        code === TIMEOUT_EXIT_CODE ||
        (code === TIMEOUT_KILLED_EXIT_CODE && Date.now() - startedAt >= timeoutSec * 1000),
    };
  }

  const writeAbsBytes = (name: string, absPath: string, data: Uint8Array): Promise<void> =>
    onBox(name, (box) => box.fs.writeBytes({ path: absPath, content: data, permissions: "0644" }));

  const readAbsBytes = (name: string, absPath: string): Promise<Uint8Array | null> =>
    orNull(onBox(name, (box) => box.fs.readBytes({ path: absPath })));

  const base = createExecSandboxBase({
    label: "baseten",
    prefix,
    instanceName: async (scope, scratch) =>
      sandboxScopeName(scratch ? `${prefix}-scratch` : prefix, scope, MAX_NAME_LENGTH),
    ...(opts.egressProxyUrl ? { egressProxyUrl: opts.egressProxyUrl } : {}),
    homeDir: HOME_DIR,
    defaultTimeoutSec,
    credentialPaths: opts.credentialPaths ?? [],
    deleteFailureCode: "sandbox_delete_failed",
    ...(opts.onError ? { onError: opts.onError } : {}),
    exec,
    writeAbsBytes,
    readAbsBytes,
    ensureResident: async (name, onStatus) => ({ coldStart: await ensureSandbox(name, true, onStatus) }),
    isProvisioned: (name) => boxByName.has(name),
    async recreateScratch(name) {
      await opts.advisoryLock.withLock(`baseten-provision:${name}`, () => deleteSandbox(name));
      await ensureSandbox(name, false);
    },
    deleteInstance: lockedDelete,
    forgetInstance: (name) => boxByName.delete(name),
    ...(opts.layerToolFiles ? { installLayerTools: createLayerToolInstaller(opts.layerToolFiles) } : {}),
  });
  const processes = createExecProcessSessions({
    run: (handle, command, options) =>
      exec(handle.id, command, options?.timeoutMs ? Math.ceil(options.timeoutMs / 1000) : defaultTimeoutSec),
  });
  const staging = createBackendBlobStaging("baseten", exec, opts);
  const files = createExecFileOps({ label: "baseten", exec, writeInline: writeAbsBytes });
  const exports = createExecExport({
    label: "baseten",
    exec,
    readAbsBytes,
    defaultHomeDir: HOME_DIR,
    ephemeralCredentialPrefixes: ephemeralCredLinkPaths(opts.credentialPaths ?? []).map(({ rel }) => rel),
  });

  return {
    profile: {
      backend: "baseten",
      writablePersistence: "resident_disk",
      processSessions: true,
      egressEnforcement: "none",
      spec: {
        os: `Debian 12 — Baseten sandbox from the QM sandbox base image (home, with the workspace, is a ${HOME_VOLUME_GB} GB volume of this scope that survives Baseten deleting the sandbox 7 days after it was created; the rest of the disk is held in memory and starts fresh then; standby keeps running processes)`,
        runtimes: [...SANDBOX_BASE_IMAGE_SPEC.runtimes],
        memoryMb: MEMORY_MB,
        diskGb: HOME_VOLUME_GB,
        homeDir: HOME_DIR,
        workdir: base.workspaceDir,
        get tools() {
          return visibleTools([...SANDBOX_BASE_IMAGE_SPEC.tools, ...(opts.extraTools ?? [])]);
        },
        get notInstalled() {
          return visibleNotInstalled(SANDBOX_BASE_IMAGE_SPEC.notInstalled, opts.extraTools ?? []);
        },
      },
    },
    provision: base.provision,
    run: base.run,
    readFile: base.readFile,
    writeFile: base.writeFile,
    readFileBytes: base.readFileBytes,
    writeFileBytes: base.writeFileBytes,
    teardown: base.teardown,
    ...files,
    ...staging,
    exportFiles: exports.exportFiles,
    ...processes,
    destroyScope: (scopeId) =>
      base.provisionQueue(scopeId, () => {
        return lockedDelete(sandboxScopeName(prefix, scopeId, MAX_NAME_LENGTH));
      }),
  };
}
