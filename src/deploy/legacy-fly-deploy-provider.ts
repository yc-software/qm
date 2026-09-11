import { pack } from "tar-stream";
import type { Deployment, DeploymentVersion } from "./deploy-store.ts";
import type { DeployEndpoint, DeployProvider, DeployReconcileInput } from "./deploy-provider.ts";
import { normalizeRelPath, readTree } from "./deploy-fs.ts";
import { swallow } from "../util/errors.ts";
import { sleep } from "../util/async.ts";
import { shq } from "../util/shell.ts";
import { DEPLOY_RELEASE_AUD, mintCapabilityToken } from "../auth/capability-token.ts";
import { CAPABILITY_HEADER } from "../api/contract.ts";
import { MAX_BLOB_BYTES, type BlobTransferStore } from "../persistence/blob-transfer.ts";

const APP_PORT = 8080;
const DATA_DIR = "/data";
const VOLUME_NAME = "qm_data";
const OWNER_KEY = "qm_deployment_id";
const VERSION_KEY = "qm_deployment_version";
const RELEASE_KEY = "qm_deployment_release";
const RELEASE_EXPIRY = Date.UTC(2100, 0, 1);
const MACHINE_WAIT_SLICE_SECONDS = 60;
const MACHINE_WAIT_ATTEMPTS = 5;

export interface FlyApp {
  name: string;
  organization?: { slug?: string };
}

export interface FlyVolume {
  id: string;
  name: string;
  state?: string;
  attached_machine_id?: string | null;
  region?: string;
}

export interface FlyMachine {
  id: string;
  instance_id?: string;
  state?: string;
  config?: FlyMachineConfig;
}

export interface FlyMachineConfig {
  image: string;
  env?: Record<string, string>;
  metadata?: Record<string, string>;
  [key: string]: unknown;
}

export interface FlyDeployApi {
  getApp(name: string): Promise<FlyApp | null>;
  createApp(name: string, org: string): Promise<void>;
  ensureFlycast(name: string): Promise<void>;
  listVolumes(name: string): Promise<FlyVolume[]>;
  createVolume(name: string, region: string): Promise<FlyVolume>;
  listMachines(name: string): Promise<FlyMachine[]>;
  createMachine(name: string, region: string, config: FlyMachineConfig): Promise<FlyMachine>;
  updateMachine(name: string, id: string, config: FlyMachineConfig): Promise<FlyMachine>;
  startMachine(name: string, id: string): Promise<void>;
  waitMachineStopped(name: string, id: string, instanceId: string): Promise<void>;
  waitMachine(name: string, id: string): Promise<void>;
  deleteMachine(name: string, id: string): Promise<void>;
}

export interface FlyDeployProviderOptions {
  token: string;
  org: string;
  region: string;
  image: string;
  appPrefix: string;
  apiBaseUrl: string;
  capabilitySecret: string;
  releaseStore: BlobTransferStore;
  api?: FlyDeployApi;
  fetchImpl?: typeof fetch;
  probe?: (endpoint: DeployEndpoint) => Promise<void>;
  readyTimeoutMs?: number;
  now?: () => number;
}

class FlyApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export function createFlyDeployApi(
  token: string,
  fetchImpl: typeof fetch = fetch,
  machinesBaseUrl = "https://api.machines.dev",
  graphqlUrl = "https://api.fly.io/graphql",
): FlyDeployApi {
  const authorization = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const response = await fetchImpl(`${machinesBaseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(70_000),
      headers: { authorization, "content-type": "application/json", ...init.headers },
    });
    const body = await response.text();
    if (!response.ok)
      throw new FlyApiError(
        `Fly API ${init.method ?? "GET"} ${path} failed (${response.status}): ${body.slice(0, 300)}`,
        response.status,
      );
    return body ? (JSON.parse(body) as T) : (undefined as T);
  };
  const graphql = async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
    const response = await fetchImpl(graphqlUrl, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const body = await response.text();
    if (!response.ok)
      throw new FlyApiError(`Fly GraphQL failed (${response.status}): ${body.slice(0, 300)}`, response.status);
    const parsed = JSON.parse(body) as { data?: T; errors?: Array<{ message?: string }> };
    if (parsed.errors?.length)
      throw new Error(`Fly GraphQL failed: ${parsed.errors.map((e) => e.message ?? "unknown error").join("; ")}`);
    if (!parsed.data) throw new Error("Fly GraphQL returned no data");
    return parsed.data;
  };
  return {
    async getApp(name) {
      try {
        return await request<FlyApp>(`/v1/apps/${encodeURIComponent(name)}`);
      } catch (error) {
        if (error instanceof FlyApiError && error.status === 404) return null;
        throw error;
      }
    },
    async createApp(name, org) {
      await request("/v1/apps", { method: "POST", body: JSON.stringify({ app_name: name, org_slug: org }) });
    },
    async ensureFlycast(name) {
      const query = `query ($appName: String!) { app(name: $appName) { ipAddresses { nodes { type } } } }`;
      const found = await graphql<{ app: { ipAddresses: { nodes: Array<{ type: string }> } } }>(query, {
        appName: name,
      });
      const publicTypes = found.app.ipAddresses.nodes.map((ip) => ip.type).filter((type) => type !== "private_v6");
      if (publicTypes.length) {
        throw new Error(`Fly app ${name} has public IP addresses (${publicTypes.join(", ")}); refusing deployment`);
      }
      if (found.app.ipAddresses.nodes.some((ip) => ip.type === "private_v6")) return;
      const mutation = `mutation ($input: AllocateIPAddressInput!) { allocateIpAddress(input: $input) { ipAddress { id } } }`;
      await graphql(mutation, { input: { appId: name, type: "private_v6", region: "" } });
    },
    listVolumes(name) {
      return request<FlyVolume[]>(`/v1/apps/${encodeURIComponent(name)}/volumes`);
    },
    createVolume(name, region) {
      return request<FlyVolume>(`/v1/apps/${encodeURIComponent(name)}/volumes`, {
        method: "POST",
        body: JSON.stringify({ name: VOLUME_NAME, region, size_gb: 1, auto_backup_enabled: true }),
      });
    },
    listMachines(name) {
      return request<FlyMachine[]>(`/v1/apps/${encodeURIComponent(name)}/machines`);
    },
    createMachine(name, region, config) {
      return request<FlyMachine>(`/v1/apps/${encodeURIComponent(name)}/machines`, {
        method: "POST",
        body: JSON.stringify({ region, config }),
      });
    },
    updateMachine(name, id, config) {
      return request<FlyMachine>(`/v1/apps/${encodeURIComponent(name)}/machines/${encodeURIComponent(id)}`, {
        method: "POST",
        body: JSON.stringify({ config, skip_launch: true }),
      });
    },
    async startMachine(name, id) {
      await request(`/v1/apps/${encodeURIComponent(name)}/machines/${encodeURIComponent(id)}/start`, {
        method: "POST",
      });
    },
    async waitMachineStopped(name, id, instanceId) {
      await request(
        `/v1/apps/${encodeURIComponent(name)}/machines/${encodeURIComponent(id)}` +
          `/wait?state=stopped&instance_id=${encodeURIComponent(instanceId)}&timeout=${MACHINE_WAIT_SLICE_SECONDS}`,
      );
    },
    async waitMachine(name, id) {
      const path =
        `/v1/apps/${encodeURIComponent(name)}/machines/${encodeURIComponent(id)}` +
        `/wait?state=started&timeout=${MACHINE_WAIT_SLICE_SECONDS}`;
      for (let attempt = 1; attempt <= MACHINE_WAIT_ATTEMPTS; attempt++) {
        try {
          await request(path);
          return;
        } catch (error) {
          if (!(error instanceof FlyApiError) || error.status !== 408 || attempt === MACHINE_WAIT_ATTEMPTS) throw error;
        }
      }
    },
    async deleteMachine(name, id) {
      await request(`/v1/apps/${encodeURIComponent(name)}/machines/${encodeURIComponent(id)}?force=true`, {
        method: "DELETE",
      });
    },
  };
}

async function tarBytes(files: Array<{ path: string; data: Uint8Array }>): Promise<Buffer | null> {
  if (!files.length) return null;
  const archive = pack();
  const chunks: Buffer[] = [];
  const complete = new Promise<Buffer>((resolve, reject) => {
    archive.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", reject);
  });
  for (const file of files) {
    await new Promise<void>((resolve, reject) => {
      archive.entry({ name: normalizeRelPath(file.path), mode: 0o600 }, Buffer.from(file.data), (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }
  archive.finalize();
  return complete;
}

function liveMachines(machines: FlyMachine[]): FlyMachine[] {
  return machines.filter((machine) => machine.state !== "destroyed" && machine.state !== "destroying");
}

export function createLegacyFlyDeployProvider(opts: FlyDeployProviderOptions): DeployProvider {
  const api = opts.api ?? createFlyDeployApi(opts.token, opts.fetchImpl);
  const readyTimeoutMs = opts.readyTimeoutMs ?? 60_000;
  const endpointFor = (name: string): DeployEndpoint => ({ host: `${name}.flycast`, port: 80 });
  const appName = (d: Deployment): string => {
    const suffix = d.id.replaceAll("-", "").slice(0, 16).toLowerCase();
    const name = `${opts.appPrefix}-${suffix}`;
    if (name.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)) {
      throw new Error(`invalid Fly deploy app name ${JSON.stringify(name)}; check FLY_DEPLOY_APP_PREFIX`);
    }
    return name;
  };
  const ensureConfigured = (): void => {
    if (!opts.token) throw new Error("FLY_DEPLOY_API_TOKEN not set (DEPLOY_PROVIDER=fly)");
    if (!opts.org) throw new Error("FLY_ORG not set (DEPLOY_PROVIDER=fly)");
    if (!opts.region) throw new Error("FLY_REGION not set (DEPLOY_PROVIDER=fly)");
    if (!opts.image) throw new Error("FLY_DEPLOY_BASE_IMAGE not set (DEPLOY_PROVIDER=fly)");
    if (!opts.apiBaseUrl) throw new Error("PUBLIC_API_URL not set (DEPLOY_PROVIDER=fly)");
    if (!opts.capabilitySecret) throw new Error("CAPABILITY_SECRET not set (DEPLOY_PROVIDER=fly)");
  };
  const ensureApp = async (name: string): Promise<void> => {
    let app = await api.getApp(name);
    if (!app) {
      try {
        await api.createApp(name, opts.org);
      } catch (error) {
        app = await api.getApp(name);
        if (!app) throw error;
      }
      app = await api.getApp(name);
    }
    if (!app) throw new Error(`Fly app ${name} was not found after creation`);
    if (app.organization?.slug !== opts.org) {
      throw new Error(
        `Fly app ${name} belongs to organization ${app.organization?.slug ?? "unknown"}, expected ${opts.org}`,
      );
    }
    await api.ensureFlycast(name);
  };
  const machineFor = async (name: string, deploymentId: string): Promise<FlyMachine | null> => {
    const machines = liveMachines(await api.listMachines(name));
    const owned = machines.filter((machine) => machine.config?.metadata?.[OWNER_KEY] === deploymentId);
    if (machines.length !== owned.length)
      throw new Error(`Fly app ${name} contains a Machine not owned by deployment ${deploymentId}`);
    if (owned.length > 1) throw new Error(`Fly app ${name} contains multiple Machines for deployment ${deploymentId}`);
    return owned[0] ?? null;
  };
  const volumeFor = async (name: string, machine: FlyMachine | null): Promise<FlyVolume> => {
    const volumes = (await api.listVolumes(name)).filter(
      (volume) => volume.name === VOLUME_NAME && volume.state !== "destroyed",
    );
    if (volumes.length > 1) throw new Error(`Fly app ${name} contains multiple ${VOLUME_NAME} volumes`);
    const volume = volumes[0] ?? (await api.createVolume(name, opts.region));
    if (volume.attached_machine_id && volume.attached_machine_id !== machine?.id) {
      throw new Error(`Fly app ${name} data volume is attached to unexpected Machine ${volume.attached_machine_id}`);
    }
    return volume;
  };
  const defaultProbe = async (endpoint: DeployEndpoint): Promise<void> => {
    const deadline = Date.now() + readyTimeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const remaining = Math.max(1, deadline - Date.now());
        const response = await (opts.fetchImpl ?? fetch)(`http://${endpoint.host}:${endpoint.port}/`, {
          signal: AbortSignal.timeout(Math.min(5_000, remaining)),
          redirect: "manual",
        });
        await response.body?.cancel();
        if (response.status === 502 || response.status === 503 || response.status === 504) {
          throw new Error(`Fly proxy returned ${response.status}`);
        }
        return;
      } catch (error) {
        lastError = error;
        await sleep(Math.min(500, Math.max(1, deadline - Date.now())));
      }
    }
    throw new Error(`Fly deployment did not become reachable within ${readyTimeoutMs}ms`, { cause: lastError });
  };
  const buildConfig = async (
    d: Deployment,
    version: DeploymentVersion,
    volume: FlyVolume,
    input?: DeployReconcileInput,
  ): Promise<{ config: FlyMachineConfig; blobId: string }> => {
    const home = version.homeDir
      ? (await readTree(version.homeDir, { tolerateMissing: true })).map((file) => ({
          path: `root/${normalizeRelPath(file.path)}`,
          data: file.data,
        }))
      : [];
    let payloadFiles: Array<{ path: string; data: Uint8Array }>;
    let materialize: string;
    if (input?.gitBundle && version.commit) {
      if (!/^[0-9a-f]{40}$/i.test(version.commit)) throw new Error(`invalid deploy commit: ${version.commit}`);
      payloadFiles = [
        { path: "bundle", data: input.gitBundle },
        ...home.map((file) => ({ ...file, path: file.path.replace(/^root\//, "home/") })),
      ];
      const ref = `refs/deploy-commits/${version.commit}`;
      materialize = [
        "rm -rf /app",
        "mkdir -p /app /root",
        `git -C /app init -q`,
        `git -C /app fetch -q /tmp/qm-release/bundle ${shq(ref)}`,
        "git -C /app checkout -q --detach FETCH_HEAD",
        "[ ! -d /tmp/qm-release/home ] || cp -a /tmp/qm-release/home/. /root/",
      ].join(" && ");
    } else {
      const app = (await readTree(version.snapshotDir, { tolerateMissing: true })).map((file) => ({
        path: `app/${normalizeRelPath(file.path)}`,
        data: file.data,
      }));
      payloadFiles = [...app, ...home.map((file) => ({ ...file, path: file.path.replace(/^root\//, "home/") }))];
      materialize = [
        "rm -rf /app",
        "mv /tmp/qm-release/app /app",
        "mkdir -p /root",
        "[ ! -d /tmp/qm-release/home ] || cp -a /tmp/qm-release/home/. /root/",
      ].join(" && ");
    }
    const archive = await tarBytes(payloadFiles);
    if (!archive) throw new Error("Fly deployment snapshot is empty");
    const blob = await opts.releaseStore.put(archive, { maxBytes: MAX_BLOB_BYTES });
    const token = await mintCapabilityToken(
      {
        actorId: d.createdBy,
        scopeId: d.ownerScopeId,
        aud: DEPLOY_RELEASE_AUD,
        blob: { dir: "read", id: blob.blobId },
        exp: Math.max((opts.now ?? Date.now)() + 1, RELEASE_EXPIRY),
      },
      opts.capabilitySecret,
    );
    const base = opts.apiBaseUrl.replace(/\/$/, "");
    const url = `${base}/v1/deploy-releases/${blob.blobId}`;
    const download = [
      `curl -fSsL -H ${shq(`${CAPABILITY_HEADER}: ${token}`)} ${shq(url)} -o /tmp/qm-release.tar`,
      "rm -rf /tmp/qm-release",
      "mkdir -p /tmp/qm-release",
      "tar -xf /tmp/qm-release.tar -C /tmp/qm-release",
    ].join(" && ");
    const start = `${download} && ${materialize} && cd /app && exec sh -c ${shq(version.entrypoint)}`;
    return {
      config: {
        image: opts.image,
        env: { ...version.env, HOME: "/root", PORT: String(APP_PORT), DATA_DIR },
        metadata: {
          [OWNER_KEY]: d.id,
          [VERSION_KEY]: String(version.version),
          [RELEASE_KEY]: blob.blobId,
          fly_process_group: "app",
        },
        init: { exec: ["/bin/sh", "-lc", start] },
        mounts: [{ volume: volume.id, path: DATA_DIR }],
        guest: { cpu_kind: "shared", cpus: 1, memory_mb: 512 },
        restart: { policy: "always" },
        services: [
          {
            protocol: "tcp",
            internal_port: APP_PORT,
            autostop: "stop",
            autostart: true,
            min_machines_running: 0,
            ports: [{ port: 80, handlers: ["http"] }],
          },
        ],
      },
      blobId: blob.blobId,
    };
  };
  const place = async (
    d: Deployment,
    version: DeploymentVersion,
    input?: DeployReconcileInput,
  ): Promise<DeployEndpoint> => {
    ensureConfigured();
    const name = appName(d);
    const app = await api.getApp(name);
    if (!app) await ensureApp(name);
    else if (app.organization?.slug !== opts.org)
      throw new Error(
        `Fly app ${name} belongs to organization ${app.organization?.slug ?? "unknown"}, expected ${opts.org}`,
      );
    const machine = await machineFor(name, d.id);
    if (app) await api.ensureFlycast(name);
    const volume = await volumeFor(name, machine);
    const { config, blobId } = await buildConfig(d, version, volume, input);
    let placed: FlyMachine | null = null;
    let completed = false;
    let discardFailedRelease = false;
    const updateAndStart = async (current: FlyMachine, nextConfig: FlyMachineConfig): Promise<FlyMachine> => {
      const updated = await api.updateMachine(name, current.id, nextConfig);
      if (!updated.instance_id) throw new Error(`Fly update for Machine ${updated.id} returned no instance_id`);
      await api.waitMachineStopped(name, updated.id, updated.instance_id);
      await api.startMachine(name, updated.id);
      await api.waitMachine(name, updated.id);
      return updated;
    };
    try {
      if (machine) {
        placed = await updateAndStart(machine, config);
      } else {
        placed = await api.createMachine(name, volume.region ?? opts.region, config);
        await api.waitMachine(name, placed.id);
      }
      const endpoint = endpointFor(name);
      await (opts.probe ?? defaultProbe)(endpoint);
      completed = true;
      const previousRelease = machine?.config?.metadata?.[RELEASE_KEY];
      if (previousRelease && previousRelease !== blobId) {
        await opts.releaseStore
          .delete(previousRelease)
          .catch((cleanupError: unknown) =>
            swallow("legacy fly deploy: previous release cleanup failed", cleanupError),
          );
      }
      return { ...endpoint, image: opts.image };
    } catch (error) {
      let recoveryError: unknown;
      if (machine?.config) {
        try {
          await updateAndStart(machine, machine.config);
          discardFailedRelease = true;
        } catch (rollbackError) {
          recoveryError = rollbackError;
        }
      } else if (!machine) {
        try {
          const accepted = placed ?? (await machineFor(name, d.id));
          if (accepted) await api.deleteMachine(name, accepted.id);
          discardFailedRelease = true;
        } catch (cleanupError) {
          recoveryError = cleanupError;
        }
      }
      if (recoveryError) {
        throw new AggregateError([error, recoveryError], "Fly deployment failed and recovery failed", { cause: error });
      }
      throw error;
    } finally {
      if (!completed && discardFailedRelease) {
        await opts.releaseStore
          .delete(blobId)
          .catch((cleanupError: unknown) => swallow("legacy fly deploy: failed release cleanup failed", cleanupError));
      }
    }
  };
  return {
    profile: { managedScaleToZero: true, inPlaceReconcile: true, dataDir: DATA_DIR },
    apply: (d, version) => place(d, version),
    reconcile: (d, version, input) => place(d, version, input),
    async resolveEndpoint(d): Promise<DeployEndpoint | null> {
      ensureConfigured();
      const name = appName(d);
      const app = await api.getApp(name);
      if (!app) return null;
      if (app.organization?.slug !== opts.org) return null;
      const machine = await machineFor(name, d.id);
      if (!machine) return null;
      const endpoint = endpointFor(name);
      if (d.alwaysOn) await (opts.probe ?? defaultProbe)(endpoint);
      return endpoint;
    },
    async destroy(d): Promise<void> {
      ensureConfigured();
      const name = appName(d);
      const app = await api.getApp(name);
      if (!app) return;
      if (app.organization?.slug !== opts.org)
        throw new Error(`Fly app ${name} is not owned by the configured organization`);
      const machine = await machineFor(name, d.id);
      if (machine) {
        await api.deleteMachine(name, machine.id);
        const release = machine.config?.metadata?.[RELEASE_KEY];
        if (release) {
          await opts.releaseStore
            .delete(release)
            .catch((cleanupError: unknown) =>
              swallow("legacy fly deploy: archived release cleanup failed", cleanupError),
            );
        }
      }
    },
  };
}
