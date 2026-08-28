import { randomUUID } from "node:crypto";
import { Boxd, ConflictError, NotFoundError } from "@boxd-sh/sdk";
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

const HOME_DIR = "/home/boxd";
const WORKSPACE_BASENAME = "workspace";
const RO_LAYERS_TAR = ".ro-layers.tar";
const RO_LAYERS_MANIFEST = ".ro-layers.manifest";
const MISSING_RC = 44;
const READ_CHUNK = 512 * 1024;
const DOWNLOAD_LIMIT = 3 * 1024 * 1024;
const EXIT_GRACE_MS = 60_000;
const READY_TIMEOUT_MS = 180_000;
const READY_POLL_MS = 1_000;
const GUEST_PROBE_TIMEOUT_SEC = 15;
const MEMORY_MB_PER_VCPU = 4096;
const DEFAULT_DISK_GB = 100;
const PARKED_STATES = new Set(["stopped", "failed"]);

export interface BoxdMachine {
  id: string;
  name: string;
  status: string;
}

export interface BoxdClientLike {
  machines: {
    create(params: { name: string; org?: string; config?: { vcpu?: number; disk?: string } }): Promise<BoxdMachine>;
    get(id: string): Promise<BoxdMachine>;
    list(params?: { org?: string }): Promise<BoxdMachine[]>;
    delete(id: string): Promise<void>;
    start(id: string): Promise<void>;
    reboot(id: string): Promise<void>;
    exec(
      id: string,
      params: { command: string; timeout?: number },
    ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
    files: {
      upload(id: string, path: string, data: Uint8Array): Promise<number>;
      download(id: string, path: string): Promise<Uint8Array>;
    };
  };
}

export interface BoxdSandboxOptions {
  apiKey?: string;
  baseUrl?: string;
  org?: string;
  namePrefix?: string;
  vcpu?: number;
  diskGb?: number;
  defaultTimeoutSec?: number;
  egressProxyUrl?: string;
  blobTransfer?: BlobTransferStore;
  signingSecret?: string;
  capabilitySecret?: string;
  apiBaseUrl?: string;
  extraTools?: string[];
  credentialPaths?: CredentialPathSpec[];
  client?: BoxdClientLike;
  onError?: (e: { category: string; code: string; message: string; scopeLabel?: string }) => void;
}

const isStoppedRefusal = (e: unknown): boolean => e instanceof ConflictError && /stopped/i.test(e.message);

export function createBoxdSandbox(workspace: WorkspaceStore, opts: BoxdSandboxOptions = {}): Sandbox {
  if (!opts.client && !opts.apiKey) throw new Error("SANDBOX_BACKEND=boxd requires BOXD_API_KEY");
  const client: BoxdClientLike =
    opts.client ?? new Boxd({ apiKey: opts.apiKey!, ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}) });
  const prefix = opts.namePrefix ?? "qm";
  const orgParam = opts.org ? { org: opts.org } : {};
  const sizing = {
    ...(opts.vcpu ? { vcpu: opts.vcpu } : {}),
    ...(opts.diskGb ? { disk: `${opts.diskGb}G` } : {}),
  };
  const defaultTimeoutSec = opts.defaultTimeoutSec ?? 600;
  const workspaceDir = `${HOME_DIR}/${WORKSPACE_BASENAME}`;
  const provisionQueue = createKeyedQueue<string>();

  const idByName = new Map<string, string>();
  const scopeByName = new Map<string, string>();
  const scratchKeyByName = new Map<string, string>();
  const activeScratch = new Map<string, number>();

  async function findMachine(name: string): Promise<BoxdMachine | null> {
    const machines = await client.machines.list(orgParam);
    return machines.find((m) => m.name === name && m.status !== "destroyed") ?? null;
  }

  async function machineIdFor(name: string): Promise<string> {
    const cached = idByName.get(name);
    if (cached) return cached;
    const found = await findMachine(name);
    if (!found) throw new Error(`boxd machine ${name}: not found`);
    idByName.set(name, found.id);
    return found.id;
  }

  async function ensureRunning(id: string): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let started = false;
    for (;;) {
      const m = await client.machines.get(id);
      if (m.status === "running" || m.status === "suspended" || m.status === "hibernated") return;
      if (m.status === "destroyed") throw new Error(`boxd machine ${m.name}: destroyed`);
      if (PARKED_STATES.has(m.status) && !started) {
        await client.machines.start(id);
        started = true;
      }
      if (Date.now() > deadline) {
        throw new Error(`boxd machine ${m.name}: not running after ${READY_TIMEOUT_MS}ms (state=${m.status})`);
      }
      await sleep(READY_POLL_MS);
    }
  }

  async function createMachine(name: string): Promise<{ machine: BoxdMachine; created: boolean }> {
    try {
      const machine = await client.machines.create({
        name,
        ...orgParam,
        ...(Object.keys(sizing).length ? { config: sizing } : {}),
      });
      return { machine, created: true };
    } catch (createErr) {
      if (!(createErr instanceof ConflictError)) throw createErr;
      const existing = await findMachine(name);
      if (!existing) throw createErr;
      return { machine: existing, created: false };
    }
  }

  async function deleteMachine(name: string): Promise<void> {
    const id = idByName.get(name) ?? (await findMachine(name))?.id;
    idByName.delete(name);
    if (!id) return;
    try {
      await client.machines.delete(id);
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
    }
  }

  async function onMachine<T>(name: string, label: string, call: (id: string) => Promise<T>): Promise<T> {
    const id = await machineIdFor(name);
    try {
      return await call(id);
    } catch (e) {
      if (e instanceof NotFoundError) idByName.delete(name);
      if (!isStoppedRefusal(e)) throw new Error(`boxd ${label} ${name}: ${errMessage(e)}`, { cause: e });
    }
    await ensureRunning(id);
    try {
      return await call(id);
    } catch (e) {
      throw new Error(`boxd ${label} ${name}: ${errMessage(e)}`, { cause: e });
    }
  }

  async function execRaw(name: string, script: string, timeoutSec: number): Promise<ExecResult> {
    const r = await onMachine(name, "exec", (id) =>
      client.machines.exec(id, {
        command: `timeout ${timeoutSec} sh -c ${shq(script)}`,
        timeout: timeoutSec * 1000 + EXIT_GRACE_MS,
      }),
    );
    if (r.exitCode < 0) throw new Error(`boxd exec ${name}: stream ended without an exit status`);
    return { stdout: r.stdout, stderr: r.stderr, code: r.exitCode, timedOut: r.exitCode === 124 };
  }

  async function writeAbsBytes(name: string, absPath: string, data: Uint8Array): Promise<void> {
    const written = await onMachine(name, "write", (id) => client.machines.files.upload(id, absPath, data));
    if (written !== data.length) throw new Error(`boxd write ${absPath} failed (${written}/${data.length} bytes)`);
  }

  async function readAbsBytes(name: string, absPath: string): Promise<Uint8Array | null> {
    const stat = await execRaw(name, `[ -e ${shq(absPath)} ] || exit ${MISSING_RC}; wc -c < ${shq(absPath)}`, 60);
    if (stat.code === MISSING_RC) return null;
    if (stat.code !== 0) {
      throw new Error(`boxd read ${absPath} failed (${stat.code}): ${(stat.stderr || stat.stdout).slice(0, 200)}`);
    }
    const declared = Number.parseInt(stat.stdout.trim(), 10);
    if (!Number.isFinite(declared)) throw new Error(`boxd read ${absPath}: bad size (${stat.stdout.slice(0, 40)})`);
    let data: Uint8Array;
    if (declared <= DOWNLOAD_LIMIT) {
      data = await onMachine(name, "read", (id) => client.machines.files.download(id, absPath));
    } else {
      const parts: Buffer[] = [];
      for (let i = 0; i < Math.ceil(declared / READ_CHUNK); i++) {
        const chunk = `dd if=${shq(absPath)} bs=${READ_CHUNK} skip=${i} count=1 2>/dev/null | base64`;
        const c = await execRaw(name, chunk, 120);
        if (c.code !== 0) throw new Error(`boxd read ${absPath} chunk ${i} failed (${c.code})`);
        parts.push(Buffer.from(c.stdout.replace(/\s+/g, ""), "base64"));
      }
      data = Buffer.concat(parts);
    }
    if (data.length !== declared) throw new Error(`boxd read ${absPath}: truncated (${data.length}/${declared})`);
    return data;
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
        await ensureRunning(existing.id);
        return { coldStart: false };
      }
      try {
        onStatus?.("Creating the sandbox…");
      } catch (error) {
        void error;
      }
      const { machine, created } = await createMachine(name);
      idByName.set(name, machine.id);
      await ensureRunning(machine.id);
      return { coldStart: created };
    });
  }

  async function ensureScratch(key: string): Promise<{ name: string; coldStart: boolean }> {
    const name = spriteScopeName(`${prefix}-scratch`, key);
    return provisionQueue(`scratch:${key}`, async () => {
      scratchKeyByName.set(name, key);
      const active = activeScratch.get(name) ?? 0;
      if (active === 0 && !idByName.has(name)) {
        await deleteMachine(name).catch(swallowAs("boxd-sandbox: stale scratch delete", undefined));
        const { machine } = await createMachine(name);
        idByName.set(name, machine.id);
        await ensureRunning(machine.id);
      }
      activeScratch.set(name, active + 1);
      return { name, coldStart: active === 0 };
    });
  }

  const profile: AgentComputerProfile = {
    backend: "boxd",
    writablePersistence: "resident_disk",
    processSessions: true,
    egressEnforcement: "none",
    spec: {
      os: "Ubuntu 24.04 LTS — boxd microVM (auto-suspends when idle; the whole disk persists)",
      runtimes: ["Node 24", "Python 3"],
      get tools() {
        return visibleTools(["git", "curl", "jq", "tar", "python3", "gh", "docker", ...(opts.extraTools ?? [])]);
      },
      get notInstalled() {
        return visibleNotInstalled(["aws", "gcloud", "kubectl", "flyctl", "glab"], opts.extraTools ?? []);
      },
      ...(opts.vcpu ? { cpus: opts.vcpu, memoryMb: opts.vcpu * MEMORY_MB_PER_VCPU } : {}),
      diskGb: opts.diskGb ?? DEFAULT_DISK_GB,
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
    label: "boxd",
    exec: (id, script, t) => execRaw(id, script, t),
    writeInline: (id, abs, data) => writeAbsBytes(id, abs, data),
  });

  const blobSigningSecret = opts.capabilitySecret ?? opts.signingSecret;
  const blobStaging =
    opts.blobTransfer && blobSigningSecret && opts.apiBaseUrl
      ? createExecBlobStaging({
          label: "boxd",
          exec: (id, script, t) => execRaw(id, script, t),
          proxyPrefix: proxyExportPrefix,
          apiBaseUrl: opts.apiBaseUrl,
          capabilityHeader: CAPABILITY_HEADER,
          mintToken: (grant) =>
            mintCapabilityToken(
              {
                actorId: "boxd-sandbox",
                aud: BLOB_TRANSFER_AUD,
                scopeId: "personal:boxd-sandbox",
                blob: grant,
                exp: Date.now() + BLOB_TRANSFER_TTL_MS,
              },
              blobSigningSecret,
            ),
        })
      : null;

  const execBackup = createExecBackup({
    label: "boxd",
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
          throw new Error(`boxd provision prep failed: ${(prep.stderr || prep.stdout).slice(0, 200)}`);

        await materializeRoLayers(
          workspace,
          layers,
          handle,
          {
            readFile: (h, rel) => sandbox.readFile(h, rel),
            writeFileBytes: (h, rel, data) => sandbox.writeFileBytes(h, rel, data),
            exec: (script, t) => execRaw(name, script, t),
          },
          { manifest: RO_LAYERS_MANIFEST, tar: RO_LAYERS_TAR, label: "boxd" },
        );

        return handle;
      } catch (err) {
        await sandbox.teardown(handle).catch(swallowAs("boxd-sandbox: teardown after failed provision", undefined));
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
        execRaw(handle.id, killScript(killUid), 15).catch(swallowAs("boxd-sandbox: kill in-flight exec", undefined));
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

    async computerStatus(scopeId: string) {
      const name = spriteScopeName(prefix, scopeId);
      let machine: string;
      try {
        machine = (await client.machines.get(await machineIdFor(name))).status;
      } catch (e) {
        machine = `check failed: ${errMessage(e)}`;
      }
      let guestResponsive = false;
      try {
        guestResponsive = (await execRaw(name, "true", GUEST_PROBE_TIMEOUT_SEC)).code === 0;
      } catch (e) {
        void e;
      }
      return { machine, guestResponsive };
    },

    async restartComputer(scopeId: string): Promise<void> {
      const name = spriteScopeName(prefix, scopeId);
      const id = await machineIdFor(name);
      try {
        await client.machines.reboot(id);
      } catch (e) {
        throw new Error(`boxd reboot ${name}: ${errMessage(e)}`, { cause: e });
      }
      await ensureRunning(id);
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
          if (tdOpts?.destroy) await deleteMachine(handle.id);
          else await deleteMachine(handle.id).catch(swallowAs("boxd-sandbox: scratch delete", undefined));
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
