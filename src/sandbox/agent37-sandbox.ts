import { randomUUID } from "node:crypto";
import type { WorkspaceLayer } from "../types.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { createKeyedQueue, sleep } from "../util/async.ts";
import { swallowAs, errMessage } from "../util/errors.ts";
import { shq } from "../util/shell.ts";
import { nonInteractiveShellPrefix } from "./sandbox-env.ts";
import { createExecProcessSessions, type ExecProcessIo } from "./exec-process-session.ts";
import { materializeRoLayers } from "./ro-layers.ts";
import { createExecExport, createBackendBlobStaging, createExecFileOps, posixJoin } from "./exec-file-ops.ts";
import {
  ephemeralCredLinkScript,
  ephemeralCredLinkPaths,
  type CredentialPathSpec,
} from "../credentials/resident-paths.ts";
import { DROPPED_PROXY_ENV, forceThroughProxyEnv } from "./sandbox-env.ts";
import type { BlobTransferStore } from "../persistence/blob-transfer.ts";
import { createNoopAdvisoryLock, type AdvisoryLock } from "../persistence/advisory-lock.ts";
import { killableScript, killScript } from "./exec-kill.ts";
import { visibleNotInstalled, visibleTools } from "./sandbox.ts";
import { sandboxScopeName } from "./exec-sandbox-base.ts";
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

const HOME_DIR = "/home/node";
const WORKSPACE_BASENAME = "workspace";
const RO_LAYERS_TAR = ".ro-layers.tar";
const RO_LAYERS_MANIFEST = ".ro-layers.manifest";
const INLINE_LIMIT = 128 * 1024;
const MAX_EXEC_OUTPUT_BYTES = 16 * 1024 * 1024;
const EXEC_API_CAP_SEC = 780;
const KILL_GRACE_SEC = 5;
const EXEC_SYNC_MAX_SEC = 600;
const INSTANCE_REQUEST_TIMEOUT_MS = (EXEC_API_CAP_SEC + 30) * 1000;
const EXEC_POLL_MS = 2_000;
const EXIT_GRACE_MS = 60_000;
const CREATE_TIMEOUT_MS = 330_000;
const LIFECYCLE_TIMEOUT_MS = 830_000;
const READY_TIMEOUT_MS = 600_000;
const READY_POLL_MS = 2_000;
const RECOVER_ATTEMPTS = 3;
const GUEST_PROBE_TIMEOUT_SEC = 10;
const DEFAULT_AGENT37_BASE_URL = "https://api.agent37.com";
const DEFAULT_TEMPLATE = "agent37-codex@2026.09.14b";
const DEFAULT_CPUS = 2;
const DEFAULT_MEMORY_GB = 4;
const DEFAULT_DISK_GB = 8;
const DEFAULT_IDLE_TIMEOUT_SEC = 900;
const MIN_IDLE_TIMEOUT_SEC = 300;
const MAX_IDLE_TIMEOUT_SEC = 86_400;
const MAX_NAME_LENGTH = 60;
const SCOPE_NAME_OVERHEAD = "-scratch".length + "-".length + 40 + "-".length + 6;
const MAX_USER_TAG_LENGTH = 200;
const SHAPES: Record<number, { memory: number; disk: readonly [number, number] }> = {
  2: { memory: 4, disk: [2, 12] },
  4: { memory: 8, disk: [2, 20] },
  8: { memory: 16, disk: [2, 40] },
};
const PREFIX_TAG = "qm-prefix";
const SCOPE_TAG = "qm-scope";
const SCRATCH_TAG = "qm-scratch";
const STARTABLE_STATES = new Set(["stopped", "sleeping"]);
const LIFECYCLE_STATES = new Map<string, "running" | "paused">([
  ["running", "running"],
  ["stopped", "paused"],
  ["sleeping", "paused"],
]);
const GONE_STATES = new Set(["deleting", "deleted"]);
const DEAD_STATES = new Set(["failed", ...GONE_STATES]);
const START_WAIT_CODES = new Set(["try_again", "capacity_unavailable", "invalid_request"]);
const NOT_RUNNING_CODES = new Set([
  "try_again",
  "capacity_unavailable",
  "invalid_request",
  "container_unavailable",
  "container_unreachable",
  "upstream_unreachable",
  "host_mesh_not_ready",
  "wake_timeout",
  "wake_failed",
]);

interface InstanceInfo {
  id: string;
  url: string;
  name?: string | null;
  status: string;
  status_reason?: { code?: string; message?: string } | null;
  metadata?: Record<string, string> | null;
}

interface InstanceRef {
  id: string;
  url: string;
}

interface InstanceTarget {
  name: string;
  user: string;
  metadata: Record<string, string>;
}

interface BackupRecord {
  id: string;
  kind: string;
  created: number;
  size_bytes: number;
}

interface InstanceExecResponse {
  exit_code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export class Agent37ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface Agent37SandboxOptions {
  apiKey?: string;
  baseUrl?: string;
  namePrefix?: string;
  template?: string;
  cpus?: number;
  memoryGb?: number;
  diskGb?: number;
  idleTimeoutSec?: number;
  defaultTimeoutSec?: number;
  egressProxyUrl?: string;
  blobTransfer?: BlobTransferStore;
  signingSecret?: string;
  capabilitySecret?: string;
  apiBaseUrl?: string;
  extraTools?: string[];
  credentialPaths?: CredentialPathSpec[];
  fetchImpl?: typeof fetch;
  advisoryLock?: AdvisoryLock;
  onError?: (e: { category: string; code: string; message: string; scopeLabel?: string }) => void;
}

function validateShape(resources: { cpu: number; memory: number; disk: number }): void {
  const shape = SHAPES[resources.cpu];
  if (!shape || shape.memory !== resources.memory) {
    throw new Error(
      `AGENT37_CPUS/AGENT37_MEMORY_GB=${resources.cpu}/${resources.memory} is not an Agent37 shape; use 2/4, 4/8 or 8/16`,
    );
  }
  const [minDisk, maxDisk] = shape.disk;
  if (!Number.isInteger(resources.disk) || resources.disk < minDisk || resources.disk > maxDisk) {
    throw new Error(
      `AGENT37_DISK_GB=${resources.disk} is outside the ${resources.cpu}/${resources.memory} shape's ${minDisk}-${maxDisk} GB range`,
    );
  }
}

function validateIdleTimeout(seconds: number): void {
  if (!Number.isInteger(seconds) || seconds < MIN_IDLE_TIMEOUT_SEC || seconds > MAX_IDLE_TIMEOUT_SEC) {
    throw new Error(
      `AGENT37_IDLE_TIMEOUT_SEC=${seconds} must be a whole number of seconds from ${MIN_IDLE_TIMEOUT_SEC} to ${MAX_IDLE_TIMEOUT_SEC}`,
    );
  }
}

function validatePrefix(prefix: string): void {
  if (prefix.length + SCOPE_NAME_OVERHEAD > MAX_NAME_LENGTH) {
    throw new Error(
      `AGENT37_NAME_PREFIX=${JSON.stringify(prefix)} is too long: at most ${MAX_NAME_LENGTH - SCOPE_NAME_OVERHEAD} characters keep every instance name within Agent37's ${MAX_NAME_LENGTH}-character limit`,
    );
  }
}

async function failure(res: Response, context: string): Promise<Agent37ApiError> {
  const text = (await res.text()).slice(0, 400);
  let code = `http_${res.status}`;
  let message = text;
  try {
    const parsed = JSON.parse(text) as { error?: string | { code?: string; message?: string } };
    if (typeof parsed.error === "string") code = parsed.error;
    else if (parsed.error?.code) {
      code = parsed.error.code;
      message = parsed.error.message ?? text;
    }
  } catch (e) {
    void e;
  }
  return new Agent37ApiError(code, res.status, `agent37 ${context}: ${code} (http ${res.status}) ${message}`);
}

export function createAgent37Sandbox(workspace: WorkspaceStore, opts: Agent37SandboxOptions = {}): Sandbox {
  if (!opts.apiKey && !opts.fetchImpl) throw new Error("SANDBOX_BACKEND=agent37 requires AGENT37_API_KEY");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiKey = opts.apiKey ?? "";
  const baseUrl = (opts.baseUrl ?? DEFAULT_AGENT37_BASE_URL).replace(/\/+$/, "");
  const prefix = opts.namePrefix ?? "qm";
  const template = opts.template ?? DEFAULT_TEMPLATE;
  const resources = {
    cpu: opts.cpus ?? DEFAULT_CPUS,
    memory: opts.memoryGb ?? DEFAULT_MEMORY_GB,
    disk: opts.diskGb ?? DEFAULT_DISK_GB,
  };
  const idleTimeoutSec = opts.idleTimeoutSec ?? DEFAULT_IDLE_TIMEOUT_SEC;
  validatePrefix(prefix);
  validateShape(resources);
  validateIdleTimeout(idleTimeoutSec);
  const defaultTimeoutSec = opts.defaultTimeoutSec ?? 600;
  const advisoryLock = opts.advisoryLock ?? createNoopAdvisoryLock();
  const workspaceDir = `${HOME_DIR}/${WORKSPACE_BASENAME}`;
  const provisionQueue = createKeyedQueue<string>();

  const targets = new Map<string, InstanceTarget>();
  const instances = new Map<string, InstanceRef>();
  const scopeByName = new Map<string, string>();
  const scratchKeyByName = new Map<string, string>();
  const activeScratch = new Map<string, number>();

  const enc = encodeURIComponent;

  const remember = (target: InstanceTarget): InstanceTarget => {
    targets.set(target.name, target);
    return target;
  };
  const scopeTarget = (scope: string): InstanceTarget =>
    remember({
      name: sandboxScopeName(prefix, scope),
      user: scope.slice(0, MAX_USER_TAG_LENGTH),
      metadata: { [PREFIX_TAG]: prefix, [SCOPE_TAG]: scope },
    });
  const scratchTarget = (key: string): InstanceTarget =>
    remember({
      name: sandboxScopeName(`${prefix}-scratch`, key),
      user: key.slice(0, MAX_USER_TAG_LENGTH),
      metadata: { [PREFIX_TAG]: prefix, [SCRATCH_TAG]: key },
    });
  const rememberInstance = (name: string, info: InstanceInfo): InstanceRef => {
    const ref = { id: info.id, url: info.url.replace(/\/+$/, "") };
    instances.set(name, ref);
    return ref;
  };

  async function api(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<Response> {
    return fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  async function apiJson<T>(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
    const res = await api(method, path, body, timeoutMs);
    if (!res.ok) throw await failure(res, `${method} ${path}`);
    return (await res.json()) as T;
  }

  async function instanceApi(inst: InstanceRef, method: string, path: string, body?: Uint8Array): Promise<Response> {
    return fetchImpl(`${inst.url}${path}`, {
      method,
      headers: {
        "x-agent37-key": apiKey,
        ...(body !== undefined ? { "content-type": "application/octet-stream" } : {}),
      },
      ...(body !== undefined ? { body } : {}),
      signal: AbortSignal.timeout(INSTANCE_REQUEST_TIMEOUT_MS),
    });
  }

  const getInstance = (id: string): Promise<InstanceInfo> => apiJson<InstanceInfo>("GET", `/v1/instances/${enc(id)}`);

  async function findInstance(target: InstanceTarget): Promise<InstanceInfo | null> {
    const { data } = await apiJson<{ data: InstanceInfo[] }>("GET", "/v1/instances");
    const live = data.filter((i) => !GONE_STATES.has(i.status));
    const tagged = live.find((i) => Object.entries(target.metadata).every(([k, v]) => i.metadata?.[k] === v));
    if (tagged) return tagged;
    const legacy = live.find((i) => i.name === target.name && !i.metadata?.[PREFIX_TAG]);
    if (!legacy) return null;
    return apiJson<InstanceInfo>("PATCH", `/v1/instances/${enc(legacy.id)}`, {
      user: target.user,
      metadata: target.metadata,
    });
  }

  async function instanceFor(name: string): Promise<InstanceRef> {
    const cached = instances.get(name);
    if (cached) return cached;
    const target = targets.get(name);
    if (!target) throw new Error(`agent37 instance ${name}: unknown`);
    const found = await findInstance(target);
    if (!found) throw new Error(`agent37 instance ${name}: not found`);
    return rememberInstance(name, found);
  }

  async function ensureRunning(id: string): Promise<InstanceInfo> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      const info = await getInstance(id);
      if (info.status === "running") return info;
      if (DEAD_STATES.has(info.status)) {
        const reason = info.status_reason?.message ? `: ${info.status_reason.message}` : "";
        throw new Error(`agent37 instance ${id}: ${info.status}${reason}`);
      }
      if (Date.now() > deadline)
        throw new Error(`agent37 instance ${id}: not running after ${READY_TIMEOUT_MS}ms (status=${info.status})`);
      if (STARTABLE_STATES.has(info.status)) {
        const res = await api("POST", `/v1/instances/${enc(id)}/start`, undefined, LIFECYCLE_TIMEOUT_MS);
        if (res.ok) continue;
        const err = await failure(res, `start ${id}`);
        if (!START_WAIT_CODES.has(err.code)) throw err;
      }
      await sleep(READY_POLL_MS);
    }
  }

  async function createInstance(target: InstanceTarget): Promise<InstanceInfo> {
    const body = {
      template,
      name: target.name,
      user: target.user,
      metadata: target.metadata,
      resources,
      auto_sleep: true,
      idle_timeout_seconds: idleTimeoutSec,
    };
    const deadline = Date.now() + CREATE_TIMEOUT_MS;
    for (;;) {
      const res = await api("POST", "/v1/instances", body, Math.max(1, deadline - Date.now()));
      if (res.ok) {
        const info = (await res.json()) as InstanceInfo;
        await ensureRunning(info.id);
        return info;
      }
      const err = await failure(res, `create ${target.name}`);
      if (err.code === "instance_limit_reached") {
        throw new Agent37ApiError(
          err.code,
          err.status,
          `agent37 create ${target.name}: the workspace is at its Agent37 instance limit (instance_limit_reached); delete instances qm no longer needs or top up the workspace to raise the cap`,
        );
      }
      if (err.code !== "no_capacity" || Date.now() + READY_POLL_MS >= deadline) throw err;
      await sleep(READY_POLL_MS);
      if (Date.now() >= deadline) throw err;
    }
  }

  async function deleteInstance(target: InstanceTarget): Promise<void> {
    const found = await findInstance(target);
    if (!found) {
      instances.delete(target.name);
      return;
    }
    const res = await api("DELETE", `/v1/instances/${enc(found.id)}`, undefined, 120_000);
    if (!res.ok && res.status !== 404) throw await failure(res, `delete ${target.name}`);
    instances.delete(target.name);
  }

  async function onInstance<T>(name: string, attempt: (inst: InstanceRef) => Promise<T>): Promise<T> {
    for (let tries = 0; ; tries++) {
      const inst = await instanceFor(name);
      try {
        return await attempt(inst);
      } catch (e) {
        if (!(e instanceof Agent37ApiError) || tries >= RECOVER_ATTEMPTS) throw e;
        if (e.code === "not_found") instances.delete(name);
        else if (e.code === "provisioning_failed") {
          if ((await getInstance(inst.id)).status === "running") {
            throw new Agent37ApiError(
              e.code,
              e.status,
              `${e.message}; the command may still be running inside the instance and was not retried`,
            );
          }
        } else if (!NOT_RUNNING_CODES.has(e.code)) throw e;
        const next = await instanceFor(name);
        await sleep(READY_POLL_MS);
        await ensureRunning(next.id);
      }
    }
  }

  async function postExec(name: string, script: string): Promise<InstanceExecResponse> {
    const parsed = await onInstance(name, async (inst) => {
      const res = await api(
        "POST",
        `/v1/instances/${enc(inst.id)}/exec`,
        { command: script },
        INSTANCE_REQUEST_TIMEOUT_MS,
      );
      if (!res.ok) throw await failure(res, `exec ${name}`);
      return (await res.json()) as InstanceExecResponse;
    });
    if (parsed.truncated) {
      throw new Error(`agent37 exec ${name}: output truncated by the API: chunk the read instead`);
    }
    return parsed;
  }

  async function readSpooled(name: string, absPath: string, declared: number): Promise<Buffer> {
    const data = await readAbsBytes(name, absPath);
    if (!data || data.length !== declared) {
      throw new Error(`agent37 read ${absPath}: truncated (${data?.length ?? 0}/${declared})`);
    }
    return Buffer.from(data);
  }

  async function execRaw(name: string, script: string, timeoutSec: number): Promise<ExecResult> {
    const uid = randomUUID();
    const out = `${HOME_DIR}/.qm-exec-${uid}.out`;
    const err = `${HOME_DIR}/.qm-exec-${uid}.err`;
    const rcf = `${HOME_DIR}/.qm-exec-${uid}.rc`;
    const envelope =
      `__o=$(wc -c < ${out}); __e=$(wc -c < ${err}); printf '%s %s %s\\n' "$__rc" "$__o" "$__e"; ` +
      `if [ "$__o" -le ${INLINE_LIMIT} ] && [ "$__e" -le ${INLINE_LIMIT} ]; then base64 < ${out}; base64 < ${err}; rm -f ${out} ${err} ${rcf}; fi`;
    const timed = `timeout -k ${KILL_GRACE_SEC} ${timeoutSec} sh -c ${shq(script)} > ${out} 2> ${err}`;
    let r: InstanceExecResponse;
    if (timeoutSec <= EXEC_SYNC_MAX_SEC) {
      r = await postExec(name, `${timed}; __rc=$?; ${envelope}`);
    } else {
      const body = `${timed}; echo $? > ${rcf}`;
      const start = await postExec(name, `nohup sh -c ${shq(body)} >/dev/null 2>&1 & echo launched`);
      if (start.exit_code !== 0 || !/launched/.test(start.stdout)) {
        throw new Error(`agent37 exec ${name}: background launch failed (rc=${start.exit_code})`);
      }
      const deadline = Date.now() + timeoutSec * 1000 + EXIT_GRACE_MS;
      for (;;) {
        const p = await postExec(name, `[ -f ${rcf} ] && echo settled || echo running`);
        if (/settled/.test(p.stdout)) break;
        if (Date.now() > deadline) {
          throw new Error(`agent37 exec ${name}: no exit after ${timeoutSec}s (+grace); leaving ${rcf}`);
        }
        await sleep(EXEC_POLL_MS);
      }
      r = await postExec(name, `__rc=$(cat ${rcf}); ${envelope}`);
    }
    const text = r.stdout;
    const nl = text.indexOf("\n");
    const header = text
      .slice(0, nl < 0 ? undefined : nl)
      .trim()
      .split(/\s+/);
    if (r.exit_code !== 0 || nl < 0 || header.length !== 3) {
      throw new Error(`agent37 exec ${name}: bad envelope (rc=${r.exit_code}): ${text.slice(0, 120)}`);
    }
    const code = Number.parseInt(header[0]!, 10);
    const outLen = Number.parseInt(header[1]!, 10);
    const errLen = Number.parseInt(header[2]!, 10);
    if (![code, outLen, errLen].every(Number.isSafeInteger) || outLen < 0 || errLen < 0) {
      throw new Error(`agent37 exec ${name}: bad envelope sizes: ${header.join(" ")}`);
    }
    let outBuf: Buffer;
    let errBuf: Buffer;
    if (outLen <= INLINE_LIMIT && errLen <= INLINE_LIMIT) {
      const b64 = text.slice(nl + 1).replace(/\s+/g, "");
      const outB64 = Math.ceil(outLen / 3) * 4;
      outBuf = Buffer.from(b64.slice(0, outB64), "base64");
      errBuf = Buffer.from(b64.slice(outB64), "base64");
      if (outBuf.length !== outLen || errBuf.length !== errLen) {
        throw new Error(
          `agent37 exec ${name}: truncated stream (${outBuf.length}/${outLen} out, ${errBuf.length}/${errLen} err)`,
        );
      }
    } else {
      try {
        if (outLen > MAX_EXEC_OUTPUT_BYTES - errLen) {
          throw new Error(`agent37 exec ${name}: output exceeds ${MAX_EXEC_OUTPUT_BYTES} bytes`);
        }
        outBuf = await readSpooled(name, out, outLen);
        errBuf = await readSpooled(name, err, errLen);
      } finally {
        await postExec(name, `rm -f ${shq(out)} ${shq(err)} ${shq(rcf)}`).catch(
          swallowAs("agent37-sandbox: spool cleanup", undefined),
        );
      }
    }
    return { stdout: outBuf.toString("utf8"), stderr: errBuf.toString("utf8"), code, timedOut: code === 124 };
  }

  const filePath = (absPath: string): string => `/v1/files/content?${new URLSearchParams({ path: absPath })}`;

  async function writeAbsBytes(name: string, absPath: string, data: Uint8Array): Promise<void> {
    await onInstance(name, async (inst) => {
      const res = await instanceApi(inst, "PUT", filePath(absPath), data);
      if (!res.ok) throw await failure(res, `write ${absPath}`);
      const entry = (await res.json()) as { size?: number | null };
      if (entry.size !== data.length) {
        throw new Error(`agent37 write ${absPath}: wrote ${entry.size ?? "unknown"} of ${data.length} bytes`);
      }
    });
  }

  async function readAbsBytes(name: string, absPath: string): Promise<Uint8Array | null> {
    return onInstance(name, async (inst) => {
      const res = await instanceApi(inst, "GET", filePath(absPath));
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
      const err = await failure(res, `read ${absPath}`);
      if (err.code === "file_not_found") return null;
      throw err;
    });
  }

  async function ensureInstance(
    key: string,
    target: InstanceTarget,
    onStatus?: (text: string) => void,
  ): Promise<{ coldStart: boolean }> {
    return provisionQueue(key, () =>
      advisoryLock.withLock(`agent37-provision:${key}`, async () => {
        if (instances.has(target.name)) return { coldStart: false };
        const existing = await findInstance(target);
        if (existing) {
          rememberInstance(target.name, existing);
          if (existing.status !== "running") await ensureRunning(existing.id);
          return { coldStart: false };
        }
        try {
          onStatus?.("Creating the sandbox…");
        } catch (error) {
          void error;
        }
        rememberInstance(target.name, await createInstance(target));
        return { coldStart: true };
      }),
    );
  }

  async function ensureScratch(key: string): Promise<{ name: string; coldStart: boolean }> {
    const target = scratchTarget(key);
    return provisionQueue(`scratch:${key}`, async () => {
      scratchKeyByName.set(target.name, key);
      const active = activeScratch.get(target.name) ?? 0;
      if (active === 0 && !instances.has(target.name)) {
        await deleteInstance(target).catch(swallowAs("agent37-sandbox: stale scratch delete", undefined));
        rememberInstance(target.name, await createInstance(target));
      }
      activeScratch.set(target.name, active + 1);
      return { name: target.name, coldStart: active === 0 };
    });
  }

  function requestBackup(name: string): void {
    void instanceFor(name)
      .then((inst) => api("POST", `/v1/instances/${enc(inst.id)}/backups`, undefined, LIFECYCLE_TIMEOUT_MS))
      .catch(swallowAs("agent37-sandbox: backup request", undefined));
  }

  async function backupRecovery(id: string): Promise<NonNullable<ComputerStatus["recovery"]>> {
    try {
      const { data } = await apiJson<{ data: BackupRecord[] }>("GET", `/v1/instances/${enc(id)}/backups`);
      const newest = data[0];
      if (!newest) {
        return {
          strategy: "provider_snapshot",
          state: "none",
          error: "no backup yet: the first nightly backup lands after the first night, on-demand ones after a turn",
        };
      }
      return {
        strategy: "provider_snapshot",
        checkpointId: newest.id,
        checkpointAtMs: newest.created * 1000,
        checkpointExpiresAtMs: null,
        state: newest.kind,
      };
    } catch (e) {
      return { strategy: "provider_snapshot", error: errMessage(e) };
    }
  }

  const profile: AgentComputerProfile = {
    backend: "agent37",
    writablePersistence: "resident_disk",
    processSessions: true,
    egressEnforcement: "none",
    spec: {
      os: "Debian 12, Agent37 sandbox (the whole disk persists)",
      runtimes: ["Node 24", "Python 3"],
      get tools() {
        return visibleTools(["git", "curl", "jq", "tar", "python3", ...(opts.extraTools ?? [])]);
      },
      get notInstalled() {
        return visibleNotInstalled(["gh", "aws", "gcloud", "kubectl", "flyctl", "glab"], opts.extraTools ?? []);
      },
      cpus: resources.cpu,
      memoryMb: resources.memory * 1024,
      diskGb: resources.disk,
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

  const execFileOps = createExecFileOps({
    label: "agent37",
    exec: (id, script, t) => execRaw(id, script, t),
    writeInline: (id, abs, data) => writeAbsBytes(id, abs, data),
  });

  const blobStaging = createBackendBlobStaging("agent37", (id, script, t) => execRaw(id, script, t), opts);

  const execBackup = createExecExport({
    label: "agent37",
    exec: (id, script, t) => execRaw(id, script, t),
    readAbsBytes,
    defaultHomeDir: HOME_DIR,
    ephemeralCredentialPrefixes: ephemeralCredLinkPaths(opts.credentialPaths ?? []).map(({ rel }) => rel),
  });

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
        const target = scopeTarget(scope);
        name = target.name;
        scopeByName.set(name, scope);
        ({ coldStart } = await ensureInstance(scope, target, provOpts?.onStatus));
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
          throw new Error(`agent37 provision prep failed: ${(prep.stderr || prep.stdout).slice(0, 200)}`);

        await materializeRoLayers(
          workspace,
          layers,
          handle,
          {
            readFile: (h, rel) => sandbox.readFile(h, rel),
            writeFileBytes: (h, rel, data) => sandbox.writeFileBytes(h, rel, data),
            exec: (script, t) => execRaw(name, script, t),
          },
          { manifest: RO_LAYERS_MANIFEST, tar: RO_LAYERS_TAR, label: "agent37" },
        );

        return handle;
      } catch (err) {
        await sandbox.teardown(handle).catch(swallowAs("agent37-sandbox: teardown after failed provision", undefined));
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
        execRaw(handle.id, killScript(killUid), 15).catch(swallowAs("agent37-sandbox: kill in-flight exec", undefined));
      };
      const onAbort = () => fireKill();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        signal.throwIfAborted();
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

    exportFiles: execBackup.exportFiles,

    async computerStatus(scopeId: string): Promise<ComputerStatus> {
      const target = scopeTarget(scopeId);
      let info: InstanceInfo | null;
      try {
        info = await findInstance(target);
      } catch (e) {
        return { machine: `check failed: ${errMessage(e)}`, guestResponsive: false };
      }
      if (!info) return { machine: "no instance", provisioned: false, guestResponsive: false };
      rememberInstance(target.name, info);
      const recovery = await backupRecovery(info.id);
      let guestResponsive = false;
      if (info.status === "running") {
        try {
          guestResponsive = (await execRaw(target.name, "true", GUEST_PROBE_TIMEOUT_SEC)).code === 0;
        } catch (e) {
          void e;
        }
      }
      const lifecycleState: ComputerStatus["lifecycleState"] = LIFECYCLE_STATES.get(info.status);
      return {
        machine: `agent37 instance ${info.id}: ${info.status}`,
        provisioned: true,
        guestResponsive,
        recovery,
        ...(lifecycleState ? { lifecycleState } : {}),
      };
    },

    async restartComputer(scopeId: string): Promise<void> {
      const target = scopeTarget(scopeId);
      return provisionQueue(scopeId, () =>
        advisoryLock.withLock(`agent37-provision:${scopeId}`, async () => {
          const found = await findInstance(target);
          if (!found) throw new Error(`agent37 instance ${target.name}: not found`);
          const inst = rememberInstance(target.name, found);
          await ensureRunning(inst.id);
          const res = await api("POST", `/v1/instances/${enc(inst.id)}/restart`, undefined, LIFECYCLE_TIMEOUT_MS);
          if (!res.ok) {
            const err = await failure(res, `restart ${target.name}`);
            if (err.code !== "try_again") throw err;
          }
          await ensureRunning(inst.id);
        }),
      );
    },

    async destroyScope(scopeId: string): Promise<void> {
      return provisionQueue(scopeId, async () => {
        await advisoryLock.withLock(`agent37-provision:${scopeId}`, () => deleteInstance(scopeTarget(scopeId)));
      });
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
          const target = targets.get(handle.id);
          if (!target) return;
          if (tdOpts?.destroy) await deleteInstance(target);
          else await deleteInstance(target).catch(swallowAs("agent37-sandbox: scratch delete", undefined));
        });
      }
      if (!tdOpts?.destroy) {
        if (!tdOpts?.homeUnchanged) requestBackup(handle.id);
        return;
      }
      const target = targets.get(handle.id);
      if (!target) return;
      await deleteInstance(target).catch((e) => {
        const scope = scopeByName.get(handle.id);
        opts.onError?.({
          category: "sandbox_teardown",
          code: "instance_delete_failed",
          message: errMessage(e),
          ...(scope ? { scopeLabel: scope } : {}),
        });
      });
    },
  };

  return sandbox;
}
