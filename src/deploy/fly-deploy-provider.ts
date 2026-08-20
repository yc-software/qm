import { gzipSync } from "node:zlib";
import type { Deployment, DeploymentVersion } from "./deploy-store.ts";
import type { DeployEndpoint, DeployProvider } from "./deploy-provider.ts";
import { readTree } from "./deploy-fs.ts";
import { makeTar } from "../sandbox/tar.ts";
import { sleep } from "../util/async.ts";
import { swallow, swallowAs } from "../util/errors.ts";
import { shq } from "../util/shell.ts";

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
}

interface FlyMachineExitEvent {
  exit_code?: number;
  oom_killed?: boolean;
}

export interface FlyMachine {
  id: string;
  state: string;
  checks?: Array<{ name?: string; status?: string; output?: string }>;
  events?: Array<{ request?: { exit_event?: FlyMachineExitEvent } }>;
}

export interface FlyMachineConfig {
  image: string;
  env: Record<string, string>;
  guest: { cpu_kind: string; cpus: number; memory_mb: number };
  files: Array<{ guest_path: string; raw_value: string }>;
  services: Array<{
    protocol: "tcp";
    internal_port: number;
    ports: Array<{ port: number }>;
    checks: Array<{ type: "tcp"; interval: string; timeout: string; grace_period: string }>;
  }>;
  init: { exec: string[] };
}

interface FlyMachinesApi {
  ensureApp(appName: string, orgSlug: string): Promise<void>;
  ensurePrivateIngress(appName: string): Promise<void>;
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
    const res = await fetchImpl(`${MACHINES_API_BASE_URL}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${opts.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
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
    async ensureApp(appName, orgSlug): Promise<void> {
      const r = await request("POST", "/apps", { app_name: appName, org_slug: orgSlug, network: appName });
      if (r.ok) return;
      if (r.status !== 409 && r.status !== 422 && !APP_ALREADY_TAKEN.test(r.text)) {
        throw failure(`create app ${appName}`, r);
      }
      const found = await getApp(appName);
      if (!found) throw failure(`create app ${appName}`, r);
      assertOwned(appName, orgSlug, found);
    },
    async ensurePrivateIngress(appName): Promise<void> {
      const listed = await request("GET", `${app(appName)}/ip_assignments`);
      if (!listed.ok) throw failure(`list IP assignments for ${appName}`, listed);
      const ips = parse<{ ips: FlyIpAssignment[] }>(`list IP assignments for ${appName}`, listed).ips;
      if (ips.some((entry) => !entry.ip.toLowerCase().startsWith("fdaa:"))) {
        throw new Error(`fly app ${appName} has a public IP assignment; refusing to expose the published app`);
      }
      if (ips.length) return;
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
  baseImage: string;
  org: string;
  region?: string;
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
    if (!opts.token) throw new Error("FLY_DEPLOY_API_TOKEN not set (DEPLOY_PROVIDER=fly)");
    if (!opts.appPrefix) throw new Error("FLY_DEPLOY_APP_PREFIX not set (DEPLOY_PROVIDER=fly)");
    if (!opts.baseImage) throw new Error("FLY_DEPLOY_BASE_IMAGE not set (DEPLOY_PROVIDER=fly)");
    if (!opts.org) throw new Error("FLY_ORG not set (DEPLOY_PROVIDER=fly)");
    if (opts.appPrefix.length > 26 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(opts.appPrefix)) {
      throw new Error("FLY_DEPLOY_APP_PREFIX must be a lowercase DNS label no longer than 26 characters");
    }
  }

  const appNameFor = (d: Deployment): string => `${opts.appPrefix}-${d.id}`;

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

  const machineConfig = (version: DeploymentVersion, bundle: string): FlyMachineConfig => ({
    image: opts.baseImage,
    env: { ...version.env, PORT: String(APP_PORT) },
    guest: GUEST,
    files: [{ guest_path: BUNDLE_GUEST_PATH, raw_value: bundle }],
    services: [
      {
        protocol: "tcp",
        internal_port: APP_PORT,
        ports: [{ port: APP_PORT }],
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
    while (Date.now() < deadline) {
      last = await api.getMachine(appName, machineId);
      if (last?.state === "started") return;
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
    profile: { managedScaleToZero: false },

    async apply(d: Deployment, version: DeploymentVersion): Promise<DeployEndpoint> {
      ensureConfigured();
      const appName = appNameFor(d);
      const bundle = await bundleBase64(version);
      await api.ensureApp(appName, opts.org);
      await api.ensurePrivateIngress(appName);
      const stale = await api.listMachines(appName);
      const machine = await api.createMachine(appName, {
        region,
        config: machineConfig(version, bundle),
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
      return { host: `${appName}.flycast`, port: APP_PORT };
    },

    async destroy(d: Deployment): Promise<void> {
      ensureConfigured();
      const appName = appNameFor(d);
      if (!(await api.assertOwnedApp(appName, opts.org))) return;
      await api.deleteApp(appName);
    },
  };
}
