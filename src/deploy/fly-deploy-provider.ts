import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { Deployment, DeploymentVersion } from "./deploy-store.ts";
import type { DeployEndpoint, DeployProvider } from "./deploy-provider.ts";
import { readTree } from "./deploy-fs.ts";
import { makeTar } from "../sandbox/tar.ts";
import { sleep, assertOperationActive, getOperationSignal } from "../util/async.ts";
import { swallow, swallowAs } from "../util/errors.ts";
import { shq } from "../util/shell.ts";
import type { DurableMap } from "../persistence/durable-map.ts";

const MACHINES_API_BASE_URL = "https://api.machines.dev/v1";
const DEFAULT_REGION = "lhr";
const APP_PORT = 8080;
const APP_DIR = "/app";
const BUNDLE_GUEST_PATH = "/app.tar.gz";
const MAX_BUNDLE_BASE64_BYTES = 2_000_000;
const MAX_BUNDLE_SOURCE_BYTES = 20_000_000;
const GUEST = { cpu_kind: "shared", cpus: 1, memory_mb: 512 };
const MACHINE_START_TIMEOUT_MS = 90_000;
const APP_READY_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 1_000;
const API_TIMEOUT_MS = 30_000;
const APP_ALREADY_TAKEN = /already\s+(exists|been\s+taken)|name\s+is\s+taken/i;

interface FlyApp {
  name: string;
  network: string;
  organization?: { slug?: string };
}

interface FlyIpAssignment {
  ip: string;
  network?: { name?: string; org_slug?: string };
}

interface FlyNetworkPolicy {
  netpolSelector?: { all?: boolean };
  rules?: Array<{
    action?: string;
    direction?: string;
    ports?: Array<{ protocol?: string; port?: number }>;
  }>;
}

interface FlyMachineExitEvent {
  exit_code?: number;
  oom_killed?: boolean;
}

export interface FlyMachine {
  id: string;
  state: string;
  config?: FlyMachineConfig;
  checks?: Array<{ name?: string; status?: string; output?: string }>;
  events?: Array<{ request?: { exit_event?: FlyMachineExitEvent } }>;
}

export interface FlyMachineConfig {
  image: string;
  metadata?: Record<string, string>;
  mounts?: Array<{ volume: string; path: string }>;
  env: Record<string, string>;
  guest: { cpu_kind: string; cpus: number; memory_mb: number };
  files: Array<{ guest_path: string; raw_value: string }>;
  services: Array<{
    protocol: "tcp";
    internal_port: number;
    autostop: "suspend";
    autostart: true;
    min_machines_running: number;
    ports: Array<{ port: number }>;
    checks: Array<{ type: "tcp"; interval: string; timeout: string; grace_period: string }>;
  }>;
  init: { exec: string[] };
}

interface FlyMachinesApi {
  startMachine(appName: string, machineId: string): Promise<void>;
  hasVolumes(appName: string): Promise<boolean>;
  ensureVolume(appName: string, region: string, sizeGb: number, name: string): Promise<string>;
  updateMachine(appName: string, machineId: string, config: FlyMachineConfig): Promise<void>;
  ensureApp(appName: string, orgSlug: string): Promise<void>;
  ensurePrivateIngress(appName: string, provisioned: boolean, orgSlug: string): Promise<void>;
  assertOwnedApp(appName: string, orgSlug: string): Promise<boolean>;
  deleteApp(appName: string): Promise<void>;
  listMachines(appName: string): Promise<FlyMachine[]>;
  createMachine(
    appName: string,
    input: { region: string; config: FlyMachineConfig; skip_service_registration: true },
  ): Promise<FlyMachine>;
  getMachine(appName: string, machineId: string): Promise<FlyMachine | null>;
  setCordon(appName: string, machineId: string, cordoned: boolean): Promise<void>;
  destroyMachine(appName: string, machineId: string): Promise<void>;
}

interface FlyApiResponse {
  ok: boolean;
  status: number;
  text: string;
}

function createFlyMachinesApi(opts: { token: string; fetchImpl?: typeof fetch }): FlyMachinesApi {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const request = async (method: string, path: string, body?: unknown): Promise<FlyApiResponse> => {
    assertOperationActive();
    const res = await fetchImpl(`${MACHINES_API_BASE_URL}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${opts.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([
        AbortSignal.timeout(API_TIMEOUT_MS),
        ...(getOperationSignal() ? [getOperationSignal()!] : []),
      ]),
    });
    return { ok: res.ok, status: res.status, text: await res.text() };
  };
  const failure = (what: string, r: FlyApiResponse): Error =>
    new Error(`fly ${what}: http ${r.status} ${r.text.slice(0, 200)}`);
  const parse = <T>(what: string, r: FlyApiResponse): T => {
    try {
      return JSON.parse(r.text) as T;
    } catch {
      throw new Error(`fly ${what}: unreadable response: ${r.text.slice(0, 200)}`);
    }
  };
  const app = (appName: string): string => `/apps/${encodeURIComponent(appName)}`;
  const machine = (appName: string, machineId: string): string =>
    `${app(appName)}/machines/${encodeURIComponent(machineId)}`;
  const getApp = async (appName: string): Promise<FlyApp | null> => {
    const r = await request("GET", app(appName));
    if (r.status === 404) return null;
    if (!r.ok) throw failure(`read app ${appName}`, r);
    return parse<FlyApp>(`read app ${appName}`, r);
  };
  const assertOwned = (appName: string, orgSlug: string, found: FlyApp): void => {
    if (found.name !== appName || found.organization?.slug !== orgSlug || found.network !== appName) {
      throw new Error(
        `fly app ${appName} already exists but is not the isolated app owned by this deployment; choose another FLY_DEPLOY_APP_PREFIX`,
      );
    }
  };
  return {
    async startMachine(appName, machineId): Promise<void> {
      const started = await request("POST", `${machine(appName, machineId)}/start`);
      if (!started.ok) throw failure(`start machine ${machineId}`, started);
    },
    async hasVolumes(appName): Promise<boolean> {
      const listed = await request("GET", `${app(appName)}/volumes`);
      if (!listed.ok) throw failure(`list volumes in ${appName}`, listed);
      return parse<unknown[]>(`list volumes in ${appName}`, listed).length > 0;
    },
    async ensureVolume(appName, region, sizeGb, name): Promise<string> {
      const path = `${app(appName)}/volumes`;
      const listed = await request("GET", path);
      if (!listed.ok) throw failure(`list volumes in ${appName}`, listed);
      const volumes = parse<Array<{ id: string; name: string; region: string }>>(
        `list volumes in ${appName}`,
        listed,
      ).filter((volume) => name === "qm_data" || volume.name === name);
      if (volumes.length) {
        if (volumes.length !== 1 || volumes[0]!.name !== name || volumes[0]!.region !== region) {
          throw new Error(`fly app ${appName} has unexpected volumes; reconcile storage before deploying`);
        }
        return volumes[0]!.id;
      }
      const created = await request("POST", path, {
        name,
        region,
        size_gb: sizeGb,
        encrypted: true,
        snapshot_retention: 5,
        auto_backup_enabled: true,
        compute: GUEST,
      });
      if (!created.ok) throw failure(`create volume in ${appName}`, created);
      return parse<{ id: string }>(`create volume in ${appName}`, created).id;
    },
    async updateMachine(appName, machineId, config): Promise<void> {
      const updated = await request("POST", machine(appName, machineId), { config, skip_launch: false });
      if (!updated.ok) throw failure(`update machine ${machineId}`, updated);
      const state = parse<FlyMachine>(`update machine ${machineId}`, updated).state;
      if (state === "stopped" || state === "suspended") {
        const started = await request("POST", `${machine(appName, machineId)}/start`);
        if (!started.ok) throw failure(`start updated machine ${machineId}`, started);
      }
    },
    async ensureApp(appName, orgSlug): Promise<void> {
      const existing = await getApp(appName);
      if (existing) {
        assertOwned(appName, orgSlug, existing);
        return;
      }
      const r = await request("POST", "/apps", { app_name: appName, org_slug: orgSlug, network: appName });
      if (r.ok) return;
      if (r.status !== 409 && r.status !== 422 && !APP_ALREADY_TAKEN.test(r.text)) {
        throw failure(`create app ${appName}`, r);
      }
      const found = await getApp(appName);
      if (!found) throw failure(`create app ${appName}`, r);
      assertOwned(appName, orgSlug, found);
    },
    async ensurePrivateIngress(appName, provisioned, orgSlug): Promise<void> {
      const listed = await request("GET", `${app(appName)}/ip_assignments`);
      if (!listed.ok) throw failure(`list IP assignments for ${appName}`, listed);
      const ips = parse<{ ips: FlyIpAssignment[] }>(`list IP assignments for ${appName}`, listed).ips;
      if (ips.some((entry) => !entry.ip.toLowerCase().startsWith("fdaa:"))) {
        throw new Error(`fly app ${appName} has a public IP assignment; refusing to expose the published app`);
      }
      if (provisioned && ips.length) {
        if (
          ips.some(
            ({ network }) =>
              !network?.name || network.name === "default" || network.name === appName || network.org_slug !== orgSlug,
          )
        ) {
          throw new Error(`Fly shared app ${appName} requires ingress on a separate private network in ${orgSlug}`);
        }
        const response = await request("GET", `${app(appName)}/network_policies`);
        if (!response.ok) throw failure(`read network policies for ${appName}`, response);
        const policies = parse<FlyNetworkPolicy[]>(`read network policies for ${appName}`, response);
        const ingress = (policy: FlyNetworkPolicy) =>
          policy.rules?.filter((rule) => rule.direction === "ingress") ?? [];
        if (
          !policies.some(
            (policy) =>
              policy.netpolSelector?.all === true &&
              Object.keys(policy.netpolSelector).length === 1 &&
              ingress(policy).length > 0,
          ) ||
          policies.some((policy) =>
            ingress(policy).some(
              (rule) =>
                rule.action !== "allow" ||
                !rule.ports?.length ||
                rule.ports.some((port) => port.protocol !== "tcp" || port.port !== 22),
            ),
          )
        ) {
          throw new Error(`Fly shared app ${appName} requires all-machine ingress restricted to TCP port 22`);
        }
      }
      if (ips.length) return;
      if (provisioned) throw new Error(`Fly shared app ${appName} needs private ingress provisioned before publishing`);
      const assigned = await request("POST", `${app(appName)}/ip_assignments`, { type: "private_v6" });
      if (!assigned.ok) throw failure(`allocate private ingress for ${appName}`, assigned);
    },
    async assertOwnedApp(appName, orgSlug): Promise<boolean> {
      const found = await getApp(appName);
      if (!found) return false;
      assertOwned(appName, orgSlug, found);
      return true;
    },
    async deleteApp(appName): Promise<void> {
      const r = await request("DELETE", `${app(appName)}?force=true`);
      if (r.ok || r.status === 404) return;
      throw failure(`delete app ${appName}`, r);
    },
    async listMachines(appName): Promise<FlyMachine[]> {
      const r = await request("GET", `${app(appName)}/machines`);
      if (r.status === 404) return [];
      if (!r.ok) throw failure(`list machines in ${appName}`, r);
      return parse<FlyMachine[]>(`list machines in ${appName}`, r);
    },
    async createMachine(appName, input): Promise<FlyMachine> {
      const r = await request("POST", `${app(appName)}/machines`, input);
      if (!r.ok) throw failure(`create machine in ${appName}`, r);
      return parse<FlyMachine>(`create machine in ${appName}`, r);
    },
    async getMachine(appName, machineId): Promise<FlyMachine | null> {
      const r = await request("GET", machine(appName, machineId));
      if (r.status === 404) return null;
      if (!r.ok) throw failure(`get machine ${machineId}`, r);
      return parse<FlyMachine>(`get machine ${machineId}`, r);
    },
    async setCordon(appName, machineId, cordoned): Promise<void> {
      const action = cordoned ? "cordon" : "uncordon";
      const r = await request("POST", `${machine(appName, machineId)}/${action}`);
      if (r.ok || (cordoned && r.status === 404)) return;
      throw failure(`${action} machine ${machineId}`, r);
    },
    async destroyMachine(appName, machineId): Promise<void> {
      const r = await request("DELETE", `${machine(appName, machineId)}?force=true`);
      if (r.ok || r.status === 404) return;
      throw failure(`destroy machine ${machineId}`, r);
    },
  };
}

function exitDetail(machine: FlyMachine | null): string {
  const exit = machine?.events?.find((e) => e.request?.exit_event)?.request?.exit_event;
  if (!exit) return "; the machine reported no exit event";
  const parts = [`exit code ${exit.exit_code ?? "unknown"}`];
  if (exit.oom_killed) parts.push("killed for running out of memory");
  return `; last machine exit event: ${parts.join(", ")}`;
}

export interface FlyDeployProviderOptions {
  token: string;
  appPrefix: string;
  sharedAppName?: string;
  portStore?: DurableMap<string>;
  privateTransport?: { ensure(): Promise<number> };
  baseImage: string;
  org: string;
  region?: string;
  dataVolumeSizeGb?: number;
  configStore?: DurableMap<FlyMachineConfig>;
  machineStartTimeoutMs?: number;
  appReadyTimeoutMs?: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
}

export function createFlyDeployProvider(opts: FlyDeployProviderOptions): DeployProvider {
  const region = opts.region ?? DEFAULT_REGION;
  const api = createFlyMachinesApi({
    token: opts.token,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  const machineStartTimeoutMs = opts.machineStartTimeoutMs ?? MACHINE_START_TIMEOUT_MS;
  const appReadyTimeoutMs = opts.appReadyTimeoutMs ?? APP_READY_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
  const seconds = (ms: number): string => `${Math.round(ms / 1000)}s`;

  function ensureConfigured(): void {
    if (
      opts.sharedAppName &&
      (opts.sharedAppName.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(opts.sharedAppName))
    )
      throw new Error("Fly shared app name must be a lowercase DNS label no longer than 63 characters");
    if (opts.sharedAppName && (!opts.portStore || !opts.dataVolumeSizeGb || !opts.configStore))
      throw new Error("Fly shared apps require persistent port assignments and durable storage");
    if (opts.dataVolumeSizeGb && !opts.configStore)
      throw new Error("Fly durable storage requires a persistent configuration store");
    if (
      opts.dataVolumeSizeGb !== undefined &&
      (!Number.isInteger(opts.dataVolumeSizeGb) || opts.dataVolumeSizeGb < 1)
    ) {
      throw new Error("FLY_DEPLOY_DATA_VOLUME_SIZE_GB must be a positive integer");
    }
    if (!opts.token) throw new Error("FLY_DEPLOY_API_TOKEN not set (DEPLOY_PROVIDER=fly)");
    if (!opts.appPrefix && !opts.sharedAppName) throw new Error("FLY_DEPLOY_APP_PREFIX not set (DEPLOY_PROVIDER=fly)");
    if (!opts.baseImage) throw new Error("FLY_DEPLOY_BASE_IMAGE not set (DEPLOY_PROVIDER=fly)");
    if (!opts.org) throw new Error("FLY_ORG not set (DEPLOY_PROVIDER=fly)");
    if (
      !opts.sharedAppName &&
      (opts.appPrefix.length > 26 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(opts.appPrefix))
    ) {
      throw new Error("FLY_DEPLOY_APP_PREFIX must be a lowercase DNS label no longer than 26 characters");
    }
  }

  const appNameFor = (d: Deployment): string => opts.sharedAppName ?? `${opts.appPrefix}-${d.id}`;
  const endpointFor = async (d: Deployment, port: number): Promise<DeployEndpoint> => ({
    host: `${appNameFor(d)}.flycast`,
    port,
    ...(opts.privateTransport ? { socksProxyPort: await opts.privateTransport.ensure() } : {}),
  });
  const volumeNameFor = (d: Deployment): string =>
    opts.sharedAppName ? `qm_${createHash("sha256").update(d.id).digest("hex").slice(0, 24)}` : "qm_data";
  const deploymentMachines = async (d: Deployment): Promise<FlyMachine[]> => {
    const machines = await api.listMachines(appNameFor(d));
    return opts.sharedAppName
      ? machines.filter((machine) => machine.config?.metadata?.qm_deployment_id === d.id)
      : machines;
  };
  async function portFor(d: Deployment): Promise<number> {
    if (!opts.sharedAppName) return APP_PORT;
    const first = createHash("sha256").update(d.id).digest().readUInt32BE(0) % 45536;
    for (let offset = 0; offset < 45536; offset++) {
      const port = 20000 + ((first + offset) % 45536);
      if ((await opts.portStore!.putIfAbsent(`${opts.sharedAppName}:${port}`, d.id)) === d.id) return port;
    }
    throw new Error("Fly shared app has no available deployment ports");
  }

  async function bundleBase64(version: DeploymentVersion): Promise<string> {
    const tree = await readTree(version.snapshotDir, { tolerateMissing: true });
    const sourceBytes = tree.reduce((total, file) => total + file.data.byteLength, 0);
    if (sourceBytes > MAX_BUNDLE_SOURCE_BYTES) {
      throw new Error(
        `the app source is too large for the Fly deploy provider: ${sourceBytes} bytes, maximum ${MAX_BUNDLE_SOURCE_BYTES} bytes`,
      );
    }
    const encoded = gzipSync(await makeTar(tree)).toString("base64");
    if (encoded.length > MAX_BUNDLE_BASE64_BYTES) {
      throw new Error(
        `the app bundle is too large for the Fly deploy provider: ${encoded.length} bytes once packed and encoded, ` +
          `maximum ${MAX_BUNDLE_BASE64_BYTES} bytes — publish fewer or smaller files`,
      );
    }
    return encoded;
  }

  const machineConfig = (
    d: Deployment,
    version: DeploymentVersion,
    bundle: string,
    port: number,
  ): FlyMachineConfig => ({
    image: opts.baseImage,
    ...(opts.sharedAppName ? { metadata: { qm_deployment_id: d.id } } : {}),
    env: { ...version.env, PORT: String(APP_PORT) },
    guest: GUEST,
    files: [{ guest_path: BUNDLE_GUEST_PATH, raw_value: bundle }],
    services: [
      {
        protocol: "tcp",
        internal_port: APP_PORT,
        autostop: "suspend",
        autostart: true,
        min_machines_running: d.alwaysOn ? 1 : 0,
        ports: [{ port }],
        checks: [{ type: "tcp", interval: "2s", timeout: "1s", grace_period: "1s" }],
      },
    ],
    init: {
      exec: [
        "/bin/sh",
        "-lc",
        `mkdir -p ${APP_DIR} && tar -xzf ${BUNDLE_GUEST_PATH} -C ${APP_DIR} && cd ${APP_DIR} && exec sh -lc ${shq(version.entrypoint)}`,
      ],
    },
  });

  async function waitStarted(appName: string, machineId: string): Promise<void> {
    const deadline = Date.now() + machineStartTimeoutMs;
    let last: FlyMachine | null = null;
    let requestedStart = false;
    while (Date.now() < deadline) {
      last = await api.getMachine(appName, machineId);
      if (last?.state === "started") return;
      if (!requestedStart && (last?.state === "stopped" || last?.state === "suspended")) {
        requestedStart = true;
        await api.startMachine(appName, machineId);
      }
      await sleep(pollIntervalMs);
    }
    throw new Error(
      `fly machine ${machineId} never reached state "started" within ${seconds(machineStartTimeoutMs)} ` +
        `(last state: ${last?.state ?? "unknown"})${exitDetail(last)}`,
    );
  }

  async function waitAppReady(appName: string, machineId: string): Promise<void> {
    const deadline = Date.now() + appReadyTimeoutMs;
    let machine: FlyMachine | null = null;
    while (Date.now() < deadline) {
      machine = await api.getMachine(appName, machineId);
      if (machine?.state === "started" && machine.checks?.some((check) => check.status === "passing")) return;
      await sleep(pollIntervalMs);
    }
    machine = await api
      .getMachine(appName, machineId)
      .catch(swallowAs<FlyMachine | null>("fly-deploy: read machine after readiness timeout", machine));
    const why =
      machine && machine.state !== "started"
        ? `the version's entrypoint exited without binding port ${APP_PORT} (fly machine ${machineId} is ${machine.state})`
        : `the app never listened on port ${APP_PORT} within ${seconds(appReadyTimeoutMs)}`;
    throw new Error(`${why}${exitDetail(machine)}`);
  }

  return {
    profile: { managedScaleToZero: !!opts.sharedAppName, ...(opts.dataVolumeSizeGb ? { dataDir: "/data" } : {}) },

    async resolveEndpoint(d) {
      if (!opts.privateTransport) return d.endpoint;
      ensureConfigured();
      return endpointFor(d, await portFor(d));
    },

    async setAlwaysOn(d, alwaysOn): Promise<void> {
      ensureConfigured();
      const appName = appNameFor(d);
      if (!(await api.assertOwnedApp(appName, opts.org))) throw new Error(`fly app ${appName} is missing`);
      const machines = await deploymentMachines(d);
      if (machines.length !== 1) throw new Error(`fly app ${appName} requires one machine to change always-on`);
      const machine = await api.getMachine(appName, machines[0]!.id);
      if (!machine?.config) throw new Error(`fly app ${appName} has no machine configuration`);
      const accepted = machine.config.mounts?.length
        ? ((await opts.configStore?.get(d.id)) ?? machine.config)
        : machine.config;
      const config = {
        ...accepted,
        services: accepted.services.map((service) => ({ ...service, min_machines_running: alwaysOn ? 1 : 0 })),
      };
      try {
        await api.updateMachine(appName, machine.id, config);
        await waitStarted(appName, machine.id);
        await waitAppReady(appName, machine.id);
        await api.setCordon(appName, machine.id, false);
        if (opts.configStore) await opts.configStore.put(d.id, config);
      } catch (error) {
        await api.updateMachine(appName, machine.id, accepted);
        await waitStarted(appName, machine.id);
        await waitAppReady(appName, machine.id);
        if (opts.configStore) await opts.configStore.put(d.id, accepted);
        throw error;
      }
    },

    async apply(d: Deployment, version: DeploymentVersion): Promise<DeployEndpoint> {
      ensureConfigured();
      const appName = appNameFor(d);
      const bundle = await bundleBase64(version);
      if (opts.sharedAppName) {
        if (!(await api.assertOwnedApp(appName, opts.org)))
          throw new Error(`Fly shared app ${appName} must be provisioned before publishing`);
      } else {
        await api.ensureApp(appName, opts.org);
      }
      await api.ensurePrivateIngress(appName, Boolean(opts.sharedAppName), opts.org);
      const stale = await deploymentMachines(d);
      const port = await portFor(d);
      if (!opts.dataVolumeSizeGb && (await api.hasVolumes(appName))) {
        throw new Error(
          `fly app ${appName} has durable storage; restore FLY_DEPLOY_DATA_VOLUME_SIZE_GB before deploying`,
        );
      }
      if (opts.dataVolumeSizeGb) {
        if (stale.length > 1) throw new Error(`fly app ${appName} has multiple machines; reconcile before deploying`);
        const previous = stale[0] ? await api.getMachine(appName, stale[0].id) : null;
        if (stale.length && !previous?.config?.mounts?.some((mount) => mount.path === "/data")) {
          throw new Error(`fly app ${appName} requires an explicit migration from ephemeral storage`);
        }
        const volume = await api.ensureVolume(appName, region, opts.dataVolumeSizeGb, volumeNameFor(d));
        if (previous && (previous.config!.mounts!.length !== 1 || previous.config!.mounts![0]!.volume !== volume)) {
          throw new Error(`fly app ${appName} has an unexpected volume attachment`);
        }
        const config = machineConfig(d, version, bundle, port);
        config.env.DATA_DIR = "/data";
        config.mounts = [{ volume, path: "/data" }];
        if (previous) {
          const accepted = await opts.configStore!.get(d.id);
          try {
            await api.updateMachine(appName, previous.id, config);
            await waitStarted(appName, previous.id);
            await waitAppReady(appName, previous.id);
            await api.setCordon(appName, previous.id, false);
            await opts.configStore!.put(d.id, config);
          } catch (error) {
            if (accepted) {
              await api.updateMachine(appName, previous.id, accepted);
              await waitStarted(appName, previous.id);
              await waitAppReady(appName, previous.id);
              await api.setCordon(appName, previous.id, false);
              await opts.configStore!.put(d.id, accepted);
            }
            throw error;
          }
        } else {
          const created = await api.createMachine(appName, { region, config, skip_service_registration: true });
          try {
            await waitStarted(appName, created.id);
            await waitAppReady(appName, created.id);
            await api.setCordon(appName, created.id, false);
            await opts.configStore!.put(d.id, config);
          } catch (error) {
            await api
              .destroyMachine(appName, created.id)
              .catch((cleanupError) =>
                swallow("fly-deploy: remove unhealthy machine while retaining its data", cleanupError),
              );
            throw error;
          }
        }
        return endpointFor(d, port);
      }
      const machine = await api.createMachine(appName, {
        region,
        config: machineConfig(d, version, bundle, port),
        skip_service_registration: true,
      });
      try {
        await waitStarted(appName, machine.id);
        await waitAppReady(appName, machine.id);
      } catch (error) {
        await api
          .destroyMachine(appName, machine.id)
          .catch((cleanupError) => swallow("fly-deploy: remove unhealthy replacement", cleanupError));
        throw error;
      }
      try {
        for (const previous of stale) {
          await api.setCordon(appName, previous.id, true);
        }
        await api.setCordon(appName, machine.id, false);
      } catch (error) {
        for (const previous of stale) {
          await api
            .setCordon(appName, previous.id, false)
            .catch((rollbackError) => swallow("fly-deploy: restore previous machine routing", rollbackError));
        }
        await api
          .destroyMachine(appName, machine.id)
          .catch((cleanupError) => swallow("fly-deploy: remove failed replacement", cleanupError));
        throw error;
      }
      for (const previous of stale) {
        await api
          .destroyMachine(appName, previous.id)
          .catch((cleanupError) => swallow("fly-deploy: remove cordoned machine", cleanupError));
      }
      return endpointFor(d, port);
    },

    async destroy(d: Deployment): Promise<void> {
      ensureConfigured();
      const appName = appNameFor(d);
      if (!(await api.assertOwnedApp(appName, opts.org))) return;
      if (opts.dataVolumeSizeGb || (await api.hasVolumes(appName))) {
        for (const machine of await deploymentMachines(d)) await api.destroyMachine(appName, machine.id);
        return;
      }
      await api.deleteApp(appName);
    },
  };
}
