import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DurableMap } from "../persistence/durable-map.ts";
import { swallowAs, errMessage } from "../util/errors.ts";
import { shq } from "../util/shell.ts";
import { createExecProcessSessions, type ExecProcessIo } from "./exec-process-session.ts";
import { createLayerToolInstaller } from "./layer-tool-install.ts";
import type { LayerInstallFile } from "../deployment/load-layer.ts";
import {
  createBackendBlobStaging,
  createExecExport,
  createExecFileOps,
  type BlobStagingOptions,
} from "./exec-file-ops.ts";
import { ephemeralCredLinkPaths, type CredentialPathSpec } from "../credentials/resident-paths.ts";
import { hasParentPathSegment, visibleNotInstalled, visibleTools } from "./sandbox.ts";
import { createExecSandboxBase, createSessionCache, sandboxScopeName } from "./exec-sandbox-base.ts";
import {
  ManagedAgentsCommandLostError,
  ManagedAgentsSandboxGoneError,
  type ManagedAgentsClient,
  type ManagedAgentsSessionInfo,
  type ManagedAgentsSession,
} from "./managed-agents-client.ts";
import {
  attemptSnapshot,
  createHomeSnapshotOps,
  HOME_SNAPSHOT_PRUNE,
  isJobComputerScope,
  snapshotDue,
  type HomeSnapshotStore,
  type SnapshotBookkeeping,
} from "./home-snapshot.ts";
import type {
  AgentComputerProfile,
  ComputerStatus,
  ExecResult,
  Sandbox,
  SandboxHandle,
  TeardownOptions,
} from "./sandbox.ts";

const WORKSPACE_ROOT = "/workspace";
const HOME_DIR = `${WORKSPACE_ROOT}/home`;
const TRANSFER_RELAY_BASENAME = ".qm-transfer.";
const HOME_TAR = `${HOME_DIR}/.qm-home.tar`;
const EGRESS_FORWARD_DIR = `${WORKSPACE_ROOT}/.qm-egress`;
const EGRESS_FORWARD_PORT = 3129;
const EGRESS_FORWARD_READY_POLLS = 100;

const SNAPSHOT_PRUNE = HOME_SNAPSHOT_PRUNE;
const DEFAULT_SNAPSHOT_INTERVAL_MS = 5 * 60_000;
const CHECKPOINT_LABEL = "qm teardown";

export const QM_TEMPLATE_TOOLS = ["jq", "rg", "unzip", "wget"];

const EGRESS_FORWARDER = readFileSync(new URL("./managed-agents-egress-forward.mjs", import.meta.url));
const FORWARD_DIR = shq(EGRESS_FORWARD_DIR);
const FORWARD_SCRIPT = `forward-${createHash("sha256").update(EGRESS_FORWARDER).digest("hex").slice(0, 16)}.mjs`;
const FORWARD_RUNNING = `grep -qs ${FORWARD_SCRIPT} "/proc/$(cat ${FORWARD_DIR}/pid 2>/dev/null)/cmdline"`;

function egressForwardInstallScript(egressProxyUrl: string): string {
  return [
    `mkdir -p ${FORWARD_DIR}`,
    `{ [ -f ${FORWARD_DIR}/${FORWARD_SCRIPT} ] || { printf '%s' ${shq(EGRESS_FORWARDER.toString("base64"))} | base64 -d > ${FORWARD_DIR}/.forward.tmp && mv -f ${FORWARD_DIR}/.forward.tmp ${FORWARD_DIR}/${FORWARD_SCRIPT}; }; }`,
    `printf '%s' ${shq(new URL(egressProxyUrl).origin)} > ${FORWARD_DIR}/.proxy.$$ && mv -f ${FORWARD_DIR}/.proxy.$$ ${FORWARD_DIR}/proxy`,
  ].join(" && ");
}

const EGRESS_FORWARD_ENSURE = [
  `if [ -z "\${HTTPS_PROXY:-\${https_proxy:-}}" ]; then echo "egress: this computer was created before the egress proxy was required, so its traffic can't be forced through it. Retire it and create a new one (export any files you need first)." >&2; exit 1; fi;`,
  `if ! ${FORWARD_RUNNING}; then`,
  `old=$(cat ${FORWARD_DIR}/pid 2>/dev/null); grep -qs forward- "/proc/$old/cmdline" && ! grep -qs ${FORWARD_SCRIPT} "/proc/$old/cmdline" && kill "$old" && sleep 0.2;`,
  `(setsid nohup node ${FORWARD_DIR}/${FORWARD_SCRIPT} ${FORWARD_DIR} ${EGRESS_FORWARD_PORT} >${FORWARD_DIR}/log 2>&1 </dev/null &);`,
  `i=0; until ${FORWARD_RUNNING} || [ $i -ge ${EGRESS_FORWARD_READY_POLLS} ]; do sleep 0.1; i=$((i+1)); done;`,
  `${FORWARD_RUNNING} || { echo "egress forwarder did not start: $(tail -c 1000 ${FORWARD_DIR}/log 2>/dev/null)" >&2; exit 1; };`,
  "fi; ",
].join(" ");

function transfersDirectly(absPath: string): boolean {
  return (absPath === WORKSPACE_ROOT || absPath.startsWith(`${WORKSPACE_ROOT}/`)) && !hasParentPathSegment(absPath);
}

export interface StoredManagedAgentsSandbox extends SnapshotBookkeeping {
  sessionId: string;
  sandboxId: string;
  preservationState?: "running" | "paused" | "pause_failed";
  preservationError?: string;
  createdAtMs: number;
  checkpointId?: string;
  checkpointAtMs?: number;
  checkpointError?: string;
  pendingCheckpointDeletes?: string[];
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
  store: DurableMap<StoredManagedAgentsSandbox>;
  snapshots?: HomeSnapshotStore;
  onError?: (e: { category: string; code: string; message: string; scopeLabel?: string }) => void;
}

export function createManagedAgentsSandbox(opts: ManagedAgentsSandboxOptions): Sandbox {
  const client = opts.client;
  const prefix = opts.namePrefix ?? "qm";
  const defaultTimeoutSec = opts.defaultTimeoutSec ?? 600;
  const snapshotIntervalMs = opts.snapshotIntervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
  const store = opts.store;
  const pauseFailed = new Set<string>();

  const reportError = (category: string, code: string, message: string, scopeLabel?: string): void => {
    opts.onError?.({ category, code, message, ...(scopeLabel ? { scopeLabel } : {}) });
  };

  const homeSnapshots = opts.snapshots
    ? createHomeSnapshotOps<ManagedAgentsSession>({
        label: "do-managed-agents",
        homeDir: HOME_DIR,
        homeTarPath: HOME_TAR,
        prunePaths: [
          ...SNAPSHOT_PRUNE,
          ...ephemeralCredLinkPaths(opts.credentialPaths ?? []).map(({ rel }) => `./${rel}`),
        ],
        store: opts.snapshots,
        io: {
          runCommand: (session, script, timeoutMs) => session.runCommand(script, { timeoutMs }),
          readFileBytes: (session, abs) => session.readFileBytes(abs),
          writeFileBytes: (session, abs, data) => session.writeFileBytes(abs, data),
        },
      })
    : undefined;

  async function snapshotHome(scope: string, session: ManagedAgentsSession): Promise<void> {
    if (!homeSnapshots) return;
    await homeSnapshots.snapshotHome(scope, session);
    await store.merge(scope, { lastSnapshotMs: Date.now(), homeDirty: false });
  }

  async function pendingDeletes(scope: string): Promise<string[]> {
    return (await store.get(scope))?.pendingCheckpointDeletes ?? [];
  }

  async function forgetCheckpoint(scope: string, session: ManagedAgentsSession, checkpointId: string): Promise<void> {
    try {
      await session.deleteCheckpoint(checkpointId);
    } catch (e) {
      reportError("sandbox_snapshot", "checkpoint_delete_failed", errMessage(e), scope);
      return;
    }
    const pending = await pendingDeletes(scope);
    await store.merge(scope, { pendingCheckpointDeletes: pending.filter((id) => id !== checkpointId) });
  }

  async function retryPendingCheckpointDeletes(scope: string, session: ManagedAgentsSession): Promise<void> {
    const current = (await store.get(scope))?.checkpointId;
    for (const checkpointId of await pendingDeletes(scope)) {
      if (checkpointId === current) continue;
      await forgetCheckpoint(scope, session, checkpointId);
    }
  }

  async function captureCheckpoint(scope: string, session: ManagedAgentsSession): Promise<void> {
    if (isJobComputerScope(scope)) return;
    const stored = await store.get(scope);
    const previous = stored?.checkpointId;
    const captured = await session.createCheckpoint(CHECKPOINT_LABEL).catch(async (e: unknown) => {
      await store
        .merge(scope, { checkpointError: errMessage(e) })
        .catch(swallowAs("managed-agents-sandbox: record checkpoint error", undefined));
      throw e;
    });
    const pending = stored?.pendingCheckpointDeletes ?? [];
    const queued =
      previous && previous !== captured.checkpointId && !pending.includes(previous) ? [...pending, previous] : pending;
    await store.merge(scope, {
      checkpointId: captured.checkpointId,
      checkpointAtMs: captured.createdAtMs ?? Date.now(),
      checkpointError: undefined,
      lastSnapshotMs: Date.now(),
      pendingCheckpointDeletes: queued,
    });
    if (previous && previous !== captured.checkpointId) await forgetCheckpoint(scope, session, previous);
  }

  const hydrateHome = async (scope: string, session: ManagedAgentsSession): Promise<boolean> =>
    homeSnapshots ? homeSnapshots.hydrateHome(scope, session) : false;

  const recordSession = (scope: string, session: ManagedAgentsSession, createdAtMs: number): Promise<void> =>
    store.put(scope, {
      sessionId: session.sessionId,
      sandboxId: session.sandboxId,
      createdAtMs,
      preservationState: "running",
    });

  const ensureSession = (scope: string, name: string) => base.provisionQueue(scope, () => resumeOrCreate(scope, name));

  async function resumeOrCreate(
    scope: string,
    name: string,
    onStatus?: (text: string) => void,
  ): Promise<{ session: ManagedAgentsSession; coldStart: boolean }> {
    const adopt = async (session: ManagedAgentsSession) => {
      await store.merge(scope, {
        sandboxId: session.sandboxId,
        preservationState: "running",
        preservationError: undefined,
      });
      sessionByName.set(name, session);
      return { session, coldStart: false };
    };

    const cached = sessionByName.get(name);
    if (cached) return pauseFailed.delete(name) ? adopt(cached) : { session: cached, coldStart: false };

    const stored = await store.get(scope);
    if (stored) {
      try {
        onStatus?.("Resuming the sandbox…");
        const session = await client.connect(stored.sessionId);
        return await adopt(session);
      } catch (err) {
        if (!(err instanceof ManagedAgentsSandboxGoneError)) throw err;
      }
    }

    for (const summary of await client.list(name)) {
      try {
        const session = await client.connect(summary.sessionId);
        await recordSession(scope, session, Date.now());
        return await adopt(session);
      } catch (err) {
        if (!(err instanceof ManagedAgentsSandboxGoneError)) throw err;
      }
    }

    onStatus?.("Creating the sandbox…");
    const session = await client.create({ name, ...egressAllow });
    sessionByName.set(name, session);
    await recordSession(scope, session, Date.now());
    let hydrated: boolean;
    try {
      hydrated = await hydrateHome(scope, session);
    } catch (e) {
      reportError("sandbox_hydrate", "hydrate_failed", errMessage(e), scope);
      sessionByName.delete(name);
      await client.kill(session.sessionId).catch((err: unknown) => {
        reportError("sandbox_hydrate", "orphan_kill_failed", errMessage(err), scope);
      });
      throw new Error(
        `do-managed-agents provision: home hydration failed (${errMessage(e)}); not risking the stored snapshot`,
        {
          cause: e,
        },
      );
    }
    return { session, coldStart: !hydrated };
  }

  const cache = createSessionCache<ManagedAgentsSession>({
    base: () => base,
    createScratch: (name) => client.create({ name, ...egressAllow }),
    ensureSession,
    isGone: (err) => err instanceof ManagedAgentsSandboxGoneError,
    isLost: (err) => err instanceof ManagedAgentsCommandLostError,
  });
  const sessionByName = cache.sessions;
  const withSession = cache.withSession;

  async function execRaw(name: string, script: string, timeoutSec: number, guard = ""): Promise<ExecResult> {
    return withSession(name, async (session) => {
      const guarded = `${guard}timeout -k 5 ${timeoutSec} sh -c ${shq(script)}; exit $?`;
      const r = await session.runCommand(`sh -c ${shq(guarded)}`, {
        timeoutMs: timeoutSec * 1000 + 30_000,
      });
      return {
        stdout: r.stdout,
        stderr: r.stderr,
        code: r.exitCode,
        timedOut: r.exitCode === 124 || r.exitCode === 137,
      };
    });
  }

  const egressAllow = opts.egressProxyUrl
    ? { egressAllow: [new URL(opts.egressProxyUrl).hostname.replace(/^\[|\]$/g, "")] }
    : {};
  const egressGuard = opts.egressProxyUrl ? EGRESS_FORWARD_ENSURE : "";
  const execNetworked = (name: string, script: string, timeoutSec: number): Promise<ExecResult> =>
    execRaw(name, script, timeoutSec, egressGuard);

  const procIo: ExecProcessIo = {
    async run(handle, command, execOpts): Promise<ExecResult> {
      const timeoutSec = execOpts?.timeoutMs ? Math.ceil(execOpts.timeoutMs / 1000) : defaultTimeoutSec;
      return execNetworked(handle.id, command, timeoutSec);
    },
  };
  const procSessions = createExecProcessSessions(procIo);

  const relayFailure = (what: string, r: ExecResult): Error =>
    new Error(`do-managed-agents ${what} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  const writeAbsBytes = async (name: string, absPath: string, data: Uint8Array): Promise<void> => {
    if (transfersDirectly(absPath)) return withSession(name, (session) => session.writeFileBytes(absPath, data));
    const relay = `${WORKSPACE_ROOT}/${TRANSFER_RELAY_BASENAME}${randomUUID()}`;
    await withSession(name, (session) => session.writeFileBytes(relay, data));
    const moved = await execRaw(
      name,
      `find ${WORKSPACE_ROOT} -maxdepth 1 -name ${shq(`${TRANSFER_RELAY_BASENAME}*`)} -mmin +120 -delete 2>/dev/null; mkdir -p "$(dirname ${shq(absPath)})" && mv -f ${shq(relay)} ${shq(absPath)} || { rm -f ${shq(relay)}; exit 1; }`,
      60,
    );
    if (moved.code !== 0) throw relayFailure(`write ${absPath}`, moved);
  };
  const readAbsBytes = async (name: string, absPath: string): Promise<Uint8Array | null> => {
    if (transfersDirectly(absPath)) return withSession(name, (session) => session.readFileBytes(absPath));
    const relay = `${WORKSPACE_ROOT}/${TRANSFER_RELAY_BASENAME}${randomUUID()}`;
    const copied = await execRaw(name, `test -f ${shq(absPath)} || exit 3; cp ${shq(absPath)} ${shq(relay)}`, 60);
    if (copied.code === 3) return null;
    if (copied.code !== 0) throw relayFailure(`read ${absPath}`, copied);
    try {
      return await withSession(name, (session) => session.readFileBytes(relay));
    } finally {
      await execRaw(name, `rm -f ${shq(relay)}`, 60).catch(
        swallowAs("managed-agents-sandbox: transfer relay cleanup", undefined),
      );
    }
  };

  const base = createExecSandboxBase({
    label: "do-managed-agents",
    prefix,
    homeDir: HOME_DIR,
    defaultTimeoutSec,
    credentialPaths: opts.credentialPaths ?? [],
    egressProxyUrl: opts.egressProxyUrl ? `http://127.0.0.1:${EGRESS_FORWARD_PORT}` : undefined,
    onError: opts.onError,
    prepSuffix: opts.egressProxyUrl ? ` && ${egressForwardInstallScript(opts.egressProxyUrl)}` : "",
    exec: (name, script, timeoutSec) => execRaw(name, script, timeoutSec),
    runExec: execNetworked,
    writeAbsBytes,
    readAbsBytes,
    ensureResident: (name, onStatus) => resumeOrCreate(base.scopeFor(name) ?? "default", name, onStatus),
    isProvisioned: cache.isProvisioned,
    recreateScratch: cache.recreateScratch,
    deleteInstance: cache.deleteInstance,
    installLayerTools: opts.layerToolFiles ? createLayerToolInstaller(opts.layerToolFiles) : undefined,
    teardownResident: teardownScope,
  });

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
        return visibleTools(["git", "curl", "tar", "python3", ...(opts.extraTools ?? [])]);
      },
      get notInstalled() {
        return visibleNotInstalled(
          ["jq", "rg", "unzip", "wget", "gh", "aws", "gcloud", "kubectl", "flyctl", "glab"],
          opts.extraTools ?? [],
        );
      },
      homeDir: HOME_DIR,
      workdir: base.workspaceDir,
    },
  };

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

  const blobStaging = createBackendBlobStaging("do-managed-agents", execNetworked, opts);

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
    base.releaseScope(name);
  }

  const sandbox: Sandbox = {
    destroyScope(scopeId: string): Promise<void> {
      return base.provisionQueue(scopeId, () => destroyStoredScope(scopeId));
    },

    profile,
    startProcess: procSessions.startProcess,
    readProcess: procSessions.readProcess,
    writeStdin: procSessions.writeStdin,
    signalProcess: procSessions.signalProcess,
    listProcesses: procSessions.listProcesses,
    ...execFileOps,
    ...blobStaging,

    provision: base.provision,
    run: base.run,
    writeFileBytes: base.writeFileBytes,
    writeFile: base.writeFile,
    readFileBytes: base.readFileBytes,
    readFile: base.readFile,
    teardown: base.teardown,
    exportFiles: execExport.exportFiles,

    ...(homeSnapshots
      ? {
          async persistHomeSnapshot(scopeId: string): Promise<void> {
            const name = sandboxScopeName(prefix, scopeId);
            base.bindScope(name, scopeId);
            const { session } = await ensureSession(scopeId, name);
            await snapshotHome(scopeId, session);
          },
        }
      : {}),

    async restartComputer(scopeId: string): Promise<void> {
      const name = sandboxScopeName(prefix, scopeId);
      base.bindScope(name, scopeId);
      return base.provisionQueue(scopeId, async () => {
        const stored = await store.get(scopeId);
        if (!stored?.sessionId) throw new Error("do-managed-agents restart: no sandbox provisioned yet");
        if (homeSnapshots) {
          let session = sessionByName.get(name);
          if (!session) {
            try {
              session = await client.connect(stored.sessionId);
            } catch (e) {
              if (!(e instanceof ManagedAgentsSandboxGoneError)) throw e;
            }
          }
          if (session) {
            await snapshotHome(scopeId, session);
            await session.kill();
          }
          sessionByName.delete(name);
          await store.merge(scopeId, {
            checkpointId: undefined,
            checkpointAtMs: undefined,
            checkpointError: undefined,
            preservationError: undefined,
          });
          return;
        }
        const checkpointId = stored.checkpointId;
        if (!checkpointId) throw new Error("do-managed-agents restart: no checkpoint to restore");
        const cached = sessionByName.get(name);
        sessionByName.delete(name);
        if (cached) await cached.close();
        let restored: ManagedAgentsSessionInfo;
        try {
          restored = await client.rollback(stored.sessionId, checkpointId);
        } catch (e) {
          reportError("agent_computer", "checkpoint_rollback_failed", errMessage(e), scopeId);
          throw e;
        }
        await store.merge(scopeId, {
          sandboxId: restored.sandboxId,
          preservationState: "running",
          preservationError: undefined,
        });
        reportError(
          "agent_computer",
          "checkpoint_restored",
          `session ${stored.sessionId}: restored checkpoint ${checkpointId} onto sandbox ${restored.sandboxId}`,
          scopeId,
        );
      });
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
        base.bindScope(name, scopeId);
        const session = sessionByName.get(name) ?? (await client.connect(stored.sessionId));
        const r = await session.runCommand("echo responsive", { timeoutMs: 30_000 });
        return {
          machine,
          recovery,
          provisioned: true,
          guestResponsive: r.exitCode === 0 && r.stdout.trim() === "responsive",
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
  };

  async function teardownScope(handle: SandboxHandle, scope: string, tdOpts?: TeardownOptions): Promise<void> {
    const session = sessionByName.get(handle.id);
    if (tdOpts?.destroy) return destroyStoredScope(scope);
    if (!session) return;

    const stored = await store.get(scope);
    if (!tdOpts?.homeUnchanged) await store.merge(scope, { homeDirty: true });
    await retryPendingCheckpointDeletes(scope, session);
    if (snapshotDue(stored, tdOpts, snapshotIntervalMs))
      await attemptSnapshot(
        stored,
        (patch) => store.merge(scope, patch),
        () => (homeSnapshots ? snapshotHome(scope, session) : captureCheckpoint(scope, session)),
        (message) =>
          reportError(
            "sandbox_snapshot",
            homeSnapshots ? "teardown_snapshot_failed" : "checkpoint_failed",
            message,
            scope,
          ),
      );
    if (tdOpts?.keepWarm) return;
    try {
      await session.pause();
      await store.merge(scope, { preservationState: "paused", preservationError: undefined });
      sessionByName.delete(handle.id);
      pauseFailed.delete(handle.id);
    } catch (error) {
      pauseFailed.add(handle.id);
      await store.merge(scope, { preservationState: "pause_failed", preservationError: errMessage(error) });
      reportError("sandbox_preservation", "pause_failed", errMessage(error), scope);
      throw error;
    }
  }

  return sandbox;
}
