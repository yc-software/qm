import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import type { WorkspaceLayer } from "../types.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { createNoopAdvisoryLock, type AdvisoryLock } from "../persistence/advisory-lock.ts";
import { createMemoryMap } from "../persistence/durable-map.ts";
import { createKeyedQueue } from "../util/async.ts";
import { swallowAs, errMessage } from "../util/errors.ts";
import { shq } from "../util/shell.ts";
import { nonInteractiveShellPrefix, DROPPED_PROXY_ENV } from "./sandbox-env.ts";
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
  SuperserveSandboxGoneError,
  type SuperserveClient,
  type SuperserveNetwork,
  type SuperserveSession,
} from "./superserve-client.ts";
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

const DEFAULT_HOME_DIR = "/root";
const WORKSPACE_BASENAME = "workspace";
const RO_LAYERS_TAR = ".ro-layers.tar";
const RO_LAYERS_MANIFEST = ".ro-layers.manifest";
const DEFAULT_IDLE_PAUSE_SEC = 15 * 60;
const DEFAULT_KEEP_WARM_SEC = 3600;
const DEFAULT_RETENTION_SEC = 30 * 24 * 3600;
const SCRATCH_IDLE_PAUSE_SEC = 10 * 60;
const SCRATCH_RETENTION_SEC = 24 * 3600;
const PREP_TIMEOUT_SEC = 60;
const TIMEOUT_EXIT_CODE = 124;
const TIMEOUT_KILLED_EXIT_CODE = 137;
const KILL_AFTER_SEC = 10;
const OUTPUT_CAP_BYTES = 2 * 1024 * 1024;
const TRUNCATED_NOTICE = "[superserve: output truncated at 2 MiB; redirect large output to a file]";

export const SUPERSERVE_METADATA = {
  scope: "qm_scope",
  prefix: "qm_prefix",
  kind: "qm_kind",
  egress: "qm_egress",
  template: "qm_template",
  epoch: "qm_config_epoch",
} as const;

export interface StoredSuperserveSandbox {
  sandboxId: string;
  createdAtMs: number;
}

export interface StoredConfigEpoch {
  generation: number;
}

const CONFIG_EPOCH_LOCK = "superserve-config-epoch";

export function createConfigEpochResolver(
  store: DurableMap<StoredConfigEpoch>,
  generationKey: string,
  lock: AdvisoryLock = createNoopAdvisoryLock(),
): () => Promise<number> {
  let pending: Promise<number> | undefined;
  const claim = (): Promise<number> =>
    lock.withLock(CONFIG_EPOCH_LOCK, async () => {
      const stored = await store.get(generationKey);
      if (stored) return stored.generation;
      const generation = (await store.entries()).reduce((high, [, seen]) => Math.max(high, seen.generation), 0) + 1;
      await store.put(generationKey, { generation });
      return (await store.get(generationKey))?.generation ?? generation;
    });
  return () => {
    pending ??= claim().catch((err: unknown) => {
      pending = undefined;
      throw err;
    });
    return pending;
  };
}

export interface SuperserveSandboxOptions extends BlobStagingOptions {
  client: SuperserveClient;
  namePrefix?: string;
  defaultTimeoutSec?: number;
  template?: string;
  homeDir?: string;
  idlePauseSec?: number;
  keepWarmSec?: number;
  configEpoch?: number | (() => Promise<number>);
  retentionSec?: number;
  egressAllow?: string[];
  egressDeny?: string[];
  extraTools?: string[];
  credentialPaths?: CredentialPathSpec[];
  layerToolFiles?: () => readonly LayerInstallFile[];
  store?: DurableMap<StoredSuperserveSandbox>;
  advisoryLock?: AdvisoryLock;
  onError?: (e: { category: string; code: string; message: string; scopeLabel?: string }) => void;
}

interface Live {
  session: SuperserveSession;
  current: boolean;
}

const pinnedSandbox = new AsyncLocalStorage<string>();

const isConflict = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { statusCode?: unknown }).statusCode === 409;

export function createSuperserveSandbox(workspace: WorkspaceStore, opts: SuperserveSandboxOptions): Sandbox {
  const client = opts.client;
  const prefix = opts.namePrefix ?? "qm";
  const defaultTimeoutSec = opts.defaultTimeoutSec ?? 600;
  const configuredHome = opts.homeDir ?? DEFAULT_HOME_DIR;
  const idlePauseSec = opts.idlePauseSec ?? DEFAULT_IDLE_PAUSE_SEC;
  const keepWarmSec = Math.max(opts.keepWarmSec ?? DEFAULT_KEEP_WARM_SEC, idlePauseSec);
  const retentionSec = opts.retentionSec ?? DEFAULT_RETENTION_SEC;
  const network: SuperserveNetwork | undefined =
    opts.egressAllow?.length || opts.egressDeny?.length
      ? {
          ...(opts.egressAllow?.length ? { allowOut: opts.egressAllow } : {}),
          ...(opts.egressDeny?.length ? { denyOut: opts.egressDeny } : {}),
        }
      : undefined;
  const store = opts.store ?? createMemoryMap<StoredSuperserveSandbox>();
  const advisoryLock = opts.advisoryLock ?? createNoopAdvisoryLock();
  const lockKey = (scope: string): string => `superserve-provision:${scope}`;
  const provisionQueue = createKeyedQueue<string>();

  const liveByName = new Map<string, Live>();
  const scopeByName = new Map<string, string>();
  const scratchKeyByName = new Map<string, string>();
  const activeScratch = new Map<string, number>();

  const reportError = (category: string, code: string, message: string, scopeLabel?: string): void => {
    opts.onError?.({ category, code, message, ...(scopeLabel ? { scopeLabel } : {}) });
  };

  const workspaceDirOf = (homeDir: string): string => `${homeDir}/${WORKSPACE_BASENAME}`;

  const adoptedNetwork: SuperserveNetwork = network ?? { allowOut: [], denyOut: [] };
  const normalizedNetwork = (value: SuperserveNetwork | undefined): string =>
    JSON.stringify([
      [...(value?.allowOut ?? [])].map((rule) => rule.trim()).sort(),
      [...(value?.denyOut ?? [])].map((rule) => rule.trim()).sort(),
    ]);
  const appliedNetwork = normalizedNetwork(adoptedNetwork);
  const egressTag = createHash("sha256")
    .update(JSON.stringify([[...(adoptedNetwork.allowOut ?? [])].sort(), [...(adoptedNetwork.denyOut ?? [])].sort()]))
    .digest("hex")
    .slice(0, 16);

  const bootEpoch = Date.now();
  const configEpoch = async (): Promise<number> =>
    typeof opts.configEpoch === "function" ? opts.configEpoch() : (opts.configEpoch ?? bootEpoch);
  void configEpoch().catch(swallowAs("superserve-sandbox: claim config generation", undefined));
  const scopeMetadata = async (name: string): Promise<Record<string, string>> => ({
    [SUPERSERVE_METADATA.epoch]: String(await configEpoch()),
    [SUPERSERVE_METADATA.scope]: name,
    [SUPERSERVE_METADATA.prefix]: prefix,
    [SUPERSERVE_METADATA.kind]: "scope",
    [SUPERSERVE_METADATA.egress]: egressTag,
    ...(opts.template ? { [SUPERSERVE_METADATA.template]: opts.template } : {}),
  });

  const scopeFilter = (name: string): Record<string, string> => ({ [SUPERSERVE_METADATA.scope]: name });

  const staleHandle = (name: string): Error =>
    new Error(
      `superserve sandbox for ${name} was replaced while this handle was held; provision it again before using it`,
    );

  const handleIsCurrent = (handle: SandboxHandle): boolean => {
    const live = liveByName.get(handle.id);
    return !handle.providerSandboxId || !live || live.session.id === handle.providerSandboxId;
  };

  const assertCurrent = (handle: SandboxHandle): void => {
    if (!handleIsCurrent(handle)) throw staleHandle(handle.id);
  };

  const pinnedToHandle = <T>(handle: SandboxHandle, action: () => T): T => {
    assertCurrent(handle);
    return handle.providerSandboxId ? pinnedSandbox.run(handle.providerSandboxId, action) : action();
  };

  const guardHandleOps = <T extends object>(ops: T): T =>
    Object.fromEntries(
      Object.entries(ops).map(([key, value]) => [
        key,
        typeof value === "function"
          ? (handle: SandboxHandle, ...args: unknown[]): unknown =>
              pinnedToHandle(handle, () => (value as (...a: unknown[]) => unknown)(handle, ...args))
          : value,
      ]),
    ) as T;

  const dropLive = (name: string, sandboxId: string): void => {
    if (liveByName.get(name)?.session.id === sandboxId) liveByName.delete(name);
  };

  async function ownsGuest(name: string): Promise<boolean> {
    const live = liveByName.get(name);
    if (!live) return false;
    if (!live.current) return false;
    try {
      const info = await client.info(live.session.id, scopeFilter(name));
      live.current = Number(info.metadata[SUPERSERVE_METADATA.epoch] ?? 0) <= (await configEpoch());
      return live.current;
    } catch (err) {
      if (!(err instanceof SuperserveSandboxGoneError)) throw err;
      dropLive(name, live.session.id);
      const scope = scopeByName.get(name);
      if (scope !== undefined) await forget(scope, live.session.id);
      throw new Error(`superserve sandbox for ${name} is gone; the next provision creates a replacement`, {
        cause: err,
      });
    }
  }

  async function forget(scope: string, sandboxId: string): Promise<void> {
    if (store.deleteIf) {
      await store.deleteIf(scope, (record) => record.sandboxId === sandboxId);
      return;
    }
    const stored = await store.get(scope);
    if (stored?.sandboxId === sandboxId) await store.delete(scope);
  }

  async function reconnect(
    scope: string,
    name: string,
    sandboxId: string,
  ): Promise<{ session: SuperserveSession; current: boolean }> {
    const info = await client.info(sandboxId, scopeFilter(name));
    const stampedEpoch = Number(info.metadata[SUPERSERVE_METADATA.epoch] ?? 0);
    if (stampedEpoch > (await configEpoch())) return { session: await client.connect(sandboxId), current: false };
    if (opts.template && info.metadata[SUPERSERVE_METADATA.template] !== opts.template) {
      await client.kill(sandboxId);
      const message = `sandbox ${sandboxId} was built from template ${info.metadata[SUPERSERVE_METADATA.template] ?? "unknown"}, not ${opts.template}; it was destroyed and the next provision creates a replacement`;
      reportError("sandbox_template", "template_changed", message, scope);
      throw new SuperserveSandboxGoneError(sandboxId, message);
    }
    const stale = normalizedNetwork(info.network) !== appliedNetwork;
    const retire = async (): Promise<never> => {
      await client.kill(sandboxId);
      const message = `sandbox ${sandboxId} was paused under a different egress policy; it was destroyed and the next provision creates a replacement`;
      reportError("sandbox_egress", "policy_changed", message, scope);
      throw new SuperserveSandboxGoneError(sandboxId, message);
    };
    try {
      await client.update(sandboxId, {
        timeoutSeconds: Math.max(info.timeoutSeconds ?? 0, idlePauseSec),
        autoDeleteSeconds: retentionSec,
        metadata: { ...info.metadata, ...(await scopeMetadata(info.name)) },
        ...(stale ? { network: adoptedNetwork } : {}),
      });
    } catch (err) {
      if (stale && isConflict(err)) await retire();
      throw err;
    }
    if (stale && normalizedNetwork((await client.info(sandboxId, scopeFilter(name))).network) !== appliedNetwork) {
      await retire();
    }
    return { session: await client.connect(sandboxId), current: true };
  }

  async function adopt(
    name: string,
    session: SuperserveSession,
    persist?: { scope: string; known?: StoredSuperserveSandbox },
    current = true,
  ): Promise<Live> {
    const live: Live = { session, current };
    if (persist)
      await store.put(persist.scope, { sandboxId: session.id, createdAtMs: persist.known?.createdAtMs ?? Date.now() });
    liveByName.set(name, live);
    return live;
  }

  async function ensureLive(
    scope: string,
    name: string,
    onStatus?: (text: string) => void,
  ): Promise<{ live: Live; coldStart: boolean }> {
    const cached = liveByName.get(name);
    if (cached) {
      try {
        const info = await client.info(cached.session.id, scopeFilter(name));
        if (normalizedNetwork(info.network) === appliedNetwork) {
          cached.current = Number(info.metadata[SUPERSERVE_METADATA.epoch] ?? 0) <= (await configEpoch());
          return { live: cached, coldStart: false };
        }
        dropLive(name, cached.session.id);
      } catch (err) {
        if (!(err instanceof SuperserveSandboxGoneError)) throw err;
        dropLive(name, cached.session.id);
        await forget(scope, cached.session.id);
      }
    }

    const stored = await store.get(scope);
    if (stored) {
      try {
        const { session, current } = await reconnect(scope, name, stored.sandboxId);
        const live = await adopt(name, session, { scope, known: stored }, current);
        return { live, coldStart: false };
      } catch (err) {
        if (!(err instanceof SuperserveSandboxGoneError)) throw err;
        await forget(scope, stored.sandboxId);
      }
    }

    const listed = await client.list({ [SUPERSERVE_METADATA.scope]: name });
    for (const summary of listed) {
      try {
        const { session, current } = await reconnect(scope, name, summary.id);
        const live = await adopt(name, session, { scope }, current);
        return { live, coldStart: false };
      } catch (err) {
        if (!(err instanceof SuperserveSandboxGoneError)) throw err;
      }
    }

    try {
      onStatus?.("Creating the sandbox…");
    } catch (error) {
      void error;
    }
    const session = await client.create({
      name,
      metadata: await scopeMetadata(name),
      ...(opts.template ? { template: opts.template } : {}),
      timeoutSeconds: idlePauseSec,
      autoDeleteSeconds: retentionSec,
      ...(network ? { network } : {}),
    });
    const live = await adopt(name, session, { scope });
    return { live, coldStart: true };
  }

  async function createScratch(name: string): Promise<Live> {
    const session = await client.create({
      name,
      metadata: { ...(await scopeMetadata(name)), [SUPERSERVE_METADATA.kind]: "scratch" },
      ...(opts.template ? { template: opts.template } : {}),
      timeoutSeconds: SCRATCH_IDLE_PAUSE_SEC,
      autoDeleteSeconds: SCRATCH_RETENTION_SEC,
      ...(network ? { network } : {}),
    });
    return adopt(name, session);
  }

  async function ensureScratch(key: string): Promise<{ name: string; coldStart: boolean }> {
    const name = sandboxScopeName(`${prefix}-scratch`, key);
    scratchKeyByName.set(name, key);
    const active = activeScratch.get(name) ?? 0;
    const cached = liveByName.get(name);
    if (cached) {
      try {
        const info = await client.info(cached.session.id, scopeFilter(name));
        if (normalizedNetwork(info.network) !== appliedNetwork) {
          await client.kill(cached.session.id);
          dropLive(name, cached.session.id);
          reportError(
            "sandbox_egress",
            "policy_changed",
            `scratch sandbox ${cached.session.id} no longer carried the configured egress policy; it was destroyed and replaced`,
          );
        }
      } catch (err) {
        if (!(err instanceof SuperserveSandboxGoneError)) throw err;
        dropLive(name, cached.session.id);
      }
    }
    const coldStart = !liveByName.has(name);
    if (coldStart) await createScratch(name);
    activeScratch.set(name, active + 1);
    return { name, coldStart };
  }

  async function withLive<T>(name: string, action: (live: Live) => Promise<T>): Promise<T> {
    const live = liveByName.get(name);
    if (!live) throw new Error(`superserve sandbox for ${name} is gone; provision it again before using this handle`);
    const pinned = pinnedSandbox.getStore();
    if (pinned && live.session.id !== pinned) throw staleHandle(name);
    try {
      return await action(live);
    } catch (err) {
      if (!(err instanceof SuperserveSandboxGoneError)) throw err;
      dropLive(name, live.session.id);
      const scope = scopeByName.get(name);
      if (scope !== undefined) await forget(scope, live.session.id);
      throw new Error(`superserve sandbox for ${name} is gone; the next provision creates a replacement`, {
        cause: err,
      });
    }
  }

  function spooledScript(script: string, timeoutSec: number): string {
    const cap = OUTPUT_CAP_BYTES;
    const capture = (file: string): string => `{ head -c ${cap} >"${file}"; wc -c >"${file}.rest"; }`;
    return [
      `o=$(mktemp) && e=$(mktemp) && r=$(mktemp) || exit 1`,
      `{ { timeout -k ${KILL_AFTER_SEC} ${timeoutSec} sh -c ${shq(script)}; echo $? >"$r"; } 2>&1 1>&3 3>&- | ${capture("$e")}; } 3>&1 | ${capture("$o")}`,
      `cat "$o"`,
      `cat "$e" >&2`,
      `if [ "$(cat "$o.rest")" -gt 0 ] || [ "$(cat "$e.rest")" -gt 0 ]; then echo ${shq(TRUNCATED_NOTICE)} >&2; fi`,
      `rc=$(cat "$r")`,
      `rm -f "$o" "$e" "$r" "$o.rest" "$e.rest"`,
      `exit "\${rc:-1}"`,
    ].join("; ");
  }

  async function execRaw(name: string, script: string, timeoutSec: number): Promise<ExecResult> {
    return withLive(name, async ({ session }) => {
      const t0 = Date.now();
      const r = await session.run(spooledScript(`export HOME=${shq(configuredHome)}; ${script}`, timeoutSec), {
        timeoutMs: timeoutSec * 1000 + 30_000,
        maxOutputBytes: OUTPUT_CAP_BYTES,
      });
      const elapsedMs = Date.now() - t0;
      const stderr = r.truncated ? `${r.stderr}\n${TRUNCATED_NOTICE}` : r.stderr;
      return {
        stdout: r.stdout,
        stderr,
        code: r.exitCode,
        timedOut:
          r.exitCode === TIMEOUT_EXIT_CODE ||
          (r.exitCode === TIMEOUT_KILLED_EXIT_CODE && elapsedMs >= timeoutSec * 1000),
      };
    });
  }

  const profile: AgentComputerProfile = {
    backend: "superserve",
    writablePersistence: "resident_disk",
    processSessions: true,
    egressEnforcement: "none",
    spec: {
      os: "Ubuntu — Superserve sandbox (disk persists across pause/resume; publish durable work to git or Files)",
      runtimes: ["Node", "Python 3"],
      get tools() {
        return visibleTools([
          "git",
          "curl",
          "jq",
          "tar",
          "python3",
          "node",
          "npm",
          "gh",
          "aws",
          "claude",
          "codex",
          "x-api",
          ...(opts.extraTools ?? []),
        ]);
      },
      get notInstalled() {
        return visibleNotInstalled(["gcloud", "kubectl", "flyctl", "glab"], opts.extraTools ?? []);
      },
      homeDir: configuredHome,
      workdir: workspaceDirOf(configuredHome),
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
    withLive(name, ({ session }) => session.writeFileBytes(absPath, data));
  const readAbsBytes = (name: string, absPath: string): Promise<Uint8Array | null> =>
    withLive(name, ({ session }) => session.readFileBytes(absPath));
  const installLayerTools = opts.layerToolFiles ? createLayerToolInstaller(opts.layerToolFiles) : null;

  const execFileOps = createExecFileOps({
    label: "superserve",
    exec: (id, script, t) => execRaw(id, script, t),
    writeInline: (id, abs, data) => writeAbsBytes(id, abs, data),
  });

  const execExport = createExecExport({
    label: "superserve",
    exec: (id, script, t) => execRaw(id, script, t),
    readAbsBytes,
    defaultHomeDir: configuredHome,
    ephemeralCredentialPrefixes: ephemeralCredLinkPaths(opts.credentialPaths ?? []).map(({ rel }) => rel),
  });

  const blobStaging = createBackendBlobStaging("superserve", (id, script, t) => execRaw(id, script, t), opts);

  async function destroyStoredScope(scope: string): Promise<void> {
    const name = sandboxScopeName(prefix, scope);
    const stored = await store.get(scope);
    const cached = liveByName.get(name);
    const ids = new Set([stored?.sandboxId, cached?.session.id].filter((id): id is string => !!id));
    const listed = await client.list({ [SUPERSERVE_METADATA.scope]: name });
    for (const summary of listed) ids.add(summary.id);
    for (const id of ids) {
      try {
        await client.kill(id);
      } catch (error) {
        if (!(error instanceof SuperserveSandboxGoneError)) throw error;
      }
    }
    await store.delete(scope);
    liveByName.delete(name);
    scopeByName.delete(name);
  }

  const sandbox: Sandbox = {
    destroyScope(scopeId: string): Promise<void> {
      return provisionQueue(scopeId, () => advisoryLock.withLock(lockKey(scopeId), () => destroyStoredScope(scopeId)));
    },

    profile,
    ...guardHandleOps({
      startProcess: procSessions.startProcess,
      readProcess: procSessions.readProcess,
      writeStdin: procSessions.writeStdin,
      signalProcess: procSessions.signalProcess,
      listProcesses: procSessions.listProcesses,
    }),
    ...guardHandleOps(execFileOps),
    ...(blobStaging ? guardHandleOps(blobStaging) : {}),

    async provision(layers: WorkspaceLayer[], provOpts?: ProvisionOptions): Promise<SandboxHandle> {
      return pinnedSandbox.exit(async () => {
        const scratch = provOpts?.scratch;
        const writable = layers.find((l) => l.mode === "rw") ?? layers[0];
        const scope = writable?.scopeId ?? "default";
        let pendingHandle: SandboxHandle | undefined;
        const provisionAndPrepare = async (): Promise<SandboxHandle> => {
          let name: string;
          let coldStart: boolean;
          if (scratch) {
            ({ name, coldStart } = await ensureScratch(scratch.key));
          } else {
            name = sandboxScopeName(prefix, scope);
            scopeByName.set(name, scope);
            coldStart = (await ensureLive(scope, name, provOpts?.onStatus)).coldStart;
          }
          const homeDir = configuredHome;
          const workspaceDir = workspaceDirOf(homeDir);
          const providerSandboxId = liveByName.get(name)?.session.id;
          const env = Object.fromEntries(
            Object.entries(provOpts?.env ?? {}).filter(([k]) => !DROPPED_PROXY_ENV.has(k)),
          );
          const handle: SandboxHandle = {
            id: name,
            rootDir: workspaceDir,
            homeDir,
            coldStart,
            ...(providerSandboxId ? { providerSandboxId } : {}),
            ...(scratch ? { scratch: true } : {}),
            ...(Object.keys(env).length ? { env } : {}),
          };
          pendingHandle = handle;
          const prepare = async (): Promise<SandboxHandle> => {
            assertCurrent(handle);
            if (!(await ownsGuest(name))) return handle;
            const credLinks = scratch ? "" : ` && ${ephemeralCredLinkScript(homeDir, opts.credentialPaths ?? [])}`;
            const prep = await execRaw(name, `mkdir -p ${shq(workspaceDir)}${credLinks}`, PREP_TIMEOUT_SEC);
            if (prep.code !== 0)
              throw new Error(`superserve provision prep failed: ${(prep.stderr || prep.stdout).slice(0, 200)}`);
            await materializeRoLayers(
              workspace,
              layers,
              handle,
              {
                readFile: (h, rel) => sandbox.readFile(h, rel),
                writeFileBytes: (h, rel, data) => sandbox.writeFileBytes(h, rel, data),
                exec: (script, t) => execRaw(name, script, t),
              },
              { manifest: RO_LAYERS_MANIFEST, tar: RO_LAYERS_TAR, label: "superserve" },
            );
            if (installLayerTools)
              await installLayerTools({
                exec: (script, t) => execRaw(name, script, t),
                writeAbs: (abs, data) => writeAbsBytes(name, abs, data),
              });
            assertCurrent(handle);
            return handle;
          };
          return providerSandboxId ? pinnedSandbox.run(providerSandboxId, prepare) : prepare();
        };
        try {
          return await (scratch
            ? provisionQueue(`scratch:${scratch.key}`, provisionAndPrepare)
            : provisionQueue(scope, () => advisoryLock.withLock(lockKey(scope), provisionAndPrepare)));
        } catch (err) {
          if (pendingHandle)
            await sandbox
              .teardown(pendingHandle)
              .catch(swallowAs("superserve-sandbox: teardown after failed provision", undefined));
          throw err;
        }
      });
    },

    async run(handle, command, execOpts?: ExecOptions): Promise<ExecResult> {
      return pinnedToHandle(handle, async () => {
        const timeoutSec = execOpts?.timeoutMs ? Math.ceil(execOpts.timeoutMs / 1000) : defaultTimeoutSec;
        const exports = Object.entries(handle.env ?? {})
          .map(([k, v]) => `export ${k}=${shq(v)}`)
          .join("; ");
        const script = `${nonInteractiveShellPrefix()}${exports ? exports + "; " : ""}cd ${shq(handle.rootDir)} || exit 1; ${command}`;
        const signal = execOpts?.signal;
        if (!signal) return execRaw(handle.id, script, timeoutSec);
        const killUid = randomUUID();
        const fireKill = () => {
          execRaw(handle.id, killScript(killUid), 15).catch(
            swallowAs("superserve-sandbox: kill in-flight exec", undefined),
          );
        };
        signal.throwIfAborted();
        const onAbort = () => fireKill();
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          return await execRaw(handle.id, killableScript(script, killUid), timeoutSec);
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      });
    },

    async writeFileBytes(handle, relPath, data): Promise<void> {
      await pinnedToHandle(handle, () => writeAbsBytes(handle.id, posixJoin(handle.rootDir, relPath), data));
    },
    async writeFile(handle, relPath, data): Promise<void> {
      await sandbox.writeFileBytes(handle, relPath, Buffer.from(data, "utf8"));
    },
    async readFileBytes(handle, relPath): Promise<Uint8Array | null> {
      return pinnedToHandle(handle, () => readAbsBytes(handle.id, posixJoin(handle.rootDir, relPath)));
    },
    async readFile(handle, relPath): Promise<string | null> {
      const bytes = await sandbox.readFileBytes(handle, relPath);
      return bytes === null ? null : Buffer.from(bytes).toString("utf8");
    },

    exportFiles: (handle, exportOpts) => pinnedToHandle(handle, () => execExport.exportFiles(handle, exportOpts)),

    async computerStatus(scopeId: string): Promise<ComputerStatus> {
      const name = sandboxScopeName(prefix, scopeId);
      const stored = await store.get(scopeId);
      if (!stored) return { machine: "no sandbox provisioned yet", provisioned: false, guestResponsive: false };
      const machineOf = (sandboxId: string): string => `superserve sandbox ${sandboxId}`;
      const recovery = { strategy: "provider_pause" as const };
      let inspectedId = stored.sandboxId;
      try {
        const info = await client.info(stored.sandboxId, scopeFilter(name));
        if (info.status === "paused" || info.status === "pausing")
          return {
            machine: machineOf(stored.sandboxId),
            listed: info.status,
            lifecycleState: "paused",
            provisioned: true,
            guestResponsive: false,
            recovery: { ...recovery, state: info.status, checkpointExpiresAtMs: info.autoDeleteAtMs ?? null },
          };
        scopeByName.set(name, scopeId);
        const { live } = await provisionQueue(scopeId, () =>
          advisoryLock.withLock(lockKey(scopeId), () => ensureLive(scopeId, name)),
        );
        inspectedId = live.session.id;
        const probed = inspectedId === stored.sandboxId ? info : await client.info(inspectedId, scopeFilter(name));
        const r = await live.session.run("echo responsive", { timeoutMs: 30_000 });
        return {
          machine: machineOf(inspectedId),
          listed: probed.status,
          lifecycleState: "running",
          recovery: { ...recovery, state: probed.status },
          provisioned: true,
          guestResponsive: r.exitCode === 0 && /responsive/.test(r.stdout),
        };
      } catch (e) {
        const gone = e instanceof SuperserveSandboxGoneError;
        if (gone) {
          dropLive(name, inspectedId);
          await forget(scopeId, inspectedId);
        }
        return {
          recovery,
          machine: `${machineOf(inspectedId)} (${errMessage(e).slice(0, 120)})`,
          provisioned: !gone,
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
          const live = liveByName.get(handle.id);
          if (!live) return;
          try {
            await live.session.kill();
          } catch (err) {
            if (tdOpts?.destroy) throw err;
            swallowAs("superserve-sandbox: scratch kill", undefined)(err);
          }
          dropLive(handle.id, live.session.id);
        });
      }
      if (tdOpts?.destroy && !scopeByName.has(handle.id)) return;
      const scope = scopeByName.get(handle.id) ?? "default";
      return provisionQueue(scope, async () => {
        if (!tdOpts?.destroy && !handleIsCurrent(handle)) return;
        await teardownScope(handle.id, scope, tdOpts);
      });
    },
  };

  async function teardownScope(name: string, scope: string, tdOpts?: TeardownOptions): Promise<void> {
    if (tdOpts?.destroy) return advisoryLock.withLock(lockKey(scope), () => destroyStoredScope(scope));
    const live = liveByName.get(name);
    if (!live?.current) return;
    return advisoryLock.withLock(lockKey(scope), async () => {
      try {
        const info = await client.info(live.session.id, scopeFilter(name));
        live.current = Number(info.metadata[SUPERSERVE_METADATA.epoch] ?? 0) <= (await configEpoch());
        if (!live.current) return;
        await live.session.update({ timeoutSeconds: tdOpts?.keepWarm ? keepWarmSec : idlePauseSec });
      } catch (err) {
        if (!(err instanceof SuperserveSandboxGoneError)) throw err;
        dropLive(name, live.session.id);
        await forget(scope, live.session.id);
      }
    });
  }

  return sandbox;
}
