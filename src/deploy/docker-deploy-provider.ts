import type { Deployment, DeploymentVersion } from "./deploy-store.ts";
import type { DeployEndpoint, DeployProvider } from "./deploy-provider.ts";
import { randomUUID } from "node:crypto";
import { spawnDockerExec, type DockerExec } from "../sandbox/docker-exec.ts";
import { errMessage } from "../util/errors.ts";
import { sleep } from "../util/async.ts";

const NETWORK = "agent-deploynet";
const APP_PORT = 8080;
const APP_READY_WINDOW_MS = 60_000;
const APP_READY_STABLE_MS = 2_000;
const APP_READY_POLL_MS = 500;
const APP_READY_PROBE_TIMEOUT_MS = 2_000;

interface DockerState {
  Status?: string;
  Running?: boolean;
  OOMKilled?: boolean;
  ExitCode?: number;
  Error?: string;
}

interface DockerContainer {
  State?: DockerState;
  Config?: { Labels?: Record<string, string> };
}

export interface DockerDeployProviderOptions {
  image?: string;
  docker?: string;
  dockerExec?: DockerExec;
}

export function createDockerDeployProvider(opts: DockerDeployProviderOptions = {}): DeployProvider {
  const docker = opts.docker ?? "docker";
  const image = opts.image ?? "node:24-alpine";
  const dexec = opts.dockerExec ?? spawnDockerExec(docker);

  const name = (d: Deployment) => `agent-deploy-${d.id.slice(0, 12)}`;
  const inspectContainer = async (container: string, timeoutMs = APP_READY_PROBE_TIMEOUT_MS) => {
    const inspected = await dexec(["inspect", "--format", "{{json .}}", container], timeoutMs);
    if (inspected.code !== 0) return { inspected };
    try {
      return { inspected, container: JSON.parse(inspected.stdout) as DockerContainer };
    } catch {
      return { inspected };
    }
  };
  const removeContainer = async (container: string): Promise<void> => {
    const removed = await dexec(["rm", "-f", container]);
    if (removed.code !== 0 && !/no such container/i.test(removed.stderr)) {
      throw new Error(`docker rm ${container} failed: ${removed.stderr.trim()}`);
    }
  };
  const removeProvision = async (container: string, provision: string): Promise<boolean> => {
    const { inspected, container: info } = await inspectContainer(container);
    if (inspected.code !== 0) {
      if (/no such (object|container)/i.test(inspected.stderr)) return true;
      throw new Error(`docker inspect ${container} failed: ${inspected.stderr.trim()}`);
    }
    if (info?.Config?.Labels?.["qm.provision"] !== provision) return false;
    await removeContainer(container);
    return true;
  };
  const endpointFor = async (container: string): Promise<DeployEndpoint | null> => {
    const published = await dexec(["port", container, `${APP_PORT}/tcp`], APP_READY_PROBE_TIMEOUT_MS);
    const match = published.stdout
      .split("\n")[0]
      ?.trim()
      .match(/:(\d+)$/);
    if (published.code !== 0 || !match) return null;
    return { host: "127.0.0.1", port: Number(match[1]) };
  };
  const probeEndpoint = async (endpoint: DeployEndpoint, timeoutMs: number) => {
    try {
      const response = await fetch(`http://${endpoint.host}:${endpoint.port}/`, {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      await response.body?.cancel();
      return { ready: true as const, error: "" };
    } catch (error) {
      return { ready: false as const, error: errMessage(error) };
    }
  };
  const readinessFailure = async (container: string, probeError: string): Promise<Error> => {
    const { inspected, container: info } = await inspectContainer(container);
    const state = info?.State;
    let reason = `app never became reachable on published port ${APP_PORT} within ${APP_READY_WINDOW_MS / 1000}s`;
    if (inspected.code === 0) {
      if (state) {
        if (!state.Running) {
          const status = state.Status ? ` (${state.Status})` : "";
          const oom = state.OOMKilled ? ", OOM killed" : "";
          const detail = state.Error ? `: ${state.Error}` : "";
          reason = `container exited with code ${state.ExitCode ?? "unknown"}${status}${oom} before becoming reachable on port ${APP_PORT}${detail}`;
        } else if (probeError) {
          reason += `; last probe: ${probeError}`;
        }
      } else {
        reason = `could not read container state after readiness failed: ${inspected.stdout.trim() || inspected.stderr.trim()}`;
      }
    } else {
      reason = `could not inspect container after readiness failed: ${inspected.stderr.trim()}`;
    }
    const logs = await dexec(["logs", "--tail", "100", container], APP_READY_PROBE_TIMEOUT_MS);
    const output = `${logs.stdout}${logs.stderr}`.trim().slice(-2000);
    return new Error(
      reason + (output ? `; last output from the entrypoint:\n${output}` : "; the entrypoint produced no output"),
    );
  };
  const waitUntilReady = async (container: string, endpoint: DeployEndpoint): Promise<void> => {
    const deadline = Date.now() + APP_READY_WINDOW_MS;
    let readySince: number | undefined;
    let probeError: string;
    for (;;) {
      const now = Date.now();
      const probe = await probeEndpoint(endpoint, Math.max(1, Math.min(APP_READY_PROBE_TIMEOUT_MS, deadline - now)));
      const checkedAt = Date.now();
      probeError = probe.error;
      readySince = probe.ready ? (readySince ?? checkedAt) : undefined;
      const { inspected, container: info } = await inspectContainer(
        container,
        Math.max(1, Math.min(APP_READY_PROBE_TIMEOUT_MS, deadline - checkedAt)),
      );
      const inspectedAt = Date.now();
      if (inspected.code !== 0 || !info?.State?.Running) throw await readinessFailure(container, probeError);
      if (readySince !== undefined && inspectedAt - readySince >= APP_READY_STABLE_MS) return;
      if (inspectedAt >= deadline) throw await readinessFailure(container, probeError);
      await sleep(Math.min(APP_READY_POLL_MS, deadline - inspectedAt));
    }
  };

  return {
    profile: { managedScaleToZero: false },

    async apply(d: Deployment, version: DeploymentVersion): Promise<DeployEndpoint> {
      await dexec(["network", "create", NETWORK]);
      await removeContainer(name(d));
      const provision = randomUUID();
      const envArgs = Object.entries(version.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      const r = await dexec([
        "run",
        "-d",
        "--name",
        name(d),
        "--label",
        `qm.provision=${provision}`,
        "--label",
        `qm.deploy.id=${d.id}`,
        "--label",
        `qm.deploy.version=${version.version}`,
        "--network",
        NETWORK,
        "--memory",
        "512m",
        "--cpus",
        "1",
        "--pids-limit",
        "256",
        "-p",
        `127.0.0.1::${APP_PORT}`,
        "-v",
        `${version.snapshotDir}:/app:ro`,
        "-w",
        "/app",
        "-e",
        `PORT=${APP_PORT}`,
        ...envArgs,
        image,
        "sh",
        "-c",
        version.entrypoint,
      ]);
      if (r.code !== 0) {
        const error = new Error(`deploy run failed: ${r.stderr.trim()}`);
        try {
          await removeProvision(name(d), provision);
        } catch (cleanupError) {
          throw new Error(`${error.message}; ${errMessage(cleanupError)}`, {
            cause: cleanupError,
          });
        }
        throw error;
      }
      const container = r.stdout.trim() || name(d);
      try {
        const endpoint = await endpointFor(container);
        if (!endpoint) throw new Error(`deploy run failed: cannot resolve published port for ${name(d)}`);
        await waitUntilReady(container, endpoint);
        return endpoint;
      } catch (error) {
        try {
          await removeContainer(container);
        } catch (cleanupError) {
          throw new Error(`${errMessage(error)}; ${errMessage(cleanupError)}`, {
            cause: cleanupError,
          });
        }
        throw error;
      }
    },

    async destroy(d: Deployment): Promise<void> {
      await removeContainer(name(d));
    },

    async resolveEndpoint(d: Deployment, version: DeploymentVersion): Promise<DeployEndpoint | null> {
      if (d.appliedVersion !== version.version) return null;
      const { container } = await inspectContainer(name(d));
      if (!container?.State?.Running) return null;
      const labels = container.Config?.Labels;
      if (labels?.["qm.deploy.id"] !== d.id || labels["qm.deploy.version"] !== String(version.version)) return null;
      return endpointFor(name(d));
    },
  };
}
