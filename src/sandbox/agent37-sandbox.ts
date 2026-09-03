import { randomUUID } from "node:crypto";
import type { WorkspaceLayer } from "../types.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { createKeyedQueue, sleep } from "../util/async.ts";
import { swallowAs, errMessage } from "../util/errors.ts";
import { shq } from "../util/shell.ts";
import { nonInteractiveShellPrefix } from "./sandbox-env.ts";
import { createExecProcessSessions, type ExecProcessIo } from "./exec-process-session.ts";
import { materializeRoLayers } from "./ro-layers.ts";
import {
  BLOB_TRANSFER_TTL_MS,
  createExecBackup,
  createExecBlobStaging,
  createExecFileOps,
  posixJoin,
} from "./exec-file-ops.ts";
import {
  ephemeralCredLinkScript,
  ephemeralCredLinkPaths,
  type CredentialPathSpec,
} from "../credentials/resident-paths.ts";
import { DROPPED_PROXY_ENV, forceThroughProxyEnv, proxyExportPrefix } from "./sandbox-env.ts";
import { BLOB_TRANSFER_AUD, mintCapabilityToken } from "../auth/capability-token.ts";
import type { BlobTransferStore } from "../persistence/blob-transfer.ts";
import { createNoopAdvisoryLock, type AdvisoryLock } from "../persistence/advisory-lock.ts";
import { CAPABILITY_HEADER } from "../api/contract.ts";
import { killableScript, killScript } from "./exec-kill.ts";
import { visibleNotInstalled, visibleTools } from "./sandbox.ts";
import { spriteScopeName } from "./sprites-sandbox.ts";
import type {
  AgentComputerProfile,
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
  const workspaceDir = `${HOME_DIR}/${WORKSPACE_BASENAME}`;
  const provisionQueue = createKeyedQueue<string>();

  const idByName = new Map<string, string>();
  const scopeByName = new Map<string, string>();
  const scratchKeyByName = new Map<string, string>();
  const activeScratch = new Map<string, number>();

  async function api(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<Response> {
    return fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${opts.apiKey ?? ""}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  async function apiJson<T>(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
    const res = await api(method, path, body, timeoutMs);
    if (!res.ok) {
      throw new Error(`agent37 ${method} ${path}: http ${res.status} ${(await res.text()).slice(0, 200)}`);
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
          throw new Error(`agent37 start ${id}: http ${res.status} ${(await res.text()).slice(0, 200)}`);
        }
      }
      await sleep(READY_POLL_MS);
    }
  }

  async function createInstance(name: string): Promise<InstanceInfo> {
    const info = await apiJson<InstanceInfo>(
      "POST",
      "/v1/instances",
      { template, name, resources, auto_sleep: false },
      CREATE_TIMEOUT_MS,
    );
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
    const found = idByName.get(name) ?? (await findInstance(name))?.id;
    idByName.delete(name);
    if (!found) return;
    const res = await api("DELETE", `/v1/instances/${encodeURIComponent(found)}`, undefined, 120_000);
    if (!res.ok && res.status !== 404) {
      throw new Error(`agent37 delete ${name}: http ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
  }

  async function postExec(name: string, script: string, timeoutSec: number): Promise<InstanceExecResponse> {
    const id = await instanceIdFor(name);
    const body = { command: script };
    const timeoutMs = timeoutSec * 1000 + 2 * EXIT_GRACE_MS;
    const first = await api("POST", `/v1/instances/${encodeURIComponent(id)}/exec`, body, timeoutMs);
    let res = first;
    if (!first.ok) {
      const detail = (await first.text()).slice(0, 200);
      if (first.status === 404) idByName.delete(name);
      const notRunning = first.status === 400 && /running instances/i.test(detail);
      if (first.status !== 404 && !notRunning) {
        throw new Error(`agent37 exec ${name}: http ${first.status} ${detail}`);
      }
      const retryId = await instanceIdFor(name);
      await ensureRunning(retryId);
      res = await api("POST", `/v1/instances/${encodeURIComponent(retryId)}/exec`, body, timeoutMs);
      if (!res.ok) {
        throw new Error(`agent37 exec ${name}: http ${res.status} ${(await res.text()).slice(0, 200)}`);
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

  async function ensureInstance(
    key: string,
    name: string,
    onStatus?: (text: string) => void,
  ): Promise<{ coldStart: boolean }> {
    return provisionQueue(key, () =>
      advisoryLock.withLock(`agent37-provision:${key}`, async () => {
        if (idByName.has(name)) return { coldStart: false };
        const existing = await findInstance(name);
        if (existing) {
          idByName.set(name, existing.id);
          if (existing.status !== "running") await ensureRunning(existing.id);
          return { coldStart: false };
        }
        try {
          onStatus?.("Creating the sandbox…");
        } catch (error) {
          void error;
        }
        const info = await createInstance(name);
        idByName.set(name, info.id);
        return { coldStart: true };
      }),
    );
  }

  async function ensureScratch(key: string): Promise<{ name: string; coldStart: boolean }> {
    const name = spriteScopeName(`${prefix}-scratch`, key);
    return provisionQueue(`scratch:${key}`, async () => {
      scratchKeyByName.set(name, key);
      const active = activeScratch.get(name) ?? 0;
      if (active === 0 && !idByName.has(name)) {
        await deleteInstance(name).catch(swallowAs("agent37-sandbox: stale scratch delete", undefined));
        const info = await createInstance(name);
        idByName.set(name, info.id);
      }
      activeScratch.set(name, active + 1);
      return { name, coldStart: active === 0 };
    });
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

  const blobSigningSecret = opts.capabilitySecret ?? opts.signingSecret;
  const blobStaging =
    opts.blobTransfer && blobSigningSecret && opts.apiBaseUrl
      ? createExecBlobStaging({
          label: "agent37",
          exec: (id, script, t) => execRaw(id, script, t),
          proxyPrefix: proxyExportPrefix,
          apiBaseUrl: opts.apiBaseUrl,
          capabilityHeader: CAPABILITY_HEADER,
          mintToken: (grant) =>
            mintCapabilityToken(
              {
                actorId: "agent37-sandbox",
                aud: BLOB_TRANSFER_AUD,
                scopeId: "personal:agent37-sandbox",
                blob: grant,
                exp: Date.now() + BLOB_TRANSFER_TTL_MS,
              },
              blobSigningSecret,
            ),
        })
      : null;

  const execBackup = createExecBackup({
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
    ...(blobStaging
      ? {
          async stageIn(handle: SandboxHandle, destRelPath: string, blobId: string): Promise<void> {
            await blobStaging.stageInAbs(handle, posixJoin(handle.rootDir, destRelPath), blobId);
          },
          async stageOut(handle: SandboxHandle, srcRelPath: string): Promise<string> {
            return blobStaging.stageOutAbs(handle, posixJoin(handle.rootDir, srcRelPath));
          },
        }
      : {}),

    async provision(layers: WorkspaceLayer[], provOpts?: ProvisionOptions): Promise<SandboxHandle> {
      const scratch = provOpts?.scratch;
      const writable = layers.find((l) => l.mode === "rw") ?? layers[0];
      const scope = writable?.scopeId ?? "default";
      let name: string;
      let coldStart: boolean;
      if (scratch) {
        ({ name, coldStart } = await ensureScratch(scratch.key));
      } else {
        name = spriteScopeName(prefix, scope);
        scopeByName.set(name, scope);
        ({ coldStart } = await ensureInstance(scope, name, provOpts?.onStatus));
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

    backupComputer: execBackup.backupComputer,

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
          if (tdOpts?.destroy) await deleteInstance(handle.id);
          else await deleteInstance(handle.id).catch(swallowAs("agent37-sandbox: scratch delete", undefined));
        });
      }
      if (!tdOpts?.destroy) return;
      await deleteInstance(handle.id).catch((e) => {
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
