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

const HOME_DIR = "/root";
const WORKSPACE_BASENAME = "workspace";
const RO_LAYERS_TAR = ".ro-layers.tar";
const RO_LAYERS_MANIFEST = ".ro-layers.manifest";
const INLINE_LIMIT = 256 * 1024;
const FILE_TRANSFER_TIMEOUT_MS = 300_000;
const EXEC_SYNC_MAX_SEC = 240;
const EXEC_POLL_MS = 2_000;
const EXIT_GRACE_MS = 60_000;
const READY_TIMEOUT_MS = 180_000;
const READY_POLL_MS = 1_000;
const DEFAULT_SMOLMACHINES_BASE_URL = "https://api.smolmachines.com";
const DEFAULT_IMAGE = "codex";
const RUNNING_STATES = new Set(["running", "started", "ready"]);

interface MachineInfo {
  id: string;
  name?: string | null;
  state: string;
}

interface MachineExecResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export interface SmolmachinesSandboxOptions {
  token?: string;
  baseUrl?: string;
  namePrefix?: string;
  image?: string;
  cpus?: number;
  memoryMb?: number;
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
  const workspaceDir = `${HOME_DIR}/${WORKSPACE_BASENAME}`;
  const provisionQueue = createKeyedQueue<string>();

  const idByName = new Map<string, string>();
  const scopeByName = new Map<string, string>();
  const scratchKeyByName = new Map<string, string>();
  const activeScratch = new Map<string, number>();

  async function api(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<Response> {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${opts.token ?? ""}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res;
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

  async function awaitRunning(id: string): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      const info = await apiJson<MachineInfo>("GET", `/v1/machines/${encodeURIComponent(id)}`);
      if (RUNNING_STATES.has(info.state.toLowerCase())) return;
      if (Date.now() > deadline)
        throw new Error(`smolmachines machine ${id}: not running after ${READY_TIMEOUT_MS}ms (state=${info.state})`);
      await sleep(READY_POLL_MS);
    }
  }

  async function createMachine(name: string, ephemeral: boolean): Promise<{ info: MachineInfo; created: boolean }> {
    const res = await api("POST", "/v1/machines", {
      name,
      source: { type: "image", reference: image },
      ...(Object.keys(resources).length ? { resources } : {}),
      network: { mode: "open" },
      workdir: HOME_DIR,
      ephemeral,
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
    const res = await api("POST", `/v1/machines/${encodeURIComponent(id)}/start`);
    if (!res.ok && res.status !== 409) {
      throw new Error(`smolmachines start ${id}: http ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    await awaitRunning(id);
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
    const found = idByName.get(name) ?? (await findMachine(name))?.id;
    idByName.delete(name);
    if (!found) return;
    const res = await api("DELETE", `/v1/machines/${encodeURIComponent(found)}`);
    if (!res.ok && res.status !== 404) {
      throw new Error(`smolmachines delete ${name}: http ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
  }

  async function postExec(
    name: string,
    script: string,
    timeoutSec: number,
    stdinB64?: string,
  ): Promise<MachineExecResponse> {
    const id = await machineIdFor(name);
    const body = {
      command: ["sh", "-c", script],
      timeoutSeconds: timeoutSec + Math.ceil(EXIT_GRACE_MS / 1000),
      ...(stdinB64 !== undefined ? { stdin: stdinB64 } : {}),
    };
    const timeoutMs = timeoutSec * 1000 + 2 * EXIT_GRACE_MS;
    const first = await api("POST", `/v1/machines/${encodeURIComponent(id)}/exec`, body, timeoutMs);
    let res = first;
    if (!first.ok) {
      const detail = (await first.text()).slice(0, 200);
      if (first.status === 404) idByName.delete(name);
      if (first.status !== 409 && first.status !== 404 && !/stopped|suspended/i.test(detail)) {
        throw new Error(`smolmachines exec ${name}: http ${first.status} ${detail}`);
      }
      const retryId = await machineIdFor(name);
      await startMachine(retryId);
      res = await api("POST", `/v1/machines/${encodeURIComponent(retryId)}/exec`, body, timeoutMs);
      if (!res.ok) {
        throw new Error(`smolmachines exec ${name}: http ${res.status} ${(await res.text()).slice(0, 200)}`);
      }
    }
    const parsed = (await res.json()) as MachineExecResponse;
    if (parsed.stdoutTruncated || parsed.stderrTruncated) {
      throw new Error(`smolmachines exec ${name}: output truncated by the API — chunk the read instead`);
    }
    return parsed;
  }

  const filesUrl = (id: string, absPath: string): string =>
    `/v1/machines/${encodeURIComponent(id)}/files${absPath.split("/").map(encodeURIComponent).join("/")}`;

  async function readSpooled(name: string, absPath: string, declared: number): Promise<Buffer> {
    const data = await readAbsBytes(name, absPath);
    if (!data || data.length !== declared) {
      throw new Error(`smolmachines read ${absPath}: truncated (${data?.length ?? 0}/${declared})`);
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
    let r: MachineExecResponse;
    if (timeoutSec <= EXEC_SYNC_MAX_SEC) {
      r = await postExec(
        name,
        `timeout ${timeoutSec} sh -c ${shq(script)} > ${out} 2> ${err}; __rc=$?; ${envelope}`,
        timeoutSec,
      );
    } else {
      const body = `timeout ${timeoutSec} sh -c ${shq(script)} > ${out} 2> ${err}; echo $? > ${rcf}`;
      const start = await postExec(name, `nohup sh -c ${shq(body)} >/dev/null 2>&1 & echo launched`, 30);
      if (start.exitCode !== 0 || !/launched/.test(start.stdout)) {
        throw new Error(`smolmachines exec ${name}: background launch failed (rc=${start.exitCode})`);
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
      r = await postExec(name, `__rc=$(cat ${rcf}); ${envelope}`, 60);
    }
    const text = r.stdout;
    const nl = text.indexOf("\n");
    const header = text
      .slice(0, nl < 0 ? undefined : nl)
      .trim()
      .split(/\s+/);
    if (r.exitCode !== 0 || nl < 0 || header.length !== 3) {
      throw new Error(`smolmachines exec ${name}: bad envelope (rc=${r.exitCode}): ${text.slice(0, 120)}`);
    }
    const code = Number.parseInt(header[0]!, 10);
    const outLen = Number.parseInt(header[1]!, 10);
    const errLen = Number.parseInt(header[2]!, 10);
    let outBuf: Buffer;
    let errBuf: Buffer;
    if (outLen <= INLINE_LIMIT && errLen <= INLINE_LIMIT) {
      const b64 = text.slice(nl + 1).replace(/\s+/g, "");
      const outB64 = Math.ceil(outLen / 3) * 4;
      outBuf = Buffer.from(b64.slice(0, outB64), "base64");
      errBuf = Buffer.from(b64.slice(outB64), "base64");
      if (outBuf.length !== outLen || errBuf.length !== errLen) {
        throw new Error(
          `smolmachines exec ${name}: truncated stream (${outBuf.length}/${outLen} out, ${errBuf.length}/${errLen} err)`,
        );
      }
    } else {
      outBuf = await readSpooled(name, out, outLen);
      errBuf = await readSpooled(name, err, errLen);
      await postExec(name, `rm -f ${shq(out)} ${shq(err)} ${shq(rcf)}`, 60).catch(
        swallowAs("smolmachines-sandbox: spool cleanup", undefined),
      );
    }
    return { stdout: outBuf.toString("utf8"), stderr: errBuf.toString("utf8"), code, timedOut: code === 124 };
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

  async function ensureMachine(
    key: string,
    name: string,
    onStatus?: (text: string) => void,
  ): Promise<{ coldStart: boolean }> {
    return provisionQueue(key, async () => {
      if (idByName.has(name)) return { coldStart: false };
      const existing = await findMachine(name);
      if (existing) {
        idByName.set(name, existing.id);
        if (!RUNNING_STATES.has(existing.state)) await startMachine(existing.id);
        return { coldStart: false };
      }
      try {
        onStatus?.("Creating the sandbox…");
      } catch (error) {
        void error;
      }
      const { info, created } = await createMachine(name, false);
      idByName.set(name, info.id);
      return { coldStart: created };
    });
  }

  async function ensureScratch(key: string): Promise<{ name: string; coldStart: boolean }> {
    const name = spriteScopeName(`${prefix}-scratch`, key);
    return provisionQueue(`scratch:${key}`, async () => {
      scratchKeyByName.set(name, key);
      const active = activeScratch.get(name) ?? 0;
      if (active === 0 && !idByName.has(name)) {
        await deleteMachine(name).catch(swallowAs("smolmachines-sandbox: stale scratch delete", undefined));
        const { info } = await createMachine(name, true);
        idByName.set(name, info.id);
      }
      activeScratch.set(name, active + 1);
      return { name, coldStart: active === 0 };
    });
  }

  const profile: AgentComputerProfile = {
    backend: "smolmachines",
    writablePersistence: "resident_disk",
    processSessions: true,
    egressEnforcement: "none",
    spec: {
      os: "Debian 12 — smolmachines microVM (auto-stops when idle; the whole disk persists)",
      runtimes: ["Node", "Python 3"],
      get tools() {
        return visibleTools(["git", "curl", "jq", "tar", "python3", ...(opts.extraTools ?? [])]);
      },
      get notInstalled() {
        return visibleNotInstalled(["gh", "aws", "gcloud", "kubectl", "flyctl", "glab"], opts.extraTools ?? []);
      },
      ...(opts.cpus ? { cpus: opts.cpus } : {}),
      ...(opts.memoryMb ? { memoryMb: opts.memoryMb } : {}),
      ...(opts.diskGb ? { diskGb: opts.diskGb } : {}),
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
    label: "smolmachines",
    exec: (id, script, t) => execRaw(id, script, t),
    writeInline: (id, abs, data) => writeAbsBytes(id, abs, data),
  });

  const blobSigningSecret = opts.capabilitySecret ?? opts.signingSecret;
  const blobStaging =
    opts.blobTransfer && blobSigningSecret && opts.apiBaseUrl
      ? createExecBlobStaging({
          label: "smolmachines",
          exec: (id, script, t) => execRaw(id, script, t),
          proxyPrefix: proxyExportPrefix,
          apiBaseUrl: opts.apiBaseUrl,
          capabilityHeader: CAPABILITY_HEADER,
          mintToken: (grant) =>
            mintCapabilityToken(
              {
                actorId: "smolmachines-sandbox",
                aud: BLOB_TRANSFER_AUD,
                scopeId: "personal:smolmachines-sandbox",
                blob: grant,
                exp: Date.now() + BLOB_TRANSFER_TTL_MS,
              },
              blobSigningSecret,
            ),
        })
      : null;

  const execBackup = createExecBackup({
    label: "smolmachines",
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
        ({ coldStart } = await ensureMachine(scope, name, provOpts?.onStatus));
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
          throw new Error(`smolmachines provision prep failed: ${(prep.stderr || prep.stdout).slice(0, 200)}`);

        await materializeRoLayers(
          workspace,
          layers,
          handle,
          {
            readFile: (h, rel) => sandbox.readFile(h, rel),
            writeFileBytes: (h, rel, data) => sandbox.writeFileBytes(h, rel, data),
            exec: (script, t) => execRaw(name, script, t),
          },
          { manifest: RO_LAYERS_MANIFEST, tar: RO_LAYERS_TAR, label: "smolmachines" },
        );

        return handle;
      } catch (err) {
        await sandbox
          .teardown(handle)
          .catch(swallowAs("smolmachines-sandbox: teardown after failed provision", undefined));
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
        execRaw(handle.id, killScript(killUid), 15).catch(
          swallowAs("smolmachines-sandbox: kill in-flight exec", undefined),
        );
      };
      if (signal.aborted) fireKill();
      const onAbort = () => fireKill();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
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
          if (tdOpts?.destroy) await deleteMachine(handle.id);
          else await deleteMachine(handle.id).catch(swallowAs("smolmachines-sandbox: scratch delete", undefined));
        });
      }
      if (!tdOpts?.destroy) return;
      await deleteMachine(handle.id).catch((e) => {
        const scope = scopeByName.get(handle.id);
        opts.onError?.({
          category: "sandbox_teardown",
          code: "machine_delete_failed",
          message: errMessage(e),
          ...(scope ? { scopeLabel: scope } : {}),
        });
      });
    },
  };

  return sandbox;
}
