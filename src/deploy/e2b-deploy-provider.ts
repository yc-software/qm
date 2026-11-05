import { randomUUID } from "node:crypto";
import { LRUCache } from "lru-cache";
import type { Deployment, DeploymentVersion } from "./deploy-store.ts";
import type { DeployEndpoint, DeployProvider } from "./deploy-provider.ts";
import {
  appEnv,
  appLaunch,
  appLogs,
  appReporter,
  bundleEntries,
  exportEnv,
  extractBundle,
  STOP_APP,
  waitAppReady,
  type AppErrorSink,
} from "./shared-deploy-provider.ts";
import { makeTar } from "../sandbox/tar.ts";
import { E2bSandboxGoneError, runE2bScript, type E2bClient, type E2bSession } from "../sandbox/e2b-client.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import { createKeyedQueue } from "../util/async.ts";
import { shq } from "../util/shell.ts";
import { execFailure, swallow } from "../util/errors.ts";

const HOME_DIR = "/home/user";
const APP_DIR = `${HOME_DIR}/app`;
const DATA_DIR = `${HOME_DIR}/data`;
const APP_PORT_DEFAULT = 8080;
const ENDPOINT_PORT = 443;
const READY_WINDOW_SEC_DEFAULT = 60;
export const E2B_DEPLOY_IDLE_TIMEOUT_SEC = 600;
const ALWAYS_ON_TIMEOUT_MS = 24 * 3600_000;
const RESOLVE_CACHE_MS_DEFAULT = 15_000;
const RESOLVE_CACHE_MAX = 500;
const DEPLOY_TAG = "qm-deploy";
const TRAFFIC_TOKEN_HEADER = "e2b-traffic-access-token";

export interface StoredE2bDeployBody {
  deploymentId: string;
  sandboxId: string;
  host: string;
  trafficAccessToken?: string;
  createdAtMs: number;
}

export interface E2bDeployProviderOptions {
  client: E2bClient;
  namePrefix?: string;
  appPort?: number;
  readyWindowSec?: number;
  idleTimeoutSec?: number;
  resolveCacheMs?: number;
  store: DurableMap<StoredE2bDeployBody>;
  advisoryLock: AdvisoryLock;
  onError?: AppErrorSink;
}

export function createE2bDeployProvider(opts: E2bDeployProviderOptions): DeployProvider {
  const client = opts.client;
  const prefix = opts.namePrefix ?? "qm";
  const appPort = opts.appPort ?? APP_PORT_DEFAULT;
  const readyWindowSec = opts.readyWindowSec ?? READY_WINDOW_SEC_DEFAULT;
  const idleTimeoutMs = (opts.idleTimeoutSec ?? E2B_DEPLOY_IDLE_TIMEOUT_SEC) * 1000;
  const resolveCacheMs = opts.resolveCacheMs ?? RESOLVE_CACHE_MS_DEFAULT;
  const store = opts.store;
  const advisoryLock = opts.advisoryLock;
  const queue = createKeyedQueue<string>();
  const resolveCache = new LRUCache<string, DeployEndpoint>({
    max: RESOLVE_CACHE_MAX,
    ttl: Math.max(1, resolveCacheMs),
  });

  const serialized = <T>(d: Deployment, fn: () => Promise<T>): Promise<T> =>
    queue(d.id, () => advisoryLock.withLock(`e2b-deploy:${d.id}`, fn));

  const endpointOf = (body: Pick<StoredE2bDeployBody, "host" | "trafficAccessToken">): DeployEndpoint => ({
    host: body.host,
    port: ENDPOINT_PORT,
    tls: true,
    ...(body.trafficAccessToken ? { proxyHeaders: { [TRAFFIC_TOKEN_HEADER]: body.trafficAccessToken } } : {}),
  });

  async function unpackTree(session: E2bSession, guestDir: string, dir: string): Promise<void> {
    const entries = await bundleEntries(dir);
    if (!entries.length) return;
    const tar = `${HOME_DIR}/.qm-bundle-${randomUUID()}.tar`;
    await session.writeFileBytes(tar, await makeTar(entries));
    const r = await runE2bScript(session, extractBundle(tar, guestDir), 120);
    if (r.code !== 0) throw execFailure(`e2b deploy: unpacking into ${guestDir}`, r);
  }

  async function install(d: Deployment, session: E2bSession, version: DeploymentVersion): Promise<void> {
    const stopped = await runE2bScript(
      session,
      `${STOP_APP}; rm -rf ${shq(APP_DIR)}; mkdir -p ${shq(APP_DIR)} ${shq(DATA_DIR)}`,
      60,
    );
    if (stopped.code !== 0) throw execFailure("e2b deploy: stopping the previous version", stopped);
    await unpackTree(session, APP_DIR, version.snapshotDir);
    if (version.homeDir) await unpackTree(session, HOME_DIR, version.homeDir);
    const env = appEnv(version.env, { HOME: HOME_DIR, PORT: String(appPort), DATA_DIR });
    const inner = `${exportEnv(env)}; cd ${shq(APP_DIR)}; ${version.entrypoint}`;
    const started = await runE2bScript(session, appLaunch(inner, appPort), 60);
    if (started.code !== 0) throw execFailure("e2b deploy: app start", started);
    await waitAppReady((script, timeoutSec) => runE2bScript(session, script, timeoutSec), {
      appPort,
      windowSec: readyWindowSec,
      report: appReporter(opts.onError, d, version.env),
    });
  }

  const forget = (d: Deployment): Promise<void> =>
    store.delete(d.id).catch((err) => swallow("e2b-deploy: drop dead body pointer", err));

  async function connectStored(d: Deployment): Promise<{ stored: StoredE2bDeployBody; session: E2bSession } | null> {
    const stored = await store.get(d.id);
    if (!stored) return null;
    try {
      return { stored, session: await client.connect(stored.sandboxId) };
    } catch (e) {
      if (!(e instanceof E2bSandboxGoneError)) throw e;
      await forget(d);
      return null;
    }
  }

  async function storedAlive(d: Deployment): Promise<StoredE2bDeployBody | null> {
    const stored = await store.get(d.id);
    if (!stored || !client.info) return stored;
    try {
      await client.info(stored.sandboxId);
      return stored;
    } catch (e) {
      if (!(e instanceof E2bSandboxGoneError)) throw e;
      await forget(d);
      return null;
    }
  }

  async function killStrays(d: Deployment, keep?: string): Promise<void> {
    for (const s of await client.list({ [DEPLOY_TAG]: d.id })) if (s.sandboxId !== keep) await client.kill(s.sandboxId);
  }

  return {
    profile: { managedScaleToZero: true, dataDir: DATA_DIR },

    apply: (d, version) =>
      serialized(d, async () => {
        resolveCache.delete(d.id);
        const existing = await connectStored(d);
        if (existing) {
          await install(d, existing.session, version);
          await killStrays(d, existing.stored.sandboxId);
          return endpointOf(existing.stored);
        }
        await killStrays(d);
        const session = await client.create({
          metadata: { name: `${prefix}-app-${d.id.slice(0, 12).toLowerCase()}`, [DEPLOY_TAG]: d.id },
          timeoutMs: d.alwaysOn ? ALWAYS_ON_TIMEOUT_MS : idleTimeoutMs,
          autoPause: true,
          autoResume: true,
        });
        try {
          await install(d, session, version);
          const body: StoredE2bDeployBody = {
            deploymentId: d.id,
            sandboxId: session.sandboxId,
            host: session.host(appPort),
            ...(session.trafficAccessToken ? { trafficAccessToken: session.trafficAccessToken } : {}),
            createdAtMs: Date.now(),
          };
          await store.put(d.id, body);
          return endpointOf(body);
        } catch (e) {
          await session.kill().catch((err) => swallow("e2b-deploy: abandon failed body", err));
          throw e;
        }
      }),

    async setAlwaysOn(d, alwaysOn): Promise<void> {
      if (alwaysOn) await (await connectStored(d))?.session.keepAlive(ALWAYS_ON_TIMEOUT_MS);
    },

    async resolveEndpoint(d): Promise<DeployEndpoint | null> {
      const cached = resolveCache.get(d.id);
      if (cached) return cached;
      const stored = await storedAlive(d);
      if (!stored) return null;
      const endpoint = endpointOf(stored);
      if (resolveCacheMs > 0) resolveCache.set(d.id, endpoint);
      return endpoint;
    },

    async logs(d, logOpts): Promise<string | null> {
      const live = await connectStored(d);
      if (!live) return null;
      return appLogs((script, timeoutSec) => runE2bScript(live.session, script, timeoutSec), logOpts.tailLines);
    },

    destroy: (d) =>
      serialized(d, async () => {
        resolveCache.delete(d.id);
        const stored = await store.get(d.id);
        if (stored) await client.kill(stored.sandboxId);
        await killStrays(d);
        await forget(d);
      }),
  };
}
