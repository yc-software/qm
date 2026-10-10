import { randomUUID } from "node:crypto";
import { gzip as gzipCallback } from "node:zlib";
import { promisify } from "node:util";
import { LRUCache } from "lru-cache";
import type { Deployment, DeploymentVersion } from "./deploy-store.ts";
import type { DeployEndpoint, DeployProvider } from "./deploy-provider.ts";
import { normalizeRelPath, readTree } from "./deploy-fs.ts";
import { makeTar } from "../sandbox/tar.ts";
import {
  createAgent37Client,
  createAgent37FileWriter,
  AGENT37_GONE_STATES,
  type Agent37ExecResponse,
} from "../sandbox/agent37-client.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import { createNoopAdvisoryLock, type AdvisoryLock } from "../persistence/advisory-lock.ts";
import { createKeyedQueue } from "../util/async.ts";
import { shq } from "../util/shell.ts";
import { errMessage, swallow } from "../util/errors.ts";

const APP_DIR = "/app";
const gzip = promisify(gzipCallback);
const HOME_DIR = "/root";
const DATA_DIR = "/data";
const START_PATH = "/app/.qm-start.sh";
const LOG_PATH = "/tmp/qm-app.log";
const APP_PORT_DEFAULT = 3000;
const ENDPOINT_PORT = 443;
const APP_READY_WINDOW_SEC_DEFAULT = 60;
const EXTRACT_TIMEOUT_SEC = 300;
const RESOLVE_CACHE_MS_DEFAULT = 15_000;
const RESOLVE_CACHE_MAX = 500;
const CREATE_TIMEOUT_MS = 330_000;
const EXEC_TIMEOUT_MS = 300_000;
const DEFAULT_RUNNER_IMAGE = "docker.io/library/node:24-bookworm-slim";
const DEFAULT_RUNNER_TEMPLATE = "qm-app-runner";
const DEFAULT_CPUS = 2;
const DEFAULT_MEMORY_GB = 4;
const DEFAULT_DISK_GB = 4;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface Agent37Instance {
  id: string;
  name?: string | null;
  status: string;
  url?: string | null;
  public_ports?: Array<{ port: number; url: string }> | null;
  metadata?: Record<string, unknown>;
}

export interface StoredAgent37DeployBody {
  deploymentId: string;
  instanceId: string;
  name: string;
  host: string;
  createdAtMs: number;
}

export interface Agent37DeployProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  template?: string;
  runnerImage?: string;
  namePrefix?: string;
  cpus?: number;
  memoryGb?: number;
  diskGb?: number;
  autoSleep?: boolean;
  appPort?: number;
  readyWindowSec?: number;
  resolveCacheMs?: number;
  fetchImpl?: typeof fetch;
  store?: DurableMap<StoredAgent37DeployBody>;
  advisoryLock?: AdvisoryLock;
}

export function createAgent37DeployProvider(opts: Agent37DeployProviderOptions): DeployProvider {
  if (!opts.apiKey && !opts.fetchImpl) throw new Error("DEPLOY_PROVIDER=agent37 requires AGENT37_DEPLOY_API_KEY");
  const template = opts.template ?? DEFAULT_RUNNER_TEMPLATE;
  const runnerImage = opts.runnerImage ?? DEFAULT_RUNNER_IMAGE;
  const prefix = opts.namePrefix ?? "qm";
  const appPort = opts.appPort ?? APP_PORT_DEFAULT;
  const autoSleep = opts.autoSleep ?? true;
  const readyWindowSec = opts.readyWindowSec ?? APP_READY_WINDOW_SEC_DEFAULT;
  const resolveCacheMs = opts.resolveCacheMs ?? RESOLVE_CACHE_MS_DEFAULT;
  const resources = {
    cpu: opts.cpus ?? DEFAULT_CPUS,
    memory: opts.memoryGb ?? DEFAULT_MEMORY_GB,
    disk: opts.diskGb ?? DEFAULT_DISK_GB,
  };
  const store = opts.store ?? createMemoryMap<StoredAgent37DeployBody>();
  const advisoryLock = opts.advisoryLock ?? createNoopAdvisoryLock();
  const queue = createKeyedQueue<string>();
  const resolveCache = new LRUCache<string, DeployEndpoint>({
    max: RESOLVE_CACHE_MAX,
    ttl: Math.max(1, resolveCacheMs),
  });
  let templateReady = false;

  const { send, api, apiJson, fail, readExecResponse, ensureRunning } = createAgent37Client({
    ...opts,
    errorPrefix: "agent37 deploy",
  });
  const writeFile = createAgent37FileWriter(exec, "agent37 deploy");

  const baseName = (d: Deployment): string => `${prefix}-app-${d.id.slice(0, 12).toLowerCase()}`;

  async function ensureTemplate(): Promise<void> {
    if (templateReady) return;
    const existing = await api("GET", `/v1/templates/${encodeURIComponent(template)}`);
    if (existing.ok) {
      templateReady = true;
      return;
    }
    if (existing.status !== 404) throw await fail(`get template ${template}`, existing);
    const created = await send(
      "POST",
      "/v1/templates",
      {
        name: template,
        image_ref: runnerImage,
        description: "qm published apps",
        default_port: null,
        entrypoint: [
          "/bin/sh",
          "-c",
          `while [ ! -x ${START_PATH} ]; do sleep 1; done; exec ${START_PATH} > ${LOG_PATH} 2>&1`,
        ],
      },
      CREATE_TIMEOUT_MS,
    );
    if (!created.ok && created.status !== 409) throw await fail(`create template ${template}`, created);
    templateReady = true;
  }

  async function exec(instanceId: string, script: string, timeoutSec: number): Promise<Agent37ExecResponse> {
    const res = await send(
      "POST",
      `/v1/instances/${encodeURIComponent(instanceId)}/exec`,
      { command: script },
      Math.min(EXEC_TIMEOUT_MS, timeoutSec * 1000 + 60_000),
    );
    return readExecResponse(instanceId, res);
  }

  async function unpackTree(instanceId: string, guestDir: string, dir: string): Promise<void> {
    const files = await readTree(dir);
    const entries = files.map((f) => ({ path: normalizeRelPath(f.path), data: f.data }));
    if (!entries.length) return;
    const bundle = `/tmp/qm-bundle-${randomUUID().slice(0, 8)}.tgz`;
    await writeFile(instanceId, bundle, await gzip(await makeTar(entries)));
    const r = await exec(
      instanceId,
      `mkdir -p ${shq(guestDir)} && tar -xzmf ${shq(bundle)} -C ${shq(guestDir)}; rc=$?; rm -f ${shq(bundle)}; exit $rc`,
      EXTRACT_TIMEOUT_SEC,
    );
    if (r.exit_code !== 0) {
      throw new Error(`agent37 deploy: unpacking into ${guestDir} failed: ${(r.stderr || r.stdout).slice(0, 300)}`);
    }
  }

  function appEnv(version: DeploymentVersion): Record<string, string> {
    const declared = Object.fromEntries(Object.entries(version.env ?? {}).filter(([k]) => ENV_NAME.test(k)));
    return { ...declared, HOME: HOME_DIR, PORT: String(appPort), DATA_DIR };
  }

  function startScript(version: DeploymentVersion): string {
    const exports = Object.entries(appEnv(version))
      .map(([k, v]) => `export ${k}=${shq(v)}`)
      .join("\n");
    return `#!/bin/sh\nset -e\n${exports}\ncd "$(dirname "$0")"\nexec sh -lc ${shq(version.entrypoint)}\n`;
  }

  async function installStartScript(instanceId: string, version: DeploymentVersion): Promise<void> {
    await writeFile(instanceId, START_PATH, Buffer.from(startScript(version), "utf8"));
    const result = await exec(instanceId, `chmod 0755 ${shq(START_PATH)}`, 60);
    if (result.exit_code !== 0) throw new Error(`agent37 deploy: ${result.stderr || result.stdout}`);
  }

  async function waitReady(instanceId: string): Promise<void> {
    const probe = `const http = require('node:http');
setTimeout(() => process.exit(1), ${readyWindowSec * 1000});
function check() {
  const request = http.get('http://127.0.0.1:${appPort}/', () => process.exit(0));
  request.setTimeout(2000, () => request.destroy());
  request.on('error', () => setTimeout(check, 500));
}
check();`;
    const result = await exec(instanceId, `node -e ${shq(probe)}`, readyWindowSec + 5);
    if (result.exit_code === 0) return;
    const logs = await exec(instanceId, `tail -c 2000 ${shq(LOG_PATH)}`, 30)
      .then((out) => out.stdout || out.stderr)
      .catch((error) => `could not read app logs: ${errMessage(error)}`);
    throw new Error(`agent37 deploy: app did not listen on port ${appPort}: ${result.stderr} ${logs}`);
  }

  function hostOf(info: Agent37Instance): string {
    const port = info.public_ports?.find((p) => p.port === appPort)?.url;
    const url = port ?? info.url ?? "";
    if (!url) throw new Error(`agent37 deploy ${info.id}: the API named no URL for the app`);
    return new URL(url).hostname;
  }

  const endpointOf = (host: string): DeployEndpoint => ({
    host,
    port: ENDPOINT_PORT,
    tls: true,
    publicUrl: `https://${host}/`,
  });

  const serialized = <T>(d: Deployment, fn: () => Promise<T>): Promise<T> =>
    queue(d.id, () => advisoryLock.withLock(`agent37-deploy:${d.id}`, fn));

  async function liveStored(d: Deployment): Promise<StoredAgent37DeployBody | null> {
    const stored = await store.get(d.id);
    if (!stored) {
      const instances = await apiJson<{ data: Agent37Instance[] }>("GET", "/v1/instances");
      const found = instances.data.find(
        (i) => i.metadata?.qm_deployment_id === d.id && !AGENT37_GONE_STATES.has(i.status),
      );
      if (!found) return null;
      const recovered = {
        deploymentId: d.id,
        instanceId: found.id,
        name: found.name ?? "",
        host: hostOf(found),
        createdAtMs: Date.now(),
      };
      await store.put(d.id, recovered);
      return recovered;
    }
    const res = await api("GET", `/v1/instances/${encodeURIComponent(stored.instanceId)}`);
    if (res.ok) {
      const info = (await res.json()) as Agent37Instance;
      if (!AGENT37_GONE_STATES.has(info.status)) return stored;
    } else if (res.status !== 404) {
      throw await fail(`get ${stored.instanceId}`, res);
    }
    await store.delete(d.id);
    return null;
  }

  async function deleteInstance(instanceId: string): Promise<void> {
    const res = await api("DELETE", `/v1/instances/${encodeURIComponent(instanceId)}`, undefined, 120_000);
    if (!res.ok && res.status !== 404) throw await fail(`delete ${instanceId}`, res);
  }

  return {
    profile: { managedScaleToZero: true, dataDir: DATA_DIR },

    apply: (d, version) =>
      serialized(d, async () => {
        resolveCache.delete(d.id);
        await ensureTemplate();
        let stored = await liveStored(d);
        const fresh = !stored;
        if (!stored) {
          const name = `${baseName(d)}-${randomUUID().slice(0, 5)}`;
          const res = await send(
            "POST",
            "/v1/instances",
            {
              template,
              name,
              resources,
              auto_sleep: false,
              public_ports: [{ port: appPort }],
              metadata: { qm_deployment_id: d.id },
            },
            CREATE_TIMEOUT_MS,
          );
          if (!res.ok) throw await fail(`create ${name}`, res);
          const created = (await res.json()) as Agent37Instance;
          stored = { deploymentId: d.id, instanceId: created.id, name, host: hostOf(created), createdAtMs: Date.now() };
          await store.put(d.id, stored);
        }
        const { instanceId, host } = stored;
        try {
          await ensureRunning(instanceId);
          const prepared = await exec(
            instanceId,
            `rm -rf ${shq(APP_DIR)} && mkdir -p ${shq(APP_DIR)} ${shq(DATA_DIR)}`,
            60,
          );
          if (prepared.exit_code !== 0)
            throw new Error(`agent37 deploy prepare: ${prepared.stderr || prepared.stdout}`);
          await unpackTree(instanceId, APP_DIR, version.snapshotDir);
          if (version.homeDir) await unpackTree(instanceId, HOME_DIR, version.homeDir);
          await installStartScript(instanceId, version);
          if (!fresh) {
            const restarted = await api(
              "POST",
              `/v1/instances/${encodeURIComponent(instanceId)}/restart`,
              undefined,
              CREATE_TIMEOUT_MS,
            );
            if (!restarted.ok) throw await fail(`restart ${instanceId}`, restarted);
            await ensureRunning(instanceId);
          }
          await waitReady(instanceId);
          const configured = await api("PATCH", `/v1/instances/${encodeURIComponent(instanceId)}`, {
            auto_sleep: d.alwaysOn ? false : autoSleep,
          });
          if (!configured.ok) throw await fail(`set auto_sleep ${instanceId}`, configured);
          return endpointOf(host);
        } catch (e) {
          if (fresh) {
            await deleteInstance(instanceId)
              .then(() => store.delete(d.id))
              .catch((err) => swallow("agent37-deploy: abandon failed body", err));
          }
          throw e;
        }
      }),

    async setAlwaysOn(d, alwaysOn): Promise<void> {
      const stored = await liveStored(d);
      if (!stored) return;
      const res = await api("PATCH", `/v1/instances/${encodeURIComponent(stored.instanceId)}`, {
        auto_sleep: alwaysOn ? false : autoSleep,
      });
      if (!res.ok) throw await fail(`set auto_sleep ${stored.instanceId}`, res);
    },

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
      const r = await exec(stored.instanceId, `tail -n ${lines} ${shq(LOG_PATH)}`, 30);
      if (r.exit_code !== 0) throw new Error(`agent37 deploy logs: ${r.stderr || r.stdout}`);
      return r.stdout;
    },

    destroy: (d) =>
      serialized(d, async () => {
        resolveCache.delete(d.id);
        const stored = await liveStored(d);
        if (!stored) return;
        await deleteInstance(stored.instanceId).catch((e) => {
          throw new Error(`agent37 deploy destroy ${d.id}: ${errMessage(e)}`, { cause: e });
        });
        await store.delete(d.id);
      }),
  };
}
