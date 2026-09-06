import { randomUUID } from "node:crypto";
import type { WorkspaceLayer } from "../types.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { createMemoryMap } from "../persistence/durable-map.ts";
import { orgId as configOrgId } from "../config.ts";
import { createKeyedQueue } from "../util/async.ts";
import { collectBlob } from "../persistence/blob-transfer.ts";
import { swallowAs, errMessage } from "../util/errors.ts";
import { shq } from "../util/shell.ts";
import { nonInteractiveShellPrefix, DROPPED_PROXY_ENV, forceThroughProxyEnv } from "./sandbox-env.ts";
import { createExecProcessSessions, type ExecProcessIo } from "./exec-process-session.ts";
import { materializeRoLayers } from "./ro-layers.ts";
import { createLayerToolInstaller } from "./layer-tool-install.ts";
import type { LayerInstallFile } from "../deployment/load-layer.ts";
import {
  createBackendBlobStaging,
  createExecExport,
  createExecFileOps,
  posixJoin,
  type BlobStagingOptions,
} from "./exec-file-ops.ts";
import {
  ephemeralCredLinkScript,
  ephemeralCredLinkPaths,
  type CredentialPathSpec,
} from "../credentials/resident-paths.ts";
import { killableScript, killScript } from "./exec-kill.ts";
import { visibleNotInstalled, visibleTools } from "./sandbox.ts";
import { sandboxScopeName } from "./exec-sandbox-base.ts";
import { ModalNameConflictError, ModalSandboxGoneError, type ModalClient, type ModalSession } from "./modal-client.ts";
import {
  createHomeSnapshotOps,
  createMemorySnapshotStore,
  HOME_SNAPSHOT_PRUNE,
  snapshotDue,
  type HomeSnapshotStore,
} from "./home-snapshot.ts";
import type {
  AgentComputerProfile,
  ComputerStatus,
  ExecOptions,
  ExecResult,
  ProvisionOptions,
  Sandbox,
  SandboxHandle,
  TeardownOptions,
} from "./sandbox.ts";

const HOME_DIR = "/root";
const WORKSPACE_BASENAME = "workspace";
const RO_LAYERS_TAR = ".ro-layers.tar";
const RO_LAYERS_MANIFEST = ".ro-layers.manifest";
const HOME_TAR = `${HOME_DIR}/.qm-home.tar`;
const HYDRATED_MARKER = `${HOME_DIR}/.qm-hydrated`;
const IN_MEMORY_ADOPT_MAX_BYTES = 256 * 1024 * 1024;
const ACTIVITY_TOUCH_INTERVAL_MS = 10 * 60_000;
const SNAPSHOT_PRUNE = ["./.qm-hydrated", ...HOME_SNAPSHOT_PRUNE];

export interface StoredModalSandbox {
  sandboxId: string;
  createdAtMs: number;
  lastSnapshotMs?: number;
  lastActivityMs?: number;
  homeDirty?: boolean;
  orgId?: string;
}

export interface ModalSandboxOptions extends BlobStagingOptions {
  client: ModalClient;
  namePrefix?: string;
  defaultTimeoutSec?: number;
  snapshotIntervalMs?: number;
  rotateAfterMs?: number;
  reapIdleMs?: number;
  egressProxyUrl?: string;
  extraTools?: string[];
  credentialPaths?: CredentialPathSpec[];
  layerToolFiles?: () => readonly LayerInstallFile[];
  fileChunkBytes?: number;
  rotationHoldMs?: number;
  store?: DurableMap<StoredModalSandbox>;
  snapshots?: HomeSnapshotStore;
  onError?: (e: { category: string; code: string; message: string; scopeLabel?: string }) => void;
}

export function createModalSandbox(workspace: WorkspaceStore, opts: ModalSandboxOptions): Sandbox {
  const client = opts.client;
  const prefix = opts.namePrefix ?? "qm";
  const defaultTimeoutSec = opts.defaultTimeoutSec ?? 600;
  const snapshotIntervalMs = opts.snapshotIntervalMs ?? 0;
  const rotateAfterMs = opts.rotateAfterMs ?? 20 * 3600_000;
  const reapIdleMs = opts.reapIdleMs ?? 6 * 3600_000;
  const fileChunkBytes = opts.fileChunkBytes ?? 64 * 1024 * 1024;
  const rotationHoldMs = opts.rotationHoldMs ?? 10 * 60_000;
  const rotationHoldUntil = new Map<string, number>();
  const workspaceDir = `${HOME_DIR}/${WORKSPACE_BASENAME}`;
  const store = opts.store ?? createMemoryMap<StoredModalSandbox>();
  const snapshots = opts.snapshots ?? createMemorySnapshotStore();
  const provisionQueue = createKeyedQueue<string>();

  const sessionByName = new Map<string, ModalSession>();
  const scopeByName = new Map<string, string>();
  const scratchKeyByName = new Map<string, string>();
  const activeScratch = new Map<string, number>();

  const reportError = (category: string, code: string, message: string, scopeLabel?: string): void => {
    opts.onError?.({ category, code, message, ...(scopeLabel ? { scopeLabel } : {}) });
  };

  const homeSnapshots = createHomeSnapshotOps<ModalSession>({
    label: "modal",
    homeDir: HOME_DIR,
    homeTarPath: HOME_TAR,
    prunePaths: [...SNAPSHOT_PRUNE, ...ephemeralCredLinkPaths(opts.credentialPaths ?? []).map(({ rel }) => `./${rel}`)],
    store: snapshots,
    io: {
      runCommand: (session, script, timeoutMs) => session.runCommand(script, { timeoutMs }),
      readFileBytes: (session, abs) => session.readFileBytes(abs),
      writeFileBytes: (session, abs, data) => session.writeFileBytes(abs, data),
    },
    partBytes: fileChunkBytes,
  });

  async function snapshotHome(scope: string, session: ModalSession): Promise<void> {
    const marked = await session.runCommand(`test -f ${shq(HYDRATED_MARKER)}`, { timeoutMs: 30_000 });
    if (marked.exitCode !== 0)
      throw new Error(
        "modal snapshot refused: this sandbox never finished hydrating, its home is not a trustworthy source",
      );
    await homeSnapshots.snapshotHome(scope, session);
    await store.merge(scope, { lastSnapshotMs: Date.now(), homeDirty: false });
  }

  async function createHydrated(scope: string, name: string): Promise<{ session: ModalSession; coldStart: boolean }> {
    let session: ModalSession;
    try {
      session = await client.create({ name });
    } catch (err) {
      if (!(err instanceof ModalNameConflictError)) throw err;
      const adopted = await client.fromName(name);
      if (!adopted) throw err;
      sessionByName.set(name, adopted);
      const merged = await store.merge(scope, { sandboxId: adopted.sandboxId, lastActivityMs: Date.now() });
      if (!merged) {
        await store.put(scope, {
          sandboxId: adopted.sandboxId,
          createdAtMs: Date.now(),
          lastActivityMs: Date.now(),
          orgId: configOrgId(),
        });
      }
      return { session: adopted, coldStart: false };
    }
    sessionByName.set(name, session);
    await store.put(scope, {
      sandboxId: session.sandboxId,
      createdAtMs: Date.now(),
      lastActivityMs: Date.now(),
      orgId: configOrgId(),
    });
    let hydrated: boolean;
    try {
      hydrated = await homeSnapshots.hydrateHome(scope, session);
    } catch (e) {
      reportError("sandbox_hydrate", "hydrate_failed", errMessage(e), scope);
      sessionByName.delete(name);
      await session.terminate().catch(() => undefined);
      throw new Error(`modal provision: home hydration failed (${errMessage(e)}); not risking the stored snapshot`, {
        cause: e,
      });
    }
    const marked = await session.runCommand(`touch ${shq(HYDRATED_MARKER)}`, { timeoutMs: 30_000 });
    if (marked.exitCode !== 0) {
      sessionByName.delete(name);
      await session.terminate().catch(() => undefined);
      throw new Error(`modal provision: could not mark the sandbox hydrated: ${marked.stderr.slice(0, 200)}`);
    }
    if (hydrated) await store.merge(scope, { lastSnapshotMs: Date.now() });
    return { session, coldStart: !hydrated };
  }

  async function ensureSession(
    scope: string,
    name: string,
    onStatus?: (text: string) => void,
  ): Promise<{ session: ModalSession; coldStart: boolean }> {
    return provisionQueue(scope, async () => {
      const adopt = async (session: ModalSession): Promise<{ session: ModalSession; coldStart: boolean }> => {
        sessionByName.set(name, session);
        await store.merge(scope, { lastActivityMs: Date.now() });
        return { session, coldStart: false };
      };

      const stored = await store.get(scope);
      const stale =
        !!stored &&
        Date.now() - stored.createdAtMs > rotateAfterMs &&
        Date.now() >= (rotationHoldUntil.get(scope) ?? 0);

      const cached = sessionByName.get(name);
      if (cached && !stale) return { session: cached, coldStart: false };

      if (stored && !stale) {
        try {
          return await adopt(await client.fromId(stored.sandboxId));
        } catch (err) {
          if (!(err instanceof ModalSandboxGoneError)) throw err;
        }
        const found = await client.fromName(name);
        if (found) {
          await store.merge(scope, { sandboxId: found.sandboxId });
          return adopt(found);
        }
      }

      if (stored && stale) {
        let session: ModalSession | null = null;
        try {
          session = cached ?? (await client.fromId(stored.sandboxId));
        } catch (err) {
          if (!(err instanceof ModalSandboxGoneError)) throw err;
        }
        if (session) {
          try {
            await snapshotHome(scope, session);
          } catch (e) {
            if (!(e instanceof ModalSandboxGoneError)) {
              reportError("sandbox_snapshot", "rotate_snapshot_failed", errMessage(e), scope);
              rotationHoldUntil.set(scope, Date.now() + rotationHoldMs);
              sessionByName.set(name, session);
              await store.merge(scope, { lastActivityMs: Date.now() });
              return { session, coldStart: false };
            }
          }
          try {
            await session.terminate();
          } catch (e) {
            if (!(e instanceof ModalSandboxGoneError)) {
              reportError("sandbox_teardown", "rotate_terminate_failed", errMessage(e), scope);
              rotationHoldUntil.set(scope, Date.now() + rotationHoldMs);
              sessionByName.set(name, session);
              await store.merge(scope, { lastActivityMs: Date.now() });
              return { session, coldStart: false };
            }
          }
        }
        sessionByName.delete(name);
        await store.delete(scope).catch(() => undefined);
      }

      if (!stored) {
        const found = await client.fromName(name);
        if (found) {
          await store.put(scope, {
            sandboxId: found.sandboxId,
            createdAtMs: Date.now(),
            lastActivityMs: Date.now(),
            orgId: configOrgId(),
          });
          sessionByName.set(name, found);
          return { session: found, coldStart: false };
        }
      }

      try {
        onStatus?.("Creating the sandbox…");
      } catch (error) {
        void error;
      }
      return createHydrated(scope, name);
    });
  }

  async function ensureScratch(key: string): Promise<{ name: string; coldStart: boolean }> {
    const name = sandboxScopeName(`${prefix}-scratch`, key);
    return provisionQueue(`scratch:${key}`, async () => {
      scratchKeyByName.set(name, key);
      const active = activeScratch.get(name) ?? 0;
      if (active === 0 && !sessionByName.has(name)) {
        const session = await client.create({});
        sessionByName.set(name, session);
      }
      activeScratch.set(name, active + 1);
      return { name, coldStart: active === 0 };
    });
  }

  async function withSession<T>(name: string, action: (session: ModalSession) => Promise<T>): Promise<T> {
    const scratchKey = scratchKeyByName.get(name);
    const reviveScratch = async (): Promise<ModalSession> => {
      const session = await client.create({});
      sessionByName.set(name, session);
      return session;
    };
    const first =
      scratchKey !== undefined
        ? { session: sessionByName.get(name) ?? (await reviveScratch()) }
        : await ensureSession(scopeByName.get(name) ?? "default", name);
    try {
      return await action(first.session);
    } catch (err) {
      if (!(err instanceof ModalSandboxGoneError)) throw err;
      sessionByName.delete(name);
      const second =
        scratchKey !== undefined
          ? { session: await reviveScratch() }
          : await ensureSession(scopeByName.get(name) ?? "default", name);
      return action(second.session);
    }
  }

  const lastTouchMs = new Map<string, number>();
  async function touchActivity(name: string): Promise<void> {
    const scope = scopeByName.get(name);
    if (!scope || scratchKeyByName.has(name)) return;
    const now = Date.now();
    if (now - (lastTouchMs.get(scope) ?? 0) < ACTIVITY_TOUCH_INTERVAL_MS) return;
    lastTouchMs.set(scope, now);
    await store.merge(scope, { lastActivityMs: now }).catch(() => undefined);
  }

  async function execRaw(name: string, script: string, timeoutSec: number): Promise<ExecResult> {
    await touchActivity(name);
    return withSession(name, async (session) => {
      const r = await session.runCommand(`timeout ${timeoutSec} sh -c ${shq(script)}`, {
        timeoutMs: timeoutSec * 1000 + 30_000,
      });
      return { stdout: r.stdout, stderr: r.stderr, code: r.exitCode, timedOut: r.exitCode === 124 };
    });
  }

  const profile: AgentComputerProfile = {
    backend: "modal",
    writablePersistence: "snapshot_to_workspace",
    processSessions: true,
    egressEnforcement: "none",
    spec: {
      os: "Ubuntu — Modal sandbox (24h max lifetime; home is snapshotted and restored onto fresh sandboxes)",
      runtimes: ["Python 3"],
      get tools() {
        return visibleTools(["git", "curl", "jq", "tar", "python3", ...(opts.extraTools ?? [])]);
      },
      get notInstalled() {
        return visibleNotInstalled(["gh", "aws", "gcloud", "kubectl", "flyctl", "glab"], opts.extraTools ?? []);
      },
      homeDir: HOME_DIR,
      workdir: workspaceDir,
    },
  };

  const procIo: ExecProcessIo = {
    async run(handle, command, execOpts): Promise<ExecResult> {
      const timeoutSec = execOpts?.timeoutMs ? Math.ceil(execOpts.timeoutMs / 1000) : defaultTimeoutSec;
      return execRaw(handle.id, command, timeoutSec);
    },
  };
  const procSessions = createExecProcessSessions(procIo);

  const directProcIo = (session: ModalSession): ExecProcessIo => ({
    async run(_handle, command, execOpts): Promise<ExecResult> {
      const timeoutSec = execOpts?.timeoutMs ? Math.ceil(execOpts.timeoutMs / 1000) : defaultTimeoutSec;
      const r = await session.runCommand(`timeout ${timeoutSec} sh -c ${shq(command)}`, {
        timeoutMs: timeoutSec * 1000 + 30_000,
      });
      return { stdout: r.stdout, stderr: r.stderr, code: r.exitCode, timedOut: r.exitCode === 124 };
    },
  });

  const writeAbsBytes = (name: string, absPath: string, data: Uint8Array): Promise<void> =>
    withSession(name, (session) => session.writeFileBytes(absPath, data));
  const readAbsBytes = (name: string, absPath: string): Promise<Uint8Array | null> =>
    withSession(name, (session) => session.readFileBytes(absPath));
  const installLayerTools = opts.layerToolFiles ? createLayerToolInstaller(opts.layerToolFiles) : null;

  const execFileOps = createExecFileOps({
    label: "modal",
    exec: (id, script, t) => execRaw(id, script, t),
    writeInline: (id, abs, data) => writeAbsBytes(id, abs, data),
  });

  const execExport = createExecExport({
    label: "modal",
    exec: (id, script, t) => execRaw(id, script, t),
    readAbsBytes,
    defaultHomeDir: HOME_DIR,
    ephemeralCredentialPrefixes: ephemeralCredLinkPaths(opts.credentialPaths ?? []).map(({ rel }) => rel),
  });

  const blobStaging = createBackendBlobStaging("modal", (id, script, t) => execRaw(id, script, t), opts);

  const sandbox: Sandbox = {
    profile,
    startProcess: procSessions.startProcess,
    readProcess: procSessions.readProcess,
    writeStdin: procSessions.writeStdin,
    signalProcess: procSessions.signalProcess,
    listProcesses: procSessions.listProcesses,
    ...execFileOps,
    ...blobStaging,

    async provision(layers: WorkspaceLayer[], provOpts?: ProvisionOptions): Promise<SandboxHandle> {
      const scratch = provOpts?.scratch;
      const writable = layers.find((l) => l.mode === "rw") ?? layers[0];
      const scope = writable?.scopeId ?? "default";
      let name: string;
      let coldStart: boolean;
      if (scratch) {
        ({ name, coldStart } = await ensureScratch(scratch.key));
      } else {
        name = sandboxScopeName(prefix, scope);
        scopeByName.set(name, scope);
        ({ coldStart } = await ensureSession(scope, name, provOpts?.onStatus));
      }

      const forceEgress = !!opts.egressProxyUrl && !!provOpts?.egressToken;
      const turnEnv = Object.fromEntries(
        Object.entries(provOpts?.env ?? {}).filter(([k]) => !DROPPED_PROXY_ENV.has(k)),
      );
      const env = {
        ...turnEnv,
        ...(forceEgress ? forceThroughProxyEnv(opts.egressProxyUrl!, provOpts!.egressToken!) : {}),
      };
      const handle: SandboxHandle = {
        id: name,
        rootDir: workspaceDir,
        homeDir: HOME_DIR,
        coldStart,
        ...(scratch ? { scratch: true } : {}),
        ...(Object.keys(env).length ? { env } : {}),
      };

      try {
        const credLinks = scratch ? "" : ` && ${ephemeralCredLinkScript(HOME_DIR, opts.credentialPaths ?? [])}`;
        const prep = await execRaw(name, `mkdir -p ${shq(workspaceDir)}${credLinks}`, 60);
        if (prep.code !== 0)
          throw new Error(`modal provision prep failed: ${(prep.stderr || prep.stdout).slice(0, 200)}`);

        await materializeRoLayers(
          workspace,
          layers,
          handle,
          {
            readFile: (h, rel) => sandbox.readFile(h, rel),
            writeFileBytes: (h, rel, data) => sandbox.writeFileBytes(h, rel, data),
            exec: (script, t) => execRaw(name, script, t),
          },
          { manifest: RO_LAYERS_MANIFEST, tar: RO_LAYERS_TAR, label: "modal" },
        );
        await installLayerTools?.({
          exec: (script, t) => execRaw(name, script, t),
          writeAbs: (abs, data) => writeAbsBytes(name, abs, data),
        });

        return handle;
      } catch (err) {
        await sandbox.teardown(handle).catch(swallowAs("modal-sandbox: teardown after failed provision", undefined));
        throw err;
      }
    },

    async run(handle, command, execOpts?: ExecOptions): Promise<ExecResult> {
      const timeoutSec = execOpts?.timeoutMs ? Math.ceil(execOpts.timeoutMs / 1000) : defaultTimeoutSec;
      const exports = Object.entries(handle.env ?? {})
        .map(([k, v]) => `export ${k}=${shq(v)}`)
        .join("; ");
      const script = `${nonInteractiveShellPrefix()}${exports ? exports + "; " : ""}cd ${handle.rootDir} 2>/dev/null; ${command}`;
      const signal = execOpts?.signal;
      if (!signal) return execRaw(handle.id, script, timeoutSec);
      const killUid = randomUUID();
      const fireKill = () => {
        execRaw(handle.id, killScript(killUid), 15).catch(swallowAs("modal-sandbox: kill in-flight exec", undefined));
      };
      signal.throwIfAborted();
      const onAbort = () => fireKill();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        return await execRaw(handle.id, killableScript(script, killUid), timeoutSec);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },

    async writeFileBytes(handle, relPath, data): Promise<void> {
      await writeAbsBytes(handle.id, posixJoin(handle.rootDir, relPath), data);
    },
    async writeFile(handle, relPath, data): Promise<void> {
      await sandbox.writeFileBytes(handle, relPath, Buffer.from(data, "utf8"));
    },
    async readFileBytes(handle, relPath): Promise<Uint8Array | null> {
      return readAbsBytes(handle.id, posixJoin(handle.rootDir, relPath));
    },
    async readFile(handle, relPath): Promise<string | null> {
      const bytes = await sandbox.readFileBytes(handle, relPath);
      return bytes === null ? null : Buffer.from(bytes).toString("utf8");
    },

    exportFiles: execExport.exportFiles,

    async adoptHomeSnapshot(scopeId: string, blobId: string): Promise<void> {
      const blobTransfer = opts.blobTransfer;
      if (!blobTransfer) throw new Error("modal adoptHomeSnapshot: no blob transfer store wired");
      const ref = blobTransfer.s3Ref?.(blobId);
      if (ref && snapshots.adoptFromS3) {
        await snapshots.adoptFromS3(scopeId, ref);
      } else {
        const blob = await blobTransfer.open(blobId);
        if (!blob) throw new Error(`modal adoptHomeSnapshot: blob ${blobId} not found`);
        if (blob.sizeBytes > IN_MEMORY_ADOPT_MAX_BYTES) {
          blob.stream.destroy();
          throw new Error(
            `modal adoptHomeSnapshot: blob is ${blob.sizeBytes} bytes; adopting over ${IN_MEMORY_ADOPT_MAX_BYTES} needs S3-backed blob and snapshot stores`,
          );
        }
        await snapshots.put(scopeId, await collectBlob(blob.stream));
      }
      const name = sandboxScopeName(prefix, scopeId);
      return provisionQueue(scopeId, async () => {
        const session = sessionByName.get(name);
        sessionByName.delete(name);
        const stored = await store.get(scopeId);
        const swallowGone = (e: unknown): void => {
          if (!(e instanceof ModalSandboxGoneError)) throw e;
        };
        if (session) await session.terminate().catch(swallowGone);
        else if (stored) await client.terminate(stored.sandboxId).catch(swallowGone);
        await store.delete(scopeId);
      });
    },

    async persistHomeSnapshot(scopeId: string): Promise<void> {
      const name = sandboxScopeName(prefix, scopeId);
      scopeByName.set(name, scopeId);
      const { session } = await ensureSession(scopeId, name);
      await provisionQueue(scopeId, () => snapshotHome(scopeId, session));
    },

    async computerStatus(scopeId: string): Promise<ComputerStatus> {
      const name = sandboxScopeName(prefix, scopeId);
      const stored = await store.get(scopeId);
      if (!stored) return { machine: "no sandbox provisioned yet", provisioned: false, guestResponsive: false };
      const machine = `modal sandbox ${stored.sandboxId}`;
      try {
        scopeByName.set(name, scopeId);
        let session = sessionByName.get(name);
        if (!session) {
          session = await client.fromId(stored.sandboxId);
          sessionByName.set(name, session);
        }
        const r = await session.runCommand("echo responsive", { timeoutMs: 30_000 });
        return { machine, provisioned: true, guestResponsive: r.exitCode === 0 && /responsive/.test(r.stdout) };
      } catch (e) {
        return {
          machine: `${machine} (${errMessage(e).slice(0, 120)})`,
          provisioned: !(e instanceof ModalSandboxGoneError),
          guestResponsive: false,
        };
      }
    },

    async teardown(handle, tdOpts?: TeardownOptions): Promise<void> {
      if (handle.scratch) {
        const key = scratchKeyByName.get(handle.id);
        return provisionQueue(key ? `scratch:${key}` : handle.id, async () => {
          const remaining = (activeScratch.get(handle.id) ?? 1) - 1;
          if (remaining > 0) {
            activeScratch.set(handle.id, remaining);
            return;
          }
          activeScratch.delete(handle.id);
          const session = sessionByName.get(handle.id);
          sessionByName.delete(handle.id);
          if (session) await session.terminate().catch(swallowAs("modal-sandbox: scratch terminate", undefined));
        });
      }
      const scope = scopeByName.get(handle.id) ?? "default";
      return provisionQueue(scope, async () => {
        const session = sessionByName.get(handle.id);
        if (tdOpts?.destroy) {
          sessionByName.delete(handle.id);
          const stored = await store.get(scope);
          try {
            if (session) await session.terminate();
            else if (stored) await client.terminate(stored.sandboxId);
            await store.delete(scope);
          } catch (e) {
            reportError("sandbox_teardown", "sandbox_terminate_failed", errMessage(e), scope);
          }
          return;
        }
        if (!session) return;
        const stored = await store.get(scope);
        if (!tdOpts?.homeUnchanged) await store.merge(scope, { homeDirty: true });
        if (snapshotDue(stored, tdOpts, snapshotIntervalMs)) {
          try {
            await snapshotHome(scope, session);
            await store.merge(scope, { lastActivityMs: Date.now() });
          } catch (e) {
            reportError("sandbox_snapshot", "teardown_snapshot_failed", errMessage(e), scope);
            await store.merge(scope, { lastActivityMs: Date.now() }).catch(() => undefined);
          }
        } else {
          await store.merge(scope, { lastActivityMs: Date.now() }).catch(() => undefined);
        }
      });
    },

    async reapDeepIdle(idleMs): Promise<{ reaped: number }> {
      if (!(idleMs > 0)) return { reaped: 0 };
      const cutoff = Date.now() - Math.min(idleMs, reapIdleMs);
      let reaped = 0;
      for (const [scope, rec] of await store.entries()) {
        if (rec.orgId && rec.orgId !== configOrgId()) continue;
        if (!rec.lastActivityMs || rec.lastActivityMs > cutoff) continue;
        const name = sandboxScopeName(prefix, scope);
        scopeByName.set(name, scope);
        let session: ModalSession;
        try {
          session = sessionByName.get(name) ?? (await client.fromId(rec.sandboxId));
          const handle: SandboxHandle = { id: name, rootDir: workspaceDir, homeDir: HOME_DIR, coldStart: false };
          const live = await createExecProcessSessions(directProcIo(session)).listProcesses(handle);
          if (live.some((p) => p.status.state === "running")) continue;
        } catch (e) {
          if (e instanceof ModalSandboxGoneError) {
            sessionByName.delete(name);
            await store.delete(scope).catch(() => undefined);
          } else {
            reportError("sandbox_reap", "deep_idle_probe_failed", errMessage(e), scope);
          }
          continue;
        }
        reaped += await provisionQueue(scope, async (): Promise<number> => {
          const current = await store.get(scope);
          if (!current || current.sandboxId !== rec.sandboxId) return 0;
          if (!current.lastActivityMs || current.lastActivityMs > cutoff) return 0;
          try {
            await snapshotHome(scope, session);
            await session.terminate();
            sessionByName.delete(name);
            await store.delete(scope);
            return 1;
          } catch (e) {
            if (e instanceof ModalSandboxGoneError) {
              sessionByName.delete(name);
              await store.delete(scope).catch(() => undefined);
            } else {
              reportError("sandbox_reap", "deep_idle_reap_failed", errMessage(e), scope);
            }
            return 0;
          }
        });
      }
      return { reaped };
    },
  };

  return sandbox;
}
