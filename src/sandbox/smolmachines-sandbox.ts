import { randomUUID } from "node:crypto";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { fetchWithRetry, sleep } from "../util/async.ts";
import { httpFailure } from "../util/errors.ts";
import { shq } from "../util/shell.ts";
import { createProviderSandbox, type SandboxShared, type StoredSandboxRecord } from "./provider-sandbox.ts";
import type { ExecResult, Sandbox } from "./sandbox.ts";

const HOME_DIR = "/root";
const FILE_TRANSFER_TIMEOUT_MS = 300_000;
const EXEC_SYNC_MAX_SEC = 240;
const EXEC_POLL_MS = 2_000;
const EXIT_GRACE_MS = 60_000;
const READY_TIMEOUT_MS = 180_000;
const READY_POLL_MS = 1_000;
const SCRATCH_TTL_SEC = 24 * 3600;
const BASE_URL = "https://api.smolmachines.com";
const IMAGE = "codex";
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

export type StoredSmolmachinesSandbox = StoredSandboxRecord;

export interface SmolmachinesSandboxOptions extends SandboxShared {
  token?: string;
  baseUrl?: string;
  store: DurableMap<StoredSmolmachinesSandbox>;
  fetchImpl?: typeof fetch;
}

export function createSmolmachinesSandbox(workspace: WorkspaceStore, opts: SmolmachinesSandboxOptions): Sandbox {
  if (!opts.token && !opts.fetchImpl) throw new Error("SANDBOX_BACKEND=smolmachines requires SMOLMACHINES_TOKEN");
  const token = opts.token ?? "";
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = (opts.baseUrl ?? BASE_URL).replace(/\/+$/, "");
  const resources = {
    ...(opts.cpus ? { cpus: opts.cpus } : {}),
    ...(opts.memoryMb ? { memoryMb: opts.memoryMb } : {}),
    ...(opts.diskGb ? { diskGb: opts.diskGb } : {}),
  };
  const egressProxyHost = opts.egressProxyUrl ? new URL(opts.egressProxyUrl).hostname : undefined;
  const network: MachineNetwork = egressProxyHost ? { mode: "allowCidrs", hosts: [egressProxyHost] } : { mode: "open" };

  const idByName = new Map<string, string>();
  const egressVerified = new Set<string>();

  const isRunning = (info: MachineInfo): boolean => RUNNING_STATES.has(info.state.toLowerCase());
  const machinePath = (id: string): string => `/v1/machines/${encodeURIComponent(id)}`;

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
        authorization: `Bearer ${token}`,
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
      throw new Error(`smolmachines ${method} ${path}: ${await httpFailure(res)}`);
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
      source: { type: "image", reference: IMAGE },
      ...(Object.keys(resources).length ? { resources } : {}),
      network,
      workdir: HOME_DIR,
      ephemeral,
      ...(ephemeral ? { ttlSeconds: SCRATCH_TTL_SEC } : {}),
      ...(opts.idleParkSec ? { autoStopSeconds: opts.idleParkSec } : {}),
    });
    if (res.status === 409) {
      const existing = await findMachine(name);
      if (!existing) throw new Error(`smolmachines create ${name}: http 409 but the machine is not listed`);
      await startMachine(existing.id);
      return { info: existing, created: false };
    }
    if (!res.ok) {
      throw new Error(`smolmachines create ${name}: ${await httpFailure(res)}`);
    }
    const info = (await res.json()) as MachineInfo;
    await startMachine(info.id);
    return { info, created: true };
  }

  async function startMachine(id: string): Promise<void> {
    const res = await api("POST", `${machinePath(id)}/start`);
    if (!res.ok && res.status !== 409) {
      throw new Error(`smolmachines start ${id}: ${await httpFailure(res)}`);
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
      throw new Error(`smolmachines delete ${name}: ${await httpFailure(res)}`);
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
    const first = await send("POST", execPath(id), body, timeoutMs);
    let res = first;
    if (!first.ok) {
      const detail = await httpFailure(first);
      if (first.status === 404) idByName.delete(name);
      if (first.status !== 409 && first.status !== 404 && !/stopped|suspended/i.test(detail)) {
        throw new Error(`smolmachines exec ${name}: ${detail}`);
      }
      const retryId = await machineIdFor(name);
      await startMachine(retryId);
      res = await send("POST", execPath(retryId), body, timeoutMs);
      if (!res.ok) {
        throw new Error(`smolmachines exec ${name}: ${await httpFailure(res)}`);
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
    const res = await fetchWithRetry(
      (signal) =>
        fetchImpl(`${baseUrl}${filesUrl(id, absPath)}`, {
          method: "PUT",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
          body: Buffer.from(data),
          signal,
        }),
      "idempotent",
      { timeoutMs: FILE_TRANSFER_TIMEOUT_MS },
    );
    if (!res.ok) {
      throw new Error(`smolmachines write ${absPath}: ${await httpFailure(res)}`);
    }
  }

  async function readAbsBytes(name: string, absPath: string): Promise<Uint8Array | null> {
    const id = await machineIdFor(name);
    const res = await fetchWithRetry(
      (signal) =>
        fetchImpl(`${baseUrl}${filesUrl(id, absPath)}`, {
          headers: { authorization: `Bearer ${token}` },
          signal,
        }),
      "idempotent",
      { timeoutMs: FILE_TRANSFER_TIMEOUT_MS },
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`smolmachines read ${absPath}: ${await httpFailure(res)}`);
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

  const idleNote = opts.idleParkSec ? `; stops after ${opts.idleParkSec}s idle and restarts on the next command` : "";
  return createProviderSandbox(
    workspace,
    {
      backend: "smolmachines",
      homeDir: HOME_DIR,
      os: `smolmachines microVM booted from the ${IMAGE} image (the whole disk persists across stops${idleNote})`,
      cpus: opts.cpus ?? DEFAULT_CPUS,
      memoryMb: opts.memoryMb ?? DEFAULT_MEMORY_MB,
      ...(opts.diskGb ? { diskGb: opts.diskGb } : {}),
      egressEnforcement: egressProxyHost ? "domain" : "none",
      exec: execRaw,
      writeAbsBytes,
      readAbsBytes,
      async inspect(name) {
        const info = await findMachine(name);
        if (!info) return null;
        idByName.set(name, info.id);
        return {
          state: isRunning(info) ? "running" : "parked",
          detail: `machine ${info.id} ${info.state}${info.error ? `: ${info.error}` : ""}`,
        };
      },
      async create(name, { scratch }) {
        const { info } = await createMachine(name, scratch);
        idByName.set(name, info.id);
      },
      resume: async (name) => startMachine(await machineIdFor(name)),
      destroy: deleteMachine,
      isLive: (name) => idByName.has(name),
      forget: (name) => idByName.delete(name),
      ...(egressProxyHost ? { ensureEgress } : {}),
    },
    opts,
    opts.store,
  );
}
