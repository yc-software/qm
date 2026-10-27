import type { WorkspaceLayer } from "../types.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import type { LayerInstallFile } from "../deployment/load-layer.ts";
import { errMessage, swallowAs } from "../util/errors.ts";
import { ephemeralCredLinkPaths, type CredentialPathSpec } from "../credentials/resident-paths.ts";
import { createExecProcessSessions } from "./exec-process-session.ts";
import {
  createBackendBlobStaging,
  createExecExport,
  createExecFileOps,
  type BlobStagingOptions,
} from "./exec-file-ops.ts";
import { createExecSandboxBase, sandboxScopeName, type ExecSandboxBase } from "./exec-sandbox-base.ts";
import { createLayerToolInstaller } from "./layer-tool-install.ts";
import { withConnectorSdk, type ConnectorSdkBundle } from "./connector-sdk.ts";
import { isJobComputerScope, visibleNotInstalled, visibleTools } from "./sandbox.ts";
import type { SandboxBodies } from "./sandbox-bodies.ts";
import type {
  AgentComputerProfile,
  BackendSandbox,
  ComputerStatus,
  EgressEnforcement,
  ExecResult,
  ProvisionOptions,
  SandboxHandle,
  TeardownOptions,
  WritablePersistence,
} from "./sandbox.ts";

const DEFAULT_TIMEOUT_SEC = 600;
const DEFAULT_SNAPSHOT_INTERVAL_SEC = 300;
const GUEST_PROBE_TIMEOUT_SEC = 15;
const BASE_TOOLS = ["git", "curl", "jq", "tar", "python3"];
const OPTIONAL_TOOLS = ["gh", "aws", "gcloud", "kubectl", "flyctl", "glab"];

type ErrorReport = (e: { category: string; code: string; message: string; scopeLabel?: string }) => void;

export interface SandboxShared extends BlobStagingOptions {
  defaultTimeoutSec?: number;
  egressProxyUrl?: string;
  snapshotIntervalSec?: number;
  cpus?: number;
  memoryMb?: number;
  diskGb?: number;
  idleParkSec?: number;
  maxLifetimeSec?: number;
  keepWarmSec?: number;
  advisoryLock: AdvisoryLock;
  extraTools?: string[];
  credentialPaths?: CredentialPathSpec[];
  layerToolFiles?: () => readonly LayerInstallFile[];
  connectorSdk?: () => Promise<ConnectorSdkBundle>;
  onError?: ErrorReport;
}

export const sandboxNamePrefix = (shared: BlobStagingOptions): string =>
  shared.tenantConfig?.().sandboxNamePrefix ?? "qm";

export interface StoredSandboxRecord {
  initializationPending?: boolean;
  lastSnapshotMs?: number;
  homeDirty?: boolean;
  snapshotError?: string;
  checkpointId?: string;
  checkpointAtMs?: number;
}

export interface MachineState {
  state: "running" | "parked";
  detail: string;
  resources?: ComputerStatus["resources"];
}

interface DriverCheckpoints {
  machineBound?: boolean;
  capture(name: string): Promise<string>;
  restore(name: string, checkpointId: string): Promise<void>;
  drop?(name: string, checkpointId: string): Promise<void>;
}

export interface SandboxDriver {
  backend: string;
  /** cpus/memoryMb/diskGb are read live, so a driver may fill them in once it observes the machine. */
  homeDir: string;
  os: string;
  runtimes?: string[];
  tools?: string[];
  cpus?: number;
  memoryMb?: number;
  diskGb?: number;
  writablePersistence?: WritablePersistence;
  egressEnforcement: EgressEnforcement;
  combineRoundTrips?: boolean;
  envViaExec?: boolean;
  exec(name: string, script: string, timeoutSec: number, env?: Record<string, string>): Promise<ExecResult>;
  writeAbsBytes(name: string, absPath: string, data: Uint8Array): Promise<void>;
  readAbsBytes(name: string, absPath: string): Promise<Uint8Array | null>;
  inspect(name: string): Promise<MachineState | null>;
  create(name: string, opts: { scratch: boolean; scope?: string }): Promise<void | { homeRetained: boolean }>;
  resume(name: string): Promise<void>;
  park?(name: string, opts: { keepWarm: boolean }): Promise<void>;
  destroy(name: string): Promise<void>;
  isLive(name: string): boolean;
  forget?(name: string): void;
  restart?(name: string, ctx: { initializationPending: boolean }): Promise<void>;
  rotationDue?(name: string): Promise<boolean>;
  ensureEgress?(name: string): Promise<void>;
  checkpoints?: DriverCheckpoints;
}

export type ProviderSandbox = BackendSandbox & {
  readonly scopeFor: (name: string) => string | undefined;
  readonly scopeOf: (name: string) => Promise<string | undefined>;
  readonly nameFor: (scopeId: string) => string;
  readonly lifecycle: <T>(scopeId: string, fn: () => Promise<T>) => Promise<T>;
  readonly captureCheckpoint: (scopeId: string, name: string) => Promise<void>;
  readonly ensureResident: (scopeId: string) => Promise<void>;
};

interface ProviderContext {
  driver: SandboxDriver;
  store: SandboxBodies<StoredSandboxRecord>;
  backend: string;
  lock: <T>(scope: string, fn: () => Promise<T>) => Promise<T>;
  report: (category: string, code: string, e: unknown, scopeLabel?: string) => void;
}

function createProviderCheckpointing({ driver, store, backend, report }: ProviderContext) {
  async function captureCheckpoint(scope: string, name: string): Promise<void> {
    if (isJobComputerScope(scope)) return;
    const previous = (await store.get(scope))?.checkpointId;
    try {
      const checkpointId = await driver.checkpoints!.capture(name);
      await store.upsert(scope, {
        checkpointId,
        checkpointAtMs: Date.now(),
        lastSnapshotMs: Date.now(),
        homeDirty: false,
        snapshotError: undefined,
      });
      if (previous && previous !== checkpointId)
        await driver.checkpoints
          ?.drop?.(name, previous)
          .catch(swallowAs(`${backend}-sandbox: drop checkpoint`, undefined));
    } catch (e) {
      await store.upsert(scope, { snapshotError: errMessage(e) });
      throw e;
    }
  }

  async function rotate(scope: string, name: string): Promise<boolean> {
    try {
      if (driver.checkpoints) await captureCheckpoint(scope, name);
      await driver.destroy(name);
      driver.forget?.(name);
      return true;
    } catch (e) {
      report("sandbox_snapshot", "rotate_failed", e, scope);
      return false;
    }
  }

  async function initialize(scope: string, name: string, onStatus?: (text: string) => void): Promise<boolean> {
    let stored = await store.get(scope);
    if (driver.isLive(name) && !stored?.initializationPending) return false;
    let existing = await driver.inspect(name);
    if (
      existing &&
      !stored?.initializationPending &&
      (await driver.rotationDue?.(name)) &&
      (await rotate(scope, name))
    ) {
      existing = null;
      stored = await store.get(scope);
    }
    if (existing && !stored?.initializationPending) {
      if (existing.state === "parked") await driver.resume(name);
      return false;
    }
    await store.upsert(scope, { initializationPending: true });
    onStatus?.("Preparing the sandbox…");
    let created = false;
    let booted = false;
    let retained = false;
    try {
      if (existing) await driver.resume(name);
      else {
        retained = (await driver.create(name, { scratch: false, scope }))?.homeRetained ?? false;
        created = true;
      }
      booted = true;
      const checkpointId = stored?.checkpointId;
      const machineBound = !!driver.checkpoints?.machineBound;
      const restored =
        checkpointId && driver.checkpoints && !machineBound
          ? (await driver.checkpoints.restore(name, checkpointId), true)
          : false;
      const hydrated = restored || retained;
      await store.upsert(scope, {
        initializationPending: undefined,
        ...(hydrated ? { homeDirty: false } : {}),
        ...(created && machineBound ? { checkpointId: undefined, checkpointAtMs: undefined } : {}),
      });
      return !hydrated;
    } catch (e) {
      if (created)
        await driver.destroy(name).catch(swallowAs(`${backend}-sandbox: destroy after failed hydration`, undefined));
      driver.forget?.(name);
      if (!booted) throw e;
      report("sandbox_hydrate", "hydrate_failed", e, scope);
      throw new Error(
        `${backend} provision: checkpoint restore failed (${errMessage(e)}); not starting an empty home`,
        {
          cause: e,
        },
      );
    }
  }

  return { captureCheckpoint, initialize };
}

function createProviderBase(
  workspace: WorkspaceStore,
  { driver, backend, lock }: ProviderContext,
  shared: SandboxShared,
  deps: {
    prefix: () => string;
    defaultTimeoutSec: number;
    initialize: (scope: string, name: string, onStatus?: (text: string) => void) => Promise<boolean>;
    scopeOf: (name: string) => Promise<string | undefined>;
  },
): ExecSandboxBase {
  const { homeDir } = driver;
  const { prefix, defaultTimeoutSec, initialize, scopeOf } = deps;
  return createExecSandboxBase({
    workspace,
    label: backend,
    prefix,
    homeDir,
    defaultTimeoutSec,
    credentialPaths: shared.credentialPaths ?? [],
    ...(shared.layerToolFiles || shared.connectorSdk
      ? {
          installLayerTools: withConnectorSdk(
            homeDir,
            createLayerToolInstaller(shared.layerToolFiles ?? (() => [])),
            shared.connectorSdk,
          ),
        }
      : {}),
    ...(driver.combineRoundTrips ? { combineLayerToolPrep: true } : {}),
    ...(shared.egressProxyUrl ? { egressProxyUrl: shared.egressProxyUrl } : {}),
    deleteFailureCode: `${backend}_delete_failed`,
    ...(shared.onError ? { onError: shared.onError } : {}),
    exec: driver.exec,
    ...(driver.envViaExec ? { envViaExec: true } : {}),
    writeAbsBytes: driver.writeAbsBytes,
    readAbsBytes: driver.readAbsBytes,
    ensureResident: async (name, scope, onStatus) => {
      return { coldStart: await lock(scope, () => initialize(scope, name, onStatus)) };
    },
    isProvisioned: driver.isLive,
    async recreateScratch(name) {
      await driver.destroy(name).catch(swallowAs(`${backend}-sandbox: stale scratch destroy`, undefined));
      await driver.create(name, { scratch: true });
    },
    deleteInstance: async (name) => {
      const scope = await scopeOf(name);
      return scope ? lock(scope, () => driver.destroy(name)) : driver.destroy(name);
    },
    ...(driver.forget ? { forgetInstance: driver.forget } : {}),
    ...(driver.ensureEgress ? { ensureEgress: driver.ensureEgress } : {}),
  });
}

function providerProfile(driver: SandboxDriver, shared: SandboxShared, workdir: string): AgentComputerProfile {
  const { backend, homeDir } = driver;
  const extraTools = shared.extraTools ?? [];
  return {
    backend,
    writablePersistence: driver.writablePersistence ?? "resident_disk",
    processSessions: true,
    ...(driver.park ? { parksOnTeardown: true } : {}),
    egressEnforcement: driver.egressEnforcement,
    spec: {
      os: driver.os,
      runtimes: driver.runtimes ?? ["Node", "Python 3"],
      tools: visibleTools([...(driver.tools ?? BASE_TOOLS), ...extraTools]),
      notInstalled: visibleNotInstalled(
        OPTIONAL_TOOLS.filter((t) => !(driver.tools ?? []).includes(t)),
        extraTools,
      ),
      get cpus() {
        return driver.cpus;
      },
      get memoryMb() {
        return driver.memoryMb;
      },
      get diskGb() {
        return driver.diskGb;
      },
      homeDir,
      workdir,
    },
  };
}

async function providerRecovery(
  { driver, store }: ProviderContext,
  scope: string,
): Promise<Pick<ComputerStatus, "recovery">> {
  if (!driver.checkpoints) return {};
  const stored = await store.get(scope);
  return {
    recovery: {
      strategy: "provider_snapshot",
      ...(stored?.checkpointId ? { checkpointId: stored.checkpointId } : {}),
      ...(stored?.lastSnapshotMs ? { checkpointAtMs: stored.lastSnapshotMs } : {}),
      ...(stored?.snapshotError ? { error: stored.snapshotError } : {}),
    },
  };
}

function createProviderResidency(
  { driver, store, lock, report }: ProviderContext,
  base: ExecSandboxBase,
  deps: {
    nameFor: (scope: string) => string;
    requireScope: (name: string) => Promise<string>;
    checkpointDue: (stored: StoredSandboxRecord | null | undefined, opts?: TeardownOptions) => boolean;
    captureCheckpoint: (scope: string, name: string) => Promise<void>;
  },
) {
  const { nameFor, requireScope, checkpointDue, captureCheckpoint } = deps;
  const residents = new Map<string, number>();
  const hold = (name: string, delta: number): void => {
    const count = (residents.get(name) ?? 0) + delta;
    if (count > 0) residents.set(name, count);
    else residents.delete(name);
  };

  async function provision(layers: WorkspaceLayer[], opts?: ProvisionOptions): Promise<SandboxHandle> {
    if (opts?.scratch) return base.provision(layers, opts);
    const writable = layers.find((l) => l.mode === "rw") ?? layers[0];
    const name = nameFor(writable?.scopeId ?? "default");
    hold(name, 1);
    try {
      return await base.provision(layers, opts);
    } catch (e) {
      hold(name, -1);
      throw e;
    }
  }

  async function teardown(handle: SandboxHandle, opts?: TeardownOptions): Promise<void> {
    if (!handle.scratch) hold(handle.id, -1);
    if (!handle.scratch && opts?.destroy && driver.checkpoints?.machineBound) {
      const scope = await requireScope(handle.id);
      await base.provisionQueue(scope, () =>
        lock(scope, () => store.upsert(scope, { checkpointId: undefined, checkpointAtMs: undefined })),
      );
    }
    if (!handle.scratch && !opts?.destroy) {
      const scope = await requireScope(handle.id);
      await base.provisionQueue(scope, () =>
        lock(scope, async () => {
          const stored = await store.get(scope);
          if (stored?.initializationPending) return;
          if (!opts?.homeUnchanged) await store.upsert(scope, { homeDirty: true });
          if (residents.has(handle.id)) return;
          if (driver.checkpoints && checkpointDue(stored, opts)) {
            await captureCheckpoint(scope, handle.id).catch((e) =>
              report("sandbox_snapshot", "teardown_snapshot_failed", e, scope),
            );
          }
          if (driver.park) {
            await driver
              .park(handle.id, { keepWarm: !!opts?.keepWarm })
              .catch((e) => report("sandbox_teardown", "park_failed", e, scope));
          }
        }),
      );
    }
    return base.teardown(handle, opts);
  }

  return { provision, teardown };
}

function providerScopeMethods(ctx: ProviderContext, base: ExecSandboxBase, nameFor: (scope: string) => string) {
  const { driver, store, backend, lock } = ctx;
  const recovery = (scope: string) => providerRecovery(ctx, scope);
  return {
    async computerStatus(scopeId: string): Promise<ComputerStatus> {
      const name = nameFor(scopeId);
      const rec = await recovery(scopeId);
      let machine: MachineState | null;
      try {
        machine = await driver.inspect(name);
      } catch (e) {
        return { ...rec, machine: `lookup failed: ${errMessage(e)}`, guestResponsive: false };
      }
      if (!machine)
        return { ...rec, machine: "no machine provisioned yet", provisioned: false, guestResponsive: false };
      if (machine.state === "parked")
        return { ...rec, machine: machine.detail, lifecycleState: "paused", provisioned: true, guestResponsive: false };
      let guestResponsive = false;
      let pressure: ComputerStatus["pressure"];
      let probeError: string | undefined;
      try {
        const probe = await driver.exec(name, "true", GUEST_PROBE_TIMEOUT_SEC);
        guestResponsive = probe.code === 0;
        pressure = probe.pressure;
      } catch (e) {
        probeError = errMessage(e);
      }
      return {
        ...rec,
        machine: machine.detail,
        lifecycleState: "running",
        provisioned: true,
        guestResponsive,
        ...(probeError ? { probeError } : {}),
        ...(pressure ? { pressure } : {}),
        ...(machine.resources ? { resources: machine.resources } : {}),
      };
    },

    ...(driver.restart || driver.checkpoints
      ? {
          async restartComputer(scopeId: string): Promise<void> {
            const name = nameFor(scopeId);
            await base.provisionQueue(scopeId, () =>
              lock(scopeId, async () => {
                const stored = await store.get(scopeId);
                if (driver.restart)
                  return driver.restart(name, { initializationPending: !!stored?.initializationPending });
                if (!stored?.checkpointId) throw new Error(`${backend} restart: no checkpoint to restore`);
                await driver.checkpoints!.restore(name, stored.checkpointId);
              }),
            );
          },
        }
      : {}),

    async destroyScope(scopeId: string): Promise<void> {
      const name = nameFor(scopeId);
      await base.provisionQueue(scopeId, () =>
        lock(scopeId, async () => {
          const stored = await store.get(scopeId);
          await driver.destroy(name);
          driver.forget?.(name);
          if (stored?.checkpointId)
            await driver.checkpoints
              ?.drop?.(name, stored.checkpointId)
              .catch(swallowAs(`${backend}-sandbox: drop checkpoint on destroy`, undefined));
          await store.delete(scopeId);
        }),
      );
    },
  } satisfies Partial<ProviderSandbox>;
}

export function createProviderSandbox(
  workspace: WorkspaceStore,
  driver: SandboxDriver,
  shared: SandboxShared,
  store: SandboxBodies<StoredSandboxRecord>,
): ProviderSandbox {
  const { backend, homeDir } = driver;
  const prefix = (): string => sandboxNamePrefix(shared);
  const defaultTimeoutSec = shared.defaultTimeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const snapshotIntervalMs = (shared.snapshotIntervalSec ?? DEFAULT_SNAPSHOT_INTERVAL_SEC) * 1000;
  const checkpointDue = (stored: StoredSandboxRecord | null | undefined, opts?: TeardownOptions): boolean => {
    if (stored?.lastSnapshotMs && Date.now() - stored.lastSnapshotMs < snapshotIntervalMs) return false;
    return !opts?.homeUnchanged || stored?.homeDirty !== false;
  };
  const lock = <T>(scope: string, fn: () => Promise<T>): Promise<T> =>
    shared.advisoryLock.withLock(`${backend}-provision:${prefix()}:${scope}`, fn);
  const scopeByName = new Map<string, string>();
  const nameFor = (scope: string): string => {
    const name = sandboxScopeName(prefix(), scope);
    scopeByName.set(name, scope);
    return name;
  };
  const scopeFor = (name: string): string | undefined => base.scopeFor(name) ?? scopeByName.get(name);
  async function scopeOf(name: string): Promise<string | undefined> {
    const known = scopeFor(name);
    if (known) return known;
    for (const [scope] of await store.entries()) nameFor(scope);
    return scopeByName.get(name);
  }
  async function requireScope(name: string): Promise<string> {
    const scope = await scopeOf(name);
    if (!scope) throw new Error(`${backend} sandbox ${name}: no stored scope maps to this name`);
    return scope;
  }
  const credentialPrefixes = ephemeralCredLinkPaths(shared.credentialPaths ?? []).map(({ rel }) => rel);

  const report = (category: string, code: string, e: unknown, scopeLabel?: string): void => {
    shared.onError?.({ category, code, message: errMessage(e), ...(scopeLabel ? { scopeLabel } : {}) });
  };
  const ctx: ProviderContext = { driver, store, backend, lock, report };
  const { captureCheckpoint, initialize } = createProviderCheckpointing(ctx);
  const base = createProviderBase(workspace, ctx, shared, { prefix, defaultTimeoutSec, initialize, scopeOf });
  const profile = providerProfile(driver, shared, base.workspaceDir);

  const procSessions = createExecProcessSessions({
    run: (handle, command, execOpts) =>
      driver.exec(handle.id, command, execOpts?.timeoutMs ? Math.ceil(execOpts.timeoutMs / 1000) : defaultTimeoutSec),
  });
  const fileOps = createExecFileOps({
    label: backend,
    exec: driver.exec,
    writeInline: driver.writeAbsBytes,
    ...(driver.combineRoundTrips ? { combineRemoveAndList: true } : {}),
  });
  const staging = createBackendBlobStaging(backend, driver.exec, shared);
  const execExport = createExecExport({
    label: backend,
    exec: driver.exec,
    readAbsBytes: driver.readAbsBytes,
    defaultHomeDir: homeDir,
    ephemeralCredentialPrefixes: credentialPrefixes,
  });
  const { provision, teardown } = createProviderResidency(ctx, base, {
    nameFor,
    requireScope,
    checkpointDue,
    captureCheckpoint,
  });

  return {
    profile,
    scopeFor,
    scopeOf,
    nameFor,
    lifecycle: (scope, fn) => base.provisionQueue(scope, () => lock(scope, fn)),
    captureCheckpoint,
    ensureResident: async (scope) => {
      await base.provisionQueue(scope, () => lock(scope, () => initialize(scope, nameFor(scope))));
    },
    provision,
    run: base.run,
    writeFile: base.writeFile,
    writeFileBytes: base.writeFileBytes,
    readFile: base.readFile,
    readFileBytes: base.readFileBytes,
    ...fileOps,
    ...staging,
    exportFiles: execExport.exportFiles,
    startProcess: procSessions.startProcess,
    readProcess: procSessions.readProcess,
    writeStdin: procSessions.writeStdin,
    signalProcess: procSessions.signalProcess,
    listProcesses: procSessions.listProcesses,
    teardown,
    ...providerScopeMethods(ctx, base, nameFor),
  };
}
