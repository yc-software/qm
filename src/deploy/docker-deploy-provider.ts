import type { Deployment, DeploymentVersion } from "./deploy-store.ts";
import type { DeployEndpoint, DeployProvider } from "./deploy-provider.ts";
import { spawnDockerExec, type DockerExec } from "../sandbox/docker-exec.ts";
import { errMessage } from "../util/errors.ts";

const APP_PORT = 8080;
const LEGACY_NETWORK = "agent-deploynet";
const DAEMON_PROBE_TIMEOUT_MS = 10_000;

export interface DockerDeployProviderOptions {
  image?: string;
  docker?: string;
  basePort?: number;
  dockerExec?: DockerExec;
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
  const image = opts.image ?? "node:24-alpine";
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
  const appVolume = (d: Deployment) => `qm-app-${d.id.slice(0, 12)}`;
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
  const removeContainerIfPresent = async (container: string): Promise<void> => {
    const r = await dexec(["rm", "-f", container]);
    if (r.code !== 0 && !/no such (?:object|container)|not found/i.test(r.stderr)) {
      throw new Error(`docker rm ${container} failed: ${r.stderr.trim()}`);
    }
  };
  const removeVolumeIfPresent = async (volume: string): Promise<void> => {
    const r = await dexec(["volume", "rm", volume]);
    if (r.code !== 0 && !/no such volume|not found/i.test(r.stderr)) {
      throw new Error(`docker volume rm ${volume} failed: ${r.stderr.trim()}`);
    }
  };
  const cleanupFailedApply = async (d: Deployment, net: string): Promise<void> => {
    await removeContainerIfPresent(name(d)).catch(() => undefined);
    await removeVolumeIfPresent(appVolume(d)).catch(() => undefined);
    await dexec(["network", "rm", net]).catch(() => undefined);
    freePort(name(d));
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
    profile: { managedScaleToZero: false },

    async apply(d: Deployment, version: DeploymentVersion): Promise<DeployEndpoint> {
      const net = await ensureNetwork(network(d));
      await removeContainerIfPresent(name(d));
      await removeVolumeIfPresent(appVolume(d));
      const volume = await dexec(["volume", "create", appVolume(d)]);
      if (volume.code !== 0) {
        await cleanupFailedApply(d, net);
        throw new Error(`docker volume create ${appVolume(d)} failed: ${volume.stderr.trim()}`);
      }
      const hostPort = allocPort(name(d));
      const envArgs = Object.entries(version.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      const created = await dexec([
        "create",
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
        `${appVolume(d)}:/app`,
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
      if (created.code !== 0) {
        await cleanupFailedApply(d, net);
        throw new Error(`deploy create failed: ${created.stderr.trim()}`);
      }
      const copied = await dexec(["cp", `${version.snapshotDir}/.`, `${name(d)}:/app`]);
      if (copied.code !== 0) {
        await cleanupFailedApply(d, net);
        throw new Error(`deploy snapshot copy failed: ${copied.stderr.trim()}`);
      }
      const started = await dexec(["start", name(d)]);
      if (started.code !== 0) {
        await cleanupFailedApply(d, net);
        throw new Error(`deploy start failed: ${started.stderr.trim()}`);
      }
      return { host: "127.0.0.1", port: hostPort };
    },

    async logs(d: Deployment, opts: { tailLines: number }): Promise<string | null> {
      if (!(await migrateTarget(name(d)))) return null;
      const lines = Math.max(1, Math.min(2000, Math.floor(opts.tailLines)));
      const r = await dexec(["logs", "--tail", String(lines), name(d)]);
      if (r.code !== 0) return null;
      return `${r.stdout}${r.stderr}`;
    },

    async destroy(d: Deployment): Promise<void> {
      let failure: unknown;
      try {
        await removeContainerIfPresent(name(d));
      } catch (e) {
        failure = e;
      }
      try {
        await removeVolumeIfPresent(appVolume(d));
      } catch (e) {
        failure ??= e;
      }
      try {
        const removed = await dexec(["network", "rm", network(d)]);
        if (removed.code !== 0 && !/no such network|not found/i.test(removed.stderr)) {
          failure ??= new Error(`docker network rm ${network(d)} failed: ${removed.stderr.trim()}`);
        }
      } finally {
        freePort(name(d));
      }
      if (failure) throw failure;
    },

    async resolveEndpoint(d): Promise<DeployEndpoint | null> {
      return (await migrateTarget(name(d))) ? d.endpoint : null;
    },
  };
}
