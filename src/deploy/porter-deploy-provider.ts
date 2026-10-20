import { randomUUID } from "node:crypto";
import { LRUCache } from "lru-cache";
import { NotFoundError } from "porter-sandbox";
import type { Deployment, DeploymentVersion } from "./deploy-store.ts";
import type { DeployEndpoint, DeployProvider } from "./deploy-provider.ts";
import {
  appEnv as declaredAppEnv,
  appGone,
  appLaunch,
  appLogs,
  appReporter,
  bundleEntries,
  extractBundle,
  waitAppReady,
  type AppErrorSink,
} from "./shared-deploy-provider.ts";
import { posixJoin } from "./deploy-fs.ts";
import { makeTar } from "../sandbox/tar.ts";
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
import { execFailure, swallow, swallowAs } from "../util/errors.ts";

const APP_DIR = "/app";
const HOME_DIR = "/root";
const DATA_DIR = "/data";
const APP_PORT_DEFAULT = 8080;
const ENDPOINT_PORT = 443;
const APP_READY_WINDOW_SEC_DEFAULT = 60;
const APP_START_EXEC_TIMEOUT_SEC = 60;
const BUNDLE_DIR = ".qm-bundle";
const BUNDLE_UPLOAD_TIMEOUT_MS = 600_000;
const BUNDLE_EXTRACT_TIMEOUT_SEC = 300;
const RESOLVE_CACHE_MS_DEFAULT = 15_000;
const RESOLVE_CACHE_MAX = 500;
const KIND_TAG = "qm-kind";
const DEPLOY_TAG = "qm-deploy";
const DEFAULT_RUNNER_IMAGE = "ghcr.io/porter-dev/qm-app-runner:latest";

export interface StoredPorterDeployBody {
  deploymentId: string;
  sandboxId: string;
  name: string;
  host: string;
  port?: number;
  createdAtMs: number;
}

export interface PorterDeployProviderOptions {
  appsDomain?: string;
  token?: string;
  baseUrl?: string;
  runnerImage?: string;
  visibility?: "public" | "private" | "internal";
  namePrefix?: string;
  ttlSec?: number;
  appPort?: number;
  readyWindowSec?: number;
  resolveCacheMs?: number;
  client?: PorterClientLike;
  store?: DurableMap<StoredPorterDeployBody>;
  advisoryLock?: AdvisoryLock;
  onError?: AppErrorSink;
}

export function createPorterDeployProvider(opts: PorterDeployProviderOptions): DeployProvider {
  const appsDomain = opts.appsDomain;
  const image = opts.runnerImage ?? DEFAULT_RUNNER_IMAGE;
  const visibility = opts.visibility ?? (appsDomain ? "private" : "internal");
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
    appsDomain && visibility !== "internal" ? `${porterDnsLabel(d.name ?? d.id)}.${appsDomain}` : undefined;
  const endpointOf = (body: { host: string; port?: number }): DeployEndpoint =>
    body.port
      ? { host: body.host, port: body.port }
      : { host: body.host, port: ENDPOINT_PORT, tls: true, publicUrl: `https://${body.host}/` };

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
    return declaredAppEnv(version.env, { HOME: HOME_DIR, PORT: String(appPort), DATA_DIR });
  }

  async function unpackTree(sandboxId: string, volumeId: string, guestDir: string, dir: string): Promise<void> {
    const entries = await bundleEntries(dir);
    if (!entries.length) return;
    const bundle = `${BUNDLE_DIR}/${randomUUID()}.tar`;
    const uploaded = await client.volumes.raw
      .writeFile(volumeId, await makeTar(entries), { path: `/${bundle}` }, { timeoutMs: BUNDLE_UPLOAD_TIMEOUT_MS })
      .then(() => true, swallowAs("porter-deploy: bundle upload failed, writing files one at a time", false));
    if (!uploaded) {
      for (const entry of entries) await writeAbsBytes(sandboxId, posixJoin(guestDir, entry.path), entry.data);
      return;
    }
    const guestBundle = posixJoin(DATA_DIR, bundle);
    const r = await execRaw(
      sandboxId,
      extractBundle(guestBundle, guestDir, `rmdir ${shq(posixJoin(DATA_DIR, BUNDLE_DIR))} 2>/dev/null`),
      BUNDLE_EXTRACT_TIMEOUT_SEC,
    );
    if (r.code !== 0) throw execFailure(`porter deploy: unpacking into ${guestDir}`, r);
  }

  async function materialize(sandboxId: string, volumeId: string, version: DeploymentVersion): Promise<void> {
    await unpackTree(sandboxId, volumeId, APP_DIR, version.snapshotDir);
    if (version.homeDir) await unpackTree(sandboxId, volumeId, HOME_DIR, version.homeDir);
  }

  async function startApp(d: Deployment, sandboxId: string, version: DeploymentVersion): Promise<void> {
    const inner = `cd ${shq(APP_DIR)}; ${version.entrypoint}`;
    const script = [
      `mkdir -p ${shq(APP_DIR)} ${shq(DATA_DIR)}`,
      `export HOME=${shq(HOME_DIR)} PORT=${appPort} DATA_DIR=${shq(DATA_DIR)}`,
      appLaunch(inner, appPort),
    ].join("; ");
    const r = await execRaw(sandboxId, script, APP_START_EXEC_TIMEOUT_SEC);
    if (r.code !== 0) throw execFailure("porter deploy app start", r);
    await waitAppReady((script, timeoutSec) => execRaw(sandboxId, script, timeoutSec), {
      appPort,
      windowSec: readyWindowSec,
      report: appReporter(opts.onError, d, version.env),
    });
  }

  async function addressOf(d: Deployment, sb: PorterSandboxLike): Promise<{ host: string; port?: number }> {
    const status = await sb.refresh();
    if (visibility === "internal") {
      const address = status.internal_address ?? "";
      const split = address.lastIndexOf(":");
      const port = Number(address.slice(split + 1));
      if (split <= 0 || !Number.isInteger(port) || port <= 0) {
        throw new Error(
          `porter deploy ${d.id}: the cluster reported no internal address for the app (${JSON.stringify(address)}) — internal visibility needs sandbox-api 0.1.58 or newer`,
        );
      }
      return { host: address.slice(0, split), port };
    }
    const host = status.host || domainOf(d);
    if (!host) {
      throw new Error(
        `porter deploy ${d.id}: the cluster named no host for the app — its sandbox ingress has no root domain, so set PORTER_DEPLOY_APPS_DOMAIN to a domain whose wildcard resolves to that ingress (docs/porter.md)`,
      );
    }
    return { host };
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
          networking:
            visibility === "internal"
              ? [{ port: appPort, internal: true }]
              : [{ port: appPort, ...(domainOf(d) ? { domains: [{ domain: domainOf(d), visibility }] } : {}) }],
          ...(opts.ttlSec ? { ttl_seconds: opts.ttlSec } : {}),
        });
        try {
          await waitPorterRunning(name, sb);
          const address = await addressOf(d, sb);
          await materialize(sb.id, volumeId, version);
          await startApp(d, sb.id, version);
          await store.put(d.id, { deploymentId: d.id, sandboxId: sb.id, name, ...address, createdAtMs: Date.now() });
          return endpointOf(address);
        } catch (e) {
          await sb.terminate().catch((err) => swallow("porter-deploy: abandon failed body", err));
          throw e;
        }
      }),

    async resolveEndpoint(d, version): Promise<DeployEndpoint | null> {
      const cached = resolveCache.get(d.id);
      if (cached) return cached;
      const stored = await liveStored(d);
      if (!stored) {
        resolveCache.delete(d.id);
        return null;
      }
      const exec = (script: string, timeoutSec: number) => execRaw(stored.sandboxId, script, timeoutSec);
      const report = appReporter(opts.onError, d, version.env);
      if (await appGone(exec, { appPort, report })) return null;
      const endpoint = endpointOf(stored);
      if (resolveCacheMs > 0) resolveCache.set(d.id, endpoint);
      return endpoint;
    },

    async logs(d, logOpts): Promise<string | null> {
      const stored = await liveStored(d);
      if (!stored) return null;
      return appLogs((script, timeoutSec) => execRaw(stored.sandboxId, script, timeoutSec), logOpts.tailLines);
    },

    destroy: (d) =>
      serialized(d, async () => {
        resolveCache.delete(d.id);
        await retireBodies(d, false);
        await store.delete(d.id).catch((e) => swallow("porter-deploy: destroy clear pointer", e));
      }),
  };
}
