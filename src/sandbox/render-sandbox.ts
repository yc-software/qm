import { bootTenant, tenancyBooted } from "../tenants/boot.ts";
import { SandboxSnapshotNotFoundError } from "@renderinc/sdk";
import { randomUUID } from "node:crypto";
import { orgId } from "../config.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import type { CredentialPathSpec } from "../credentials/resident-paths.ts";
import { ephemeralCredLinkPaths } from "../credentials/resident-paths.ts";
import type { LayerInstallFile } from "../deployment/load-layer.ts";
import { createLayerToolInstaller } from "./layer-tool-install.ts";
import { errMessage, swallow, swallowAs } from "../util/errors.ts";
import { shq } from "../util/shell.ts";
import { createExecSandboxBase, sandboxScopeName } from "./exec-sandbox-base.ts";
import { createExecProcessSessions } from "./exec-process-session.ts";
import { attemptSnapshot, snapshotDue, type SnapshotBookkeeping } from "./home-snapshot.ts";
import {
  createExecFileOps,
  createExecExport,
  createBackendBlobStaging,
  type BlobStagingOptions,
} from "./exec-file-ops.ts";
import {
  SandboxProvisionCleanupError,
  visibleNotInstalled,
  visibleTools,
  type ComputerStatus,
  type ExecResult,
  type Sandbox,
  type SandboxHandle,
} from "./sandbox.ts";
import type { RenderClient, RenderListedSandbox, RenderSandboxInfo, RenderSnapshot } from "./render-client.ts";
import type { RenderBase } from "./render-base.ts";
import { RENDER_COMPUTER_LIFETIME_SEC, RENDER_IDLE_STOP_MS, RENDER_SANDBOX_TTL_SEC } from "./render-limits.ts";
import { claimThenBind } from "../tenants/claim.ts";

const ORPHAN_GRACE_MS = 15 * 60_000;
const ACTIVITY_TOUCH_MS = 60_000;
const ACTIVITY_GRACE_MS = 3 * ACTIVITY_TOUCH_MS;
const RESTARTED_MESSAGE =
  "This Render computer was restarted or stopped while the command ran; its file changes may be lost, so check before running it again";
const DELETED_MESSAGE = "This Render computer was deleted while the command ran";
const FENCE = { stopped: true, stopping: true } as const;
const UNFENCE = { stopped: undefined, stopping: undefined };
const activeSince = (stored: StoredRenderSandbox | null, cutoffMs: number): boolean =>
  !stored || stored.lastActivityMs > cutoffMs;

interface RenderSandboxResources {
  sandboxId?: string;
  checkpoint?: RenderSnapshot;
}

export interface StoredRenderSandbox extends RenderSandboxResources, SnapshotBookkeeping {
  sandboxId: string;
  expiresAtMs: number;
  lastActivityMs: number;
  baseImage: string;
  stopped?: boolean;
  stopping?: boolean;
  retiredResources?: RenderSandboxResources[];
  retirementError?: string;
  recoveryError?: string;
}

export interface StoredRenderScratch extends RenderSandboxInfo {
  cleanupPending?: boolean;
}

export interface StoredRenderNamespace {
  id: string;
}

export interface StoredRenderCleanup {
  resources: RenderSandboxResources[];
  error?: string;
}

export interface RenderSandboxOptions extends BlobStagingOptions {
  client: RenderClient;
  base: RenderBase;
  store: DurableMap<StoredRenderSandbox>;
  scratchStore: DurableMap<StoredRenderScratch>;
  cleanupStore: DurableMap<StoredRenderCleanup>;
  advisoryLock: AdvisoryLock;
  namespaceStore: DurableMap<StoredRenderNamespace>;
  namePrefix?: string;
  homeDir?: string;
  defaultTimeoutSec?: number;
  checkpointIntervalMs?: number;
  extraTools?: string[];
  credentialPaths?: CredentialPathSpec[];
  layerToolFiles?: () => readonly LayerInstallFile[];
  onError?: (e: { category: string; code: string; message: string; scopeLabel?: string }, error?: unknown) => void;
}

export function createRenderSandbox(opts: RenderSandboxOptions): Sandbox {
  const { client, store, scratchStore, cleanupStore, advisoryLock, base: goldens } = opts;
  const prefix = opts.namePrefix ?? "qm";
  const homeDir = opts.homeDir ?? "/root";
  const defaultTimeoutSec = opts.defaultTimeoutSec ?? 600;
  const rotationMarginMs = (defaultTimeoutSec + 60) * 1000;
  const checkpointIntervalMs = opts.checkpointIntervalMs ?? 5 * 60_000;
  const scratch = new Map<string, RenderSandboxInfo>();
  const nameFor = (scope: string): string => sandboxScopeName(prefix, scope);
  let sandboxName: Promise<string> | undefined;
  const nameSandbox = (): Promise<string> =>
    (sandboxName ??= opts.namespaceStore.putIfAbsent("singleton", { id: randomUUID() }).then(
      (namespace) => sandboxScopeName(prefix, `${orgId()}-${namespace.id}`),
      (error: unknown) => {
        sandboxName = undefined;
        throw error;
      },
    ));
  const lifecycleKey = (name: string): string => `render-sandbox:${name}`;
  const withLifecycle = <T>(name: string, fn: () => Promise<T>): Promise<T> =>
    advisoryLock.withLock(lifecycleKey(name), fn);
  const tryLock = advisoryLock.tryWithLock;
  const guardHandle =
    <Args extends unknown[], Result>(
      operation: (handle: SandboxHandle, ...args: Args) => Promise<Result>,
    ): ((handle: SandboxHandle, ...args: Args) => Promise<Result>) =>
    async (handle, ...args) => {
      if (handle.scratch) {
        if (handle.providerSandboxId) {
          const temporary = await scratchStore.get(handle.id);
          if (temporary?.id !== handle.providerSandboxId || temporary.cleanupPending)
            throw new Error("Render disposable sandbox has been released");
        }
        return operation(handle, ...args);
      }
      const heartbeat = setInterval(
        () => void idFor(handle.id, true).catch(swallowAs("render-sandbox: record activity", undefined)),
        ACTIVITY_TOUCH_MS / 2,
      );
      heartbeat.unref();
      try {
        return await operation(handle, ...args);
      } finally {
        clearInterval(heartbeat);
      }
    };
  const reportError = (code: string, error: unknown, scopeLabel?: string): void =>
    opts.onError?.(
      {
        category: "sandbox_snapshot",
        code,
        message: errMessage(error),
        ...(scopeLabel ? { scopeLabel } : {}),
      },
      error,
    );
  const scopeFor = (name: string): string => {
    const scope = base.scopeFor(name);
    if (!scope) throw new Error(`Render sandbox scope is unknown: ${name}`);
    return scope;
  };
  const recentlySaved = (stored: StoredRenderSandbox): boolean => !snapshotDue(stored, undefined, checkpointIntervalMs);
  const idFor = async (name: string, homeDirty = false): Promise<string> => {
    if (!base.scopeFor(name)) {
      const temporary = await scratchStore.get(name);
      if (!temporary) throw new Error("Render disposable sandbox has been released");
      if (temporary.cleanupPending) throw new Error("Render disposable sandbox cleanup is pending");
      return temporary.id;
    }
    const scope = scopeFor(name);
    let stored = await store.get(scope);
    if (stored && ((homeDirty && stored.homeDirty !== true) || Date.now() - stored.lastActivityMs >= ACTIVITY_TOUCH_MS))
      stored = await store.update(scope, (row) =>
        row.stopped ? row : { ...row, lastActivityMs: Date.now(), ...(homeDirty ? { homeDirty: true } : {}) },
      );
    if (!stored) throw new Error(`Render sandbox is not provisioned: ${name}`);
    if (stored.stopping) throw new Error("This Render computer is being restarted or stopped; try again in a moment");
    if (stored.stopped)
      throw new Error("This Render computer has stopped; the next turn restores it from its last checkpoint");
    return stored.sandboxId;
  };
  const settle = async (name: string, sandboxId: string): Promise<string | undefined> => {
    const scope = base.scopeFor(name);
    if (!scope) return undefined;
    const current = await store.get(scope);
    if (!current) return DELETED_MESSAGE;
    if (current.sandboxId !== sandboxId) return RESTARTED_MESSAGE;
    if (current.stopped) return current.homeDirty === false ? RESTARTED_MESSAGE : undefined;
    if (current.homeDirty === false) await store.merge(scope, { homeDirty: true });
    return undefined;
  };
  const settleWrite = async <T>(name: string, sandboxId: string, work: () => Promise<T>): Promise<T> => {
    let result: T;
    try {
      result = await work();
    } catch (error) {
      await settle(name, sandboxId).catch(swallowAs("render-sandbox: mark home changed", undefined));
      throw error;
    }
    const lost = await settle(name, sandboxId).catch(swallowAs("render-sandbox: confirm write", undefined));
    if (lost) throw new Error(lost);
    return result;
  };
  const exec = async (name: string, script: string, timeoutSec: number): Promise<ExecResult> => {
    const sandboxId = await idFor(name, true);
    const startedAtMs = Date.now();
    const result = await settleWrite(name, sandboxId, () =>
      client.runScript(sandboxId, script, timeoutSec).catch(async (error: unknown) => {
        const scope = base.scopeFor(name);
        const info = scope ? await client.get(sandboxId).catch(() => undefined) : undefined;
        if (!scope || info === undefined || (info && info.status !== "terminated" && info.status !== "errored"))
          throw error;
        const current = await store.update(scope, (row) =>
          row.sandboxId === sandboxId ? { ...row, stopped: true } : row,
        );
        if (current && (current.sandboxId !== sandboxId || current.stopping))
          throw new Error(RESTARTED_MESSAGE, { cause: error });
        throw new Error("This Render computer has stopped; the next turn restores it from its last checkpoint", {
          cause: error,
        });
      }),
    );
    const timedOut =
      (result.exitCode === 124 || result.exitCode === 137) && Date.now() - startedAtMs >= timeoutSec * 1000;
    return { stdout: result.stdout, stderr: result.stderr, code: result.exitCode, timedOut };
  };
  const writeAbsBytes = async (name: string, path: string, data: Uint8Array): Promise<void> => {
    const sandboxId = await idFor(name, true);
    await settleWrite(name, sandboxId, () => client.writeFileBytes(sandboxId, path, data));
  };
  const readAbsBytes = async (name: string, path: string): Promise<Uint8Array | null> =>
    client.readFileBytes(await idFor(name), path);

  async function waitCheckpoint(snapshot: RenderSnapshot): Promise<RenderSnapshot> {
    const available = await client.waitSnapshot(snapshot);
    if (available.expiresAtMs <= Date.now())
      throw new Error(`Render checkpoint ${available.id} is no longer available`);
    return available;
  }

  const resourcesFor = (stored: StoredRenderSandbox): RenderSandboxResources => ({
    sandboxId: stored.sandboxId,
    checkpoint: stored.checkpoint,
  });

  async function disposeResources(resources: RenderSandboxResources): Promise<void> {
    if (resources.sandboxId) await client.terminate(resources.sandboxId);
    if (resources.checkpoint) await client.deleteSnapshot(resources.checkpoint);
  }

  async function cleanupRetired(scope: string, stored: StoredRenderSandbox): Promise<StoredRenderSandbox> {
    const retired = [...(stored.retiredResources ?? [])];
    while (retired.length) {
      try {
        await disposeResources(retired[0]!);
      } catch (error) {
        reportError("retirement_failed", error, scope);
        return (await store.merge(scope, { retirementError: errMessage(error) }))!;
      }
      retired.shift();
      stored = (await store.merge(scope, {
        retiredResources: retired.length ? retired : undefined,
        retirementError: undefined,
      }))!;
    }
    return stored;
  }

  const retire = (stored: StoredRenderSandbox, resources: RenderSandboxResources): RenderSandboxResources[] => [
    ...(stored.retiredResources ?? []),
    resources,
  ];

  async function recordCheckpointFailure(scope: string, error: unknown, snapshot: RenderSnapshot | undefined) {
    const current = await store.get(scope);
    if (!current) return;
    const failed = await store.merge(scope, {
      homeDirty: true,
      recoveryError: errMessage(error),
      ...(snapshot &&
      current.checkpoint?.id !== snapshot.id &&
      !current.retiredResources?.some((resources) => resources.checkpoint?.id === snapshot.id)
        ? { retiredResources: retire(current, { checkpoint: snapshot }) }
        : {}),
    });
    if (failed) await cleanupRetired(scope, failed);
  }

  async function checkpoint(
    scope: string,
    stored: StoredRenderSandbox,
    active?: boolean,
  ): Promise<StoredRenderSandbox> {
    if (active === undefined) return checkpoint(scope, stored, await hasLiveProcesses(stored.sandboxId));
    stored = await cleanupRetired(scope, stored);
    if (!active) stored = (await store.merge(scope, { homeDirty: false })) ?? stored;
    let snapshot: RenderSnapshot | undefined;
    let saved: StoredRenderSandbox;
    try {
      snapshot = await client.createSnapshot(stored.sandboxId, nameFor(scope));
      const staged = await store.merge(scope, { retiredResources: retire(stored, { checkpoint: snapshot }) });
      if (!staged) throw new Error(`Render sandbox checkpoint lost its scope: ${scope}`);
      const available = await waitCheckpoint(snapshot);
      const merged = await store.merge(scope, {
        checkpoint: available,
        lastSnapshotMs: Date.now(),
        ...(active ? { homeDirty: true } : {}),
        recoveryError: undefined,
        retiredResources: stored.checkpoint
          ? retire(stored, { checkpoint: stored.checkpoint })
          : stored.retiredResources,
      });
      if (!merged) throw new Error(`Render sandbox checkpoint lost its scope: ${scope}`);
      saved = merged;
    } catch (error) {
      await recordCheckpointFailure(scope, error, snapshot).catch(
        swallowAs("render-sandbox: record checkpoint failure", undefined),
      );
      throw error;
    }
    return cleanupRetired(scope, saved);
  }

  async function clearCredentials(sandboxId: string): Promise<void> {
    const scrub = await client.runScript(sandboxId, `rm -rf /tmp/agent-creds ${shq(homeDir)}/.cred-state*`, 30);
    if (scrub.exitCode !== 0) throw new Error(`Render sandbox could not clear expired credentials: ${scrub.stderr}`);
  }

  async function hasLiveProcesses(sandboxId: string): Promise<boolean> {
    const sessions = await createExecProcessSessions({
      async run(_handle, command, options) {
        const result = await client.runScript(sandboxId, command, Math.ceil((options?.timeoutMs ?? 30_000) / 1000));
        if (result.exitCode !== 0) throw new Error(`Render process probe failed: ${result.stderr}`);
        return { stdout: result.stdout, stderr: result.stderr, code: result.exitCode, timedOut: false };
      },
    }).listProcesses({ id: sandboxId, rootDir: `${homeDir}/workspace`, homeDir });
    return sessions.some((process) => process.status.state === "running");
  }

  async function ensureResident(name: string, onStatus?: (text: string) => void): Promise<{ coldStart: boolean }> {
    const scope = scopeFor(name);
    const pending = await cleanupStore.get(scope);
    if (pending)
      await finishCleanup(scope).catch(async (error: unknown) => {
        const current = await store.get(scope);
        if (current && pending.resources.some(({ sandboxId }) => sandboxId === current.sandboxId)) throw error;
      });
    let stored = await store.get(scope);
    if (stored) stored = await cleanupRetired(scope, stored);
    const info = stored ? await client.get(stored.sandboxId) : null;
    if (!stored || info?.status !== "running") return replace(scope, stored, info, onStatus);
    const now = Date.now();
    if (
      info.expiresAtMs <= now + rotationMarginMs &&
      (info.expiresAtMs <= now + rotationMarginMs / 2 || !activeSince(stored, now - ACTIVITY_GRACE_MS)) &&
      !(await hasLiveProcesses(info.id))
    )
      return replace(scope, stored, info, onStatus);
    await store.merge(scope, { lastActivityMs: Date.now(), ...(stored.stopped || stored.stopping ? UNFENCE : {}) });
    return { coldStart: false };
  }

  async function replace(
    scope: string,
    stored: StoredRenderSandbox | null,
    info: RenderSandboxInfo | null,
    onStatus?: (text: string) => void,
  ): Promise<{ coldStart: boolean }> {
    let snapshotId: string | undefined;
    if (stored) {
      if (info?.status === "running") {
        const running = stored;
        await store.merge(scope, FENCE);
        stored = await reopenOnFailure(scope, async () => {
          const saved = await checkpoint(scope, running, false);
          await client.terminate(info.id);
          return saved;
        });
      } else if (info?.status === "suspended") {
        await client.terminate(info.id);
        await store.merge(scope, { stopped: true });
      } else if (info && info.status !== "terminated" && info.status !== "errored") {
        throw new Error(`Render sandbox ${info.id} is ${info.status}; retry after its transition ends`);
      }
      if (stored.checkpoint && stored.checkpoint.expiresAtMs > Date.now()) {
        const snapshot = await client.getSnapshot(stored.checkpoint).catch((error) => {
          if (error instanceof SandboxSnapshotNotFoundError) return null;
          throw error;
        });
        if (snapshot?.status === "available" && snapshot.expiresAtMs > Date.now()) snapshotId = snapshot.id;
      }
      if (!snapshotId) {
        throw new Error(
          "Render sandbox has no available native snapshot; refusing an empty replacement. Restore a recovery copy or delete this computer to start again.",
        );
      }
    }
    const source = stored ? { ref: stored.baseImage, snapshotId: snapshotId! } : await goldens.ready(onStatus);
    onStatus?.(stored ? "Restoring your computer…" : "Starting your computer…");
    await start(scope, stored, source).catch(async (error: unknown) => {
      if (stored?.stopping)
        await store
          .merge(scope, { stopping: undefined })
          .catch(swallowAs("render-sandbox: end a failed restart", undefined));
      throw error;
    });
    return { coldStart: !stored };
  }

  async function reopenOnFailure<T>(scope: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      await store
        .merge(scope, UNFENCE)
        .catch(swallowAs("render-sandbox: reopen computer after a failed stop", undefined));
      throw error;
    }
  }

  async function start(
    scope: string,
    stored: StoredRenderSandbox | null,
    source: { ref: string; snapshotId: string },
  ): Promise<void> {
    const created = await client.create({
      name: await nameSandbox(),
      snapshotId: source.snapshotId,
      lifetimeSec: RENDER_COMPUTER_LIFETIME_SEC,
      onCreated: (sandboxId) => holdForCleanup(scope, sandboxId),
    });
    try {
      if (stored) {
        await clearCredentials(created.id);
      }
      await store.put(scope, {
        ...stored,
        sandboxId: created.id,
        expiresAtMs: created.expiresAtMs,
        lastActivityMs: Date.now(),
        baseImage: source.ref,
        stopped: undefined,
        stopping: undefined,
      });
    } catch (error) {
      await client
        .terminate(created.id)
        .then(
          () => releaseFromCleanup(scope, created.id),
          async (terminateError: unknown) => {
            swallow(`render-sandbox: terminate untracked sandbox ${created.id}`, terminateError);
            if ((await store.get(scope))?.sandboxId !== created.id) await holdForCleanup(scope, created.id);
          },
        )
        .catch(swallowAs("render-sandbox: discard untracked sandbox", undefined));
      throw error;
    }
    await releaseFromCleanup(scope, created.id);
  }

  async function holdForCleanup(scope: string, sandboxId: string): Promise<void> {
    const pending = await cleanupStore.get(scope);
    if (pending?.resources.some((resources) => resources.sandboxId === sandboxId)) return;
    await cleanupStore.put(scope, { ...pending, resources: [...(pending?.resources ?? []), { sandboxId }] });
  }

  async function releaseFromCleanup(scope: string, sandboxId: string): Promise<void> {
    const pending = await cleanupStore.get(scope);
    if (!pending) return;
    const resources = pending.resources.filter((resources) => resources.sandboxId !== sandboxId);
    if (resources.length) await cleanupStore.put(scope, { ...pending, resources });
    else await cleanupStore.delete(scope);
  }

  async function finishCleanup(scope: string): Promise<void> {
    let pending = await cleanupStore.get(scope);
    if (!pending) return;
    const stored = await store.get(scope);
    if (stored && pending.resources.some((resources) => resources.sandboxId === stored.sandboxId))
      await store.delete(scope);
    try {
      while (pending.resources.length) {
        await disposeResources(pending.resources[0]!);
        pending = { resources: pending.resources.slice(1) };
        await cleanupStore.put(scope, pending);
      }
      await cleanupStore.delete(scope);
    } catch (error) {
      reportError("retirement_failed", error, scope);
      await cleanupStore.put(scope, { ...pending, error: errMessage(error) });
      throw error;
    }
  }

  async function destroyScope(scope: string): Promise<void> {
    const name = nameFor(scope);
    return withLifecycle(name, async () => {
      const stored = await store.get(scope);
      if (stored) {
        const earlier = await cleanupStore.get(scope);
        await cleanupStore.put(scope, {
          resources: [...(earlier?.resources ?? []), resourcesFor(stored), ...(stored.retiredResources ?? [])],
        });
        await store.delete(scope);
      }
      await finishCleanup(scope);
    });
  }

  async function trackedSandboxIds(): Promise<Set<string>> {
    const resources: RenderSandboxResources[] = [];
    for (const [, stored] of await store.entries()) resources.push(stored, ...(stored.retiredResources ?? []));
    for (const [, pending] of await cleanupStore.entries()) resources.push(...pending.resources);
    const ids = new Set(resources.flatMap((entry) => (entry.sandboxId ? [entry.sandboxId] : [])));
    for (const [, temporary] of await scratchStore.entries()) ids.add(temporary.id);
    for (const temporary of scratch.values()) ids.add(temporary.id);
    return ids;
  }

  async function sweepOrphans(): Promise<number> {
    if (bootTenant() === undefined && tenancyBooted()) return 0;
    let listed: RenderListedSandbox[];
    try {
      listed = await client.listLive(await nameSandbox());
    } catch (error) {
      reportError("orphan_list_failed", error);
      return 0;
    }
    const cutoff = Date.now() - ORPHAN_GRACE_MS;
    const candidates = listed.filter((sandbox) => sandbox.createdAtMs <= cutoff);
    if (!candidates.length) return 0;
    const tracked = await trackedSandboxIds();
    let reaped = 0;
    for (const orphan of candidates) {
      if (tracked.has(orphan.id)) continue;
      try {
        await client.terminate(orphan.id);
        reaped++;
      } catch (error) {
        reportError("orphan_terminate_failed", new Error(`terminate orphan sandbox ${orphan.id}`, { cause: error }));
      }
    }
    return reaped;
  }

  async function destroyScratch(name: string): Promise<void> {
    const temporary = (await scratchStore.get(name)) ?? scratch.get(name);
    if (!temporary) return;
    await scratchStore.put(name, { ...temporary, cleanupPending: true });
    await client.terminate(temporary.id);
    await scratchStore.delete(name);
    scratch.delete(name);
  }

  const base = createExecSandboxBase({
    label: "render",
    prefix,
    homeDir,
    defaultTimeoutSec,
    credentialPaths: opts.credentialPaths ?? [],
    deleteFailureCode: "render_destroy_failed",
    onError: opts.onError,
    exec,
    writeAbsBytes,
    readAbsBytes,
    ensureResident,
    isProvisioned: (name) => scratch.has(name),
    async recreateScratch(name) {
      const temporary = await client.create({
        name: await nameSandbox(),
        snapshotId: (await goldens.ready()).snapshotId,
        lifetimeSec: RENDER_SANDBOX_TTL_SEC,
      });
      scratch.set(name, temporary);
      try {
        await scratchStore.put(name, temporary);
      } catch (error) {
        try {
          await client.terminate(temporary.id);
          scratch.delete(name);
        } catch (cleanupError) {
          await scratchStore.put(name, { ...temporary, cleanupPending: true });
          reportError("scratch_cleanup_failed", cleanupError);
        }
        throw error;
      }
    },
    async deleteInstance(name) {
      const scope = base.scopeFor(name);
      if (scope) await destroyScope(scope);
      else await destroyScratch(name);
    },
    ...(opts.layerToolFiles ? { installLayerTools: createLayerToolInstaller(opts.layerToolFiles) } : {}),
  });
  const processes = createExecProcessSessions({
    run: (handle, command, options) =>
      exec(handle.id, command, options?.timeoutMs ? Math.ceil(options.timeoutMs / 1000) : defaultTimeoutSec),
  });
  const staging = createBackendBlobStaging("render", exec, opts);
  const files = createExecFileOps({ label: "render", exec, writeInline: writeAbsBytes });
  const exports = createExecExport({
    label: "render",
    exec,
    readAbsBytes,
    defaultHomeDir: homeDir,
    ephemeralCredentialPrefixes: ephemeralCredLinkPaths(opts.credentialPaths ?? []).map(({ rel }) => rel),
  });

  return {
    profile: {
      backend: "render",
      writablePersistence: "provider_managed",
      processSessions: true,
      egressEnforcement: "none",
      spec: {
        os: `Debian 12 — Render sandbox from the QM sandbox base image (it stops after ${RENDER_IDLE_STOP_MS / 60_000} idle minutes with no running processes and runs at most ${RENDER_COMPUTER_LIFETIME_SEC / 86400} days; files return from checkpoints when it starts again, but background processes do not; publish durable work to git or Files)`,
        runtimes: ["Node 24", "Python 3 (venv on PATH — `pip install` just works)"],
        cpus: 2,
        memoryMb: 4096,
        diskGb: 10,
        homeDir,
        workdir: base.workspaceDir,
        get tools() {
          return visibleTools([
            "git",
            "curl",
            "wget",
            "jq",
            "unzip",
            "gnupg",
            "python3",
            "gh",
            "aws (CLI v2)",
            ...(opts.extraTools ?? []),
          ]);
        },
        get notInstalled() {
          return visibleNotInstalled(["gcloud", "kubectl", "flyctl", "glab"], opts.extraTools ?? []);
        },
      },
    },
    async provision(scope, options) {
      const name = options?.scratch ? sandboxScopeName(`${prefix}-scratch`, options.scratch.key) : nameFor(scope);
      await goldens.ready(options?.onStatus);
      return withLifecycle(name, async () => {
        if (options?.scratch) {
          const temporary = await scratchStore.get(name);
          if (temporary?.cleanupPending) await destroyScratch(name);
          else if (temporary && scratch.get(name)?.id !== temporary.id)
            throw new Error("Render disposable sandbox is in use by another core");
          else if (!temporary) scratch.delete(name);
        }
        let handle: SandboxHandle;
        try {
          handle = await base.provision(scope, options);
        } catch (error) {
          const temporary = scratch.get(name);
          if (error instanceof SandboxProvisionCleanupError && temporary) error.handle.providerSandboxId = temporary.id;
          throw error;
        }
        if (handle.scratch) {
          handle.providerSandboxId = scratch.get(handle.id)?.id;
        } else {
          const scope = scopeFor(handle.id);
          const stored = await store.get(scope);
          if (stored && !stored.checkpoint && !recentlySaved(stored)) await checkpoint(scope, stored);
        }
        return handle;
      });
    },
    run: guardHandle(base.run),
    readFile: guardHandle(base.readFile),
    writeFile: guardHandle(base.writeFile),
    readFileBytes: guardHandle(base.readFileBytes),
    writeFileBytes: guardHandle(base.writeFileBytes),
    importFiles: guardHandle(files.importFiles),
    listDir: guardHandle(files.listDir),
    removeDir: guardHandle(files.removeDir),
    exportFiles: guardHandle(exports.exportFiles),
    ...(staging ? { stageIn: guardHandle(staging.stageIn), stageOut: guardHandle(staging.stageOut) } : {}),
    startProcess: guardHandle(processes.startProcess),
    readProcess: guardHandle(processes.readProcess),
    writeStdin: guardHandle(processes.writeStdin),
    signalProcess: guardHandle(processes.signalProcess),
    listProcesses: guardHandle(processes.listProcesses),
    destroyScope,

    async persistHomeSnapshot(scope) {
      await withLifecycle(nameFor(scope), async () => {
        const stored = await store.get(scope);
        if (!stored) throw new Error(`Render sandbox is not provisioned: ${scope}`);
        await checkpoint(scope, stored);
      });
    },
    async teardown(handle, options) {
      if (handle.scratch)
        return withLifecycle(handle.id, async () => {
          const temporary = await scratchStore.get(handle.id);
          if (handle.providerSandboxId && temporary?.id !== handle.providerSandboxId) return;
          await base.teardown(handle, options);
        });
      const scope = scopeFor(handle.id);
      if (options?.destroy) return destroyScope(scope);
      await withLifecycle(handle.id, async () => {
        const stored = await store.get(scope);
        if (!stored) return;
        if (!options?.homeUnchanged && stored.homeDirty !== true) await store.merge(scope, { homeDirty: true });
        if (snapshotDue(stored, options, checkpointIntervalMs))
          await attemptSnapshot(
            stored,
            (patch) => store.merge(scope, patch),
            () => checkpoint(scope, stored),
            (message) => reportError("teardown_checkpoint_failed", message, scope),
          );
        await store.merge(scope, { lastActivityMs: Date.now() });
      });
    },
    async restartComputer(scope) {
      const name = nameFor(scope);
      await withLifecycle(name, async () => {
        const stored = await store.get(scope);
        if (!stored) return;
        const info = await client.get(stored.sandboxId);
        await replace(scope, stored, info);
      });
    },
    async reapDeepIdle(idleMs) {
      let reaped = 0;
      const scratchDue = (scratch: StoredRenderScratch | null): boolean =>
        !!scratch && (scratch.cleanupPending || scratch.expiresAtMs <= Date.now());
      await claimThenBind(scratchStore.claimTenants, async () => {
        for (const [name, scratch] of await scratchStore.entries())
          if (scratchDue(scratch))
            await tryLock(lifecycleKey(name), async () => {
              if (!scratchDue(await scratchStore.get(name))) return;
              await destroyScratch(name);
              reaped++;
            }).catch((error) => reportError("scratch_cleanup_failed", error));
      });
      const cutoff =
        Date.now() - Math.max(ACTIVITY_GRACE_MS, Math.min(idleMs > 0 ? idleMs : Infinity, RENDER_IDLE_STOP_MS));
      const stale = (stored: StoredRenderSandbox): boolean => stored.homeDirty !== false && !recentlySaved(stored);
      const due = (stored: StoredRenderSandbox): boolean =>
        !!stored.stopping ||
        (!stored.stopped && (stored.expiresAtMs <= Date.now() || stored.lastActivityMs <= cutoff || stale(stored)));
      await claimThenBind(
        () => cleanupStore.claimIds(),
        (scope) =>
          tryLock(lifecycleKey(nameFor(scope)), () => finishCleanup(scope)).catch(
            swallowAs(`render-sandbox: finish cleanup of ${scope}`, undefined),
          ),
      );
      await claimThenBind(store.claimTenants, async () => {
        for (const [scope, candidate] of await store.entries()) {
          if (!due(candidate) && !candidate.retiredResources?.length) continue;
          const name = nameFor(scope);
          await tryLock(lifecycleKey(name), async () => {
            let stored = await store.get(scope);
            if (stored) stored = await cleanupRetired(scope, stored);
            if (stored?.stopping) stored = await store.merge(scope, UNFENCE);
            if (!stored || !due(stored)) return;
            const info = await client.get(stored.sandboxId);
            if (!info || info.status === "terminated" || info.status === "errored") {
              if (stored.expiresAtMs > Date.now())
                reportError(
                  "computer_ended",
                  new Error(`Render sandbox ${stored.sandboxId} is ${info?.status ?? "missing"}`),
                  scope,
                );
              await store.merge(scope, { stopped: true });
              return;
            }
            if (info.status !== "running") return;
            const active = await hasLiveProcesses(info.id);
            if (active && !stale(stored)) return;
            if (active || activeSince(stored, cutoff)) {
              await checkpoint(scope, stored, active || undefined);
              return;
            }
            const fenced = await store.update(scope, (row) => (activeSince(row, cutoff) ? row : { ...row, ...FENCE }));
            if (!fenced?.stopping) return;
            const stopped = await reopenOnFailure(scope, async () => {
              if (await hasLiveProcesses(info.id)) return false;
              await clearCredentials(info.id).catch((error: unknown) =>
                reportError("credential_clear_failed", error, scope),
              );
              await checkpoint(scope, fenced, false);
              await client.terminate(info.id);
              return true;
            });
            await store.merge(scope, stopped ? { stopping: undefined } : UNFENCE);
            if (stopped) reaped++;
          }).catch((error) => reportError("idle_checkpoint_failed", error, scope));
        }
      });
      reaped += await sweepOrphans();
      return { reaped };
    },
    async computerStatus(scope): Promise<ComputerStatus> {
      const stored = await store.get(scope);
      if (!stored) {
        const pending = await cleanupStore.get(scope);
        if (!pending) return { machine: "no sandbox provisioned yet", provisioned: false, guestResponsive: false };
        return {
          machine: "Render cleanup pending",
          provisioned: false,
          guestResponsive: false,
          recovery: { strategy: "provider_snapshot", state: "cleanup_pending", error: pending.error },
        };
      }
      const recovery = {
        strategy: "provider_snapshot" as const,
        ...(stored.checkpoint
          ? {
              checkpointId: stored.checkpoint.id,
              checkpointAtMs: stored.checkpoint.capturedAtMs,
              checkpointExpiresAtMs: stored.checkpoint.expiresAtMs,
            }
          : {}),
        ...((stored.recoveryError ?? stored.retirementError)
          ? { error: stored.recoveryError ?? stored.retirementError }
          : {}),
      };
      try {
        const info = await client.get(stored.sandboxId);
        const running = info?.status === "running";
        if (!running && stored.checkpoint && stored.checkpoint.expiresAtMs > Date.now())
          return {
            machine: `Render sandbox ${stored.sandboxId}: ${info?.status ?? "missing"}`,
            lifecycleState: "paused",
            provisioned: true,
            guestResponsive: false,
            recovery,
          };
        const response = running ? await client.runScript(stored.sandboxId, "true", 10) : null;
        return {
          machine: `Render sandbox ${stored.sandboxId}: ${info?.status ?? "missing"}`,
          provisioned: running,
          guestResponsive: response?.exitCode === 0,
          expiresAtMs: stored.expiresAtMs,
          recovery,
          ...(running ? { lifecycleState: "running" } : {}),
        };
      } catch (error) {
        return {
          machine: `Render sandbox ${stored.sandboxId}`,
          guestResponsive: false,
          recovery,
          probeError: errMessage(error),
        };
      }
    },
  };
}
