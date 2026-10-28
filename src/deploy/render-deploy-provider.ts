import { createHmac, randomBytes } from "node:crypto";
import { LRUCache } from "lru-cache";
import type { DurableMap } from "../persistence/durable-map.ts";
import { createNoopAdvisoryLock, type AdvisoryLock } from "../persistence/advisory-lock.ts";
import { createKeyedQueue, sleep } from "../util/async.ts";
import { swallow } from "../util/errors.ts";
import type { DeployProvider } from "./deploy-provider.ts";
import type { Deployment, DeploymentVersion, DeployEndpoint } from "./deploy-store.ts";
import type { RenderDeployArtifacts } from "./render-deploy-artifacts.ts";
import { createRenderApi, list, RenderApiError } from "./render-api.ts";
import { createRenderAppNetwork } from "./render-app-network.ts";
import { appEnv } from "./shared-deploy-provider.ts";

const FAILED = new Set(["build_failed", "update_failed", "pre_deploy_failed", "canceled", "deactivated"]);
const OWNER_MARKER = "QM_DEPLOYMENT_ID";
const RENDER_APP_AUTH_HEADER = "x-qm-render-app-token";
const GATEWAY_TOKEN_TTL_MS = 30 * 60_000;
const GATEWAY_TOKEN_STEP_MS = 10 * 60_000;
const READINESS_PROBE_MS = 250;
const READINESS_SUCCESS_THRESHOLD = 40;

export function renderGatewayToken(secret: string, expiresAtMs: number): string {
  return `${expiresAtMs}.${createHmac("sha256", secret).update(String(expiresAtMs)).digest("base64url")}`;
}

interface Service {
  id: string;
  name: string;
  ownerId: string;
  environmentId?: string;
  type: string;
  suspended: string;
  serviceDetails: {
    url?: string;
    region?: string;
    disk?: { id: string; name: string; mountPath: string; sizeGB: number };
    numInstances?: number;
  };
}

interface Deploy {
  id: string;
  status: string;
  commit?: { id: string };
}

interface RenderPending {
  version: number;
  runnerCommit: string;
  readinessNonce: string;
  previousDeployId?: string;
  deployId?: string;
}

export interface StoredRenderDeploy {
  deploymentId: string;
  appRegion: string;
  serviceId?: string;
  environmentId?: string;
  host?: string;
  token: string;
  liveVersion?: number;
  suspended: boolean;
  pending?: RenderPending;
}

export interface RenderDeployProviderOptions {
  apiKey: string;
  workspaceId: string;
  projectId: string;
  environmentId: string;
  source: { repo: string; branch: string; commit: string };
  region?: string;
  appRegion?: string;
  store: DurableMap<StoredRenderDeploy>;
  artifacts: RenderDeployArtifacts;
  resources: { ensure(deploymentId: string, repair?: boolean): Promise<Record<string, string>> };
  deployTimeoutMs?: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
  advisoryLock?: AdvisoryLock;
}

export function createRenderDeployProvider(opts: RenderDeployProviderOptions): DeployProvider {
  const api = createRenderApi(opts);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const prefix = "qm-app";
  const region = opts.region ?? "oregon";
  const timeout = opts.deployTimeoutMs ?? 600_000;
  const poll = opts.pollIntervalMs ?? 2_000;
  const locks = opts.advisoryLock ?? createNoopAdvisoryLock();
  const queue = createKeyedQueue();
  const name = (d: Deployment) => `${prefix}-${d.id}`;
  const path = (s: Service) => `/services/${encodeURIComponent(s.id)}`;
  const save = (r: StoredRenderDeploy) => opts.store.put(r.deploymentId, r);
  const network = createRenderAppNetwork({ ...opts, api, name });
  const endpoints = new LRUCache<string, DeployEndpoint>({ max: 500, ttl: 10_000 });
  const checks = new Map<string, Promise<DeployEndpoint | null>>();
  const serialized = <T>(d: Deployment, run: () => Promise<T>) =>
    queue(d.id, () =>
      locks.withLock(`render-provider:${d.id}`, async () => {
        endpoints.delete(d.id);
        try {
          return await run();
        } finally {
          endpoints.delete(d.id);
        }
      }),
    );

  async function validate(): Promise<void> {
    const environment = await api.request<{ id: string; projectId: string }>(
      "GET",
      `/environments/${encodeURIComponent(opts.environmentId)}`,
    );
    if (environment?.id !== opts.environmentId || environment.projectId !== opts.projectId)
      throw new Error("Render app environment does not belong to the configured project");
  }

  async function owned(service: Service, deployment: Deployment, record: StoredRenderDeploy): Promise<Service> {
    await network.assertEnvironment(deployment, record.environmentId);
    if (
      service.name !== name(deployment) ||
      service.ownerId !== opts.workspaceId ||
      service.environmentId !== record.environmentId ||
      service.type !== "web_service" ||
      service.serviceDetails.region !== record.appRegion ||
      service.serviceDetails.disk?.name !== "data" ||
      service.serviceDetails.disk.mountPath !== "/data" ||
      service.serviceDetails.disk.sizeGB < 1 ||
      service.serviceDetails.numInstances !== 1
    )
      throw new Error(`Render app ${deployment.id} is not the expected gated service with a persistent disk at /data`);
    const marker = await api.request<{ value: string }>("GET", `${path(service)}/env-vars/${OWNER_MARKER}`);
    if (marker?.value !== deployment.id) throw new Error("Render app service ownership does not match");
    return service;
  }

  const retained = (record: StoredRenderDeploy): Promise<Service | null> =>
    record.serviceId
      ? api.request<Service>("GET", `/services/${encodeURIComponent(record.serviceId)}`, undefined, true)
      : Promise.resolve(null);

  async function byName(deployment: Deployment, record: StoredRenderDeploy): Promise<Service | null> {
    const service = (
      await list<Service>(api, "/services", "service", { name: name(deployment), ownerId: opts.workspaceId })
    ).find((row) => row.name === name(deployment));
    return service ? owned(service, deployment, record) : null;
  }

  async function find(deployment: Deployment, record: StoredRenderDeploy): Promise<Service | null> {
    const service = await retained(record);
    return service ? owned(service, deployment, record) : byName(deployment, record);
  }

  function hostOf(service: Service): string {
    const value = service.serviceDetails.url;
    if (!value) throw new Error("Render app has no HTTPS address");
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/")
      throw new Error("Render app has an invalid HTTPS address");
    return url.hostname;
  }

  function endpoint(host: string, token: string): DeployEndpoint {
    const expiresAtMs = Math.ceil((Date.now() + GATEWAY_TOKEN_TTL_MS) / GATEWAY_TOKEN_STEP_MS) * GATEWAY_TOKEN_STEP_MS;
    return {
      host,
      port: 443,
      tls: true,
      proxyHeaders: { [RENDER_APP_AUTH_HEADER]: renderGatewayToken(token, expiresAtMs), connection: "close" },
    };
  }

  async function probe(address: DeployEndpoint): Promise<Response> {
    const response = await fetchImpl(`https://${address.host}:${address.port}/__qm_ready`, {
      headers: address.proxyHeaders,
      redirect: "manual",
      signal: AbortSignal.timeout(3_000),
    });
    await response.body?.cancel();
    return response;
  }

  async function recent(service: Service, limit: number): Promise<Deploy[]> {
    const page = await api.request<Array<{ deploy: Deploy }>>("GET", `${path(service)}/deploys?limit=${limit}`);
    if (!Array.isArray(page)) throw new Error("Render returned an invalid deploy list");
    return page.map((item) => item.deploy);
  }

  const latest = async (service: Service) => (await recent(service, 1))[0];

  const active = (deploy: Deploy) => deploy.status !== "live" && !FAILED.has(deploy.status);

  async function settle(service: Service): Promise<void> {
    for (const deploy of (await recent(service, 100)).filter(active))
      await api.request("POST", `${path(service)}/deploys/${encodeURIComponent(deploy.id)}/cancel`).catch((error) => {
        if (!(error instanceof RenderApiError && error.rejected)) throw error;
        swallow("render-deploy: cancel an active deploy", error);
      });
    await idle(service);
  }

  async function finish(
    deployment: Deployment,
    initial: StoredRenderDeploy & { pending: RenderPending },
  ): Promise<{ service: Service; record: StoredRenderDeploy; address: DeployEndpoint }> {
    const unconfirmed = (cause?: unknown) =>
      new Error(`Render app ${deployment.id} has an unconfirmed deployment; retry to reconcile it`, { cause });
    const service = await find(deployment, initial);
    if (!service) throw unconfirmed();
    let record = initial;
    if (record.serviceId !== service.id) {
      record = { ...record, serviceId: service.id };
      await save(record);
    }
    let probeFailure: unknown;
    let readyProbes = 0;
    let deploy: Deploy | null = null;
    let checkedAt = 0;
    let suspended = service.suspended === "suspended";
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (!record.pending.deployId) {
        const own = (deploy: Deploy | undefined) =>
          deploy && deploy.id !== record.pending.previousDeployId && deploy.commit?.id === record.pending.runnerCommit
            ? deploy
            : undefined;
        let found = own(await latest(service));
        if (!found && suspended) {
          try {
            await api.request("POST", `${path(service)}/resume`);
          } catch (error) {
            if ((await retained(record))?.suspended === "suspended") {
              if (error instanceof RenderApiError && error.rejected) await save({ ...record, pending: undefined });
              throw error;
            }
            swallow("render-deploy: resume the app service", error);
          }
          suspended = false;
          found = own(await latest(service));
        }
        if (!found) {
          await settle(service);
          try {
            found =
              (await api.request<Deploy>("POST", `${path(service)}/deploys`, {
                commitId: record.pending.runnerCommit,
              })) ?? undefined;
          } catch (error) {
            if (error instanceof RenderApiError && error.rejected) {
              await save({ ...record, pending: undefined });
              throw error;
            }
            found = own(await latest(service));
            if (!found) throw error;
            swallow("render-deploy: submit the pinned deploy", error);
          }
        }
        if (found?.id) {
          record = { ...record, pending: { ...record.pending, deployId: found.id } };
          await save(record);
        }
      }
      const { deployId, readinessNonce, runnerCommit, version } = record.pending;
      if (deployId) {
        if (!deploy || Date.now() - checkedAt >= poll) {
          deploy = await api.request<Deploy>("GET", `${path(service)}/deploys/${encodeURIComponent(deployId)}`);
          checkedAt = Date.now();
        }
        if (deploy && FAILED.has(deploy.status)) {
          await save({ ...record, pending: undefined });
          throw new Error(`Render deploy ${deploy.id} ${deploy.status}`);
        }
        if (deploy?.status === "live") {
          const address = endpoint(hostOf(service), record.token);
          const response = await probe(address).catch((error: unknown) => {
            probeFailure = error;
            return undefined;
          });
          const ready = response?.status === 204 && response.headers.get("x-qm-render-app-ready") === readinessNonce;
          if (ready && deploy.commit?.id !== runnerCommit) {
            await save({ ...record, pending: undefined });
            throw new Error("The Render app runner was built from a different Git commit");
          }
          if (response && !ready)
            probeFailure = new Error(
              response.status === 204
                ? "Render app readiness returned a different deployment nonce"
                : `Render app readiness returned HTTP ${response.status}`,
            );
          readyProbes = ready ? readyProbes + 1 : 0;
          if (readyProbes >= READINESS_SUCCESS_THRESHOLD) {
            const live: StoredRenderDeploy = {
              ...record,
              host: address.host,
              liveVersion: version,
              suspended: false,
              pending: undefined,
            };
            await save(live);
            return { service, record: live, address };
          }
        } else readyProbes = 0;
      }
      await sleep(Math.max(1, readyProbes > 0 ? Math.min(READINESS_PROBE_MS, poll) : poll));
    }
    throw unconfirmed(probeFailure);
  }

  async function check(deployment: Deployment, record: StoredRenderDeploy): Promise<DeployEndpoint | null> {
    let service: Service | null;
    try {
      service = await retained(record);
    } catch (error) {
      if (!record.host) throw error;
      swallow("render-deploy: check the app service", error);
      return endpoint(record.host, record.token);
    }
    service ??= await byName(deployment, record);
    if (!service || service.suspended === "suspended") return null;
    const host = hostOf(service);
    if (host !== record.host) await opts.store.merge(deployment.id, { host });
    return endpoint(host, record.token);
  }

  async function idle(service: Service): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const deploy = await latest(service);
      if (!deploy || !active(deploy)) return;
      await sleep(Math.max(1, poll));
    }
    throw new Error("The previous Render deployment is still pending");
  }

  async function apply(deployment: Deployment, version: DeploymentVersion): Promise<DeployEndpoint> {
    await validate();
    let record = await opts.store.get(deployment.id);
    if (!record)
      record = await opts.store.putIfAbsent(deployment.id, {
        deploymentId: deployment.id,
        appRegion: opts.appRegion ?? region,
        token: randomBytes(32).toString("base64url"),
        suspended: false,
      });
    record = await network.ensure(deployment, record);
    if (record.pending?.version === version.version) {
      const recovered = await finish(deployment, { ...record, pending: record.pending });
      record = recovered.record;
      if (record.liveVersion === version.version) return recovered.address;
    }
    let service = await find(deployment, record);
    if (
      service &&
      service.suspended !== "suspended" &&
      !record.suspended &&
      record.liveVersion === version.version &&
      deployment.appliedVersion !== version.version
    ) {
      const host = hostOf(service);
      if (record.host !== host) {
        record = { ...record, host };
        await save(record);
      }
      return endpoint(host, record.token);
    }
    const source = { repo: opts.source.repo, branch: opts.source.branch, rootDir: "", autoDeploy: "no" };
    const runtime = {
      runtime: "docker",
      envSpecificDetails: {
        dockerContext: "deploy/render-runner",
        dockerfilePath: "deploy/render-runner/Dockerfile",
        dockerCommand: "",
      },
      healthCheckPath: "/__qm_ready",
    };
    const bootstrap = {
      ...runtime,
      envSpecificDetails: { ...runtime.envSpecificDetails, dockerCommand: "/bin/sh -c exit 0" },
    };
    if (!service) {
      let created: { service: Service } | undefined;
      let failure: unknown;
      try {
        created =
          (await api.request<{ service: Service }>("POST", "/services", {
            type: "web_service",
            name: name(deployment),
            ownerId: opts.workspaceId,
            environmentId: record.environmentId,
            ...source,
            envVars: [{ key: OWNER_MARKER, value: deployment.id }],
            secretFiles: [],
            serviceDetails: {
              ...bootstrap,
              plan: "0.5c-512mb",
              region: record.appRegion,
              numInstances: 1,
              disk: { name: "data", mountPath: "/data", sizeGB: 1 },
            },
          })) ?? undefined;
      } catch (error) {
        if (error instanceof RenderApiError && error.rejected) throw error;
        failure = error;
      }
      service = created?.service ?? (await find(deployment, record));
      if (!service) throw new Error("Render app bootstrap is unconfirmed; retry to reconcile it", { cause: failure });
      record = { ...record, serviceId: service.id };
      await save(record);
    }
    await settle(service);
    const resources = await opts.resources.ensure(deployment.id, record.suspended || service.suspended === "suspended");
    const artifact = await opts.artifacts.prepare(deployment, version);
    const readinessNonce = randomBytes(32).toString("base64url");
    const envVars = Object.entries({
      PORT: "8080",
      QM_RENDER_APP_TOKEN: record.token,
      [OWNER_MARKER]: deployment.id,
    }).map(([key, value]) => ({ key, value }));
    const secretFiles = [
      {
        name: "qm-render-artifact.json",
        content: JSON.stringify({
          ...artifact,
          readinessNonce,
          runtimeEnv: appEnv(version.env),
          storageEnv: resources,
        }),
      },
    ];
    await api.request("PUT", `${path(service)}/env-vars`, envVars);
    await api.request("PUT", `${path(service)}/secret-files`, secretFiles);
    await api.request("PATCH", path(service), { ...source, serviceDetails: runtime });
    const previousDeployId = (await latest(service))?.id;
    const submitted = {
      ...record,
      pending: {
        version: version.version,
        runnerCommit: opts.source.commit,
        readinessNonce,
        ...(previousDeployId ? { previousDeployId } : {}),
      },
    };
    await save(submitted);
    const live = await finish(deployment, submitted);
    return live.address;
  }

  return {
    profile: { managedScaleToZero: false, dataDir: "/data" },
    apply: (deployment, version) => serialized(deployment, () => apply(deployment, version)),
    async resolveEndpoint(deployment) {
      if (deployment.status === "archived") return null;
      const record = await opts.store.get(deployment.id);
      if (!record || record.suspended || record.pending || record.liveVersion === undefined) return null;
      const cached = endpoints.get(deployment.id);
      if (cached) return cached;
      const running = checks.get(deployment.id);
      if (running) return running;
      const pending = check(deployment, record)
        .then((address) => {
          if (address) endpoints.set(deployment.id, address);
          return address;
        })
        .finally(() => {
          if (checks.get(deployment.id) === pending) checks.delete(deployment.id);
        });
      checks.set(deployment.id, pending);
      return pending;
    },
    destroy: (deployment) =>
      serialized(deployment, async () => {
        await validate();
        const record = await opts.store.get(deployment.id);
        if (!record) return;
        let service = await find(deployment, record);
        if (service && service.suspended !== "suspended") await api.request("POST", `${path(service)}/suspend`);
        const deadline = Date.now() + timeout;
        while (service && service.suspended !== "suspended") {
          if (Date.now() >= deadline) throw new Error("Render app suspension is not confirmed");
          await sleep(Math.max(1, poll));
          service = await retained(record);
        }
        await opts.artifacts.revoke(deployment.id);
        await save({ ...record, suspended: true, pending: undefined });
      }),
    async logs(deployment, { tailLines }) {
      const record = await opts.store.get(deployment.id);
      const service = record && (await find(deployment, record));
      if (!service) return null;
      const query = new URLSearchParams({
        ownerId: opts.workspaceId,
        resource: service.id,
        type: "app",
        direction: "backward",
        limit: String(Math.max(1, Math.min(100, tailLines))),
      });
      const page = await api.request<{ logs: Array<{ timestamp: string; message: string }> }>("GET", `/logs?${query}`);
      return (
        page?.logs
          .sort(
            (a, b) =>
              Date.parse(a.timestamp) - Date.parse(b.timestamp) ||
              a.timestamp.slice(20, -1).padEnd(9, "0").localeCompare(b.timestamp.slice(20, -1).padEnd(9, "0")),
          )
          .map((log) => log.message)
          .join("\n") ?? null
      );
    },
  };
}
