import type { Deployment, DeploymentVersion } from "./deploy-store.ts";
import type { DeployEndpoint, DeployProvider } from "./deploy-provider.ts";
import { spawnDockerExec, type DockerExec } from "../sandbox/docker-exec.ts";
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
const LEGACY_NETWORK = "agent-deploynet";
const DAEMON_PROBE_TIMEOUT_MS = 10_000;
// Every other deploy provider (aws-deploy-provider.ts, e2b-deploy-provider.ts,
// porter-deploy-provider.ts, fly-deploy-provider.ts) sets DATA_DIR to a path
// backed by real persistent storage, and reports it as profile.dataDir so
// agent-tools.ts can tell the agent to keep durable state there. This
// provider had neither: the only volume it ever mounted was the read-only
// snapshotDir at /app, so anything an app wrote anywhere (including a path
// it guessed on its own, for lack of being told one) lived only in that
// specific container's own writable layer and was silently lost on the next
// apply() — which always docker rm -f's the old container before docker
// run-ing a new one. A named volume per deployment, mounted at DATA_DIR and
// left alone across apply() (only removed in destroy(), same lifecycle as
// the per-deployment network), closes that gap.
const DATA_DIR = "/data";

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
  const image = opts.image ?? "node:24";
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
  const ensureNetwork = async (net: string): Promise<string> => {
    if ((await dexec(["network", "inspect", net])).code !== 0) {
      const r = await dexec(["network", "create", net]);
      if (r.code !== 0 && !/already exists/i.test(r.stderr)) {
        throw new Error(`docker network create ${net} failed: ${r.stderr.trim()}`);
      }
    }
    return net;
  };
  const dataVolume = (d: Deployment) => `${name(d)}-data`;
  const ensureDataVolume = async (vol: string): Promise<string> => {
    // Unlike `docker network create`, `docker volume create` on a name
    // that already exists is already a no-op success (confirmed: exit 0,
    // no "already exists" error) — simpler than ensureNetwork's inspect-
    // first dance, nothing extra needed here.
    const r = await dexec(["volume", "create", vol]);
    if (r.code !== 0) throw new Error(`docker volume create ${vol} failed: ${r.stderr.trim()}`);
    return vol;
  };

  const migrateContainer = async (container: string): Promise<boolean> => {
    const inspected = await dexec(["inspect", "--format", "{{json .NetworkSettings.Networks}}", container]);
    if (inspected.code !== 0) {
      if (/no such (?:object|container)|not found/i.test(inspected.stderr)) return false;
      throw new Error(`docker inspect ${container} failed: ${inspected.stderr.trim()}`);
    }
    let attached: Record<string, unknown>;
    try {
      attached = JSON.parse(inspected.stdout) as Record<string, unknown>;
    } catch {
      throw new Error(`docker inspect ${container} returned invalid network state`);
    }
    const target = `${container}-net`;
    await ensureNetwork(target);
    if (!(target in attached)) {
      const connected = await dexec(["network", "connect", target, container]);
      if (connected.code !== 0) throw new Error(`docker network connect ${target} failed: ${connected.stderr.trim()}`);
    }
    if (LEGACY_NETWORK in attached) {
      const disconnected = await dexec(["network", "disconnect", LEGACY_NETWORK, container]);
      if (disconnected.code !== 0)
        throw new Error(`docker network disconnect ${LEGACY_NETWORK} failed: ${disconnected.stderr.trim()}`);
    }
    return true;
  };
  const migrateTarget = async (container: string): Promise<boolean> => {
    try {
      return await migrateContainer(container);
    } catch {
      return migrateContainer(container);
    }
  };

  return {
    profile: { managedScaleToZero: false, dataDir: DATA_DIR },

    async apply(d: Deployment, version: DeploymentVersion): Promise<DeployEndpoint> {
      const net = await ensureNetwork(network(d));
      const vol = await ensureDataVolume(dataVolume(d));
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
          "-v",
          `${vol}:${DATA_DIR}`,
          "-w",
          "/app",
          "-e",
          `PORT=${APP_PORT}`,
          "-e",
          `DATA_DIR=${DATA_DIR}`,
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
      if (!(await migrateTarget(name(d)))) return null;
      return appLogs(execIn(d), opts.tailLines);
    },

    async destroy(d: Deployment): Promise<void> {
      await dexec(["rm", "-f", name(d)]);
      await dexec(["network", "rm", network(d)]);
      await dexec(["volume", "rm", dataVolume(d)]);
      freePort(name(d));
    },

    async resolveEndpoint(d, version): Promise<DeployEndpoint | null> {
      if (checked.has(d.id)) return d.endpoint;
      if (!(await migrateTarget(name(d)))) return null;
      const report = appReporter(opts.onError, d, version.env);
      if (await appGone(execIn(d), { appPort: APP_PORT, report })) return null;
      checked.set(d.id, true);
      return d.endpoint;
    },
  };
}
