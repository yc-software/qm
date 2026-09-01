import { randomUUID } from "node:crypto";
import { LRUCache } from "lru-cache";
import { NotFoundError } from "porter-sandbox";
import type { Deployment, DeploymentVersion } from "./deploy-store.ts";
import type { DeployEndpoint, DeployProvider } from "./deploy-provider.ts";
import { waitAppReady, writeTree } from "./shared-deploy-provider.ts";
import {
  createPorterClient,
  createPorterExec,
  ensurePorterVolume,
  listPorterSandboxes,
  porterDnsLabel,
  porterPhaseSettled,
  retirePorterBody,
  waitPorterRunning,
  type PorterClientLike,
  type PorterSandboxLike,
} from "../sandbox/porter-client.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import { createNoopAdvisoryLock, type AdvisoryLock } from "../persistence/advisory-lock.ts";
import { createKeyedQueue } from "../util/async.ts";
import { shq } from "../util/shell.ts";
import { swallow } from "../util/errors.ts";

const APP_DIR = "/app";
const HOME_DIR = "/root";
const DATA_DIR = "/data";
const PID_PATH = "/tmp/qm-app.pid";
const LOG_PATH = "/tmp/qm-app.log";
const APP_PORT_DEFAULT = 8080;
const ENDPOINT_PORT = 443;
const APP_READY_WINDOW_SEC_DEFAULT = 60;
const APP_START_EXEC_TIMEOUT_SEC = 60;
const RESOLVE_CACHE_MS_DEFAULT = 15_000;
const RESOLVE_CACHE_MAX = 500;
const KIND_TAG = "qm-kind";
const DEPLOY_TAG = "qm-deploy";
const DEFAULT_RUNNER_IMAGE = "ghcr.io/porter-dev/qm-app-runner:latest";
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface StoredPorterDeployBody {
  deploymentId: string;
  sandboxId: string;
  name: string;
  host: string;
  createdAtMs: number;
}

export interface PorterDeployProviderOptions {
  appsDomain?: string;
  token?: string;
  baseUrl?: string;
  runnerImage?: string;
  visibility?: "public" | "private";
  namePrefix?: string;
  ttlSec?: number;
  appPort?: number;
  readyWindowSec?: number;
  resolveCacheMs?: number;
  client?: PorterClientLike;
  store?: DurableMap<StoredPorterDeployBody>;
  advisoryLock?: AdvisoryLock;
}

export function createPorterDeployProvider(opts: PorterDeployProviderOptions): DeployProvider {
  const appsDomain = opts.appsDomain;
  const image = opts.runnerImage ?? DEFAULT_RUNNER_IMAGE;
  const visibility = opts.visibility ?? "public";
  const prefix = opts.namePrefix ?? "qm";
  const appPort = opts.appPort ?? APP_PORT_DEFAULT;
  const readyWindowSec = opts.readyWindowSec ?? APP_READY_WINDOW_SEC_DEFAULT;
  const resolveCacheMs = opts.resolveCacheMs ?? RESOLVE_CACHE_MS_DEFAULT;
  const store = opts.store ?? createMemoryMap<StoredPorterDeployBody>();
  const advisoryLock = opts.advisoryLock ?? createNoopAdvisoryLock();
  const queue = createKeyedQueue<string>();
  const client: PorterClientLike =
    opts.client ??
    createPorterClient({
      ...(opts.token ? { token: opts.token } : {}),
      ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    });
  const { execRaw, writeAbsBytes } = createPorterExec(client, async (id) => id);
  const resolveCache = new LRUCache<string, DeployEndpoint>({
    max: RESOLVE_CACHE_MAX,
    ttl: Math.max(1, resolveCacheMs),
  });

  const baseName = (d: Deployment): string => `${prefix}-app-${d.id.slice(0, 12).toLowerCase()}`;
  const volumeName = (d: Deployment): string => `${baseName(d)}-data`;
  const domainOf = (d: Deployment): string | undefined =>
    appsDomain ? `${porterDnsLabel(d.name ?? d.id)}.${appsDomain}` : undefined;
  const endpointOf = (host: string): DeployEndpoint => ({
    host,
    port: ENDPOINT_PORT,
    tls: true,
    publicUrl: `https://${host}/`,
  });

  const serialized = <T>(d: Deployment, fn: () => Promise<T>): Promise<T> =>
    queue(d.id, () => advisoryLock.withLock(`porter-deploy:${d.id}`, fn));

  async function liveBodies(d: Deployment): Promise<PorterSandboxLike[]> {
    const found = await listPorterSandboxes(client, { [DEPLOY_TAG]: d.id });
    return found.filter((b) => !porterPhaseSettled(b.phase));
  }

  async function retireBodies(d: Deployment, drain: boolean): Promise<void> {
    for (const b of await liveBodies(d)) await retirePorterBody(b, drain);
  }

  function appEnv(version: DeploymentVersion): Record<string, string> {
    const declared = Object.fromEntries(Object.entries(version.env ?? {}).filter(([k]) => ENV_NAME.test(k)));
    return { ...declared, HOME: HOME_DIR, PORT: String(appPort), DATA_DIR };
  }

  async function materialize(sandboxId: string, version: DeploymentVersion): Promise<void> {
    const write = (abs: string, data: Uint8Array) => writeAbsBytes(sandboxId, abs, data);
    await writeTree(write, APP_DIR, version.snapshotDir);
    if (version.homeDir) await writeTree(write, HOME_DIR, version.homeDir);
  }

  async function startApp(sandboxId: string, version: DeploymentVersion): Promise<void> {
    const inner = `cd ${shq(APP_DIR)}; ${version.entrypoint}`;
    const launch = `sh -c ${shq(inner)} < /dev/null > ${shq(LOG_PATH)} 2>&1 & echo $! > ${shq(PID_PATH)}`;
    const script = [
      `mkdir -p ${shq(APP_DIR)} ${shq(DATA_DIR)}`,
      `export HOME=${shq(HOME_DIR)} PORT=${appPort} DATA_DIR=${shq(DATA_DIR)}`,
      `if command -v setsid >/dev/null 2>&1; then setsid ${launch}; else ${launch}; fi`,
    ].join("; ");
    const r = await execRaw(sandboxId, script, APP_START_EXEC_TIMEOUT_SEC);
    if (r.code !== 0) throw new Error(`porter deploy app start failed: ${r.stderr.slice(0, 300)}`);
    await waitAppReady((script, timeoutSec) => execRaw(sandboxId, script, timeoutSec), {
      appPort,
      windowSec: readyWindowSec,
      pidPath: PID_PATH,
      logPath: LOG_PATH,
    });
  }

  async function liveStored(d: Deployment): Promise<StoredPorterDeployBody | null> {
    const stored = await store.get(d.id);
    if (!stored) return null;
    const status = await client.sandboxes.raw.get(stored.sandboxId).catch((e) => {
      if (e instanceof NotFoundError) return null;
      throw e;
    });
    if (status?.phase === "running") return stored;
    await store.delete(d.id).catch((e) => swallow("porter-deploy: drop dead body pointer", e));
    return null;
  }

  return {
    profile: { managedScaleToZero: false, dataDir: DATA_DIR },

    apply: (d, version) =>
      serialized(d, async () => {
        resolveCache.delete(d.id);
        const { id: volumeId } = await ensurePorterVolume(client, volumeName(d));
        await retireBodies(d, true);
        await store.delete(d.id).catch((e) => swallow("porter-deploy: clear stale pointer", e));
        const name = `${baseName(d)}-${randomUUID().slice(0, 5)}`;
        const sb = await client.sandboxes.create({
          image,
          name,
          command: ["sleep", "infinity"],
          tags: { [KIND_TAG]: "app", [DEPLOY_TAG]: d.id },
          env: appEnv(version),
          volume_mounts: { [DATA_DIR]: volumeId },
          networking: [{ port: appPort, ...(domainOf(d) ? { domains: [{ domain: domainOf(d), visibility }] } : {}) }],
          ...(opts.ttlSec ? { ttl_seconds: opts.ttlSec } : {}),
        });
        try {
          await waitPorterRunning(name, sb);
          const host = (await sb.refresh()).host || domainOf(d);
          if (!host) {
            throw new Error(
              `porter deploy ${d.id}: the cluster assigned no hostname — it has no sandbox ingress configured; set PORTER_DEPLOY_APPS_DOMAIN or configure the cluster ingress`,
            );
          }
          await materialize(sb.id, version);
          await startApp(sb.id, version);
          await store.put(d.id, { deploymentId: d.id, sandboxId: sb.id, name, host, createdAtMs: Date.now() });
          return endpointOf(host);
        } catch (e) {
          await sb.terminate().catch((err) => swallow("porter-deploy: abandon failed body", err));
          throw e;
        }
      }),

    async resolveEndpoint(d): Promise<DeployEndpoint | null> {
      const cached = resolveCache.get(d.id);
      if (cached) return cached;
      const stored = await liveStored(d);
      if (!stored) {
        resolveCache.delete(d.id);
        return null;
      }
      const endpoint = endpointOf(stored.host);
      if (resolveCacheMs > 0) resolveCache.set(d.id, endpoint);
      return endpoint;
    },

    async logs(d, logOpts): Promise<string | null> {
      const stored = await liveStored(d);
      if (!stored) return null;
      const lines = Math.max(1, Math.min(2000, Math.floor(logOpts.tailLines)));
      const r = await execRaw(stored.sandboxId, `tail -n ${lines} ${shq(LOG_PATH)} 2>/dev/null || true`, 30);
      return r.stdout;
    },

    destroy: (d) =>
      serialized(d, async () => {
        resolveCache.delete(d.id);
        await retireBodies(d, false);
        await store.delete(d.id).catch((e) => swallow("porter-deploy: destroy clear pointer", e));
      }),
  };
}
