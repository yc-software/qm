import { cleanupFailedProvision } from "./sandbox.ts";
import { randomUUID } from "node:crypto";
import type { WorkspaceLayer } from "../types.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { applyPatch, createMemoryMap } from "../persistence/durable-map.ts";
import { orgId as configOrgId } from "../config.ts";
import { createKeyedQueue, sleep } from "../util/async.ts";
import { swallowAs, errMessage } from "../util/errors.ts";
import { shq } from "../util/shell.ts";
import { nonInteractiveShellPrefix, DROPPED_PROXY_ENV, forceThroughProxyEnv } from "./sandbox-env.ts";
import { createExecProcessSessions, type ExecProcessIo } from "./exec-process-session.ts";
import { materializeRoLayers } from "./ro-layers.ts";
import { withConnectorSdk, type ConnectorSdkBundle } from "./connector-sdk.ts";
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
  SNAPSHOT_TIMEOUT_MS,
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
export const ACTIVITY_TOUCH_INTERVAL_MS = 10 * 60_000;
export const ACTIVITY_GRACE_MS = 2 * ACTIVITY_TOUCH_INTERVAL_MS;
export const HYDRATION_WAIT_MS = SNAPSHOT_TIMEOUT_MS + 5 * 60_000;
const swallowGone = (error: unknown): void => {
  if (!(error instanceof ModalSandboxGoneError)) throw error;
};
const SNAPSHOT_PRUNE = ["./.qm-hydrated", ...HOME_SNAPSHOT_PRUNE];

export interface StoredModalSandbox {
  sandboxId: string;
  hydrationPending?: boolean;
  nativeSnapshotId?: string;
  nativeSnapshotExpiresAtMs?: number;
  expiresAtMs?: number;
  recoveryError?: string;
  snapshotGeneration?: number;
  createdAtMs: number;
  lastSnapshotMs?: number;
  lastSnapshotAttemptMs?: number;
  lastActivityMs?: number;
  homeDirty?: boolean;
  orgId?: string;
}

export interface ModalSandboxOptions extends BlobStagingOptions {
  client: ModalClient;
  namePrefix?: string;
  defaultTimeoutSec?: number;
  snapshotIntervalMs?: number;
  nativeSnapshotsEnabled?: boolean;
  nativeSnapshotIntervalMs?: number;
  rotateAfterMs?: number;
  reapIdleMs?: number;
  egressProxyUrl?: string;
  extraTools?: string[];
  credentialPaths?: CredentialPathSpec[];
  connectorSdk?: () => Promise<ConnectorSdkBundle>;
  layerToolFiles?: () => readonly LayerInstallFile[];
  fileChunkBytes?: number;
  rotationHoldMs?: number;
  lifetimeMarginMs?: number;
  checkpointRenewMarginMs?: number;
  orphanGraceMs?: number;
  store?: DurableMap<StoredModalSandbox>;
  snapshots?: HomeSnapshotStore;
  onError?: (e: { category: string; code: string; message: string; scopeLabel?: string }) => void;
}

export function createModalSandbox(workspace: WorkspaceStore, opts: ModalSandboxOptions): Sandbox {
  const client = opts.client;
  const prefix = opts.namePrefix ?? "qm";
  const defaultTimeoutSec = opts.defaultTimeoutSec ?? 600;
  const usesNativeSnapshots = (stored?: StoredModalSandbox | null): boolean =>
    !!stored?.nativeSnapshotId || !!(client.nativeSnapshots && opts.nativeSnapshotsEnabled);
  const snapshotIntervalMs = (stored?: StoredModalSandbox | null): number =>
    usesNativeSnapshots(stored) ? (opts.nativeSnapshotIntervalMs ?? 5 * 60_000) : (opts.snapshotIntervalMs ?? 0);
  const lastSnapshotAttemptMs = (stored?: StoredModalSandbox | null): number =>
    Math.max(stored?.lastSnapshotMs ?? 0, usesNativeSnapshots(stored) ? (stored?.lastSnapshotAttemptMs ?? 0) : 0);
  const rotateAfterMs = opts.rotateAfterMs ?? 20 * 3600_000;
  const reapIdleMs = opts.reapIdleMs ?? 6 * 3600_000;
  const fileChunkBytes = opts.fileChunkBytes ?? 64 * 1024 * 1024;
  const rotationHoldMs = opts.rotationHoldMs ?? 10 * 60_000;
  const lifetimeMarginMs = opts.lifetimeMarginMs ?? 30 * 60_000;
  const checkpointRenewMarginMs = opts.checkpointRenewMarginMs ?? 7 * 24 * 3600_000;
  const orphanGraceMs = opts.orphanGraceMs ?? 10 * 60_000;
  const rotationHoldUntil = new Map<string, number>();
  const orphanFirstSeenMs = new Map<string, number>();
  const tags = (kind: "scope" | "scratch"): Record<string, string> => ({
    "qm-org": configOrgId(),
    "qm-prefix": prefix,
    "qm-kind": kind,
  });
  const workspaceDir = `${HOME_DIR}/${WORKSPACE_BASENAME}`;
  const store = opts.store ?? createMemoryMap<StoredModalSandbox>();
  if (!store.update || !store.deleteIf) throw new Error("Modal sandboxes require an atomic durable store");
  const updateRow = store.update.bind(store);
  const deleteRowIf = store.deleteIf.bind(store);
  const patchIfCurrent = (
    scope: string,
    sandboxId: string,
    patch: Partial<StoredModalSandbox>,
  ): Promise<StoredModalSandbox | null> =>
    updateRow(scope, (current) => (current.sandboxId === sandboxId ? applyPatch(current, patch) : current));
  const forgetIfCurrent = (scope: string, sandboxId: string): Promise<boolean> =>
    deleteRowIf(scope, (current) => current.sandboxId === sandboxId && !current.nativeSnapshotId);
  const snapshots = opts.snapshots ?? createMemorySnapshotStore();
  const localQueue = createKeyedQueue<string>();

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

  async function isHydrated(session: ModalSession): Promise<boolean> {
    const marked = await session.runCommand(`test -f ${shq(HYDRATED_MARKER)}`, { timeoutMs: 30_000 });
    return marked.exitCode === 0;
  }

  async function assertHydrated(session: ModalSession): Promise<void> {
    if (!(await isHydrated(session)))
      throw new Error(
        "modal snapshot refused: this sandbox never finished hydrating, its home is not a trustworthy source",
      );
  }

  async function snapshotHome(scope: string, session: ModalSession): Promise<void> {
    await assertHydrated(session);
    if (usesNativeSnapshots(await store.get(scope))) {
      if (!session.snapshotHome) throw new Error("native Modal home checkpoint is not supported by this client");
      const requested = await updateRow(scope, (current) => {
        if (current.sandboxId !== session.sandboxId) throw new Error("Modal checkpoint source has been replaced");
        return {
          ...current,
          snapshotGeneration: (current.snapshotGeneration ?? 0) + 1,
          lastSnapshotAttemptMs: Date.now(),
        };
      });
      if (!requested) throw new Error("Modal checkpoint source is no longer tracked");
      const capturedAtMs = Date.now();
      try {
        const snapshot = await session.snapshotHome();
        const committed = await updateRow(scope, (current) =>
          current.sandboxId === session.sandboxId && current.snapshotGeneration === requested.snapshotGeneration
            ? {
                ...current,
                nativeSnapshotId: snapshot.imageId,
                nativeSnapshotExpiresAtMs: snapshot.expiresAtMs,
                recoveryError: undefined,
                lastSnapshotAttemptMs: undefined,
                lastSnapshotMs: capturedAtMs,
                homeDirty: false,
              }
            : current,
        );
        if (committed?.nativeSnapshotId !== snapshot.imageId)
          throw new Error("Modal checkpoint was superseded; keeping the source running");
      } catch (error) {
        await updateRow(scope, (current) =>
          current.sandboxId === session.sandboxId && current.snapshotGeneration === requested.snapshotGeneration
            ? { ...current, recoveryError: errMessage(error) }
            : current,
        );
        throw error;
      }
    } else {
      await homeSnapshots.snapshotHome(scope, session);
      await patchIfCurrent(scope, session.sandboxId, { lastSnapshotMs: Date.now(), homeDirty: false });
    }
  }

  const hydrationIncomplete = (): Error =>
    new Error(
      "Modal home hydration is still running on another core or was interrupted; retry shortly, and if it persists use computer restart to discard the incomplete replacement and retry the retained checkpoint",
    );

  async function settledRow(scope: string): Promise<StoredModalSandbox | null> {
    for (;;) {
      const row = await store.get(scope);
      if (!row?.hydrationPending) return row;
      if (Date.now() >= row.createdAtMs + HYDRATION_WAIT_MS) throw hydrationIncomplete();
      await sleep(1_000);
    }
  }

  async function adopt(
    scope: string,
    name: string,
    session: ModalSession,
  ): Promise<{ session: ModalSession; coldStart: boolean }> {
    if (!(await isHydrated(session))) {
      await settledRow(scope);
      await assertHydrated(session);
    }
    const now = Date.now();
    const stamp = { sandboxId: session.sandboxId, lastActivityMs: now };
    const row = await updateRow(scope, (current) => (current.hydrationPending ? current : { ...current, ...stamp }));
    if (row?.hydrationPending) {
      const settled = await settledRow(scope);
      const holder = settled?.sandboxId ?? session.sandboxId;
      return adopt(scope, name, holder === session.sandboxId ? session : await client.fromId(holder));
    }
    if (!row) await store.putIfAbsent(scope, { ...stamp, createdAtMs: now, orgId: configOrgId() });
    sessionByName.set(name, session);
    return { session, coldStart: false };
  }

  async function createHydrated(
    scope: string,
    name: string,
    expected: string | undefined,
    activityMs = Date.now(),
  ): Promise<{ session: ModalSession; coldStart: boolean }> {
    const previous = await store.get(scope);
    if (previous?.nativeSnapshotExpiresAtMs && previous.nativeSnapshotExpiresAtMs <= Date.now()) {
      const recoveryError =
        "Modal home checkpoint has expired; explicitly import a recovery snapshot before creating a replacement";
      await store.merge(scope, { recoveryError });
      throw new Error(recoveryError);
    }
    let session: ModalSession;
    try {
      session = await client.create({ name, tags: tags("scope") });
    } catch (err) {
      if (!(err instanceof ModalNameConflictError)) throw err;
      const holder = await client.fromName(name);
      if (!holder) throw err;
      return adopt(scope, name, holder);
    }
    const fresh: StoredModalSandbox = {
      hydrationPending: true,
      ...(client.lifetimeMs ? { expiresAtMs: Date.now() + client.lifetimeMs } : {}),
      sandboxId: session.sandboxId,
      createdAtMs: Date.now(),
      lastActivityMs: activityMs,
      orgId: configOrgId(),
    };
    const claimed =
      (expected !== undefined &&
        (await updateRow(scope, (current) =>
          current.sandboxId === expected ? { ...current, ...fresh, lastSnapshotAttemptMs: undefined } : current,
        ))) ||
      (await store.putIfAbsent(scope, fresh));
    if (claimed.sandboxId !== session.sandboxId) {
      await session.terminate().catch(swallowGone);
      return adopt(scope, name, await client.fromId(claimed.sandboxId));
    }
    const abandon = async (): Promise<void> => {
      sessionByName.delete(name);
      await session.terminate().then(
        () => patchIfCurrent(scope, session.sandboxId, { hydrationPending: false }),
        () => undefined,
      );
    };
    let hydrated: boolean;
    try {
      if (claimed.nativeSnapshotId) {
        if (!session.restoreHome) throw new Error("native Modal home restore is not supported by this client");
        await session.restoreHome(claimed.nativeSnapshotId);
        hydrated = true;
      } else {
        hydrated = await homeSnapshots.hydrateHome(scope, session);
      }
    } catch (e) {
      await patchIfCurrent(scope, session.sandboxId, { recoveryError: errMessage(e) });
      reportError("sandbox_hydrate", "hydrate_failed", errMessage(e), scope);
      await abandon();
      throw new Error(`modal provision: home hydration failed (${errMessage(e)}); not risking the stored snapshot`, {
        cause: e,
      });
    }
    const marked = await session.runCommand(`touch ${shq(HYDRATED_MARKER)}`, { timeoutMs: 30_000 });
    if (marked.exitCode !== 0) {
      await abandon();
      throw new Error(`modal provision: could not mark the sandbox hydrated: ${marked.stderr.slice(0, 200)}`);
    }
    await patchIfCurrent(scope, session.sandboxId, {
      hydrationPending: false,
      ...(hydrated && !claimed.nativeSnapshotId ? { lastSnapshotMs: Date.now() } : {}),
    });
    sessionByName.set(name, session);
    return { session, coldStart: !hydrated };
  }

  async function ensureSession(
    scope: string,
    name: string,
    onStatus?: (text: string) => void,
    allowRotation = true,
  ): Promise<{ session: ModalSession; coldStart: boolean }> {
    return localQueue(scope, async () => {
      const stored = await settledRow(scope);
      const stale =
        allowRotation &&
        !!stored &&
        Date.now() - stored.createdAtMs > rotateAfterMs &&
        Date.now() >= (rotationHoldUntil.get(scope) ?? 0);

      const cached = sessionByName.get(name);
      const current = cached && cached.sandboxId === stored?.sandboxId ? cached : undefined;
      if (current && !stale) return { session: current, coldStart: false };

      if (stored && !stale) {
        try {
          return await adopt(scope, name, await client.fromId(stored.sandboxId));
        } catch (err) {
          if (!(err instanceof ModalSandboxGoneError)) throw err;
        }
        const found = await client.fromName(name);
        if (found) return adopt(scope, name, found);
      }

      if (stored && stale) {
        let session: ModalSession | null = null;
        try {
          session = current ?? (await client.fromId(stored.sandboxId));
        } catch (err) {
          if (!(err instanceof ModalSandboxGoneError)) throw err;
        }
        if (session) {
          const keep = async (): Promise<{ session: ModalSession; coldStart: boolean }> => {
            rotationHoldUntil.set(scope, Date.now() + rotationHoldMs);
            return adopt(scope, name, session!);
          };
          await assertHydrated(session);
          try {
            await snapshotHome(scope, session);
          } catch (e) {
            if (!(e instanceof ModalSandboxGoneError)) {
              reportError("sandbox_snapshot", "rotate_snapshot_failed", errMessage(e), scope);
              return keep();
            }
          }
          try {
            await session.terminate();
          } catch (e) {
            if (!(e instanceof ModalSandboxGoneError)) {
              reportError("sandbox_teardown", "rotate_terminate_failed", errMessage(e), scope);
              return keep();
            }
          }
        }
        sessionByName.delete(name);
        await forgetIfCurrent(scope, stored.sandboxId);
      }

      if (!stored) {
        const found = await client.fromName(name);
        if (found) return adopt(scope, name, found);
      }

      try {
        onStatus?.("Creating the sandbox…");
      } catch (error) {
        void error;
      }
      return createHydrated(scope, name, stored?.sandboxId);
    });
  }

  async function ensureScratch(key: string): Promise<{ name: string; coldStart: boolean }> {
    const name = sandboxScopeName(`${prefix}-scratch`, key);
    return localQueue(`scratch:${key}`, async () => {
      scratchKeyByName.set(name, key);
      const active = activeScratch.get(name) ?? 0;
      if (active === 0 && !sessionByName.has(name)) {
        const session = await client.create({ tags: tags("scratch") });
        sessionByName.set(name, session);
      }
      activeScratch.set(name, active + 1);
      return { name, coldStart: active === 0 };
    });
  }

  const lastTouchMs = new Map<string, number>();
  async function touchActivity(scope: string): Promise<void> {
    const now = Date.now();
    if (now - (lastTouchMs.get(scope) ?? 0) < ACTIVITY_TOUCH_INTERVAL_MS) return;
    const touched = await store.merge(scope, { lastActivityMs: now }).catch(() => null);
    if (touched) lastTouchMs.set(scope, now);
  }

  async function withSession<T>(name: string, action: (session: ModalSession) => Promise<T>): Promise<T> {
    const scratchKey = scratchKeyByName.get(name);
    const scope = scratchKey === undefined ? scopeByName.get(name) : undefined;
    if (scratchKey === undefined && scope === undefined) throw new Error("sandbox handle has been released");
    if (scope !== undefined) await touchActivity(scope);
    const revive = async (): Promise<ModalSession> => {
      if (scope !== undefined) return (await ensureSession(scope, name, undefined, false)).session;
      const session = await client.create({ tags: tags("scratch") });
      sessionByName.set(name, session);
      return session;
    };
    const first = sessionByName.get(name) ?? (await revive());
    const heartbeat =
      scope === undefined
        ? undefined
        : setInterval(() => void touchActivity(scope), ACTIVITY_TOUCH_INTERVAL_MS / 2).unref();
    try {
      return await action(first);
    } catch (err) {
      if (!(err instanceof ModalSandboxGoneError)) throw err;
      sessionByName.delete(name);
      if (scope !== undefined && !(await store.get(scope))) throw err;
      return action(await revive());
    } finally {
      clearInterval(heartbeat);
    }
  }

  async function runTimed(
    session: ModalSession,
    script: string,
    timeoutSec: number,
    env?: Record<string, string>,
  ): Promise<ExecResult> {
    const r = await session.runCommand(script, {
      timeoutMs: timeoutSec * 1000,
      ...(env ? { env } : {}),
    });
    return { stdout: r.stdout, stderr: r.stderr, code: r.exitCode, timedOut: r.exitCode === 124 };
  }

  async function execRaw(
    name: string,
    script: string,
    timeoutSec: number,
    env?: Record<string, string>,
  ): Promise<ExecResult> {
    return withSession(name, (session) => runTimed(session, script, timeoutSec, env));
  }

  const profile: AgentComputerProfile = {
    backend: "modal",
    writablePersistence: usesNativeSnapshots() ? "provider_managed" : "snapshot_to_workspace",
    processSessions: true,
    egressEnforcement: opts.egressProxyUrl ? "domain" : "none",
    spec: {
      os: "Debian 12 — Modal sandbox (24h max lifetime; home checkpoints have limited retention; publish durable work to git or Files)",
      runtimes: ["Node 24", "Python 3"],
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
    run(_handle, command, execOpts): Promise<ExecResult> {
      const timeoutSec = execOpts?.timeoutMs ? Math.ceil(execOpts.timeoutMs / 1000) : defaultTimeoutSec;
      return runTimed(session, command, timeoutSec);
    },
  });

  const writeAbsBytes = (name: string, absPath: string, data: Uint8Array): Promise<void> =>
    withSession(name, (session) => session.writeFileBytes(absPath, data));
  const readAbsBytes = (name: string, absPath: string): Promise<Uint8Array | null> =>
    withSession(name, (session) => session.readFileBytes(absPath));
  const installLayerTools = withConnectorSdk(
    HOME_DIR,
    createLayerToolInstaller(opts.layerToolFiles ?? (() => [])),
    opts.connectorSdk,
  );

  const execFileOps = createExecFileOps({
    combineRemoveAndList: true,
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

  async function destroyStoredScope(scope: string): Promise<void> {
    const name = sandboxScopeName(prefix, scope);
    const stored = await store.get(scope);
    const cached = sessionByName.get(name);
    const ids = new Set([stored?.sandboxId, cached?.sandboxId].filter((id): id is string => !!id));
    if (stored) await deleteRowIf(scope, (current) => current.sandboxId === stored.sandboxId);
    for (const id of ids) {
      try {
        await client.terminate(id);
      } catch (error) {
        if (error instanceof ModalSandboxGoneError) continue;
        if (stored)
          await store
            .putIfAbsent(scope, stored)
            .catch((e: unknown) => reportError("sandbox_teardown", "destroy_restore_failed", errMessage(e), scope));
        throw error;
      }
    }
    sessionByName.delete(name);
    scopeByName.delete(name);
    rotationHoldUntil.delete(scope);
    lastTouchMs.delete(scope);
  }

  function checkpointRenewalDue(rec: StoredModalSandbox, now: number): boolean {
    if (!rec.nativeSnapshotId || !rec.nativeSnapshotExpiresAtMs) return false;
    const remaining = rec.nativeSnapshotExpiresAtMs - now;
    const lifetime = rec.nativeSnapshotExpiresAtMs - (rec.lastSnapshotMs ?? 0);
    return remaining > 0 && remaining <= Math.min(checkpointRenewMarginMs, lifetime / 2);
  }

  function renewCheckpoint(scope: string, name: string, rec: StoredModalSandbox): Promise<void> {
    return localQueue(scope, async () => {
      const current = await store.get(scope);
      if (
        !current ||
        current.hydrationPending ||
        current.nativeSnapshotId !== rec.nativeSnapshotId ||
        !checkpointRenewalDue(current, Date.now())
      )
        return;
      const parkedAt = current.lastActivityMs ?? 0;
      const stillParked = async (sandboxId: string): Promise<boolean> => {
        const row = await store.get(scope);
        return row?.sandboxId === sandboxId && (row.lastActivityMs ?? 0) === parkedAt;
      };
      try {
        const { session } = await createHydrated(scope, name, current.sandboxId, parkedAt);
        if (!(await stillParked(session.sandboxId))) return;
        try {
          await snapshotHome(scope, session);
        } finally {
          if (await stillParked(session.sandboxId)) {
            sessionByName.delete(name);
            await session.terminate().catch(swallowGone);
          }
        }
      } catch (e) {
        if (!(e instanceof ModalSandboxGoneError))
          reportError("sandbox_snapshot", "checkpoint_renewal_failed", errMessage(e), scope);
      }
    });
  }

  function refreshCheckpoint(scope: string, rec: StoredModalSandbox, session: ModalSession): Promise<void> {
    return localQueue(scope, async () => {
      try {
        const current = await store.get(scope);
        if (
          !current ||
          current.sandboxId !== rec.sandboxId ||
          Date.now() - lastSnapshotAttemptMs(current) <= snapshotIntervalMs(current)
        )
          return;
        await snapshotHome(scope, session);
      } catch (error) {
        if (!(error instanceof ModalSandboxGoneError))
          reportError("sandbox_snapshot", "periodic_snapshot_failed", errMessage(error), scope);
      }
    });
  }

  function retire(
    scope: string,
    name: string,
    rec: StoredModalSandbox,
    session: ModalSession,
    idleCutoffMs?: number,
  ): Promise<number> {
    return localQueue(scope, async (): Promise<number> => {
      const current = await store.get(scope);
      if (!current || current.sandboxId !== rec.sandboxId) return 0;
      if (idleCutoffMs !== undefined && (!current.lastActivityMs || current.lastActivityMs > idleCutoffMs)) return 0;
      try {
        await snapshotHome(scope, session);
        if (idleCutoffMs !== undefined) {
          const latest = await store.get(scope);
          if (latest?.sandboxId !== rec.sandboxId || (latest.lastActivityMs ?? 0) > idleCutoffMs) return 0;
        }
        await session.terminate();
        sessionByName.delete(name);
        await forgetIfCurrent(scope, rec.sandboxId);
        return 1;
      } catch (e) {
        if (e instanceof ModalSandboxGoneError) {
          sessionByName.delete(name);
          await forgetIfCurrent(scope, rec.sandboxId).catch(() => undefined);
        } else {
          reportError("sandbox_reap", "deep_idle_reap_failed", errMessage(e), scope);
        }
        return 0;
      }
    });
  }

  async function sweepOrphans(now: number): Promise<number> {
    if (!client.listRunning) return 0;
    const tracked = async (): Promise<Set<string>> => {
      const ids = new Set<string>();
      for (const [, rec] of await store.entries()) ids.add(rec.sandboxId);
      for (const session of sessionByName.values()) ids.add(session.sandboxId);
      return ids;
    };
    let known = await tracked();
    const listed = new Set<string>();
    const candidates: string[] = [];
    try {
      for await (const sandboxId of client.listRunning(tags("scope"))) {
        listed.add(sandboxId);
        if (known.has(sandboxId)) continue;
        const firstSeen = orphanFirstSeenMs.get(sandboxId) ?? now;
        orphanFirstSeenMs.set(sandboxId, firstSeen);
        if (now - firstSeen >= orphanGraceMs) candidates.push(sandboxId);
      }
    } catch (e) {
      reportError("sandbox_reap", "orphan_list_failed", errMessage(e));
      return 0;
    }
    for (const id of orphanFirstSeenMs.keys()) if (!listed.has(id) || known.has(id)) orphanFirstSeenMs.delete(id);
    if (!candidates.length) return 0;
    known = await tracked();
    let reaped = 0;
    for (const sandboxId of candidates) {
      if (known.has(sandboxId)) continue;
      try {
        await client.terminate(sandboxId);
        orphanFirstSeenMs.delete(sandboxId);
        reaped++;
      } catch (e) {
        if (e instanceof ModalSandboxGoneError) orphanFirstSeenMs.delete(sandboxId);
        else reportError("sandbox_reap", "orphan_terminate_failed", errMessage(e));
      }
    }
    return reaped;
  }

  const sandbox: Sandbox = {
    destroyScope(scopeId: string): Promise<void> {
      return localQueue(scopeId, () => destroyStoredScope(scopeId));
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
        await installLayerTools(
          {
            exec: (script, t) => execRaw(name, script, t),
            writeAbs: (abs, data) => writeAbsBytes(name, abs, data),
          },
          `mkdir -p ${shq(workspaceDir)}${credLinks}`,
        );

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

        return handle;
      } catch (err) {
        await cleanupFailedProvision(sandbox, handle, err);
        throw err;
      }
    },

    async run(handle, command, execOpts?: ExecOptions): Promise<ExecResult> {
      const timeoutSec = execOpts?.timeoutMs ? Math.ceil(execOpts.timeoutMs / 1000) : defaultTimeoutSec;
      const script = `${nonInteractiveShellPrefix()}cd ${handle.rootDir} 2>/dev/null; ${command}`;
      const signal = execOpts?.signal;
      if (!signal) return execRaw(handle.id, script, timeoutSec, handle.env);
      const killUid = randomUUID();
      const fireKill = () => {
        execRaw(handle.id, killScript(killUid), 15).catch(swallowAs("modal-sandbox: kill in-flight exec", undefined));
      };
      signal.throwIfAborted();
      const onAbort = () => fireKill();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        return await execRaw(handle.id, killableScript(script, killUid), timeoutSec, handle.env);
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
      await localQueue(scopeId, async () => {
        await assertHydrated(session);
        await homeSnapshots.snapshotHome(scopeId, session);
      });
    },

    async restartComputer(scopeId: string): Promise<void> {
      await localQueue(scopeId, async () => {
        const stored = await store.get(scopeId);
        if (!stored) return;
        const name = sandboxScopeName(prefix, scopeId);
        let session: ModalSession | undefined;
        try {
          session = await client.fromId(stored.sandboxId);
        } catch (error) {
          if (!(error instanceof ModalSandboxGoneError)) throw error;
        }
        if (session) {
          if (!stored.hydrationPending) await snapshotHome(scopeId, session);
          await session.terminate();
        }
        sessionByName.delete(name);
        await patchIfCurrent(scopeId, stored.sandboxId, { hydrationPending: false, recoveryError: undefined });
      });
    },

    async computerStatus(scopeId: string): Promise<ComputerStatus> {
      const name = sandboxScopeName(prefix, scopeId);
      const stored = await store.get(scopeId);
      if (!stored) return { machine: "no sandbox provisioned yet", provisioned: false, guestResponsive: false };
      const recovery = {
        strategy: stored.nativeSnapshotId ? ("provider_snapshot" as const) : ("workspace_snapshot" as const),
        ...(stored.nativeSnapshotId
          ? { checkpointId: stored.nativeSnapshotId, checkpointExpiresAtMs: stored.nativeSnapshotExpiresAtMs }
          : {}),
        ...(stored.lastSnapshotMs ? { checkpointAtMs: stored.lastSnapshotMs } : {}),
        ...(stored.recoveryError ? { error: stored.recoveryError } : {}),
      };
      const machine = `modal sandbox ${stored.sandboxId}`;
      if (stored.hydrationPending)
        return {
          machine,
          provisioned: true,
          guestResponsive: false,
          recovery:
            Date.now() < stored.createdAtMs + HYDRATION_WAIT_MS
              ? { ...recovery, state: "hydrating" }
              : {
                  ...recovery,
                  state: "failed",
                  error:
                    "Home hydration did not finish. Use computer restart to discard the incomplete replacement and retry the retained checkpoint.",
                },
        };
      try {
        scopeByName.set(name, scopeId);
        const cached = sessionByName.get(name);
        const session =
          cached && cached.sandboxId === stored.sandboxId ? cached : await client.fromId(stored.sandboxId);
        const r = await session.runCommand("echo responsive", { timeoutMs: 30_000 });
        return {
          machine,
          expiresAtMs: stored.expiresAtMs,
          recovery,
          provisioned: true,
          guestResponsive: r.exitCode === 0 && /responsive/.test(r.stdout),
        };
      } catch (e) {
        return {
          expiresAtMs: stored.expiresAtMs,
          recovery,
          machine: `${machine} (${errMessage(e).slice(0, 120)})`,
          provisioned: !(e instanceof ModalSandboxGoneError),
          guestResponsive: false,
        };
      }
    },

    async teardown(handle, tdOpts?: TeardownOptions): Promise<void> {
      if (handle.scratch) {
        const key = scratchKeyByName.get(handle.id);
        return localQueue(key ? `scratch:${key}` : handle.id, async () => {
          const remaining = (activeScratch.get(handle.id) ?? 1) - 1;
          if (remaining > 0) {
            activeScratch.set(handle.id, remaining);
            return;
          }
          activeScratch.delete(handle.id);
          const session = sessionByName.get(handle.id);
          if (session) {
            if (tdOpts?.destroy) await session.terminate();
            else await session.terminate().catch(swallowAs("modal-sandbox: scratch terminate", undefined));
          }
          sessionByName.delete(handle.id);
          scratchKeyByName.delete(handle.id);
        });
      }
      if (tdOpts?.destroy && !scopeByName.has(handle.id)) return;
      const scope = scopeByName.get(handle.id) ?? "default";
      return localQueue(scope, async () => {
        const session = sessionByName.get(handle.id);
        if (tdOpts?.destroy) return destroyStoredScope(scope);
        if (!session) return;
        const stored = await store.get(scope);
        if (!tdOpts?.homeUnchanged) await store.merge(scope, { homeDirty: true });
        if (
          snapshotDue({ ...stored, lastSnapshotMs: lastSnapshotAttemptMs(stored) }, tdOpts, snapshotIntervalMs(stored))
        ) {
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
      const now = Date.now();
      const cutoff = now - Math.max(Math.min(idleMs, reapIdleMs), ACTIVITY_GRACE_MS);
      let reaped = 0;
      for (const [scope, rec] of await store.entries()) {
        if (rec.orgId && rec.orgId !== configOrgId()) continue;
        if (rec.hydrationPending) continue;
        const name = sandboxScopeName(prefix, scope);
        scopeByName.set(name, scope);
        let session: ModalSession | undefined;
        try {
          const cached = sessionByName.get(name);
          session = cached && cached.sandboxId === rec.sandboxId ? cached : await client.fromId(rec.sandboxId);
        } catch (e) {
          if (!(e instanceof ModalSandboxGoneError)) {
            reportError("sandbox_reap", "deep_idle_probe_failed", errMessage(e), scope);
            continue;
          }
        }
        if (!session) {
          sessionByName.delete(name);
          if (!rec.nativeSnapshotId) await forgetIfCurrent(scope, rec.sandboxId).catch(() => undefined);
          else if (checkpointRenewalDue(rec, now)) await renewCheckpoint(scope, name, rec);
          continue;
        }
        if (rec.expiresAtMs && rec.expiresAtMs - now <= lifetimeMarginMs) {
          const forced = rec.expiresAtMs - now <= lifetimeMarginMs / 2;
          reaped += await retire(scope, name, rec, session, forced ? undefined : now - ACTIVITY_GRACE_MS);
          continue;
        }
        if (rec.lastActivityMs && rec.lastActivityMs <= cutoff) {
          let busy: boolean;
          try {
            const handle: SandboxHandle = { id: name, rootDir: workspaceDir, homeDir: HOME_DIR, coldStart: false };
            const live = await createExecProcessSessions(directProcIo(session)).listProcesses(handle);
            busy = live.some((p) => p.status.state === "running");
          } catch (e) {
            if (e instanceof ModalSandboxGoneError) {
              sessionByName.delete(name);
              if (!rec.nativeSnapshotId) await forgetIfCurrent(scope, rec.sandboxId).catch(() => undefined);
            } else {
              reportError("sandbox_reap", "deep_idle_probe_failed", errMessage(e), scope);
            }
            continue;
          }
          if (!busy) {
            reaped += await retire(scope, name, rec, session, cutoff);
            continue;
          }
        }
        if (usesNativeSnapshots(rec) && now - lastSnapshotAttemptMs(rec) > snapshotIntervalMs(rec))
          await refreshCheckpoint(scope, rec, session);
      }
      reaped += await sweepOrphans(now);
      return { reaped };
    },
  };

  return sandbox;
}
