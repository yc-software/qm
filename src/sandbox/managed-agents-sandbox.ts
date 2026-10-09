import { cleanupFailedProvision } from "./sandbox.ts";
import { randomUUID } from "node:crypto";
import type { WorkspaceLayer } from "../types.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { createMemoryMap } from "../persistence/durable-map.ts";
import { createKeyedQueue } from "../util/async.ts";
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
import {
  ManagedAgentsCommandLostError,
  ManagedAgentsSandboxGoneError,
  type ManagedAgentsClient,
  type ManagedAgentsSessionInfo,
  type ManagedAgentsSession,
} from "./managed-agents-client.ts";
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

const HOME_DIR = "/workspace/home";
const WORKSPACE_BASENAME = "workspace";
const RO_LAYERS_TAR = ".ro-layers.tar";
const RO_LAYERS_MANIFEST = ".ro-layers.manifest";
const HOME_TAR = `${HOME_DIR}/.qm-home.tar`;

const SNAPSHOT_PRUNE = HOME_SNAPSHOT_PRUNE;
const DEFAULT_SNAPSHOT_INTERVAL_MS = 5 * 60_000;
const CHECKPOINT_LABEL = "qm teardown";

export const QM_TEMPLATE_TOOLS = ["jq", "rg", "unzip", "wget"];

export interface StoredManagedAgentsSandbox {
  sessionId: string;
  sandboxId: string;
  preservationState?: "running" | "paused" | "pause_failed";
  preservationError?: string;
  createdAtMs: number;
  lastSnapshotMs?: number;
  homeDirty?: boolean;
  checkpointId?: string;
  checkpointAtMs?: number;
  checkpointError?: string;
}

export interface ManagedAgentsSandboxOptions extends BlobStagingOptions {
  client: ManagedAgentsClient;
  namePrefix?: string;
  defaultTimeoutSec?: number;
  snapshotIntervalMs?: number;
  egressProxyUrl?: string;
  extraTools?: string[];
  credentialPaths?: CredentialPathSpec[];
  layerToolFiles?: () => readonly LayerInstallFile[];
  store?: DurableMap<StoredManagedAgentsSandbox>;
  snapshots?: HomeSnapshotStore;
  onError?: (e: { category: string; code: string; message: string; scopeLabel?: string }) => void;
}

export function createManagedAgentsSandbox(workspace: WorkspaceStore, opts: ManagedAgentsSandboxOptions): Sandbox {
  const client = opts.client;
  const prefix = opts.namePrefix ?? "qm";
  const defaultTimeoutSec = opts.defaultTimeoutSec ?? 600;
  const snapshotIntervalMs = opts.snapshotIntervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
  const workspaceDir = `${HOME_DIR}/${WORKSPACE_BASENAME}`;
  const store = opts.store ?? createMemoryMap<StoredManagedAgentsSandbox>();
  const snapshots = opts.snapshots ?? createMemorySnapshotStore();
  const provisionQueue = createKeyedQueue<string>();

  const sessionByName = new Map<string, ManagedAgentsSession>();
  const scopeByName = new Map<string, string>();
  const scratchKeyByName = new Map<string, string>();
  const activeScratch = new Map<string, number>();

  const reportError = (category: string, code: string, message: string, scopeLabel?: string): void => {
    opts.onError?.({ category, code, message, ...(scopeLabel ? { scopeLabel } : {}) });
  };

  const homeSnapshots = createHomeSnapshotOps<ManagedAgentsSession>({
    label: "do-managed-agents",
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

  async function snapshotHome(scope: string, session: ManagedAgentsSession): Promise<void> {
    await homeSnapshots.snapshotHome(scope, session);
    await store.merge(scope, { lastSnapshotMs: Date.now(), homeDirty: false });
  }

  async function captureCheckpoint(scope: string, session: ManagedAgentsSession): Promise<void> {
    const previous = (await store.get(scope))?.checkpointId;
    const captured = await session.createCheckpoint(CHECKPOINT_LABEL);
    await store.merge(scope, {
      checkpointId: captured.checkpointId,
      checkpointAtMs: captured.createdAtMs ?? Date.now(),
      checkpointError: undefined,
    });
    if (!previous || previous === captured.checkpointId) return;
    try {
      await session.deleteCheckpoint(previous);
    } catch (e) {
      reportError("sandbox_snapshot", "checkpoint_delete_failed", errMessage(e), scope);
    }
  }

  const hydrateHome = (scope: string, session: ManagedAgentsSession): Promise<boolean> =>
    homeSnapshots.hydrateHome(scope, session);

  const recordSession = (scope: string, session: ManagedAgentsSession, createdAtMs: number): Promise<void> =>
    store.put(scope, {
      sessionId: session.sessionId,
      sandboxId: session.sandboxId,
      createdAtMs,
      preservationState: "running",
    });

  async function ensureSession(
    scope: string,
    name: string,
    onStatus?: (text: string) => void,
  ): Promise<{ session: ManagedAgentsSession; coldStart: boolean }> {
    return provisionQueue(scope, async () => {
      const cached = sessionByName.get(name);
      if (cached) return { session: cached, coldStart: false };

      const adopt = (session: ManagedAgentsSession): { session: ManagedAgentsSession; coldStart: boolean } => {
        sessionByName.set(name, session);
        return { session, coldStart: false };
      };

      const stored = await store.get(scope);
      if (stored) {
        try {
          onStatus?.("Resuming the sandbox…");
          const session = await client.connect(stored.sessionId);
          await store.merge(scope, { preservationState: "running", sandboxId: session.sandboxId });
          return adopt(session);
        } catch (err) {
          if (!(err instanceof ManagedAgentsSandboxGoneError)) throw err;
        }
      }

      for (const summary of await client.list(name)) {
        try {
          const session = await client.connect(summary.sessionId);
          await recordSession(scope, session, Date.now());
          return adopt(session);
        } catch (err) {
          if (!(err instanceof ManagedAgentsSandboxGoneError)) throw err;
        }
      }

      onStatus?.("Creating the sandbox…");
      const session = await client.create({ name });
      sessionByName.set(name, session);
      await recordSession(scope, session, Date.now());
      let hydrated: boolean;
      try {
        hydrated = await hydrateHome(scope, session);
      } catch (e) {
        reportError("sandbox_hydrate", "hydrate_failed", errMessage(e), scope);
        sessionByName.delete(name);
        await client.kill(session.sessionId).catch(() => undefined);
        throw new Error(
          `do-managed-agents provision: home hydration failed (${errMessage(e)}); not risking the stored snapshot`,
          {
            cause: e,
          },
        );
      }
      return { session, coldStart: !hydrated };
    });
  }

  async function ensureScratch(key: string): Promise<{ name: string; coldStart: boolean }> {
    const name = sandboxScopeName(`${prefix}-scratch`, key);
    return provisionQueue(`scratch:${key}`, async () => {
      scratchKeyByName.set(name, key);
      const active = activeScratch.get(name) ?? 0;
      if (active === 0 && !sessionByName.has(name)) {
        sessionByName.set(name, await client.create({ name }));
      }
      activeScratch.set(name, active + 1);
      return { name, coldStart: active === 0 };
    });
  }

  async function withSession<T>(name: string, action: (session: ManagedAgentsSession) => Promise<T>): Promise<T> {
    const scratchKey = scratchKeyByName.get(name);
    if (scratchKey === undefined && !scopeByName.has(name)) throw new Error("sandbox handle has been released");

    const reviveScratch = async (): Promise<ManagedAgentsSession> => {
      const session = await client.create({ name });
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
      if (err instanceof ManagedAgentsCommandLostError) sessionByName.delete(name);
      if (!(err instanceof ManagedAgentsSandboxGoneError)) throw err;
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
    backend: "do-managed-agents",
    writablePersistence: client.nativePause ? "provider_managed" : "snapshot_to_workspace",
    processSessions: true,
    parksOnTeardown: true,
    egressEnforcement: opts.egressProxyUrl ? "domain" : "none",
    spec: {
      os: "Linux — DigitalOcean Managed Agents Firecracker microVM (provider pause preserves state; publish durable work to git or Files)",
      runtimes: ["Node", "Python 3"],
      get tools() {
        return visibleTools(["git", "curl", "tar", "python3", "gh", ...(opts.extraTools ?? [])]);
      },
      get notInstalled() {
        return visibleNotInstalled(
          ["jq", "rg", "unzip", "wget", "aws", "gcloud", "kubectl", "flyctl", "glab"],
          opts.extraTools ?? [],
        );
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
    label: "do-managed-agents",
    exec: (id, script, t) => execRaw(id, script, t),
    writeInline: (id, abs, data) => writeAbsBytes(id, abs, data),
  });

  const execExport = createExecExport({
    label: "do-managed-agents",
    exec: (id, script, t) => execRaw(id, script, t),
    readAbsBytes,
    defaultHomeDir: HOME_DIR,
    ephemeralCredentialPrefixes: ephemeralCredLinkPaths(opts.credentialPaths ?? []).map(({ rel }) => rel),
  });

  const blobStaging = createBackendBlobStaging("do-managed-agents", (id, script, t) => execRaw(id, script, t), opts);

  async function destroyStoredScope(scope: string): Promise<void> {
    const name = sandboxScopeName(prefix, scope);
    const stored = await store.get(scope);
    const cached = sessionByName.get(name);
    const ids = new Set([stored?.sessionId, cached?.sessionId].filter((id): id is string => !!id));
    for (const id of ids) {
      try {
        if (cached && id === cached.sessionId) await cached.kill();
        else await client.kill(id);
      } catch (error) {
        if (!(error instanceof ManagedAgentsSandboxGoneError)) throw error;
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
          throw new Error(`do-managed-agents provision prep failed: ${(prep.stderr || prep.stdout).slice(0, 200)}`);

        await materializeRoLayers(
          workspace,
          layers,
          handle,
          {
            readFile: (h, rel) => sandbox.readFile(h, rel),
            writeFileBytes: (h, rel, data) => sandbox.writeFileBytes(h, rel, data),
            exec: (script, t) => execRaw(name, script, t),
          },
          { manifest: RO_LAYERS_MANIFEST, tar: RO_LAYERS_TAR, label: "do-managed-agents" },
        );
        await installLayerTools?.({
          exec: (script, t) => execRaw(name, script, t),
          writeAbs: (abs, data) => writeAbsBytes(name, abs, data),
        });

        return handle;
      } catch (err) {
        await cleanupFailedProvision(sandbox, handle, err);
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
      const fireKill = (): void => {
        execRaw(handle.id, killScript(killUid), 15).catch(
          swallowAs("managed-agents-sandbox: kill in-flight exec", undefined),
        );
      };
      signal.throwIfAborted();
      const onAbort = (): void => fireKill();
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
      const machine = `do-managed-agents sandbox ${stored.sandboxId || stored.sessionId}`;
      const checkpointAtMs = stored.checkpointAtMs ?? stored.lastSnapshotMs;
      const recoveryError = stored.preservationError ?? stored.checkpointError;
      const recovery = {
        strategy: "workspace_snapshot" as const,
        state: stored.preservationState,
        ...(recoveryError ? { error: recoveryError } : {}),
        ...(stored.checkpointId ? { checkpointId: stored.checkpointId } : {}),
        ...(checkpointAtMs ? { checkpointAtMs } : {}),
      };
      try {
        const info: ManagedAgentsSessionInfo = await client.info(stored.sessionId);
        if (info.state === "paused")
          return {
            machine,
            listed: info.state,
            lifecycleState: "paused",
            provisioned: true,
            guestResponsive: false,
            recovery: { ...recovery, state: "paused" },
          };
        scopeByName.set(name, scopeId);
        let session = sessionByName.get(name);
        if (!session) {
          session = await client.connect(stored.sessionId);
          sessionByName.set(name, session);
        }
        const r = await session.runCommand("echo responsive", { timeoutMs: 30_000 });
        return {
          machine,
          recovery,
          provisioned: true,
          guestResponsive: r.exitCode === 0 && /responsive/.test(r.stdout),
        };
      } catch (e) {
        return {
          recovery,
          machine: `${machine} (${errMessage(e).slice(0, 120)})`,
          provisioned: !(e instanceof ManagedAgentsSandboxGoneError),
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
          if (session) {
            if (tdOpts?.destroy) await session.kill();
            else await session.kill().catch(swallowAs("managed-agents-sandbox: scratch kill", undefined));
          }
          sessionByName.delete(handle.id);
          scratchKeyByName.delete(handle.id);
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
    if (snapshotDue(stored, tdOpts, snapshotIntervalMs)) {
      try {
        await captureCheckpoint(scope, session);
      } catch (e) {
        await store.merge(scope, { checkpointError: errMessage(e) });
        reportError("sandbox_snapshot", "checkpoint_failed", errMessage(e), scope);
      }
      try {
        await snapshotHome(scope, session);
      } catch (e) {
        reportError("sandbox_snapshot", "teardown_snapshot_failed", errMessage(e), scope);
      }
    }
    if (tdOpts?.keepWarm) return;
    try {
      await session.pause();
      await store.merge(scope, { preservationState: "paused", preservationError: undefined });
      sessionByName.delete(handle.id);
    } catch (error) {
      await store.merge(scope, { preservationState: "pause_failed", preservationError: errMessage(error) });
      reportError("sandbox_preservation", "pause_failed", errMessage(error), scope);
      throw error;
    }
  }

  return sandbox;
}
