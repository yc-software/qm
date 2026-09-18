import { randomUUID } from "node:crypto";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { createMemoryMap } from "../persistence/durable-map.ts";
import { sleep } from "../util/async.ts";
import { errMessage, swallowAs } from "../util/errors.ts";
import { shq } from "../util/shell.ts";
import { createExecProcessSessions, type ExecProcessIo } from "./exec-process-session.ts";
import {
  createBackendBlobStaging,
  createExecExport,
  createExecFileOps,
  type BlobStagingOptions,
} from "./exec-file-ops.ts";
import { ephemeralCredLinkPaths, type CredentialPathSpec } from "../credentials/resident-paths.ts";
import { visibleNotInstalled, visibleTools } from "./sandbox.ts";
import { createExecSandboxBase, sandboxScopeName } from "./exec-sandbox-base.ts";
import { createLayerToolInstaller } from "./layer-tool-install.ts";
import { createHomeSnapshotOps, HOME_SNAPSHOT_PRUNE, snapshotDue, type HomeSnapshotStore } from "./home-snapshot.ts";
import type { LayerInstallFile } from "../deployment/load-layer.ts";
import type { AgentComputerProfile, ComputerStatus, ExecResult, Sandbox, TeardownOptions } from "./sandbox.ts";

const HOME_DIR = "/root";
const HOME_TAR = `${HOME_DIR}/.qm-home.tar`;
const FILE_TRANSFER_TIMEOUT_MS = 300_000;
const EXEC_SYNC_MAX_SEC = 240;
const EXEC_POLL_MS = 2_000;
const EXIT_GRACE_MS = 60_000;
const READY_TIMEOUT_MS = 180_000;
const READY_POLL_MS = 1_000;
const GUEST_PROBE_TIMEOUT_SEC = 15;
const SCRATCH_TTL_SEC = 24 * 3600;
const DEFAULT_SMOLMACHINES_BASE_URL = "https://api.smolmachines.com";
const DEFAULT_IMAGE = "codex";
const DEFAULT_CPUS = 4;
const DEFAULT_MEMORY_MB = 8192;
const RUNNING_STATES = new Set(["running", "started", "ready"]);

type MachineNetwork =
  { mode: "open" } | { mode: "blocked" } | { mode: "allowCidrs"; cidrs?: string[]; hosts?: string[] };

interface MachineInfo {
  id: string;
  name?: string | null;
  state: string;
  ready?: boolean;
  error?: string | null;
  network?: MachineNetwork;
}

interface MachineExecResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutB64?: string;
  stderrB64?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export interface StoredSmolmachinesSandbox {
  lastSnapshotMs?: number;
  homeDirty?: boolean;
  snapshotError?: string;
}

export interface SmolmachinesSandboxOptions extends BlobStagingOptions {
  token?: string;
  baseUrl?: string;
  namePrefix?: string;
  image?: string;
  cpus?: number;
  memoryMb?: number;
  diskGb?: number;
  autoStopSec?: number;
  defaultTimeoutSec?: number;
  egressProxyUrl?: string;
  snapshotIntervalMs?: number;
  store?: DurableMap<StoredSmolmachinesSandbox>;
  snapshots?: HomeSnapshotStore;
  extraTools?: string[];
  credentialPaths?: CredentialPathSpec[];
  layerToolFiles?: () => readonly LayerInstallFile[];
  fetchImpl?: typeof fetch;
  onError?: (e: { category: string; code: string; message: string; scopeLabel?: string }) => void;
}

export function createSmolmachinesSandbox(workspace: WorkspaceStore, opts: SmolmachinesSandboxOptions = {}): Sandbox {
  if (!opts.token && !opts.fetchImpl) throw new Error("SANDBOX_BACKEND=smolmachines requires SMOLMACHINES_TOKEN");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = (opts.baseUrl ?? DEFAULT_SMOLMACHINES_BASE_URL).replace(/\/+$/, "");
  const prefix = opts.namePrefix ?? "qm";
  const image = opts.image ?? DEFAULT_IMAGE;
  const resources = {
    ...(opts.cpus ? { cpus: opts.cpus } : {}),
    ...(opts.memoryMb ? { memoryMb: opts.memoryMb } : {}),
    ...(opts.diskGb ? { diskGb: opts.diskGb } : {}),
  };
  const defaultTimeoutSec = opts.defaultTimeoutSec ?? 600;
  const snapshotIntervalMs = opts.snapshotIntervalMs ?? 0;
  const store = opts.store ?? createMemoryMap<StoredSmolmachinesSandbox>();
  const egressProxyHost = opts.egressProxyUrl ? new URL(opts.egressProxyUrl).hostname : undefined;
  const network: MachineNetwork = egressProxyHost ? { mode: "allowCidrs", hosts: [egressProxyHost] } : { mode: "open" };

  const idByName = new Map<string, string>();
  const egressVerified = new Set<string>();

  const isRunning = (info: MachineInfo): boolean => RUNNING_STATES.has(info.state.toLowerCase());
  const machinePath = (id: string): string => `/v1/machines/${encodeURIComponent(id)}`;

  async function api(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<Response> {
    return fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${opts.token ?? ""}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  async function apiJson<T>(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
    const res = await api(method, path, body, timeoutMs);
    if (!res.ok) {
      throw new Error(`smolmachines ${method} ${path}: http ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  async function findMachine(name: string): Promise<MachineInfo | null> {
    const machines = await apiJson<MachineInfo[]>("GET", "/v1/machines");
    return machines.find((m) => m.name === name) ?? null;
  }

  async function awaitReady(id: string): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      const info = await apiJson<MachineInfo>("GET", machinePath(id));
      if (info.state.toLowerCase() === "error") {
        throw new Error(`smolmachines machine ${id}: entered error state${info.error ? `: ${info.error}` : ""}`);
      }
      if (info.ready === true || (info.ready === undefined && isRunning(info))) return;
      if (Date.now() > deadline) {
        throw new Error(`smolmachines machine ${id}: not ready after ${READY_TIMEOUT_MS}ms (state=${info.state})`);
      }
      await sleep(READY_POLL_MS);
    }
  }

  async function createMachine(name: string, ephemeral: boolean): Promise<{ info: MachineInfo; created: boolean }> {
    const res = await api("POST", "/v1/machines", {
      name,
      source: { type: "image", reference: image },
      ...(Object.keys(resources).length ? { resources } : {}),
      network,
      workdir: HOME_DIR,
      ephemeral,
      ...(ephemeral ? { ttlSeconds: SCRATCH_TTL_SEC } : {}),
      ...(opts.autoStopSec ? { autoStopSeconds: opts.autoStopSec } : {}),
    });
    if (res.status === 409) {
      const existing = await findMachine(name);
      if (!existing) throw new Error(`smolmachines create ${name}: http 409 but the machine is not listed`);
      await startMachine(existing.id);
      return { info: existing, created: false };
    }
    if (!res.ok) {
      throw new Error(`smolmachines create ${name}: http ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    const info = (await res.json()) as MachineInfo;
    await startMachine(info.id);
    return { info, created: true };
  }

  async function startMachine(id: string): Promise<void> {
    const res = await api("POST", `${machinePath(id)}/start`);
    if (!res.ok && res.status !== 409) {
      throw new Error(`smolmachines start ${id}: http ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    await awaitReady(id);
  }

  async function machineIdFor(name: string): Promise<string> {
    const cached = idByName.get(name);
    if (cached) return cached;
    const found = await findMachine(name);
    if (!found) throw new Error(`smolmachines machine ${name}: not found`);
    idByName.set(name, found.id);
    return found.id;
  }

  async function deleteMachine(name: string): Promise<void> {
    const found = (await findMachine(name))?.id;
    if (!found) {
      idByName.delete(name);
      return;
    }
    const res = await api("DELETE", machinePath(found));
    if (!res.ok && res.status !== 404) {
      throw new Error(`smolmachines delete ${name}: http ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    idByName.delete(name);
  }

  function decodeStream(
    name: string,
    label: string,
    b64: string | undefined,
    text: string,
    truncated?: boolean,
  ): string {
    if (b64 !== undefined) return Buffer.from(b64, "base64").toString("utf8");
    if (truncated) throw new Error(`smolmachines exec ${name}: ${label} truncated and no byte-exact stream returned`);
    return text;
  }

  async function postExec(name: string, script: string, timeoutSec: number): Promise<ExecResult> {
    const id = await machineIdFor(name);
    const body = {
      command: ["sh", "-c", script],
      timeoutSeconds: timeoutSec + Math.ceil(EXIT_GRACE_MS / 1000),
    };
    const timeoutMs = timeoutSec * 1000 + 2 * EXIT_GRACE_MS;
    const execPath = (machineId: string): string => `${machinePath(machineId)}/exec?output=b64`;
    const first = await api("POST", execPath(id), body, timeoutMs);
    let res = first;
    if (!first.ok) {
      const detail = (await first.text()).slice(0, 200);
      if (first.status === 404) idByName.delete(name);
      if (first.status !== 409 && first.status !== 404 && !/stopped|suspended/i.test(detail)) {
        throw new Error(`smolmachines exec ${name}: http ${first.status} ${detail}`);
      }
      const retryId = await machineIdFor(name);
      await startMachine(retryId);
      res = await api("POST", execPath(retryId), body, timeoutMs);
      if (!res.ok) {
        throw new Error(`smolmachines exec ${name}: http ${res.status} ${(await res.text()).slice(0, 200)}`);
      }
    }
    const r = (await res.json()) as MachineExecResponse;
    return {
      stdout: decodeStream(name, "stdout", r.stdoutB64, r.stdout, r.stdoutTruncated),
      stderr: decodeStream(name, "stderr", r.stderrB64, r.stderr, r.stderrTruncated),
      code: r.exitCode,
      timedOut: r.exitCode === 124,
    };
  }

  const filesUrl = (id: string, absPath: string): string =>
    `${machinePath(id)}/files${absPath.split("/").map(encodeURIComponent).join("/")}`;

  async function execRaw(name: string, script: string, timeoutSec: number): Promise<ExecResult> {
    const guarded = `timeout ${timeoutSec} sh -c ${shq(script)}`;
    if (timeoutSec <= EXEC_SYNC_MAX_SEC) return postExec(name, guarded, timeoutSec);
    const uid = randomUUID();
    const out = `${HOME_DIR}/.qm-exec-${uid}.out`;
    const err = `${HOME_DIR}/.qm-exec-${uid}.err`;
    const rcf = `${HOME_DIR}/.qm-exec-${uid}.rc`;
    const body = `${guarded} > ${out} 2> ${err}; echo $? > ${rcf}`;
    const start = await postExec(name, `nohup sh -c ${shq(body)} >/dev/null 2>&1 & echo launched`, 30);
    if (start.code !== 0 || !/launched/.test(start.stdout)) {
      throw new Error(`smolmachines exec ${name}: background launch failed (rc=${start.code})`);
    }
    const deadline = Date.now() + timeoutSec * 1000 + EXIT_GRACE_MS;
    for (;;) {
      const p = await postExec(name, `[ -f ${rcf} ] && echo settled || echo running`, 30);
      if (/settled/.test(p.stdout)) break;
      if (Date.now() > deadline) {
        throw new Error(`smolmachines exec ${name}: no exit after ${timeoutSec}s (+grace); leaving ${rcf}`);
      }
      await sleep(EXEC_POLL_MS);
    }
    return postExec(name, `__rc=$(cat ${rcf}); cat ${out}; cat ${err} >&2; rm -f ${out} ${err} ${rcf}; exit $__rc`, 60);
  }

  async function writeAbsBytes(name: string, absPath: string, data: Uint8Array): Promise<void> {
    const id = await machineIdFor(name);
    const res = await fetchImpl(`${baseUrl}${filesUrl(id, absPath)}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${opts.token ?? ""}`, "content-type": "application/octet-stream" },
      body: Buffer.from(data),
      signal: AbortSignal.timeout(FILE_TRANSFER_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`smolmachines write ${absPath}: http ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
  }

  async function readAbsBytes(name: string, absPath: string): Promise<Uint8Array | null> {
    const id = await machineIdFor(name);
    const res = await fetchImpl(`${baseUrl}${filesUrl(id, absPath)}`, {
      headers: { authorization: `Bearer ${opts.token ?? ""}` },
      signal: AbortSignal.timeout(FILE_TRANSFER_TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`smolmachines read ${absPath}: http ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  async function ensureEgress(name: string): Promise<void> {
    const id = await machineIdFor(name);
    if (egressVerified.has(id)) return;
    const info = await apiJson<MachineInfo>("GET", machinePath(id));
    const got = info.network;
    const hosts = got?.mode === "allowCidrs" ? (got.hosts ?? []).map((h) => h.toLowerCase()) : [];
    const cidrs = got?.mode === "allowCidrs" ? (got.cidrs ?? []) : [];
    const bound = hosts.length === 1 && hosts[0] === egressProxyHost!.toLowerCase() && cidrs.length === 0;
    if (!bound) {
      throw new Error(
        `smolmachines egress ${name}: machine network is ${JSON.stringify(got)}, expected ${JSON.stringify(network)}; destroy the sandbox so it is recreated with the allow list`,
      );
    }
    egressVerified.add(id);
  }

  const homeSnapshots = opts.snapshots
    ? createHomeSnapshotOps<string>({
        label: "smolmachines",
        homeDir: HOME_DIR,
        homeTarPath: HOME_TAR,
        prunePaths: [
          ...HOME_SNAPSHOT_PRUNE,
          ...ephemeralCredLinkPaths(opts.credentialPaths ?? []).map(({ rel }) => `./${rel}`),
        ],
        store: opts.snapshots,
        io: {
          runCommand: async (name, script, timeoutMs) => {
            const r = await execRaw(name, script, Math.ceil(timeoutMs / 1000));
            return { exitCode: r.code, stdout: r.stdout, stderr: r.stderr };
          },
          readFileBytes: readAbsBytes,
          writeFileBytes: writeAbsBytes,
        },
      })
    : undefined;

  async function mergeStored(scope: string, patch: Partial<StoredSmolmachinesSandbox>): Promise<void> {
    await store.putIfAbsent(scope, {});
    await store.merge(scope, patch);
  }

  async function snapshotHome(scope: string, name: string): Promise<void> {
    try {
      await homeSnapshots!.snapshotHome(scope, name);
      await mergeStored(scope, { lastSnapshotMs: Date.now(), homeDirty: false, snapshotError: undefined });
    } catch (e) {
      await mergeStored(scope, { snapshotError: errMessage(e) });
      throw e;
    }
  }

  async function ensureMachine(
    name: string,
    scope: string,
    onStatus?: (text: string) => void,
  ): Promise<{ coldStart: boolean }> {
    if (idByName.has(name)) return { coldStart: false };
    const existing = await findMachine(name);
    if (existing) {
      idByName.set(name, existing.id);
      if (!isRunning(existing)) await startMachine(existing.id);
      return { coldStart: false };
    }
    try {
      onStatus?.("Creating the sandbox…");
    } catch (error) {
      void error;
    }
    const { info, created } = await createMachine(name, false);
    idByName.set(name, info.id);
    if (!created || !homeSnapshots) return { coldStart: created };
    try {
      const hydrated = await homeSnapshots.hydrateHome(scope, name);
      if (hydrated) await mergeStored(scope, { homeDirty: false });
      return { coldStart: !hydrated };
    } catch (e) {
      opts.onError?.({
        category: "sandbox_hydrate",
        code: "hydrate_failed",
        message: errMessage(e),
        scopeLabel: scope,
      });
      await deleteMachine(name).catch(swallowAs("smolmachines-sandbox: delete after failed hydration", undefined));
      throw new Error(
        `smolmachines provision: home hydration failed (${errMessage(e)}); not risking the stored snapshot`,
        {
          cause: e,
        },
      );
    }
  }

  const base = createExecSandboxBase({
    workspace,
    label: "smolmachines",
    prefix,
    homeDir: HOME_DIR,
    defaultTimeoutSec,
    credentialPaths: opts.credentialPaths ?? [],
    ...(opts.layerToolFiles ? { installLayerTools: createLayerToolInstaller(opts.layerToolFiles) } : {}),
    egressProxyUrl: opts.egressProxyUrl,
    deleteFailureCode: "machine_delete_failed",
    onError: opts.onError,
    exec: execRaw,
    writeAbsBytes,
    readAbsBytes,
    ensureResident: (name, onStatus) => ensureMachine(name, base.scopeFor(name) ?? "default", onStatus),
    isProvisioned: (name) => idByName.has(name),
    async recreateScratch(name) {
      await deleteMachine(name).catch(swallowAs("smolmachines-sandbox: stale scratch delete", undefined));
      const { info } = await createMachine(name, true);
      idByName.set(name, info.id);
    },
    deleteInstance: deleteMachine,
    ...(egressProxyHost ? { ensureEgress } : {}),
  });

  const idleNote = opts.autoStopSec ? `; stops after ${opts.autoStopSec}s idle and restarts on the next command` : "";
  const profile: AgentComputerProfile = {
    backend: "smolmachines",
    writablePersistence: "resident_disk",
    processSessions: true,
    egressEnforcement: egressProxyHost ? "domain" : "none",
    spec: {
      os: `smolmachines microVM booted from the ${image} image (the whole disk persists across stops${idleNote})`,
      runtimes: ["Node", "Python 3"],
      get tools() {
        return visibleTools(["git", "curl", "jq", "tar", "python3", ...(opts.extraTools ?? [])]);
      },
      get notInstalled() {
        return visibleNotInstalled(["gh", "aws", "gcloud", "kubectl", "flyctl", "glab"], opts.extraTools ?? []);
      },
      cpus: opts.cpus ?? DEFAULT_CPUS,
      memoryMb: opts.memoryMb ?? DEFAULT_MEMORY_MB,
      ...(opts.diskGb ? { diskGb: opts.diskGb } : {}),
      homeDir: HOME_DIR,
      workdir: base.workspaceDir,
    },
  };

  const procIo: ExecProcessIo = {
    async run(handle, command, execOpts): Promise<ExecResult> {
      const timeoutSec = execOpts?.timeoutMs ? Math.ceil(execOpts.timeoutMs / 1000) : defaultTimeoutSec;
      return execRaw(handle.id, command, timeoutSec);
    },
  };
  const procSessions = createExecProcessSessions(procIo);

  const execFileOps = createExecFileOps({
    label: "smolmachines",
    exec: (id, script, t) => execRaw(id, script, t),
    writeInline: (id, abs, data) => writeAbsBytes(id, abs, data),
  });

  const blobStaging = createBackendBlobStaging("smolmachines", (id, script, t) => execRaw(id, script, t), opts);

  const execExport = createExecExport({
    label: "smolmachines",
    exec: (id, script, t) => execRaw(id, script, t),
    readAbsBytes,
    defaultHomeDir: HOME_DIR,
    ephemeralCredentialPrefixes: ephemeralCredLinkPaths(opts.credentialPaths ?? []).map(({ rel }) => rel),
  });

  async function recoveryFor(scopeId: string): Promise<Pick<ComputerStatus, "recovery">> {
    if (!homeSnapshots) return {};
    const stored = await store.get(scopeId);
    return {
      recovery: {
        strategy: "workspace_snapshot",
        ...(stored?.lastSnapshotMs ? { checkpointAtMs: stored.lastSnapshotMs } : {}),
        ...(stored?.snapshotError ? { error: stored.snapshotError } : {}),
      },
    };
  }

  return {
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
    exportFiles: execExport.exportFiles,

    ...(homeSnapshots
      ? {
          async persistHomeSnapshot(scopeId: string): Promise<void> {
            const name = sandboxScopeName(prefix, scopeId);
            await base.provisionQueue(scopeId, async () => {
              await ensureMachine(name, scopeId);
              await snapshotHome(scopeId, name);
            });
          },
        }
      : {}),

    async computerStatus(scopeId: string): Promise<ComputerStatus> {
      const name = sandboxScopeName(prefix, scopeId);
      const recovery = await recoveryFor(scopeId);
      let info: MachineInfo | null;
      try {
        info = await findMachine(name);
      } catch (e) {
        return { ...recovery, machine: `lookup failed: ${errMessage(e)}`, guestResponsive: false };
      }
      if (!info)
        return { ...recovery, machine: "no machine provisioned yet", provisioned: false, guestResponsive: false };
      idByName.set(name, info.id);
      const machine = `machine ${info.id} ${info.state}${info.error ? `: ${info.error}` : ""}`;
      if (!isRunning(info)) {
        return {
          ...recovery,
          machine,
          listed: info.state,
          lifecycleState: "paused",
          provisioned: true,
          guestResponsive: false,
        };
      }
      let guestResponsive = false;
      let probeError: string | undefined;
      try {
        guestResponsive = (await execRaw(name, "true", GUEST_PROBE_TIMEOUT_SEC)).code === 0;
      } catch (e) {
        probeError = errMessage(e);
      }
      return {
        ...recovery,
        machine,
        listed: info.state,
        lifecycleState: "running",
        provisioned: true,
        guestResponsive,
        ...(probeError ? { probeError } : {}),
      };
    },

    async destroyScope(scopeId: string): Promise<void> {
      return base.provisionQueue(scopeId, async () => {
        await deleteMachine(sandboxScopeName(prefix, scopeId));
        await store.delete(scopeId);
      });
    },

    async teardown(handle, tdOpts?: TeardownOptions): Promise<void> {
      if (homeSnapshots && !handle.scratch && !tdOpts?.destroy) {
        const scope = base.scopeFor(handle.id) ?? "default";
        await base.provisionQueue(scope, async () => {
          const stored = await store.get(scope);
          if (!tdOpts?.homeUnchanged) await mergeStored(scope, { homeDirty: true });
          if (!snapshotDue(stored, tdOpts, snapshotIntervalMs)) return;
          try {
            await snapshotHome(scope, handle.id);
          } catch (e) {
            opts.onError?.({
              category: "sandbox_snapshot",
              code: "teardown_snapshot_failed",
              message: errMessage(e),
              scopeLabel: scope,
            });
          }
        });
      }
      return base.teardown(handle, tdOpts);
    },
  };
}
