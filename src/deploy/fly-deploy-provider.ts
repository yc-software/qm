import { connect } from "node:net";
import { gzipSync } from "node:zlib";
import type { Deployment, DeploymentVersion } from "./deploy-store.ts";
import type { DeployEndpoint, DeployProvider } from "./deploy-provider.ts";
import { readTree } from "./deploy-fs.ts";
import { makeTar } from "../sandbox/tar.ts";
import { sleep } from "../util/async.ts";
import { swallowAs } from "../util/errors.ts";
import { shq } from "../util/shell.ts";

const MACHINES_API_BASE_URL = "https://api.machines.dev/v1";
const DEFAULT_REGION = "lhr";
const APP_PORT = 8080;
const APP_DIR = "/app";
const BUNDLE_GUEST_PATH = "/app.tar.gz";
const MAX_BUNDLE_BASE64_BYTES = 2_000_000;
const GUEST = { cpu_kind: "shared", cpus: 1, memory_mb: 512 };
const MACHINE_START_TIMEOUT_MS = 90_000;
const APP_READY_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 1_000;
const DIAL_TIMEOUT_MS = 2_000;
const API_TIMEOUT_MS = 30_000;
const APP_ALREADY_TAKEN = /already\s+(exists|been\s+taken)|name\s+is\s+taken/i;

interface FlyMachineExitEvent {
  exit_code?: number;
  oom_killed?: boolean;
}

export interface FlyMachine {
  id: string;
  state: string;
  events?: Array<{ request?: { exit_event?: FlyMachineExitEvent } }>;
}

export interface FlyMachineConfig {
  image: string;
  env: Record<string, string>;
  guest: { cpu_kind: string; cpus: number; memory_mb: number };
  files: Array<{ guest_path: string; raw_value: string }>;
  services: never[];
  init: { exec: string[] };
}

interface FlyMachinesApi {
  createApp(appName: string, orgSlug: string): Promise<void>;
  deleteApp(appName: string): Promise<void>;
  listMachines(appName: string): Promise<FlyMachine[]>;
  createMachine(appName: string, input: { region: string; config: FlyMachineConfig }): Promise<FlyMachine>;
  getMachine(appName: string, machineId: string): Promise<FlyMachine | null>;
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
  return {
    async createApp(appName, orgSlug): Promise<void> {
      const r = await request("POST", "/apps", { app_name: appName, org_slug: orgSlug });
      if (r.ok || r.status === 409 || APP_ALREADY_TAKEN.test(r.text)) return;
      throw failure(`create app ${appName}`, r);
    },
    async deleteApp(appName): Promise<void> {
      const r = await request("DELETE", app(appName));
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
    async destroyMachine(appName, machineId): Promise<void> {
      const r = await request("DELETE", `${machine(appName, machineId)}?force=true`);
      if (r.ok || r.status === 404) return;
      throw failure(`destroy machine ${machineId}`, r);
    },
  };
}

function tcpReachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const settle = (reachable: boolean): void => {
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(DIAL_TIMEOUT_MS);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
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
  dialPort?: (host: string, port: number) => Promise<boolean>;
}

export function createFlyDeployProvider(opts: FlyDeployProviderOptions): DeployProvider {
  const region = opts.region ?? DEFAULT_REGION;
  const api = createFlyMachinesApi({
    token: opts.token,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  const dialPort = opts.dialPort ?? tcpReachable;
  const machineStartTimeoutMs = opts.machineStartTimeoutMs ?? MACHINE_START_TIMEOUT_MS;
  const appReadyTimeoutMs = opts.appReadyTimeoutMs ?? APP_READY_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
  const seconds = (ms: number): string => `${Math.round(ms / 1000)}s`;

  function ensureConfigured(): void {
    if (!opts.token) throw new Error("FLY_DEPLOY_API_TOKEN not set (DEPLOY_PROVIDER=fly)");
    if (!opts.appPrefix) throw new Error("FLY_DEPLOY_APP_PREFIX not set (DEPLOY_PROVIDER=fly)");
    if (!opts.baseImage) throw new Error("FLY_DEPLOY_BASE_IMAGE not set (DEPLOY_PROVIDER=fly)");
    if (!opts.org) throw new Error("FLY_ORG not set (DEPLOY_PROVIDER=fly)");
  }

  const appNameFor = (d: Deployment): string => `${opts.appPrefix}-${d.id.slice(0, 12)}`;

  async function bundleBase64(version: DeploymentVersion): Promise<string> {
    const tree = await readTree(version.snapshotDir, { tolerateMissing: true });
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
    services: [],
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
    while (Date.now() < deadline) {
      if (await dialPort(`${appName}.internal`, APP_PORT)) return;
      await sleep(pollIntervalMs);
    }
    const machine = await api
      .getMachine(appName, machineId)
      .catch(swallowAs<FlyMachine | null>("fly-deploy: read machine after readiness timeout", null));
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
      await api.createApp(appName, opts.org);
      for (const stale of await api.listMachines(appName)) await api.destroyMachine(appName, stale.id);
      const machine = await api.createMachine(appName, { region, config: machineConfig(version, bundle) });
      await waitStarted(appName, machine.id);
      await waitAppReady(appName, machine.id);
      return { host: `${appName}.internal`, port: APP_PORT };
    },

    async destroy(d: Deployment): Promise<void> {
      ensureConfigured();
      await api.deleteApp(appNameFor(d));
    },
  };
}
