import { randomUUID } from "node:crypto";
import type { WorkspaceLayer } from "../types.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { createMemoryMap } from "../persistence/durable-map.ts";
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
import { E2bSandboxGoneError, type E2bClient, type E2bSession } from "./e2b-client.ts";
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

const HOME_DIR = "/home/user";
const WORKSPACE_BASENAME = "workspace";
const RO_LAYERS_TAR = ".ro-layers.tar";
const RO_LAYERS_MANIFEST = ".ro-layers.manifest";
const HOME_TAR = `${HOME_DIR}/.qm-home.tar`;
const IN_MEMORY_ADOPT_MAX_BYTES = 256 * 1024 * 1024;

const SNAPSHOT_PRUNE = HOME_SNAPSHOT_PRUNE;

export interface StoredE2bSandbox {
  sandboxId: string;
  nativePause?: boolean;
  preservationState?: "running" | "paused" | "pause_failed";
  preservationError?: string;
  createdAtMs: number;
  lastSnapshotMs?: number;
  homeDirty?: boolean;
}

export interface E2bSandboxOptions extends BlobStagingOptions {
  client: E2bClient;
  namePrefix?: string;
  defaultTimeoutSec?: number;

  snapshotIntervalMs?: number;
  egressProxyUrl?: string;
  extraTools?: string[];
  credentialPaths?: CredentialPathSpec[];
  layerToolFiles?: () => readonly LayerInstallFile[];
  store?: DurableMap<StoredE2bSandbox>;
  snapshots?: HomeSnapshotStore;
  onError?: (e: { category: string; code: string; message: string; scopeLabel?: string }) => void;
}

export function createE2bSandbox(workspace: WorkspaceStore, opts: E2bSandboxOptions): Sandbox {
  const client = opts.client;
  const prefix = opts.namePrefix ?? "qm";
  const defaultTimeoutSec = opts.defaultTimeoutSec ?? 600;
  const snapshotIntervalMs = opts.snapshotIntervalMs ?? 0;
  const workspaceDir = `${HOME_DIR}/${WORKSPACE_BASENAME}`;
  const store = opts.store ?? createMemoryMap<StoredE2bSandbox>();
  const snapshots = opts.snapshots ?? createMemorySnapshotStore();
  const provisionQueue = createKeyedQueue<string>();

  const sessionByName = new Map<string, E2bSession>();
  const scopeByName = new Map<string, string>();
  const scratchKeyByName = new Map<string, string>();
  const activeScratch = new Map<string, number>();

  const reportError = (category: string, code: string, message: string, scopeLabel?: string): void => {
    opts.onError?.({ category, code, message, ...(scopeLabel ? { scopeLabel } : {}) });
  };

  const homeSnapshots = createHomeSnapshotOps<E2bSession>({
    label: "e2b",
    homeDir: HOME_DIR,
    homeTarPath: HOME_TAR,
    prunePaths: [...SNAPSHOT_PRUNE, ...ephemeralCredLinkPaths(opts.credentialPaths ?? []).map(({ rel }) => `./${rel}`)],
    store: snapshots,
    io: {
      runCommand: (session, script, timeoutMs) => session.runCommand(script, { timeoutMs }),
      readFileBytes: (session, abs) => session.readFileBytes(abs),
      writeFileBytes: (session, abs, data) => session.writeFileBytes(abs, data),
    },
  });

  async function snapshotHome(scope: string, session: E2bSession): Promise<void> {
    await homeSnapshots.snapshotHome(scope, session);
    await store.merge(scope, { lastSnapshotMs: Date.now(), homeDirty: false });
  }

  const hydrateHome = (scope: string, session: E2bSession): Promise<boolean> =>
    homeSnapshots.hydrateHome(scope, session);

  async function ensureSession(
    scope: string,
    name: string,
    onStatus?: (text: string) => void,
  ): Promise<{ session: E2bSession; coldStart: boolean }> {
    return provisionQueue(scope, async () => {
      const cached = sessionByName.get(name);
      if (cached) return { session: cached, coldStart: false };

      const adopt = (session: E2bSession): { session: E2bSession; coldStart: boolean } => {
        sessionByName.set(name, session);
        return { session, coldStart: false };
      };

      const stored = await store.get(scope);
      if (stored) {
        try {
          const session = await client.connect(stored.sandboxId);
          const info = await client.info?.(session.sandboxId);
          await store.merge(scope, {
            preservationState: "running",
            ...(info ? { nativePause: info.onTimeout === "pause" } : {}),
          });
          return adopt(session);
        } catch (err) {
          if (!(err instanceof E2bSandboxGoneError)) throw err;
        }
      }

      const listed = await client.list({ name });
      for (const summary of listed) {
        try {
          const session = await client.connect(summary.sandboxId);
          const info = await client.info?.(session.sandboxId);
          await store.put(scope, {
            sandboxId: session.sandboxId,
            createdAtMs: Date.now(),
            nativePause: info?.onTimeout === "pause",
          });
          return adopt(session);
        } catch (err) {
          if (!(err instanceof E2bSandboxGoneError)) throw err;
        }
      }

      if (stored?.nativePause) {
        throw new Error("e2b sandbox is gone; explicitly import a recovery snapshot before replacing its home");
      }
      try {
        onStatus?.("Creating the sandbox…");
      } catch (error) {
        void error;
      }
      const session = await client.create({ metadata: { name }, autoPause: true });
      sessionByName.set(name, session);
      await store.put(scope, {
        sandboxId: session.sandboxId,
        createdAtMs: Date.now(),
        nativePause: false,
        preservationState: "running",
      });
      let hydrated: boolean;
      try {
        hydrated = await hydrateHome(scope, session);
      } catch (e) {
        reportError("sandbox_hydrate", "hydrate_failed", errMessage(e), scope);
        sessionByName.delete(name);
        await client.kill(session.sandboxId).catch(() => undefined);
        throw new Error(`e2b provision: home hydration failed (${errMessage(e)}); not risking the stored snapshot`, {
          cause: e,
        });
      }
      await store.merge(scope, { nativePause: client.nativePause });
      return { session, coldStart: !hydrated };
    });
  }

  async function ensureScratch(key: string): Promise<{ name: string; coldStart: boolean }> {
    const name = sandboxScopeName(`${prefix}-scratch`, key);
    return provisionQueue(`scratch:${key}`, async () => {
      scratchKeyByName.set(name, key);
      const active = activeScratch.get(name) ?? 0;
      if (active === 0 && !sessionByName.has(name)) {
        const session = await client.create({ metadata: { name, scratch: "true" }, autoPause: false });
        sessionByName.set(name, session);
      }
      activeScratch.set(name, active + 1);
      return { name, coldStart: active === 0 };
    });
  }

  async function withSession<T>(name: string, action: (session: E2bSession) => Promise<T>): Promise<T> {
    const scratchKey = scratchKeyByName.get(name);

    const reviveScratch = async (): Promise<E2bSession> => {
      const session = await client.create({ metadata: { name, scratch: "true" }, autoPause: false });
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
      if (!(err instanceof E2bSandboxGoneError)) throw err;
      sessionByName.delete(name);
      const second =
        scratchKey !== undefined
          ? { session: await reviveScratch() }
          : await ensureSession(scopeByName.get(name) ?? "default", name);
      return action(second.session);
    }
  }

  async function execRaw(name: string, script: string, timeoutSec: number): Promise<ExecResult> {
    return withSession(name, async (session) => {
      const r = await session.runCommand(`timeout ${timeoutSec} sh -c ${shq(script)}`, {
        timeoutMs: timeoutSec * 1000 + 30_000,
      });
      return { stdout: r.stdout, stderr: r.stderr, code: r.exitCode, timedOut: r.exitCode === 124 };
    });
  }

  const profile: AgentComputerProfile = {
    backend: "e2b",
    writablePersistence: client.nativePause ? "provider_managed" : "snapshot_to_workspace",
    processSessions: true,
    egressEnforcement: "none",
    spec: {
      os: "Ubuntu — E2B Firecracker sandbox (provider pause preserves state; publish durable work to git or Files)",
      runtimes: ["Node", "Python 3"],
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

  const writeAbsBytes = (name: string, absPath: string, data: Uint8Array): Promise<void> =>
    withSession(name, (session) => session.writeFileBytes(absPath, data));
  const readAbsBytes = (name: string, absPath: string): Promise<Uint8Array | null> =>
    withSession(name, (session) => session.readFileBytes(absPath));
  const installLayerTools = opts.layerToolFiles ? createLayerToolInstaller(opts.layerToolFiles) : null;

  const execFileOps = createExecFileOps({
    label: "e2b",
    exec: (id, script, t) => execRaw(id, script, t),
    writeInline: (id, abs, data) => writeAbsBytes(id, abs, data),
  });

  const execExport = createExecExport({
    label: "e2b",
    exec: (id, script, t) => execRaw(id, script, t),
    readAbsBytes,
    defaultHomeDir: HOME_DIR,
    ephemeralCredentialPrefixes: ephemeralCredLinkPaths(opts.credentialPaths ?? []).map(({ rel }) => rel),
  });

  const blobStaging = createBackendBlobStaging("e2b", (id, script, t) => execRaw(id, script, t), opts);

  async function destroyStoredScope(scope: string): Promise<void> {
    const name = sandboxScopeName(prefix, scope);
    const stored = await store.get(scope);
    const cached = sessionByName.get(name);
    const ids = new Set([stored?.sandboxId, cached?.sandboxId].filter((id): id is string => !!id));
    for (const id of ids) {
      try {
        await client.kill(id);
      } catch (error) {
        if (!(error instanceof E2bSandboxGoneError)) throw error;
      }
    }
    await store.delete(scope);
    sessionByName.delete(name);
    scopeByName.delete(name);
  }

  const sandbox: Sandbox = {
    destroyScope(scopeId: string): Promise<void> {
      return provisionQueue(scopeId, () => destroyStoredScope(scopeId));
    },

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
          throw new Error(`e2b provision prep failed: ${(prep.stderr || prep.stdout).slice(0, 200)}`);

        await materializeRoLayers(
          workspace,
          layers,
          handle,
          {
            readFile: (h, rel) => sandbox.readFile(h, rel),
            writeFileBytes: (h, rel, data) => sandbox.writeFileBytes(h, rel, data),
            exec: (script, t) => execRaw(name, script, t),
          },
          { manifest: RO_LAYERS_MANIFEST, tar: RO_LAYERS_TAR, label: "e2b" },
        );
        await installLayerTools?.({
          exec: (script, t) => execRaw(name, script, t),
          writeAbs: (abs, data) => writeAbsBytes(name, abs, data),
        });

        return handle;
      } catch (err) {
        await sandbox.teardown(handle).catch(swallowAs("e2b-sandbox: teardown after failed provision", undefined));
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
        execRaw(handle.id, killScript(killUid), 15).catch(swallowAs("e2b-sandbox: kill in-flight exec", undefined));
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
      if (!blobTransfer) throw new Error("e2b adoptHomeSnapshot: no blob transfer store wired");
      const ref = blobTransfer.s3Ref?.(blobId);
      if (ref && snapshots.adoptFromS3) {
        await snapshots.adoptFromS3(scopeId, ref);
      } else {
        const blob = await blobTransfer.open(blobId);
        if (!blob) throw new Error(`e2b adoptHomeSnapshot: blob ${blobId} not found`);
        if (blob.sizeBytes > IN_MEMORY_ADOPT_MAX_BYTES) {
          blob.stream.destroy();
          throw new Error(
            `e2b adoptHomeSnapshot: blob is ${blob.sizeBytes} bytes; adopting over ${IN_MEMORY_ADOPT_MAX_BYTES} needs S3-backed blob and snapshot stores`,
          );
        }
        await snapshots.put(scopeId, await collectBlob(blob.stream));
      }
      const name = sandboxScopeName(prefix, scopeId);
      return provisionQueue(scopeId, async () => {
        const session = sessionByName.get(name);
        sessionByName.delete(name);
        const stored = await store.get(scopeId);
        const killGone = (e: unknown): void => {
          if (!(e instanceof E2bSandboxGoneError)) throw e;
        };
        if (session) await session.kill().catch(killGone);
        else if (stored) await client.kill(stored.sandboxId).catch(killGone);
        await store.delete(scopeId);
      });
    },

    async persistHomeSnapshot(scopeId: string): Promise<void> {
      const name = sandboxScopeName(prefix, scopeId);
      scopeByName.set(name, scopeId);
      const { session } = await ensureSession(scopeId, name);
      await snapshotHome(scopeId, session);
    },

    async computerStatus(scopeId: string): Promise<ComputerStatus> {
      const name = sandboxScopeName(prefix, scopeId);
      const stored = await store.get(scopeId);

      if (!stored) return { machine: "no sandbox provisioned yet", provisioned: false, guestResponsive: false };
      const machine = `e2b sandbox ${stored.sandboxId}`;
      let expiresAtMs: number | undefined;
      const recovery = {
        strategy: stored.nativePause ? ("provider_pause" as const) : ("workspace_snapshot" as const),
        state: stored.preservationState,
        ...(stored.preservationError ? { error: stored.preservationError } : {}),
        ...(stored.lastSnapshotMs ? { checkpointAtMs: stored.lastSnapshotMs } : {}),
      };
      try {
        if (client.info) {
          const info = await client.info(stored.sandboxId);
          expiresAtMs = info.state === "running" ? info.expiresAtMs : undefined;
          if (info.state === "paused")
            return {
              machine,
              listed: info.state,
              lifecycleState: "paused",
              provisioned: true,
              guestResponsive: false,
              recovery: { ...recovery, state: info.state, checkpointExpiresAtMs: null },
            };
        }
        scopeByName.set(name, scopeId);
        let session = sessionByName.get(name);
        if (!session) {
          session = await client.connect(stored.sandboxId);
          sessionByName.set(name, session);
        }
        const r = await session.runCommand("echo responsive", { timeoutMs: 30_000 });
        return {
          machine,
          expiresAtMs,
          recovery,
          provisioned: true,
          guestResponsive: r.exitCode === 0 && /responsive/.test(r.stdout),
        };
      } catch (e) {
        return {
          recovery,
          machine: `${machine} (${errMessage(e).slice(0, 120)})`,
          provisioned: !(e instanceof E2bSandboxGoneError),
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
          if (session) await session.kill().catch(swallowAs("e2b-sandbox: scratch kill", undefined));
        });
      }
      if (tdOpts?.destroy && !scopeByName.has(handle.id)) return;
      const scope = scopeByName.get(handle.id) ?? "default";
      return provisionQueue(scope, () => teardownScope(handle, scope, tdOpts));
    },
  };

  async function teardownScope(handle: SandboxHandle, scope: string, tdOpts?: TeardownOptions): Promise<void> {
    const session = sessionByName.get(handle.id);
    if (tdOpts?.destroy) return destroyStoredScope(scope);
    if (!session) return;

    const stored = await store.get(scope);
    if (!tdOpts?.homeUnchanged) await store.merge(scope, { homeDirty: true });
    if (!stored?.nativePause && snapshotDue(stored, tdOpts, snapshotIntervalMs)) {
      try {
        await snapshotHome(scope, session);
      } catch (e) {
        reportError("sandbox_snapshot", "teardown_snapshot_failed", errMessage(e), scope);
      }
    }
    if (tdOpts?.keepWarm) return;
    try {
      await session.pause();
      await store.merge(scope, {
        preservationState: "paused",
        preservationError: undefined,
        ...(stored?.nativePause ? { homeDirty: false } : {}),
      });
      sessionByName.delete(handle.id);
    } catch (error) {
      await store.merge(scope, { preservationState: "pause_failed", preservationError: errMessage(error) });
      reportError("sandbox_preservation", "pause_failed", errMessage(error), scope);
      throw error;
    }
  }

  return sandbox;
}
