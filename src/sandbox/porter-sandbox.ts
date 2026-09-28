import { randomUUID } from "node:crypto";
import { LRUCache } from "lru-cache";
import { NotFoundError, type SandboxSpec } from "porter-sandbox";
import type { WorkspaceLayer } from "../types.ts";
import { orgId as configOrgId } from "../config.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { createNoopAdvisoryLock, type AdvisoryLock } from "../persistence/advisory-lock.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import { createKeyedQueue } from "../util/async.ts";
import { swallowAs, errMessage } from "../util/errors.ts";
import {
  createPorterClient,
  createPorterExec,
  ensurePorterVolume,
  listPorterSandboxes,
  porterPhaseSettled,
  porterSandboxById,
  porterSlug,
  retirePorterBody,
  waitPorterRunning,
  type PorterClientLike,
  type PorterSandboxLike,
  type PorterSandboxStatus,
  type PorterVolumeMount,
} from "./porter-client.ts";
import { shq } from "../util/shell.ts";
import { nonInteractiveShellPrefix, DROPPED_PROXY_ENV, forceThroughProxyEnv } from "./sandbox-env.ts";
import { createExecProcessSessions, type ExecProcessIo } from "./exec-process-session.ts";
import { materializeRoLayers } from "./ro-layers.ts";
import { createExecExport, createBackendBlobStaging, createExecFileOps, posixJoin } from "./exec-file-ops.ts";
import {
  ephemeralCredLinkScript,
  ephemeralCredLinkPaths,
  type CredentialPathSpec,
} from "../credentials/resident-paths.ts";
import type { BlobTransferStore } from "../persistence/blob-transfer.ts";
import { killableScript, killScript } from "./exec-kill.ts";
import { visibleNotInstalled, visibleTools } from "./sandbox.ts";
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

const WORKSPACE_BASENAME = "workspace";
const EXPORT_SCRATCH_BASENAME = ".qm-export";
const RO_LAYERS_TAR = ".ro-layers.tar";
const RO_LAYERS_MANIFEST = ".ro-layers.manifest";
const GUEST_PROBE_TIMEOUT_SEC = 10;
const FAILED_BODY_LOG_LINES = 5;
const EGRESS_TAG = "qm-egress";
const SCOPE_TAG = "qm-scope";
const KIND_TAG = "qm-kind";
const DEFAULT_PORTER_SANDBOX_IMAGE = "ghcr.io/porter-dev/qm-sandbox:latest";
const DEFAULT_TTL_SEC = 28_800;
const DEFAULT_SNAPSHOT_INTERVAL_MS = 30 * 60_000;
const BODY_CACHE_MAX = 1000;

interface BodyEntry {
  name: string;
  sb: PorterSandboxLike;
}

export interface StoredPorterScope {
  sandboxId?: string;
  name?: string;
  lastActivityMs: number;
  snapshotId?: string;
  snapshotImage?: string;
  snapshotAtMs?: number;
  orgId?: string;
}

export interface PorterSandboxOptions {
  image?: string;
  token?: string;
  baseUrl?: string;
  namePrefix?: string;
  homeDir?: string;
  ttlSec?: number;
  cpus?: number;
  memoryMb?: number;
  defaultTimeoutSec?: number;
  snapshotIntervalMs?: number;
  egressProxyUrl?: string;
  blobTransfer?: BlobTransferStore;
  signingSecret?: string;
  capabilitySecret?: string;
  apiBaseUrl?: string;
  extraTools?: string[];
  credentialPaths?: CredentialPathSpec[];
  advisoryLock?: AdvisoryLock;
  store?: DurableMap<StoredPorterScope>;
  client?: PorterClientLike;
  onError?: (e: { category: string; code: string; message: string; scopeLabel?: string }) => void;
}

export const porterScopeSlug = porterSlug;

const bodyName = (slug: string): string => `${slug}-${randomUUID().slice(0, 5)}`;

export function createPorterSandbox(workspace: WorkspaceStore, opts: PorterSandboxOptions = {}): Sandbox {
  const image = opts.image ?? DEFAULT_PORTER_SANDBOX_IMAGE;
  const prefix = opts.namePrefix ?? "qm";
  const homeDir = opts.homeDir ?? "/root";
  const ttlSec = opts.ttlSec ?? DEFAULT_TTL_SEC;
  const defaultTimeoutSec = opts.defaultTimeoutSec ?? 600;
  const snapshotIntervalMs = opts.snapshotIntervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
  const workspaceDir = `${homeDir}/${WORKSPACE_BASENAME}`;
  const exportScratchDir = `${homeDir}/${EXPORT_SCRATCH_BASENAME}`;
  const provisionQueue = createKeyedQueue<string>();
  const advisoryLock = opts.advisoryLock ?? createNoopAdvisoryLock();
  const store = opts.store ?? createMemoryMap<StoredPorterScope>();
  const egressProxyHost = opts.egressProxyUrl ? new URL(opts.egressProxyUrl).hostname : undefined;
  const resources: SandboxSpec["resources"] | undefined =
    opts.cpus !== undefined || opts.memoryMb !== undefined
      ? {
          ...(opts.cpus !== undefined ? { cpu: String(opts.cpus) } : {}),
          ...(opts.memoryMb !== undefined ? { memory: `${opts.memoryMb}Mi` } : {}),
        }
      : undefined;

  const client: PorterClientLike =
    opts.client ??
    createPorterClient({
      ...(opts.token ? { token: opts.token } : {}),
      ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    });

  const bodies = new Map<string, BodyEntry>();
  const bodyCache = new LRUCache<string, BodyEntry>({ max: BODY_CACHE_MAX });
  const volumeByBody = new LRUCache<string, PorterVolumeMount>({ max: BODY_CACHE_MAX });
  const scopeByBody = new Map<string, string>();
  const scratchSlugByName = new Map<string, string>();
  const activeScratch = new Map<string, number>();

  const reportError = (category: string, code: string, message: string, scope?: string): void =>
    opts.onError?.({ category, code, message, ...(scope ? { scopeLabel: scope } : {}) });

  function noteBody(entry: BodyEntry, status?: PorterSandboxStatus): void {
    bodyCache.set(entry.name, entry);
    const volumeId = status?.volume_mounts?.[homeDir];
    if (volumeId) volumeByBody.set(entry.name, { volumeId, mountPath: homeDir });
  }

  async function remember(scope: string, patch: Partial<StoredPorterScope>): Promise<void> {
    const merged = await store.merge(scope, patch);
    if (!merged) {
      await store.put(scope, { ...patch, lastActivityMs: patch.lastActivityMs ?? Date.now(), orgId: configOrgId() });
    }
  }

  const snapshotDue = (rec: StoredPorterScope | null): boolean => !!rec && rec.lastActivityMs > (rec.snapshotAtMs ?? 0);

  const usableSnapshotId = (rec: StoredPorterScope | null): string | undefined =>
    rec?.snapshotId && rec.snapshotImage === image ? rec.snapshotId : undefined;

  async function captureSnapshot(scope: string, sb: PorterSandboxLike): Promise<void> {
    const before = await store.get(scope);
    const snap = await client.snapshots.create(sb.id);
    if (snap.status !== "ready") {
      throw new Error(
        `porter snapshot of ${sb.id} ${snap.status}${snap.failure_reason ? `: ${snap.failure_reason}` : ""}`,
      );
    }
    await remember(scope, {
      snapshotId: snap.id,
      snapshotImage: image,
      snapshotAtMs: snap.t_ready_unix_ms ?? Date.now(),
    });
    if (before?.snapshotId && before.snapshotId !== snap.id) {
      await client.snapshots
        .delete(before.snapshotId)
        .catch(swallowAs("porter-sandbox: drop superseded snapshot", undefined));
    }
  }

  async function retireScopeBody(scope: string, sb: PorterSandboxLike, drain: boolean): Promise<void> {
    if (sb.phase === "running" && snapshotDue(await store.get(scope))) {
      await captureSnapshot(scope, sb).catch((e) =>
        reportError("sandbox_snapshot", "porter_snapshot_failed", errMessage(e), scope),
      );
    }
    await retirePorterBody(sb, drain);
  }

  async function liveBody(slug: string, attachedTo: string[] = []): Promise<BodyEntry | null> {
    const cached = bodies.get(slug);
    if (cached) {
      await cached.sb.refresh().catch((e) => {
        bodies.delete(slug);
        if (!(e instanceof NotFoundError)) throw e;
      });
      if (bodies.has(slug) && cached.sb.phase === "running") return cached;
      bodies.delete(slug);
    }
    const attached = (await Promise.all(attachedTo.map((id) => porterSandboxById(client, id)))).filter(
      (b): b is PorterSandboxLike => b !== null,
    );
    const pick = (found: PorterSandboxLike[]) =>
      found.find((b) => b.phase === "running") ?? found.find((b) => b.phase === "creating" || b.phase === "queued");
    const live = pick(attached) ?? pick(await listPorterSandboxes(client, { [SCOPE_TAG]: slug }));
    if (!live) return null;
    const status = await live.refresh();
    await waitPorterRunning(status.name, live);
    const entry = { name: status.name, sb: live };
    bodies.set(slug, entry);
    noteBody(entry, status);
    return entry;
  }

  async function createBody(
    slug: string,
    egressMode: "proxy" | "open",
    volume?: PorterVolumeMount,
    kind: "scope" | "scratch" = "scope",
    snapshotId?: string,
  ): Promise<BodyEntry> {
    const name = bodyName(slug);
    const sb = await client.sandboxes
      .create({
        image: snapshotId ? "" : image,
        ...(snapshotId ? { snapshot_id: snapshotId } : {}),
        name,
        command: ["sleep", "infinity"],
        tags: { [SCOPE_TAG]: slug, [EGRESS_TAG]: egressMode, [KIND_TAG]: kind },
        ...(volume ? { volume_mounts: { [volume.mountPath]: volume.volumeId } } : {}),
        ...(egressMode === "proxy" && egressProxyHost ? { egress: { allowed_destinations: [egressProxyHost] } } : {}),
        ...(resources ? { resources } : {}),
        ttl_seconds: ttlSec,
      })
      .catch((e) => {
        if (errMessage(e).includes("egress restriction is not available")) {
          throw new Error(
            `porter sandbox ${name}: PORTER_SANDBOX_EGRESS_PROXY_URL is set but this cluster has egress restriction turned off, so Porter refuses to create the body at all — enable it on the cluster's sandbox-api system application or unset the proxy URL (docs/porter.md) (${errMessage(e)})`,
            { cause: e },
          );
        }
        throw e;
      });
    try {
      await waitPorterRunning(name, sb);
    } catch (e) {
      await sb.terminate().catch(swallowAs("porter-sandbox: abandon half-created body", undefined));
      throw e;
    }
    const entry = { name, sb };
    bodies.set(slug, entry);
    noteBody(entry);
    if (volume) volumeByBody.set(name, volume);
    return entry;
  }

  async function createScopeBody(
    scope: string,
    slug: string,
    egressMode: "proxy" | "open",
    volume: PorterVolumeMount,
  ): Promise<BodyEntry> {
    const snapshotId = usableSnapshotId(await store.get(scope));
    let ref: BodyEntry;
    if (snapshotId) {
      try {
        ref = await createBody(slug, egressMode, volume, "scope", snapshotId);
      } catch (e) {
        reportError("sandbox_provision", "porter_snapshot_unusable", errMessage(e), scope);
        await remember(scope, { snapshotId: undefined, snapshotImage: undefined, snapshotAtMs: undefined });
        ref = await createBody(slug, egressMode, volume);
      }
    } else {
      ref = await createBody(slug, egressMode, volume);
    }
    scopeByBody.set(ref.name, scope);
    await remember(scope, { sandboxId: ref.sb.id, name: ref.name, lastActivityMs: Date.now() });
    return ref;
  }

  async function ensureScopeBody(
    scope: string,
    egressMode: "proxy" | "open",
    onStatus?: (text: string) => void,
  ): Promise<{ name: string; coldStart: boolean }> {
    const slug = porterScopeSlug(prefix, scope);
    return provisionQueue(scope, () =>
      advisoryLock.withLock(`porter-provision:${scope}`, async () => {
        const volumeName = `${slug}-home`;
        let volume: { id: string; created: boolean; attachedTo: string[] };
        try {
          volume = await ensurePorterVolume(client, volumeName);
        } catch (e) {
          throw new Error(`porter volume ${volumeName}: ${errMessage(e)}`, { cause: e });
        }
        const existing = await liveBody(slug, volume.attachedTo);
        if (existing) {
          scopeByBody.set(existing.name, scope);
          await remember(scope, { sandboxId: existing.sb.id, name: existing.name, lastActivityMs: Date.now() });
          const wantProxy = egressMode === "proxy";
          const hasProxy = existing.sb.tags?.[EGRESS_TAG] === "proxy";
          if (!wantProxy || hasProxy) return { name: existing.name, coldStart: false };
          bodies.delete(slug);
          await retireScopeBody(scope, existing.sb, true);
        }
        try {
          onStatus?.("Starting your computer…");
        } catch (error) {
          void error;
        }
        const ref = await createScopeBody(scope, slug, egressMode, { mountPath: homeDir, volumeId: volume.id });
        return { name: ref.name, coldStart: volume.created };
      }),
    );
  }

  async function ensureScratch(
    key: string,
    egressMode: "proxy" | "open",
  ): Promise<{ name: string; coldStart: boolean }> {
    const slug = porterScopeSlug(`${prefix}-scratch-${egressMode}`, key);
    return provisionQueue(`scratch:${slug}`, async () => {
      const active = activeScratch.get(slug) ?? 0;
      if (active === 0) {
        const stale = await liveBody(slug);
        bodies.delete(slug);
        if (stale) await retirePorterBody(stale.sb, false);
        await createBody(slug, egressMode, undefined, "scratch");
      }
      const ref = bodies.get(slug);
      if (!ref) throw new Error(`porter scratch ${slug} vanished during provision`);
      scratchSlugByName.set(ref.name, slug);
      activeScratch.set(slug, active + 1);
      return { name: ref.name, coldStart: active === 0 };
    });
  }

  async function bodyByName(id: string): Promise<BodyEntry | null> {
    const cached = bodyCache.get(id);
    if (cached) return cached;
    const fetched = await client.sandboxes.get(id).catch((e) => {
      if (e instanceof NotFoundError) return null;
      throw e;
    });
    if (!fetched) return null;
    const entry = { name: id, sb: fetched };
    noteBody(entry, await fetched.refresh());
    return entry;
  }

  async function refFor(id: string): Promise<BodyEntry> {
    const entry = await bodyByName(id);
    if (!entry) throw new Error(`porter sandbox ${id} not found`);
    return entry;
  }

  const { execRaw, writeAbsBytes, readAbsBytes } = createPorterExec(
    client,
    async (id) => (await refFor(id)).sb.id,
    (id) => volumeByBody.get(id),
  );

  const profile: AgentComputerProfile = {
    backend: "porter",
    writablePersistence: "resident_disk",
    processSessions: true,
    egressEnforcement: opts.egressProxyUrl ? "domain" : "none",
    spec: {
      os: "Debian 12 container on Porter Sandboxes — $HOME persists on a volume; paths outside $HOME are carried across sandbox rotation by a filesystem snapshot taken before each rotation and during idle sweeps, so installs there made since the last sweep can be lost if the sandbox is killed by its lifetime cap",
      runtimes: ["Node 24", "Python 3"],
      get tools() {
        return visibleTools(["git", "curl", "wget", "jq", "unzip", "python3", "gh", "aws", ...(opts.extraTools ?? [])]);
      },
      get notInstalled() {
        return visibleNotInstalled(["gcloud", "kubectl", "flyctl", "glab"], opts.extraTools ?? []);
      },
      ...(opts.cpus !== undefined ? { cpus: opts.cpus } : {}),
      ...(opts.memoryMb !== undefined ? { memoryMb: opts.memoryMb } : {}),
      homeDir,
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
    label: "porter",
    exec: (id, script, t) => execRaw(id, script, t),
    writeInline: (id, abs, data) => writeAbsBytes(id, abs, data),
  });

  const blobStaging = createBackendBlobStaging("porter", (id, script, t) => execRaw(id, script, t), opts);

  const execExport = createExecExport({
    label: "porter",
    exec: (id, script, t) => execRaw(id, script, t),
    readAbsBytes,
    defaultHomeDir: homeDir,
    ephemeralCredentialPrefixes: ephemeralCredLinkPaths(opts.credentialPaths ?? []).map(({ rel }) => rel),
    archiveDir: () => exportScratchDir,
  });

  const handleFor = (name: string): SandboxHandle => ({ id: name, rootDir: workspaceDir, homeDir, coldStart: false });

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
      const forceEgress = !!egressProxyHost && !!provOpts?.egressToken;
      let name: string;
      let coldStart: boolean;
      if (scratch) {
        ({ name, coldStart } = await ensureScratch(scratch.key, forceEgress ? "proxy" : "open"));
      } else {
        ({ name, coldStart } = await ensureScopeBody(scope, forceEgress ? "proxy" : "open", provOpts?.onStatus));
      }

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
        homeDir,
        coldStart,
        ...(scratch ? { scratch: true } : {}),
        ...(Object.keys(env).length ? { env } : {}),
      };

      try {
        const credLinks = scratch ? "" : ` && ${ephemeralCredLinkScript(homeDir, opts.credentialPaths ?? [])}`;
        const prep = await execRaw(name, `mkdir -p ${shq(workspaceDir)}${credLinks}`, 60);
        if (prep.code !== 0)
          throw new Error(`porter provision prep failed: ${(prep.stderr || prep.stdout).slice(0, 200)}`);

        await materializeRoLayers(
          workspace,
          layers,
          handle,
          {
            readFile: (h, rel) => sandbox.readFile(h, rel),
            writeFileBytes: (h, rel, data) => sandbox.writeFileBytes(h, rel, data),
            exec: (script, t) => execRaw(name, script, t),
          },
          { manifest: RO_LAYERS_MANIFEST, tar: RO_LAYERS_TAR, label: "porter" },
        );

        return handle;
      } catch (err) {
        await sandbox.teardown(handle).catch(swallowAs("porter-sandbox: teardown after failed provision", undefined));
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
        execRaw(handle.id, killScript(killUid), 15).catch(swallowAs("porter-sandbox: kill in-flight exec", undefined));
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

    exportFiles: execExport.exportFiles,

    async computerStatus(scopeId: string): Promise<ComputerStatus> {
      const slug = porterScopeSlug(prefix, scopeId);
      const rec = await store.get(scopeId);
      const recovery: ComputerStatus["recovery"] = rec?.snapshotId
        ? {
            strategy: "provider_snapshot",
            checkpointId: rec.snapshotId,
            ...(rec.snapshotAtMs !== undefined ? { checkpointAtMs: rec.snapshotAtMs } : {}),
            checkpointExpiresAtMs: null,
          }
        : undefined;
      let machine = "no computer";
      let name: string | undefined;
      let expiresAtMs: number | undefined;
      let probeError: string | undefined;
      try {
        const found = await listPorterSandboxes(client, { [SCOPE_TAG]: slug });
        const live = found.find((b) => b.phase === "running") ?? found.find((b) => !porterPhaseSettled(b.phase));
        const last = rec?.sandboxId ? found.find((b) => b.id === rec.sandboxId) : undefined;
        if (live) {
          machine = live.phase ?? "unknown";
          if (machine === "running") {
            const status = await live.refresh();
            name = status.name;
            noteBody({ name, sb: live }, status);
            if (status.started_at) expiresAtMs = Date.parse(status.started_at) + ttlSec * 1000;
          }
        } else if (last?.phase === "failed") {
          machine = "failed";
          const lines = await last.logs({ limit: FAILED_BODY_LOG_LINES }).catch(() => []);
          const tail = lines.map((l) => l.line).join(" | ");
          probeError = `last body ${last.id} failed${tail ? `; last log: ${tail.slice(0, 300)}` : ""}`;
        }
      } catch (e) {
        machine = `check failed: ${errMessage(e)}`;
      }
      let guestResponsive = false;
      if (name) {
        try {
          guestResponsive = (await execRaw(name, "true", GUEST_PROBE_TIMEOUT_SEC)).code === 0;
        } catch (e) {
          probeError = errMessage(e);
        }
      }
      return {
        machine,
        guestResponsive,
        ...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
        ...(recovery ? { recovery } : {}),
        ...(probeError ? { probeError } : {}),
      };
    },

    async restartComputer(scopeId: string): Promise<void> {
      const slug = porterScopeSlug(prefix, scopeId);
      return provisionQueue(scopeId, () =>
        advisoryLock.withLock(`porter-provision:${scopeId}`, async () => {
          const found = await listPorterSandboxes(client, { [SCOPE_TAG]: slug });
          const live = found.filter((b) => !porterPhaseSettled(b.phase));
          const egressMode = live.some((b) => b.tags?.[EGRESS_TAG] === "proxy") ? "proxy" : "open";
          bodies.delete(slug);
          for (const b of live) await retireScopeBody(scopeId, b, true);
          const volume = await ensurePorterVolume(client, `${slug}-home`);
          await createScopeBody(scopeId, slug, egressMode, { mountPath: homeDir, volumeId: volume.id });
        }),
      );
    },

    async teardown(handle, tdOpts?: TeardownOptions): Promise<void> {
      if (handle.scratch) {
        const slug = scratchSlugByName.get(handle.id) ?? handle.id;
        return provisionQueue(`scratch:${slug}`, async () => {
          const remaining = (activeScratch.get(slug) ?? 1) - 1;
          if (remaining > 0) {
            activeScratch.set(slug, remaining);
            return;
          }
          activeScratch.delete(slug);
          const ref = bodies.get(slug) ?? (await bodyByName(handle.id));
          bodies.delete(slug);
          if (!ref) return;
          if (tdOpts?.destroy) await retirePorterBody(ref.sb, false);
          else await retirePorterBody(ref.sb, false).catch(swallowAs("porter-sandbox: scratch terminate", undefined));
        });
      }
      const scope = scopeByBody.get(handle.id) ?? handle.scopeId;
      if (!tdOpts?.destroy) {
        if (scope)
          await remember(scope, { lastActivityMs: Date.now() }).catch(
            swallowAs("porter-sandbox: note activity", undefined),
          );
        return;
      }
      return provisionQueue(scope ?? handle.id, async () => {
        const cachedSlug = scope ? porterScopeSlug(prefix, scope) : undefined;
        const ref = cachedSlug ? bodies.get(cachedSlug) : undefined;
        if (cachedSlug) bodies.delete(cachedSlug);
        try {
          const target = ref ?? (await bodyByName(handle.id));
          const slug = target?.sb.tags?.[SCOPE_TAG] ?? cachedSlug;
          if (target) await retirePorterBody(target.sb, true);
          if (slug) await client.volumes.delete(`${slug}-home`);
          if (scope) {
            const rec = await store.take(scope);
            if (rec?.snapshotId) await client.snapshots.delete(rec.snapshotId);
          }
        } catch (e) {
          reportError("sandbox_teardown", "porter_destroy_failed", errMessage(e), scope);
        }
      });
    },

    async reapDeepIdle(idleMs): Promise<{ reaped: number }> {
      if (!(idleMs > 0)) return { reaped: 0 };
      const cutoff = Date.now() - idleMs;
      let reaped = 0;
      for (const [scope, candidate] of await store.entries()) {
        if (candidate.orgId && candidate.orgId !== configOrgId()) continue;
        if (!candidate.sandboxId) continue;
        const slug = porterScopeSlug(prefix, scope);
        reaped += await provisionQueue(scope, () =>
          advisoryLock.withLock(`porter-provision:${scope}`, async (): Promise<number> => {
            const rec = await store.get(scope);
            if (!rec?.sandboxId || !rec.name || rec.sandboxId !== candidate.sandboxId) return 0;
            const idle = rec.lastActivityMs < cutoff;
            const due = snapshotDue(rec) && Date.now() - (rec.snapshotAtMs ?? 0) > snapshotIntervalMs;
            if (!idle && !due) return 0;
            try {
              const sb = await porterSandboxById(client, rec.sandboxId);
              if (sb?.phase !== "running") return 0;
              if (idle) {
                const live = await procSessions.listProcesses(handleFor(rec.name));
                if (live.some((p) => p.status.state === "running")) return 0;
                bodies.delete(slug);
                await retireScopeBody(scope, sb, false);
                return 1;
              }
              await captureSnapshot(scope, sb);
              return 0;
            } catch (e) {
              reportError(
                "sandbox_reap",
                idle ? "deep_idle_reap_failed" : "periodic_snapshot_failed",
                errMessage(e),
                scope,
              );
              return 0;
            }
          }),
        );
      }
      return { reaped };
    },
  };

  return sandbox;
}
