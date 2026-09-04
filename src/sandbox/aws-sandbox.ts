import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { orgId as configOrgId } from "../config.ts";
import type { WorkspaceLayer } from "../types.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { createNoopAdvisoryLock, type AdvisoryLock } from "../persistence/advisory-lock.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import { createKeyedQueue } from "../util/async.ts";
import { scopeStorageKey } from "../util/scope-storage-key.ts";
import { swallow, swallowAs, errMessage } from "../util/errors.ts";
import { shq } from "../util/shell.ts";
import { nonInteractiveShellPrefix } from "./sandbox-env.ts";
import { createExecProcessSessions, type ExecProcessIo } from "./exec-process-session.ts";
import { materializeRoLayers } from "./ro-layers.ts";
import { createExecBackup, createExecFileOps, posixJoin } from "./exec-file-ops.ts";
import { createMicrovmApi, createMicrovmClient, type AwsMicrovmApi } from "./aws-microvm-api.ts";
import type {
  AgentComputerProfile,
  ExecOptions,
  ExecResult,
  ProvisionOptions,
  Sandbox,
  SandboxHandle,
  TeardownOptions,
} from "./sandbox.ts";
import { visibleNotInstalled, visibleTools } from "./sandbox.ts";
import {
  ephemeralCredLinkPaths,
  ephemeralCredLinkScript,
  type CredentialPathSpec,
} from "../credentials/resident-paths.ts";

const HOME_DIR = "/root";
const WORKSPACE_BASENAME = "workspace";
const WORKSPACE_DIR = `${HOME_DIR}/${WORKSPACE_BASENAME}`;
const HOME_TAR = "/tmp/agent-home.tar";
const RO_LAYERS_TAR = ".ro-layers.tar";
const RO_LAYERS_MANIFEST = ".ro-layers.manifest";
const SNAPSHOT_PRUNE = [
  "./.cache",
  "./.cache/*",
  "*/.cache",
  "*/.cache/*",
  "./__pycache__",
  "*/__pycache__",
  "*/__pycache__/*",
  "./.npm",
  "./.aws",
];

const DEFAULT_INGRESS = (region: string) =>
  `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:ALL_INGRESS`;
const DEFAULT_EGRESS = (region: string) =>
  `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`;

export interface StoredMicrovm {
  microvmId: string;
  endpoint: string;
  imageVersion?: string;
  createdAtMs: number;
  lastSnapshotMs?: number;
  lastActivityMs?: number;
  orgId?: string;
}

export interface AwsSandboxOptions {
  region: string;
  profile?: string;
  imageIdentifier: string;
  imageVersion?: string;
  executionRoleArn?: string;
  ingressConnectorArns?: string[];
  egressConnectorArns?: string[];
  s3Bucket: string;
  s3Prefix?: string;
  agentPort?: number;
  maxIdleDurationSeconds?: number;
  suspendedDurationSeconds?: number;
  maximumDurationInSeconds?: number;
  rotateAfterSeconds?: number;
  snapshotIntervalMs?: number;
  defaultTimeoutSec?: number;
  cpus?: number;
  memoryMb?: number;
  diskGb?: number;
  store?: DurableMap<StoredMicrovm>;
  advisoryLock?: AdvisoryLock;
  extraTools?: string[];
  credentialPaths?: CredentialPathSpec[];
  onError?: (e: { category: string; code: string; message: string; scopeLabel?: string }) => void;
  api?: AwsMicrovmApi;
  s3?: Pick<S3Client, "send">;
  fetchImpl?: typeof fetch;
}

interface BodyRef {
  microvmId: string;
  endpoint: string;
}

export function createAwsSandbox(workspace: WorkspaceStore, opts: AwsSandboxOptions): Sandbox {
  const region = opts.region;
  const api =
    opts.api ??
    createMicrovmApi({
      region,
      ...(opts.profile ? { profile: opts.profile } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
  const s3: Pick<S3Client, "send"> =
    opts.s3 ?? new S3Client({ region, ...(opts.profile ? { profile: opts.profile } : {}) });
  const store = opts.store ?? createMemoryMap<StoredMicrovm>();
  const advisoryLock = opts.advisoryLock ?? createNoopAdvisoryLock();
  const provisionQueue = createKeyedQueue<string>();
  const onError = opts.onError;

  const ingress = opts.ingressConnectorArns?.length ? opts.ingressConnectorArns : [DEFAULT_INGRESS(region)];
  const egress = opts.egressConnectorArns?.length ? opts.egressConnectorArns : [DEFAULT_EGRESS(region)];
  const s3Prefix = (opts.s3Prefix ?? "sandbox-home").replace(/\/+$/, "");
  const agentPort = opts.agentPort ?? 8080;
  const defaultTimeoutSec = opts.defaultTimeoutSec ?? 600;
  const maximumDurationInSeconds = opts.maximumDurationInSeconds ?? 28_800;
  const rotateAfterMs = (opts.rotateAfterSeconds ?? 27_000) * 1000;
  const snapshotIntervalMs = opts.snapshotIntervalMs ?? 0;
  const cpus = opts.cpus ?? 4;
  const memoryMb = opts.memoryMb ?? 8192;
  const diskGb = opts.diskGb ?? 8;
  const credentialPaths = opts.credentialPaths ?? [];

  const endpointById = new Map<string, string>();
  const scopeByMicrovm = new Map<string, string>();
  const scratchByKey = new Map<string, BodyRef>();
  const activeByMicrovm = new Map<string, number>();

  function reportError(category: string, code: string, message: string, scopeLabel?: string): void {
    onError?.({ category, code, message, ...(scopeLabel ? { scopeLabel } : {}) });
  }

  const s3KeyFor = (scope: string): string => `${s3Prefix}/${scopeStorageKey(scope)}.tar`;

  const client = createMicrovmClient(api, {
    agentPort,
    tokenTtlMinutes: 30,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });

  async function resolveEndpoint(id: string): Promise<string> {
    const cached = endpointById.get(id);
    if (cached) return cached;
    const desc = await api.getMicrovm(id);
    if (!desc.endpoint) throw new Error(`microVM ${id} has no endpoint`);
    endpointById.set(id, desc.endpoint);
    return desc.endpoint;
  }

  async function execRaw(id: string, command: string, timeoutSec: number): Promise<ExecResult> {
    return client.execRaw(id, await resolveEndpoint(id), command, timeoutSec);
  }

  async function writeAbsBytes(id: string, absPath: string, data: Uint8Array): Promise<void> {
    await client.writeAbs(id, await resolveEndpoint(id), absPath, data);
  }

  async function readAbsBytes(id: string, absPath: string): Promise<Uint8Array | null> {
    const res = await client.daemon(id, await resolveEndpoint(id), "/read", { path: absPath });
    if (res.status === 404) return null;
    if (res.status !== 200)
      throw new Error(`microVM read ${absPath} failed (${res.status}): ${res.text.slice(0, 200)}`);
    return Buffer.from((JSON.parse(res.text) as { b64: string }).b64, "base64");
  }

  async function ensureRunning(id: string): Promise<void> {
    await client.ensureRunning(id, await resolveEndpoint(id));
  }

  async function snapshotHome(scope: string, id: string): Promise<void> {
    const credentialPrunes = ephemeralCredLinkPaths(credentialPaths).map(({ rel }) => `./${rel}`);
    const pruneExpr = [...SNAPSHOT_PRUNE, ...credentialPrunes].map((p) => `-path ${shq(p)}`).join(" -o ");
    const script = `cd ${shq(HOME_DIR)} 2>/dev/null || exit 0; find . \\( ${pruneExpr} \\) -prune -o -type f -print0 | tar --null -T - -cf ${shq(HOME_TAR)} 2>/dev/null`;
    const made = await execRaw(id, script, 180);
    if (made.code !== 0) throw new Error(`snapshot tar failed: ${made.stderr.slice(0, 200)}`);
    const bytes = await readAbsBytes(id, HOME_TAR);
    await execRaw(id, `rm -f ${shq(HOME_TAR)}`, 30).catch(() => {});
    if (!bytes) throw new Error("snapshot read-back empty");
    await s3.send(new PutObjectCommand({ Bucket: opts.s3Bucket, Key: s3KeyFor(scope), Body: bytes }));
  }

  async function hydrateHome(scope: string, id: string): Promise<boolean> {
    let bytes: Uint8Array | null;
    try {
      const got = await s3.send(new GetObjectCommand({ Bucket: opts.s3Bucket, Key: s3KeyFor(scope) }));
      const arr = await got.Body?.transformToByteArray();
      bytes = arr ?? null;
    } catch (e) {
      const code = (e as { name?: string; $metadata?: { httpStatusCode?: number } })?.name ?? "";
      const status =
        (e as { $metadata?: { httpStatusCode?: number }; status?: number })?.$metadata?.httpStatusCode ??
        (e as { status?: number })?.status;
      if (!/NoSuchKey|NotFound/.test(code) && status !== 404) swallow("aws-sandbox: hydrate", e);
      return false;
    }
    if (!bytes || !bytes.length) return false;
    await writeAbsBytes(id, HOME_TAR, bytes);
    const r = await execRaw(
      id,
      `mkdir -p ${shq(HOME_DIR)} && cd ${shq(HOME_DIR)} && tar -xf ${shq(HOME_TAR)}; rc=$?; rm -f ${shq(HOME_TAR)}; exit $rc`,
      180,
    );
    if (r.code !== 0) throw new Error(`hydrate extract failed: ${r.stderr.slice(0, 200)}`);
    return true;
  }

  let resolvedImageArn: string | undefined;
  async function imageArn(): Promise<string> {
    if (resolvedImageArn) return resolvedImageArn;
    if (opts.imageIdentifier.startsWith("arn:")) {
      resolvedImageArn = opts.imageIdentifier;
      return resolvedImageArn;
    }
    const img = await api.findImage(opts.imageIdentifier);
    if (!img) throw new Error(`AWS sandbox image not found: ${opts.imageIdentifier}`);
    resolvedImageArn = img.imageArn;
    return resolvedImageArn;
  }

  async function launchBody(scope: string | undefined): Promise<{ id: string; endpoint: string }> {
    const run = await api.runMicrovm({
      imageIdentifier: await imageArn(),
      ...(opts.imageVersion ? { imageVersion: opts.imageVersion } : {}),
      ingressNetworkConnectors: ingress,
      egressNetworkConnectors: egress,
      ...(opts.executionRoleArn ? { executionRoleArn: opts.executionRoleArn } : {}),
      idlePolicy: {
        autoResumeEnabled: true,
        maxIdleDurationSeconds: opts.maxIdleDurationSeconds ?? 900,
        suspendedDurationSeconds: opts.suspendedDurationSeconds ?? 3600,
      },
      maximumDurationInSeconds,
      clientToken: `${scope ?? "scratch"}-${Date.now()}`,
    });
    const ready = await api.waitForState(run.microvmId, "RUNNING");
    const endpoint = run.endpoint ?? ready.endpoint;
    if (!endpoint) throw new Error(`microVM ${run.microvmId} has no endpoint`);
    endpointById.set(run.microvmId, endpoint);
    await client.waitDaemon(run.microvmId, endpoint);
    return { id: run.microvmId, endpoint };
  }

  async function ensureBody(scope: string): Promise<{ id: string; endpoint: string; coldStart: boolean }> {
    return provisionQueue(scope, () =>
      advisoryLock.withLock(`aws-provision:${scope}`, async () => {
        const stored = await store.get(scope);
        if (stored) {
          const desc = await api.tryGetMicrovm(stored.microvmId);
          const alive = desc && desc.state !== "TERMINATED" && desc.state !== "TERMINATING";
          const stale = Date.now() - stored.createdAtMs > rotateAfterMs;
          if (alive && !stale) {
            endpointById.set(stored.microvmId, stored.endpoint);
            scopeByMicrovm.set(stored.microvmId, scope);
            await ensureRunning(stored.microvmId);
            return { id: stored.microvmId, endpoint: stored.endpoint, coldStart: false };
          }
          if (alive && stale) {
            endpointById.set(stored.microvmId, stored.endpoint);
            await ensureRunning(stored.microvmId).catch(() => {});
            await snapshotHome(scope, stored.microvmId).catch((e) =>
              reportError("sandbox_snapshot", "rotate_snapshot_failed", errMessage(e), scope),
            );
            await api.terminate(stored.microvmId).catch(() => {});
          }
        }
        const body = await launchBody(scope);
        scopeByMicrovm.set(body.id, scope);
        const hydrated = await hydrateHome(scope, body.id);
        await store.put(scope, {
          microvmId: body.id,
          endpoint: body.endpoint,
          ...(opts.imageVersion ? { imageVersion: opts.imageVersion } : {}),
          createdAtMs: Date.now(),
          ...(hydrated ? { lastSnapshotMs: Date.now() } : {}),
          orgId: configOrgId(),
        });
        return { id: body.id, endpoint: body.endpoint, coldStart: !hydrated };
      }),
    );
  }

  async function ensureScratch(key: string): Promise<{ id: string; endpoint: string; coldStart: boolean }> {
    return provisionQueue(`scratch:${key}`, async () => {
      const existing = scratchByKey.get(key);
      if (existing) {
        const desc = await api.tryGetMicrovm(existing.microvmId);
        if (desc && desc.state !== "TERMINATED" && desc.state !== "TERMINATING") {
          endpointById.set(existing.microvmId, existing.endpoint);
          await ensureRunning(existing.microvmId);
          return { id: existing.microvmId, endpoint: existing.endpoint, coldStart: false };
        }
      }
      const body = await launchBody(undefined);
      scratchByKey.set(key, { microvmId: body.id, endpoint: body.endpoint });
      return { id: body.id, endpoint: body.endpoint, coldStart: true };
    });
  }

  const profile: AgentComputerProfile = {
    backend: "aws-microvm",
    writablePersistence: "snapshot_to_workspace",
    processSessions: true,
    egressEnforcement: "none",
    spec: {
      os: "Amazon Linux 2023, glibc",
      runtimes: ["Node 24", "Python 3 (venv on PATH)"],
      get tools() {
        return visibleTools([
          "git",
          "curl",
          "wget",
          "jq",
          "unzip",
          "gnupg",
          "python3",
          "gh",
          "aws (CLI v2)",
          ...(opts.extraTools ?? []),
        ]);
      },
      get notInstalled() {
        return visibleNotInstalled(["gcloud", "kubectl", "glab"], opts.extraTools ?? []);
      },
      cpus,
      memoryMb,
      diskGb,
      homeDir: HOME_DIR,
      workdir: WORKSPACE_DIR,
    },
  };

  const procIo: ExecProcessIo = {
    async run(handle, command, execOpts): Promise<ExecResult> {
      const timeoutSec = execOpts?.timeoutMs ? Math.ceil(execOpts.timeoutMs / 1000) : defaultTimeoutSec;
      await ensureRunning(handle.id);
      return execRaw(handle.id, command, timeoutSec);
    },
  };
  const procSessions = createExecProcessSessions(procIo);

  const execFileOps = createExecFileOps({
    label: "aws",
    exec: (id, script, t) => execRaw(id, script, t),
    writeInline: (id, abs, data) => writeAbsBytes(id, abs, data),
  });

  const execBackup = createExecBackup({
    label: "aws",
    exec: (id, script, t) => execRaw(id, script, t),
    readAbsBytes,
    defaultHomeDir: HOME_DIR,
    ephemeralCredentialPrefixes: ephemeralCredLinkPaths(credentialPaths).map(({ rel }) => rel),
  });

  const sandbox: Sandbox = {
    profile,
    startProcess: procSessions.startProcess,
    readProcess: procSessions.readProcess,
    writeStdin: procSessions.writeStdin,
    signalProcess: procSessions.signalProcess,
    listProcesses: procSessions.listProcesses,
    ...execFileOps,

    async provision(layers: WorkspaceLayer[], provOpts?: ProvisionOptions): Promise<SandboxHandle> {
      const scratch = provOpts?.scratch;
      const writable = layers.find((l) => l.mode === "rw") ?? layers[0];
      const scope = writable?.scopeId ?? "default";
      const body = scratch ? await ensureScratch(scratch.key) : await ensureBody(scope);
      const id = body.id;
      endpointById.set(id, body.endpoint);
      const coldStart = body.coldStart;

      const prepared = await execRaw(
        id,
        `mkdir -p ${shq(WORKSPACE_DIR)} && ${ephemeralCredLinkScript(HOME_DIR, credentialPaths)}`,
        30,
      );
      if (prepared.code !== 0) throw new Error(`AWS sandbox credential setup failed: ${prepared.stderr.slice(0, 200)}`);

      const env = provOpts?.env && Object.keys(provOpts.env).length ? provOpts.env : undefined;
      const handle: SandboxHandle = {
        id,
        rootDir: WORKSPACE_DIR,
        homeDir: HOME_DIR,
        coldStart,
        ...(scratch ? { scratch: true } : {}),
        ...(env ? { env } : {}),
      };

      await materializeRoLayers(
        workspace,
        layers,
        handle,
        {
          readFile: (h, rel) => sandbox.readFile(h, rel),
          writeFileBytes: (h, rel, data) => sandbox.writeFileBytes(h, rel, data),
          exec: (script, t) => execRaw(id, script, t),
        },
        { manifest: RO_LAYERS_MANIFEST, tar: RO_LAYERS_TAR, label: "aws" },
      );

      activeByMicrovm.set(id, (activeByMicrovm.get(id) ?? 0) + 1);
      return handle;
    },

    async run(handle, command, execOpts?: ExecOptions): Promise<ExecResult> {
      const timeoutSec = execOpts?.timeoutMs ? Math.ceil(execOpts.timeoutMs / 1000) : defaultTimeoutSec;
      await ensureRunning(handle.id);
      const exports = Object.entries(handle.env ?? {})
        .map(([k, v]) => `export ${k}=${shq(v)}`)
        .join("; ");
      const script = `${nonInteractiveShellPrefix()}${exports ? exports + "; " : ""}cd ${handle.rootDir} 2>/dev/null; ${command}`;
      return execRaw(handle.id, script, timeoutSec);
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
      const remaining = (activeByMicrovm.get(handle.id) ?? 1) - 1;
      if (remaining > 0) {
        activeByMicrovm.set(handle.id, remaining);
        return;
      }
      activeByMicrovm.delete(handle.id);

      if (handle.scratch) {
        for (const [k, ref] of scratchByKey) if (ref.microvmId === handle.id) scratchByKey.delete(k);
        if (tdOpts?.destroy) await api.terminate(handle.id);
        else await api.terminate(handle.id).catch(swallowAs("aws-sandbox: scratch terminate", undefined));
        client.evict(handle.id);
        endpointById.delete(handle.id);
        return;
      }

      if (tdOpts?.keepWarm) return;

      const scope = scopeByMicrovm.get(handle.id) ?? (await scopeOf(handle.id));
      if (tdOpts?.destroy) {
        await api.terminate(handle.id).catch(swallowAs("aws-sandbox: destroy terminate", undefined));
        if (scope) {
          await s3.send(new DeleteObjectCommand({ Bucket: opts.s3Bucket, Key: s3KeyFor(scope) })).catch(() => {});
          await store.delete(scope).catch(() => {});
        }
        client.evict(handle.id);
        endpointById.delete(handle.id);
        return;
      }

      if (scope) {
        const stored = await store.get(scope);
        const due = !stored?.lastSnapshotMs || Date.now() - stored.lastSnapshotMs > snapshotIntervalMs;
        if (due) {
          try {
            await snapshotHome(scope, handle.id);
            await store.merge(scope, { lastSnapshotMs: Date.now(), lastActivityMs: Date.now() });
          } catch (e) {
            reportError("sandbox_snapshot", "teardown_snapshot_failed", errMessage(e), scope);
            await store.merge(scope, { lastActivityMs: Date.now() }).catch(() => {});
          }
        } else {
          await store.merge(scope, { lastActivityMs: Date.now() }).catch(() => {});
        }
      }
      await api.suspend(handle.id).catch(swallowAs("aws-sandbox: suspend on teardown", undefined));
    },

    async reapDeepIdle(idleMs): Promise<{ reaped: number }> {
      if (!(idleMs > 0)) return { reaped: 0 };
      const cutoff = Date.now() - idleMs;
      let reaped = 0;
      for (const [scope, rec] of await store.entries()) {
        if (rec.orgId && rec.orgId !== configOrgId()) continue;
        if (!rec.lastActivityMs || rec.lastActivityMs > cutoff) continue;
        const desc = await api.tryGetMicrovm(rec.microvmId);
        if (!desc || desc.state === "TERMINATED" || desc.state === "TERMINATING") {
          await store.delete(scope).catch(() => {});
          continue;
        }
        try {
          endpointById.set(rec.microvmId, rec.endpoint);
          const due = !rec.lastSnapshotMs || (rec.lastActivityMs ?? 0) > rec.lastSnapshotMs;
          if (due) {
            await ensureRunning(rec.microvmId);
            await snapshotHome(scope, rec.microvmId);
          }
          await api.terminate(rec.microvmId);
          await store.delete(scope);
          reaped++;
        } catch (e) {
          reportError("sandbox_reap", "deep_idle_reap_failed", errMessage(e), scope);
        }
      }
      return { reaped };
    },
  };

  async function scopeOf(microvmId: string): Promise<string | undefined> {
    const cached = scopeByMicrovm.get(microvmId);
    if (cached) return cached;
    for (const [scope, rec] of await store.entries()) if (rec.microvmId === microvmId) return scope;
    return undefined;
  }

  return sandbox;
}
