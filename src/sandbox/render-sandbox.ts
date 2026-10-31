import { SandboxSnapshotNotFoundError } from "@renderinc/sdk";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import type { CredentialPathSpec } from "../credentials/resident-paths.ts";
import { ephemeralCredLinkPaths } from "../credentials/resident-paths.ts";
import type { LayerInstallFile } from "../deployment/load-layer.ts";
import { createLayerToolInstaller } from "./layer-tool-install.ts";
import { errMessage, swallowAs } from "../util/errors.ts";
import { shq } from "../util/shell.ts";
import { AWS_CLI_ENSURE } from "./aws-cli.ts";
import { createExecSandboxBase, sandboxScopeName } from "./exec-sandbox-base.ts";
import { createExecProcessSessions } from "./exec-process-session.ts";
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
import type { RenderClient, RenderSandboxInfo, RenderSnapshot } from "./render-client.ts";
import { RENDER_SANDBOX_TTL_SEC } from "./render-limits.ts";

interface RenderSandboxResources {
  sandboxId?: string;
  checkpoint?: RenderSnapshot;
}

export interface StoredRenderSandbox extends RenderSandboxResources {
  sandboxId: string;
  expiresAtMs: number;
  lastActivityMs: number;
  homeDirty?: boolean;
  savedAtMs?: number;
  retiredResources?: RenderSandboxResources[];
  retirementError?: string;
  recoveryError?: string;
}

export interface StoredRenderScratch extends RenderSandboxInfo {
  cleanupPending?: boolean;
}

export interface StoredRenderCleanup {
  resources: RenderSandboxResources[];
  error?: string;
}

export interface RenderSandboxOptions extends BlobStagingOptions {
  client: RenderClient;
  store: DurableMap<StoredRenderSandbox>;
  scratchStore: DurableMap<StoredRenderScratch>;
  cleanupStore: DurableMap<StoredRenderCleanup>;
  advisoryLock: AdvisoryLock;
  namePrefix?: string;
  homeDir?: string;
  defaultTimeoutSec?: number;
  checkpointIntervalMs?: number;
  extraTools?: string[];
  credentialPaths?: CredentialPathSpec[];
  layerToolFiles?: () => readonly LayerInstallFile[];
  onError?: (e: { category: string; code: string; message: string; scopeLabel?: string }) => void;
}

export function createRenderSandbox(workspace: WorkspaceStore, opts: RenderSandboxOptions): Sandbox {
  const { client, store, scratchStore, cleanupStore, advisoryLock } = opts;
  const prefix = opts.namePrefix ?? "qm";
  const homeDir = opts.homeDir ?? "/root";
  const defaultTimeoutSec = opts.defaultTimeoutSec ?? 600;
  const checkpointIntervalMs = opts.checkpointIntervalMs ?? 5 * 60_000;
  const rotationMarginMs = (defaultTimeoutSec + 60) * 1000;
  const expiryCheckpointWindowMs = Math.max(rotationMarginMs, 20 * 60_000);
  const scratch = new Map<string, RenderSandboxInfo>();
  const nameFor = (scope: string): string => sandboxScopeName(prefix, scope);
  const lifecycleKey = (name: string): string => `render-sandbox:${name}`;
  const useKey = (name: string): string => `render-sandbox-use:${name}`;
  const withLifecycle = <T>(name: string, fn: () => Promise<T>): Promise<T> =>
    advisoryLock.withLock(lifecycleKey(name), fn);
  const withUse = <T>(name: string, fn: () => Promise<T>): Promise<T> => advisoryLock.withLock(useKey(name), fn);
  const tryLock = advisoryLock.tryWithLock;
  const tryUse = <T>(name: string, fn: () => Promise<T>): Promise<T | null> => tryLock(useKey(name), fn);
  const shared = advisoryLock.withSharedLock;
  const lockHandle =
    <Args extends unknown[], Result>(
      operation: (handle: SandboxHandle, ...args: Args) => Promise<Result>,
    ): ((handle: SandboxHandle, ...args: Args) => Promise<Result>) =>
    (handle, ...args) =>
      shared(useKey(handle.id), async () => {
        if (handle.scratch && handle.providerSandboxId) {
          const temporary = await scratchStore.get(handle.id);
          if (temporary?.id !== handle.providerSandboxId || temporary.cleanupPending)
            throw new Error("Render disposable sandbox has been released");
        }
        return operation(handle, ...args);
      });
  const reportError = (code: string, error: unknown, scopeLabel?: string): void =>
    opts.onError?.({
      category: "sandbox_snapshot",
      code,
      message: errMessage(error),
      ...(scopeLabel ? { scopeLabel } : {}),
    });
  const scopeFor = (name: string): string => {
    const scope = base.scopeFor(name);
    if (!scope) throw new Error(`Render sandbox scope is unknown: ${name}`);
    return scope;
  };
  const recentlySaved = (stored: StoredRenderSandbox): boolean =>
    stored.savedAtMs !== undefined && Date.now() - stored.savedAtMs < checkpointIntervalMs;
  const idFor = async (name: string, homeDirty = false): Promise<string> => {
    if (!base.scopeFor(name)) {
      const temporary = await scratchStore.get(name);
      if (!temporary) throw new Error("Render disposable sandbox has been released");
      if (temporary.cleanupPending) throw new Error("Render disposable sandbox cleanup is pending");
      return temporary.id;
    }
    const scope = scopeFor(name);
    const stored = await store.get(scope);
    if (!stored) throw new Error(`Render sandbox is not provisioned: ${name}`);
    if ((homeDirty && stored.homeDirty !== true) || Date.now() - stored.lastActivityMs >= 60_000)
      await store.merge(scope, { lastActivityMs: Date.now(), ...(homeDirty ? { homeDirty: true } : {}) });
    return stored.sandboxId;
  };
  const exec = async (name: string, script: string, timeoutSec: number): Promise<ExecResult> => {
    const result = await client.runScript(await idFor(name, true), script, timeoutSec);
    return { stdout: result.stdout, stderr: result.stderr, code: result.exitCode, timedOut: result.exitCode === 124 };
  };
  const installTools = async (sandboxId: string): Promise<void> => {
    const installed = await client.runScript(sandboxId, AWS_CLI_ENSURE, 300);
    if (installed.exitCode !== 0)
      reportError(
        "aws_cli_install_failed",
        new Error(
          `Render sandbox ${sandboxId} could not install the AWS CLI (exit ${installed.exitCode}): ${installed.stderr.slice(-300)} ${installed.stdout.slice(-300)}`.trim(),
        ),
      );
  };
  const writeAbsBytes = async (name: string, path: string, data: Uint8Array): Promise<void> =>
    client.writeFileBytes(await idFor(name, true), path, data);
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

  async function checkpoint(
    scope: string,
    stored: StoredRenderSandbox,
    active?: boolean,
  ): Promise<StoredRenderSandbox> {
    if (active === undefined) {
      const saved = await tryUse(nameFor(scope), async () =>
        (await hasLiveProcesses(stored.sandboxId)) ? null : checkpoint(scope, stored, false),
      );
      return saved ?? checkpoint(scope, stored, true);
    }
    stored = await cleanupRetired(scope, stored);
    let snapshot: RenderSnapshot | undefined;
    let saved: StoredRenderSandbox;
    try {
      snapshot = await client.createSnapshot(stored.sandboxId, nameFor(scope));
      const staged = await store.merge(scope, { retiredResources: retire(stored, { checkpoint: snapshot }) });
      if (!staged) throw new Error(`Render sandbox checkpoint lost its scope: ${scope}`);
      const available = await waitCheckpoint(snapshot);
      const merged = await store.merge(scope, {
        checkpoint: available,
        savedAtMs: Date.now(),
        homeDirty: active,
        recoveryError: undefined,
        retiredResources: stored.checkpoint
          ? retire(stored, { checkpoint: stored.checkpoint })
          : stored.retiredResources,
      });
      if (!merged) throw new Error(`Render sandbox checkpoint lost its scope: ${scope}`);
      saved = merged;
    } catch (error) {
      reportError("native_checkpoint_failed", error, scope);
      const current = await store.get(scope);
      if (current) {
        const failed = await store.merge(scope, {
          recoveryError: errMessage(error),
          ...(snapshot &&
          current.checkpoint?.id !== snapshot.id &&
          !current.retiredResources?.some((resources) => resources.checkpoint?.id === snapshot?.id)
            ? { retiredResources: retire(current, { checkpoint: snapshot }) }
            : {}),
        });
        if (failed) await cleanupRetired(scope, failed);
      }
      throw error;
    }
    return cleanupRetired(scope, saved);
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
    if (!stored || info?.status !== "running") return withUse(name, () => replace(scope, stored, info, onStatus));
    const running = stored;
    const rotated =
      info.expiresAtMs > Date.now() + rotationMarginMs
        ? null
        : await tryUse(name, async () =>
            (await hasLiveProcesses(info.id)) ? null : replace(scope, running, info, onStatus),
          );
    if (rotated) return rotated;
    await store.merge(scope, { lastActivityMs: Date.now() });
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
        stored = await checkpoint(scope, stored, false);
        await client.terminate(info.id);
      } else if (info?.status === "suspended") {
        await client.terminate(info.id);
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
    onStatus?.(stored ? "Restoring your computer…" : "Starting your computer…");
    await start(scope, stored, snapshotId);
    return { coldStart: !stored };
  }

  async function start(scope: string, stored: StoredRenderSandbox | null, from: string | undefined): Promise<void> {
    const created = await client.create(from);
    try {
      if (created.expiresAtMs <= Date.now() + rotationMarginMs) {
        throw new Error("Render sandbox lifetime must exceed the command timeout by at least 60 seconds");
      }
      await installTools(created.id);
      if (from) {
        const scrub = await client.runScript(created.id, `rm -rf /tmp/agent-creds ${shq(homeDir)}/.cred-state*`, 30);
        if (scrub.exitCode !== 0)
          throw new Error(`Render sandbox could not clear expired credentials: ${scrub.stderr}`);
      }
      await store.put(scope, {
        ...stored,
        sandboxId: created.id,
        expiresAtMs: created.expiresAtMs,
        lastActivityMs: Date.now(),
      });
    } catch (error) {
      await client.terminate(created.id).catch(swallowAs("render-sandbox: discard untracked sandbox", undefined));
      throw error;
    }
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
    return withLifecycle(name, () =>
      withUse(name, async () => {
        const stored = await store.get(scope);
        if (stored) {
          const earlier = await cleanupStore.get(scope);
          await cleanupStore.put(scope, {
            resources: [...(earlier?.resources ?? []), resourcesFor(stored), ...(stored.retiredResources ?? [])],
          });
          await store.delete(scope);
        }
        await finishCleanup(scope);
      }),
    );
  }

  async function destroyScratch(name: string): Promise<void> {
    const temporary = (await scratchStore.get(name)) ?? scratch.get(name);
    if (!temporary) return;
    await withUse(name, async () => {
      await scratchStore.put(name, { ...temporary, cleanupPending: true });
      await client.terminate(temporary.id);
      await scratchStore.delete(name);
      scratch.delete(name);
    });
  }

  const base = createExecSandboxBase({
    workspace,
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
      const temporary = await client.create();
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
      await installTools(temporary.id);
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
        os: `Debian 12 — Render sandbox (each sandbox runs at most ${RENDER_SANDBOX_TTL_SEC / 3600} hours; files return from checkpoints in the next sandbox, but background processes stop when a sandbox ends; publish durable work to git or Files)`,
        runtimes: ["Node 24", "Python 3"],
        cpus: 2,
        memoryMb: 4096,
        diskGb: 10,
        homeDir,
        workdir: base.workspaceDir,
        get tools() {
          return visibleTools(["git", "curl", "jq", "tar", "python3", "aws", ...(opts.extraTools ?? [])]);
        },
        get notInstalled() {
          return visibleNotInstalled(["gh", "gcloud", "kubectl", "flyctl", "glab"], opts.extraTools ?? []);
        },
      },
    },
    async provision(layers, options) {
      const writable = layers.find((layer) => layer.mode === "rw") ?? layers[0];
      const name = options?.scratch
        ? sandboxScopeName(`${prefix}-scratch`, options.scratch.key)
        : nameFor(writable?.scopeId ?? "default");
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
          handle = await base.provision(layers, options);
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
    run: lockHandle(base.run),
    readFile: lockHandle(base.readFile),
    writeFile: lockHandle(base.writeFile),
    readFileBytes: lockHandle(base.readFileBytes),
    writeFileBytes: lockHandle(base.writeFileBytes),
    importFiles: lockHandle(files.importFiles),
    listDir: lockHandle(files.listDir),
    removeDir: lockHandle(files.removeDir),
    exportFiles: lockHandle(exports.exportFiles),
    ...(staging ? { stageIn: lockHandle(staging.stageIn), stageOut: lockHandle(staging.stageOut) } : {}),
    startProcess: lockHandle(processes.startProcess),
    readProcess: lockHandle(processes.readProcess),
    writeStdin: lockHandle(processes.writeStdin),
    signalProcess: lockHandle(processes.signalProcess),
    listProcesses: lockHandle(processes.listProcesses),
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
        let stored = await store.get(scope);
        if (!stored) return;
        if (!options?.homeUnchanged && stored.homeDirty !== true)
          stored = (await store.merge(scope, { homeDirty: true })) ?? stored;
        if (
          (stored.homeDirty !== false && !recentlySaved(stored)) ||
          (stored.homeDirty === true && stored.expiresAtMs <= Date.now() + expiryCheckpointWindowMs)
        )
          await checkpoint(scope, stored).catch((error) => reportError("teardown_checkpoint_failed", error, scope));
        await store.merge(scope, { lastActivityMs: Date.now() });
      });
    },
    async restartComputer(scope) {
      const name = nameFor(scope);
      await withLifecycle(name, async () => {
        const stored = await store.get(scope);
        if (!stored) return;
        const info = await client.get(stored.sandboxId);
        if (info?.status !== "running") return;
        await withUse(name, async () => {
          await checkpoint(scope, stored, await hasLiveProcesses(info.id));
          await client.terminate(info.id);
        });
      });
    },
    async reapDeepIdle(idleMs) {
      let reaped = 0;
      for (const [name, candidate] of await scratchStore.entries()) {
        if (!candidate.cleanupPending && candidate.expiresAtMs > Date.now()) continue;
        await tryLock(lifecycleKey(name), async () => {
          const temporary = await scratchStore.get(name);
          if (!temporary || (!temporary.cleanupPending && temporary.expiresAtMs > Date.now())) return;
          await destroyScratch(name);
          reaped++;
        }).catch((error) => reportError("scratch_cleanup_failed", error));
      }
      const cutoff = idleMs > 0 ? Date.now() - idleMs : -Infinity;
      const stale = (stored: StoredRenderSandbox): boolean => stored.homeDirty !== false && !recentlySaved(stored);
      const due = (stored: StoredRenderSandbox): boolean =>
        stored.expiresAtMs > Date.now() &&
        (stored.lastActivityMs <= cutoff ||
          stored.expiresAtMs <= Date.now() + expiryCheckpointWindowMs ||
          stale(stored));
      for (const [scope] of await cleanupStore.entries())
        await tryLock(lifecycleKey(nameFor(scope)), () => finishCleanup(scope)).catch(
          swallowAs(`render-sandbox: finish cleanup of ${scope}`, undefined),
        );
      for (const [scope, candidate] of await store.entries()) {
        if (!due(candidate) && !candidate.retiredResources?.length) continue;
        const name = nameFor(scope);
        await tryLock(lifecycleKey(name), async () => {
          let stored = await store.get(scope);
          if (stored) stored = await cleanupRetired(scope, stored);
          if (!stored || !due(stored)) return;
          const info = await client.get(stored.sandboxId);
          if (info?.status !== "running") return;
          const expiresSoon = info.expiresAtMs <= Date.now() + expiryCheckpointWindowMs;
          const rotate = info.expiresAtMs <= Date.now() + rotationMarginMs;
          const idle = stored.lastActivityMs <= cutoff;
          if (!expiresSoon && !idle && !stale(stored)) return;
          const active = await hasLiveProcesses(info.id);
          if (active && !expiresSoon && !stale(stored)) return;
          const save = (!active && (idle || rotate || stale(stored))) || !recentlySaved(stored);
          const current = stored;
          const stopped =
            !active &&
            (idle || rotate) &&
            (await tryUse(name, async () => {
              if (await hasLiveProcesses(info.id)) return false;
              if (save) await checkpoint(scope, current, false);
              await client.terminate(info.id);
              return true;
            }));
          if (stopped) reaped++;
          else if (save) await checkpoint(scope, stored, active || undefined);
        }).catch((error) => reportError("idle_checkpoint_failed", error, scope));
      }
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
