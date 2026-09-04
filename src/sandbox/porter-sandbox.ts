import { randomUUID } from "node:crypto";
import { NotFoundError } from "porter-sandbox";
import type { WorkspaceLayer } from "../types.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { createNoopAdvisoryLock, type AdvisoryLock } from "../persistence/advisory-lock.ts";
import { createKeyedQueue } from "../util/async.ts";
import { swallowAs, errMessage } from "../util/errors.ts";
import {
  createPorterClient,
  createPorterExec,
  ensurePorterVolume,
  listPorterSandboxes,
  porterPhaseSettled,
  porterSlug,
  retirePorterBody,
  waitPorterRunning,
  type PorterClientLike,
  type PorterSandboxLike,
} from "./porter-client.ts";
import { shq } from "../util/shell.ts";
import {
  nonInteractiveShellPrefix,
  DROPPED_PROXY_ENV,
  forceThroughProxyEnv,
  proxyExportPrefix,
} from "./sandbox-env.ts";
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
import { BLOB_TRANSFER_AUD, mintCapabilityToken } from "../auth/capability-token.ts";
import type { BlobTransferStore } from "../persistence/blob-transfer.ts";
import { CAPABILITY_HEADER } from "../api/contract.ts";
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
const RO_LAYERS_TAR = ".ro-layers.tar";
const RO_LAYERS_MANIFEST = ".ro-layers.manifest";
const GUEST_PROBE_TIMEOUT_SEC = 10;
const EGRESS_TAG = "qm-egress";
const SCOPE_TAG = "qm-scope";
const KIND_TAG = "qm-kind";
const DEFAULT_PORTER_SANDBOX_IMAGE = "ghcr.io/porter-dev/qm-sandbox:latest";

interface BodyEntry {
  name: string;
  sb: PorterSandboxLike;
}

export interface PorterSandboxOptions {
  image?: string;
  token?: string;
  baseUrl?: string;
  namePrefix?: string;
  homeDir?: string;
  ttlSec?: number;
  defaultTimeoutSec?: number;
  egressProxyUrl?: string;
  blobTransfer?: BlobTransferStore;
  signingSecret?: string;
  capabilitySecret?: string;
  apiBaseUrl?: string;
  extraTools?: string[];
  credentialPaths?: CredentialPathSpec[];
  advisoryLock?: AdvisoryLock;
  client?: PorterClientLike;
  onError?: (e: { category: string; code: string; message: string; scopeLabel?: string }) => void;
}

export const porterScopeSlug = porterSlug;

const bodyName = (slug: string): string => `${slug}-${randomUUID().slice(0, 5)}`;

export function createPorterSandbox(workspace: WorkspaceStore, opts: PorterSandboxOptions = {}): Sandbox {
  const image = opts.image ?? DEFAULT_PORTER_SANDBOX_IMAGE;
  const prefix = opts.namePrefix ?? "qm";
  const homeDir = opts.homeDir ?? "/root";
  const ttlSec = opts.ttlSec ?? 28_800;
  const defaultTimeoutSec = opts.defaultTimeoutSec ?? 600;
  const workspaceDir = `${homeDir}/${WORKSPACE_BASENAME}`;
  const provisionQueue = createKeyedQueue<string>();
  const advisoryLock = opts.advisoryLock ?? createNoopAdvisoryLock();
  const egressProxyHost = opts.egressProxyUrl ? new URL(opts.egressProxyUrl).hostname : undefined;

  const client: PorterClientLike =
    opts.client ??
    createPorterClient({
      ...(opts.token ? { token: opts.token } : {}),
      ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    });

  const bodies = new Map<string, BodyEntry>();
  const scopeByBody = new Map<string, string>();
  const scratchSlugByName = new Map<string, string>();
  const activeScratch = new Map<string, number>();

  async function liveBody(slug: string): Promise<BodyEntry | null> {
    const cached = bodies.get(slug);
    if (cached) {
      await cached.sb.refresh().catch((e) => {
        bodies.delete(slug);
        if (!(e instanceof NotFoundError)) throw e;
      });
      if (bodies.has(slug) && cached.sb.phase === "running") return cached;
      bodies.delete(slug);
    }
    const found = await listPorterSandboxes(client, { [SCOPE_TAG]: slug });
    const live =
      found.find((b) => b.phase === "running") ?? found.find((b) => b.phase === "creating" || b.phase === "queued");
    if (!live) return null;
    const name = (await live.refresh()).name;
    await waitPorterRunning(name, live);
    const entry = { name, sb: live };
    bodies.set(slug, entry);
    return entry;
  }

  async function createBody(
    slug: string,
    egressMode: "proxy" | "open",
    volume?: { mountPath: string; id: string },
    kind: "scope" | "scratch" = "scope",
  ): Promise<BodyEntry> {
    const name = bodyName(slug);
    const sb = await client.sandboxes
      .create({
        image,
        name,
        command: ["sleep", "infinity"],
        tags: { [SCOPE_TAG]: slug, [EGRESS_TAG]: egressMode, [KIND_TAG]: kind },
        ...(volume ? { volume_mounts: { [volume.mountPath]: volume.id } } : {}),
        ...(egressMode === "proxy" && egressProxyHost ? { egress: { allowed_destinations: [egressProxyHost] } } : {}),
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
    return entry;
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
        let volume: { id: string; created: boolean };
        try {
          volume = await ensurePorterVolume(client, volumeName);
        } catch (e) {
          throw new Error(`porter volume ${volumeName}: ${errMessage(e)}`, { cause: e });
        }
        const existing = await liveBody(slug);
        if (existing) {
          const wantProxy = egressMode === "proxy";
          const hasProxy = existing.sb.tags?.[EGRESS_TAG] === "proxy";
          if (!wantProxy || hasProxy) {
            scopeByBody.set(existing.name, scope);
            return { name: existing.name, coldStart: false };
          }
          bodies.delete(slug);
          await retirePorterBody(existing.sb, true);
        }
        try {
          onStatus?.("Starting your computer…");
        } catch (error) {
          void error;
        }
        const ref = await createBody(slug, egressMode, { mountPath: homeDir, id: volume.id });
        scopeByBody.set(ref.name, scope);
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

  async function refFor(id: string): Promise<BodyEntry> {
    for (const entry of bodies.values()) if (entry.name === id) return entry;
    const fetched = await client.sandboxes.get(id).catch((e) => {
      if (e instanceof NotFoundError) return null;
      throw e;
    });
    if (!fetched) throw new Error(`porter sandbox ${id} not found`);
    return { name: id, sb: fetched };
  }

  const { execRaw, writeAbsBytes, readAbsBytes } = createPorterExec(client, async (id) => (await refFor(id)).sb.id);

  const profile: AgentComputerProfile = {
    backend: "porter",
    writablePersistence: "resident_disk",
    processSessions: true,
    egressEnforcement: opts.egressProxyUrl ? "domain" : "none",
    spec: {
      os: "Debian 12 container on Porter Sandboxes — $HOME persists on a volume; paths outside $HOME reset when the sandbox rotates",
      runtimes: ["Node 24", "Python 3"],
      get tools() {
        return visibleTools(["git", "curl", "wget", "jq", "unzip", "python3", "gh", "aws", ...(opts.extraTools ?? [])]);
      },
      get notInstalled() {
        return visibleNotInstalled(["gcloud", "kubectl", "flyctl", "glab"], opts.extraTools ?? []);
      },
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

  const blobSigningSecret = opts.capabilitySecret ?? opts.signingSecret;
  const blobStaging =
    opts.blobTransfer && blobSigningSecret && opts.apiBaseUrl
      ? createExecBlobStaging({
          label: "porter",
          exec: (id, script, t) => execRaw(id, script, t),
          proxyPrefix: proxyExportPrefix,
          apiBaseUrl: opts.apiBaseUrl,
          capabilityHeader: CAPABILITY_HEADER,
          mintToken: (grant) =>
            mintCapabilityToken(
              {
                actorId: "porter-sandbox",
                aud: BLOB_TRANSFER_AUD,
                scopeId: "personal:porter-sandbox",
                blob: grant,
                exp: Date.now() + BLOB_TRANSFER_TTL_MS,
              },
              blobSigningSecret,
            ),
        })
      : null;

  const execBackup = createExecBackup({
    label: "porter",
    exec: (id, script, t) => execRaw(id, script, t),
    readAbsBytes,
    defaultHomeDir: homeDir,
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

    backupComputer: execBackup.backupComputer,

    async computerStatus(scopeId: string): Promise<ComputerStatus> {
      const slug = porterScopeSlug(prefix, scopeId);
      let machine = "no computer";
      let name: string | undefined;
      try {
        const found = await listPorterSandboxes(client, { [SCOPE_TAG]: slug });
        const live = found.find((b) => b.phase === "running") ?? found.find((b) => !porterPhaseSettled(b.phase));
        if (live) {
          machine = live.phase ?? "unknown";
          if (machine === "running") name = (await live.refresh()).name;
        }
      } catch (e) {
        machine = `check failed: ${errMessage(e)}`;
      }
      let guestResponsive = false;
      if (name) {
        try {
          guestResponsive = (await execRaw(name, "true", GUEST_PROBE_TIMEOUT_SEC)).code === 0;
        } catch (e) {
          void e;
        }
      }
      return { machine, guestResponsive };
    },

    async restartComputer(scopeId: string): Promise<void> {
      const slug = porterScopeSlug(prefix, scopeId);
      return provisionQueue(scopeId, () =>
        advisoryLock.withLock(`porter-provision:${scopeId}`, async () => {
          const found = await listPorterSandboxes(client, { [SCOPE_TAG]: slug });
          const live = found.filter((b) => !porterPhaseSettled(b.phase));
          const egressMode = live.some((b) => b.tags?.[EGRESS_TAG] === "proxy") ? "proxy" : "open";
          bodies.delete(slug);
          for (const b of live) await retirePorterBody(b, true);
          const volume = await ensurePorterVolume(client, `${slug}-home`);
          const ref = await createBody(slug, egressMode, { mountPath: homeDir, id: volume.id });
          scopeByBody.set(ref.name, scopeId);
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
          const ref = bodies.get(slug);
          bodies.delete(slug);
          const target =
            ref?.sb ??
            (await client.sandboxes.get(handle.id).catch((e) => {
              if (e instanceof NotFoundError) return null;
              throw e;
            }));
          if (!target) return;
          if (tdOpts?.destroy) await retirePorterBody(target, false);
          else await retirePorterBody(target, false).catch(swallowAs("porter-sandbox: scratch terminate", undefined));
        });
      }
      if (!tdOpts?.destroy) return;
      const scope = scopeByBody.get(handle.id) ?? handle.scopeId;
      return provisionQueue(scope ?? handle.id, async () => {
        const cachedSlug = scope ? porterScopeSlug(prefix, scope) : undefined;
        const ref = cachedSlug ? bodies.get(cachedSlug) : undefined;
        if (cachedSlug) bodies.delete(cachedSlug);
        try {
          const target =
            ref?.sb ??
            (await client.sandboxes.get(handle.id).catch((e) => {
              if (e instanceof NotFoundError) return null;
              throw e;
            }));
          const slug = target?.tags?.[SCOPE_TAG] ?? cachedSlug;
          if (target) await retirePorterBody(target, true);
          if (slug) await client.volumes.delete(`${slug}-home`);
        } catch (e) {
          opts.onError?.({
            category: "sandbox_teardown",
            code: "porter_destroy_failed",
            message: errMessage(e),
            ...(scope ? { scopeLabel: scope } : {}),
          });
        }
      });
    },
  };

  return sandbox;
}
