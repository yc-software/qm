import { randomUUID } from "node:crypto";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { fetchWithRetry, sleep } from "../util/async.ts";
import { withRequestId, swallowAs } from "../util/errors.ts";
import { NonRetryableTurnError } from "../core/turn-error.ts";
import { shq } from "../util/shell.ts";
import { createExecProcessSessions, type ExecProcessIo } from "./exec-process-session.ts";
import { createExecExport, createBackendBlobStaging, createExecFileOps } from "./exec-file-ops.ts";
import { ephemeralCredLinkPaths, type CredentialPathSpec } from "../credentials/resident-paths.ts";
import type { BlobTransferStore } from "../persistence/blob-transfer.ts";
import { createNoopAdvisoryLock, type AdvisoryLock } from "../persistence/advisory-lock.ts";
import { visibleNotInstalled, visibleTools } from "./sandbox.ts";
import { createExecSandboxBase, sandboxScopeName } from "./exec-sandbox-base.ts";
import type { AgentComputerProfile, ExecResult, Sandbox } from "./sandbox.ts";

const HOME_DIR = "/home/node";
const INLINE_LIMIT = 128 * 1024;
const MAX_EXEC_OUTPUT_BYTES = 16 * 1024 * 1024;
const READ_CHUNK = 256 * 1024;
const WRITE_CHUNK_B64 = 64 * 1024;
const MISSING_RC = 44;
const EXEC_SYNC_MAX_SEC = 240;
const EXEC_POLL_MS = 2_000;
const EXIT_GRACE_MS = 60_000;
const CREATE_TIMEOUT_MS = 330_000;
const START_TIMEOUT_MS = 830_000;
const READY_TIMEOUT_MS = 300_000;
const READY_POLL_MS = 2_000;
const DEFAULT_AGENT37_BASE_URL = "https://api.agent37.com";
const DEFAULT_TEMPLATE = "agent37-codex";
const DEFAULT_CPUS = 2;
const DEFAULT_MEMORY_GB = 4;
const DEFAULT_DISK_GB = 8;
const STARTABLE_STATES = new Set(["stopped", "sleeping"]);
const GONE_STATES = new Set(["deleting", "deleted"]);
const DEAD_STATES = new Set(["failed", ...GONE_STATES]);
const REFUSAL_CODES = new Set([
  "insufficient_balance",
  "instance_limit_reached",
  "free_hours_exhausted",
  "subscription_required",
  "tier_limit",
  "invalid_api_key",
  "ip_not_allowed",
  "forbidden",
]);

function refusalMessage(body: string): string | null {
  let parsed: { error?: { code?: string; message?: string } };
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const { code, message } = parsed?.error ?? {};
  return code && message && REFUSAL_CODES.has(code) ? message : null;
}

async function apiFailure(action: string, res: Response): Promise<{ detail: string; error: Error }> {
  const body = await res.text().catch(() => "");
  const detail = withRequestId(`http ${res.status} ${body.slice(0, 200)}`, res.headers);
  const refused = refusalMessage(body);
  return {
    detail,
    error: refused
      ? new NonRetryableTurnError(`Agent37 refused this agent computer: ${refused}`)
      : new Error(`agent37 ${action}: ${detail}`),
  };
}

interface InstanceInfo {
  id: string;
  name?: string | null;
  status: string;
}

interface InstanceExecResponse {
  exit_code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface Agent37SandboxOptions {
  apiKey?: string;
  baseUrl?: string;
  namePrefix?: string;
  template?: string;
  cpus?: number;
  memoryGb?: number;
  diskGb?: number;
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

export function createAgent37Sandbox(workspace: WorkspaceStore, opts: Agent37SandboxOptions = {}): Sandbox {
  if (!opts.apiKey && !opts.fetchImpl) throw new Error("SANDBOX_BACKEND=agent37 requires AGENT37_API_KEY");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = (opts.baseUrl ?? DEFAULT_AGENT37_BASE_URL).replace(/\/+$/, "");
  const prefix = opts.namePrefix ?? "qm";
  const template = opts.template ?? DEFAULT_TEMPLATE;
  const resources = {
    cpu: opts.cpus ?? DEFAULT_CPUS,
    memory: opts.memoryGb ?? DEFAULT_MEMORY_GB,
    disk: opts.diskGb ?? DEFAULT_DISK_GB,
  };
  const defaultTimeoutSec = opts.defaultTimeoutSec ?? 600;
  const advisoryLock = opts.advisoryLock ?? createNoopAdvisoryLock();

  const idByName = new Map<string, string>();

  function send(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 60_000,
    signal?: AbortSignal,
  ): Promise<Response> {
    return fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${opts.apiKey ?? ""}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    });
  }

  function api(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<Response> {
    const operation = (signal?: AbortSignal) => send(method, path, body, timeoutMs, signal);
    return method === "GET" || method === "DELETE"
      ? fetchWithRetry(operation, "idempotent", { timeoutMs })
      : operation();
  }

  async function apiJson<T>(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
    const res = await api(method, path, body, timeoutMs);
    if (!res.ok) {
      throw (await apiFailure(`${method} ${path}`, res)).error;
    }
    return (await res.json()) as T;
  }

  async function findInstance(name: string): Promise<InstanceInfo | null> {
    const { data } = await apiJson<{ data: InstanceInfo[] }>("GET", "/v1/instances");
    return data.find((i) => i.name === name && !GONE_STATES.has(i.status)) ?? null;
  }

  async function ensureRunning(id: string): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      const info = await apiJson<InstanceInfo>("GET", `/v1/instances/${encodeURIComponent(id)}`);
      if (info.status === "running") return;
      if (DEAD_STATES.has(info.status)) throw new Error(`agent37 instance ${id}: ${info.status}`);
      if (Date.now() > deadline)
        throw new Error(`agent37 instance ${id}: not running after ${READY_TIMEOUT_MS}ms (status=${info.status})`);
      if (STARTABLE_STATES.has(info.status)) {
        const res = await api("POST", `/v1/instances/${encodeURIComponent(id)}/start`, undefined, START_TIMEOUT_MS);
        if (res.ok) continue;
        if (res.status !== 400 && res.status !== 409) {
          throw (await apiFailure(`start ${id}`, res)).error;
        }
      }
      await sleep(READY_POLL_MS);
    }
  }

  async function createInstance(name: string): Promise<InstanceInfo> {
    const res = await fetchWithRetry(
      (signal) =>
        send("POST", "/v1/instances", { template, name, resources, auto_sleep: true }, CREATE_TIMEOUT_MS, signal),
      "refused",
      { timeoutMs: CREATE_TIMEOUT_MS },
    );
    if (!res.ok) throw (await apiFailure(`create ${name}`, res)).error;
    const info = (await res.json()) as InstanceInfo;
    await ensureRunning(info.id);
    return info;
  }

  async function instanceIdFor(name: string): Promise<string> {
    const cached = idByName.get(name);
    if (cached) return cached;
    const found = await findInstance(name);
    if (!found) throw new Error(`agent37 instance ${name}: not found`);
    idByName.set(name, found.id);
    return found.id;
  }

  async function deleteInstance(name: string): Promise<void> {
    const found = (await findInstance(name))?.id;
    if (!found) {
      idByName.delete(name);
      return;
    }
    const res = await api("DELETE", `/v1/instances/${encodeURIComponent(found)}`, undefined, 120_000);
    if (!res.ok && res.status !== 404) {
      throw (await apiFailure(`delete ${name}`, res)).error;
    }
    idByName.delete(name);
  }

  async function postExec(name: string, script: string, timeoutSec: number): Promise<InstanceExecResponse> {
    const id = await instanceIdFor(name);
    const body = { command: script };
    const timeoutMs = timeoutSec * 1000 + 2 * EXIT_GRACE_MS;
    const first = await send("POST", `/v1/instances/${encodeURIComponent(id)}/exec`, body, timeoutMs);
    let res = first;
    if (!first.ok) {
      const { detail, error } = await apiFailure(`exec ${name}`, first);
      if (first.status === 404) idByName.delete(name);
      const notRunning = first.status === 400 && /running instances/i.test(detail);
      const freezing = first.status === 409;
      if (first.status !== 404 && !notRunning && !freezing) {
        throw error;
      }
      const retryId = await instanceIdFor(name);
      await ensureRunning(retryId);
      res = await send("POST", `/v1/instances/${encodeURIComponent(retryId)}/exec`, body, timeoutMs);
      if (!res.ok) {
        throw (await apiFailure(`exec ${name}`, res)).error;
      }
    }
    const parsed = (await res.json()) as InstanceExecResponse;
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
    let r: InstanceExecResponse;
    if (timeoutSec <= EXEC_SYNC_MAX_SEC) {
      r = await postExec(
        name,
        `timeout -k 5 ${timeoutSec} sh -c ${shq(script)} > ${out} 2> ${err}; __rc=$?; ${envelope}`,
        timeoutSec,
      );
    } else {
      const body = `timeout -k 5 ${timeoutSec} sh -c ${shq(script)} > ${out} 2> ${err}; echo $? > ${rcf}`;
      const start = await postExec(name, `nohup sh -c ${shq(body)} >/dev/null 2>&1 & echo launched`, 30);
      if (start.exit_code !== 0 || !/launched/.test(start.stdout)) {
        throw new Error(`agent37 exec ${name}: background launch failed (rc=${start.exit_code})`);
      }
      const deadline = Date.now() + timeoutSec * 1000 + EXIT_GRACE_MS;
      for (;;) {
        const p = await postExec(name, `[ -f ${rcf} ] && echo settled || echo running`, 30);
        if (/settled/.test(p.stdout)) break;
        if (Date.now() > deadline) {
          throw new Error(`agent37 exec ${name}: no exit after ${timeoutSec}s (+grace); leaving ${rcf}`);
        }
        await sleep(EXEC_POLL_MS);
      }
      r = await postExec(name, `__rc=$(cat ${rcf}); ${envelope}`, 60);
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
        await postExec(name, `rm -f ${shq(out)} ${shq(err)} ${shq(rcf)}`, 60).catch(
          swallowAs("agent37-sandbox: spool cleanup", undefined),
        );
      }
    }
    return { stdout: outBuf.toString("utf8"), stderr: errBuf.toString("utf8"), code, timedOut: code === 124 };
  }

  async function writeAbsBytes(name: string, absPath: string, data: Uint8Array): Promise<void> {
    const part = `${absPath}.${randomUUID().slice(0, 8)}.part`;
    const b64 = Buffer.from(data).toString("base64");
    const mk = await postExec(name, `mkdir -p "$(dirname ${shq(absPath)})" && : > ${shq(part)}`, 60);
    if (mk.exit_code !== 0) throw new Error(`agent37 write ${absPath}: mkdir failed (${mk.exit_code})`);
    try {
      for (let i = 0; i < b64.length; i += WRITE_CHUNK_B64) {
        const chunk = b64.slice(i, i + WRITE_CHUNK_B64);
        const r = await postExec(name, `printf %s ${shq(chunk)} | base64 -d >> ${shq(part)}`, 120);
        if (r.exit_code !== 0) {
          throw new Error(`agent37 write ${absPath}: chunk ${i / WRITE_CHUNK_B64} failed (${r.exit_code})`);
        }
      }
      const fin = await postExec(
        name,
        `sz=$(wc -c < ${shq(part)}) && mv -f ${shq(part)} ${shq(absPath)} && printf %s "$sz"`,
        60,
      );
      const written = Number.parseInt(fin.stdout.trim(), 10);
      if (fin.exit_code !== 0 || written !== data.length) {
        throw new Error(`agent37 write ${absPath} failed (rc=${fin.exit_code}, ${written}/${data.length} bytes)`);
      }
    } catch (e) {
      await postExec(name, `rm -f ${shq(part)}`, 60).catch(swallowAs("agent37-sandbox: write part cleanup", undefined));
      throw e;
    }
  }

  async function readAbsBytes(name: string, absPath: string): Promise<Uint8Array | null> {
    const script =
      `[ -e ${shq(absPath)} ] || exit ${MISSING_RC}; s=$(wc -c < ${shq(absPath)}); echo "$s"; ` +
      `if [ "$s" -le ${READ_CHUNK} ]; then base64 < ${shq(absPath)}; fi`;
    const r = await postExec(name, script, 120);
    if (r.exit_code === MISSING_RC) return null;
    if (r.exit_code !== 0) {
      throw new Error(`agent37 read ${absPath} failed (${r.exit_code}): ${r.stderr.slice(0, 200)}`);
    }
    const nl = r.stdout.indexOf("\n");
    const declared = Number.parseInt(r.stdout.slice(0, nl < 0 ? undefined : nl).trim(), 10);
    if (!Number.isFinite(declared)) throw new Error(`agent37 read ${absPath}: bad size (${r.stdout.slice(0, 40)})`);
    const parts: Buffer[] = [];
    if (declared <= READ_CHUNK) {
      parts.push(Buffer.from(r.stdout.slice(nl + 1).replace(/\s+/g, ""), "base64"));
    } else {
      for (let i = 0; i < Math.ceil(declared / READ_CHUNK); i++) {
        const c = await postExec(
          name,
          `dd if=${shq(absPath)} bs=${READ_CHUNK} skip=${i} count=1 2>/dev/null | base64`,
          120,
        );
        if (c.exit_code !== 0) throw new Error(`agent37 read ${absPath} chunk ${i} failed (${c.exit_code})`);
        parts.push(Buffer.from(c.stdout.replace(/\s+/g, ""), "base64"));
      }
    }
    const out = Buffer.concat(parts);
    if (out.length !== declared) throw new Error(`agent37 read ${absPath}: truncated (${out.length}/${declared})`);
    return out;
  }

  const base = createExecSandboxBase({
    workspace,
    label: "agent37",
    prefix,
    homeDir: HOME_DIR,
    defaultTimeoutSec,
    credentialPaths: opts.credentialPaths ?? [],
    egressProxyUrl: opts.egressProxyUrl,
    deleteFailureCode: "instance_delete_failed",
    onError: opts.onError,
    exec: execRaw,
    writeAbsBytes,
    readAbsBytes,
    ensureResident(name, onStatus) {
      const scope = base.scopeFor(name) ?? "default";
      return advisoryLock.withLock(`agent37-provision:${scope}`, async () => {
        if (idByName.has(name)) return { coldStart: false };
        const existing = await findInstance(name);
        if (existing) {
          idByName.set(name, existing.id);
          if (existing.status !== "running") await ensureRunning(existing.id);
          return { coldStart: false };
        }
        onStatus?.("Creating the sandbox…");
        const info = await createInstance(name);
        idByName.set(name, info.id);
        return { coldStart: true };
      });
    },
    isProvisioned: (name) => idByName.has(name),
    async recreateScratch(name) {
      await deleteInstance(name).catch(swallowAs("agent37-sandbox: stale scratch delete", undefined));
      const info = await createInstance(name);
      idByName.set(name, info.id);
    },
    deleteInstance,
  });

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

    provision: base.provision,
    run: base.run,
    writeFileBytes: base.writeFileBytes,
    writeFile: base.writeFile,
    readFileBytes: base.readFileBytes,
    readFile: base.readFile,
    teardown: base.teardown,
    exportFiles: execBackup.exportFiles,

    async destroyScope(scopeId: string): Promise<void> {
      return base.provisionQueue(scopeId, async () => {
        await advisoryLock.withLock(`agent37-provision:${scopeId}`, () =>
          deleteInstance(sandboxScopeName(prefix, scopeId)),
        );
      });
    },
  };

  return sandbox;
}
