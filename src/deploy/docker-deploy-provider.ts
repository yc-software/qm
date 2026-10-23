import type { Deployment, DeploymentVersion } from "./deploy-store.ts";
import type { DeployEndpoint, DeployProvider } from "./deploy-provider.ts";
import {
  dockerContainerNetworks,
  ensureDockerNetwork,
  spawnDockerExec,
  type DockerExec,
} from "../sandbox/docker-exec.ts";
import { errMessage } from "../util/errors.ts";
import {
  appBoot,
  appGone,
  appLogs,
  appReporter,
  recentAppChecks,
  waitAppReady,
  type AppErrorSink,
  type Exec,
} from "./shared-deploy-provider.ts";

const APP_PORT = 8080;
const APP_READY_WINDOW_SEC = 60;
const RUN_TIMEOUT_MS = 300_000;
const DAEMON_PROBE_TIMEOUT_MS = 10_000;

export interface DockerDeployProviderOptions {
  image?: string;
  docker?: string;
  basePort?: number;
  dockerExec?: DockerExec;
  onError?: AppErrorSink;
}

export interface DockerDaemonProbeOptions {
  docker?: string;
  dockerExec?: DockerExec;
}

export async function dockerDaemonFailure(opts: DockerDaemonProbeOptions = {}): Promise<string | null> {
  const dexec = opts.dockerExec ?? spawnDockerExec(opts.docker ?? "docker");
  try {
    const r = await dexec(["version", "-f", "{{.Server.Version}}"], DAEMON_PROBE_TIMEOUT_MS);
    if (r.code === 0) return null;
    const stderr = r.stderr.trim();
    if (stderr) return stderr;
    return r.code < 0 ? `no response within ${DAEMON_PROBE_TIMEOUT_MS / 1000}s` : `exit ${r.code}`;
  } catch (e) {
    return errMessage(e);
  }
}

export function createDockerDeployProvider(opts: DockerDeployProviderOptions = {}): DeployProvider {
  const docker = opts.docker ?? "docker";
  const image = opts.image ?? "node:24.22.1@sha256:6449e19d8184d84062525b6a7524def03146c2cb04a7f08b076680d0e8e4240a";
  let nextPort = opts.basePort ?? 9200;
  const ports = new Map<string, number>();
  const freed: number[] = [];
  const allocPort = (n: string): number => {
    const existing = ports.get(n);
    if (existing !== undefined) return existing;
    const port = freed.pop() ?? nextPort++;
    ports.set(n, port);
    return port;
  };
  const freePort = (n: string): void => {
    const p = ports.get(n);
    if (p !== undefined) {
      freed.push(p);
      ports.delete(n);
    }
  };

  const dexec = opts.dockerExec ?? spawnDockerExec(docker);

  const name = (d: Deployment) => `agent-deploy-${d.id.slice(0, 12)}`;
  const execIn =
    (d: Deployment): Exec =>
    (script, timeoutSec) =>
      dexec(["exec", name(d), "sh", "-c", script], timeoutSec * 1000);
  const checked = recentAppChecks();
  const network = (d: Deployment) => `${name(d)}-net`;
  const exists = async (d: Deployment): Promise<boolean> => (await dockerContainerNetworks(dexec, name(d))) !== null;

  return {
    profile: { managedScaleToZero: false },

    async apply(d: Deployment, version: DeploymentVersion): Promise<DeployEndpoint> {
      const net = await ensureDockerNetwork(dexec, network(d));
      await dexec(["rm", "-f", name(d)]);
      const hostPort = allocPort(name(d));
      const envArgs = Object.entries(version.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      const r = await dexec(
        [
          "run",
          "-d",
          "--restart",
          "unless-stopped",
          "--name",
          name(d),
          "--network",
          net,
          "--memory",
          "512m",
          "--cpus",
          "1",
          "--pids-limit",
          "256",
          "-p",
          `127.0.0.1:${hostPort}:${APP_PORT}`,
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
          appBoot(`cd /app; ${version.entrypoint}`, APP_PORT),
        ],
        RUN_TIMEOUT_MS,
      );
      try {
        if (r.code !== 0) throw new Error(`deploy run failed: ${r.stderr.trim()}`);
        await waitAppReady(execIn(d), {
          appPort: APP_PORT,
          windowSec: APP_READY_WINDOW_SEC,
          report: appReporter(opts.onError, d, version.env),
        });
      } catch (e) {
        await dexec(["rm", "-f", name(d)]);
        await dexec(["network", "rm", net]);
        freePort(name(d));
        throw e;
      }
      return { host: "127.0.0.1", port: hostPort };
    },

    async logs(d: Deployment, opts: { tailLines: number }): Promise<string | null> {
      if (!(await exists(d))) return null;
      return appLogs(execIn(d), opts.tailLines);
    },

    async destroy(d: Deployment): Promise<void> {
      await dexec(["rm", "-f", name(d)]);
      await dexec(["network", "rm", network(d)]);
      freePort(name(d));
    },

    async resolveEndpoint(d, version): Promise<DeployEndpoint | null> {
      if (checked.has(d.id)) return d.endpoint;
      if (!(await exists(d))) return null;
      const report = appReporter(opts.onError, d, version.env);
      if (await appGone(execIn(d), { appPort: APP_PORT, report })) return null;
      checked.set(d.id, true);
      return d.endpoint;
    },
  };
}
