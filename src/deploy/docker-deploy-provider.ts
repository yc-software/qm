import type { Deployment, DeploymentVersion } from "./deploy-store.ts";
import type { DeployEndpoint, DeployProvider } from "./deploy-provider.ts";
import { spawnDockerExec, type DockerExec } from "../sandbox/docker-exec.ts";

const APP_PORT = 8080;
const LEGACY_NETWORK = "agent-deploynet";

export interface DockerDeployProviderOptions {
  image?: string;
  docker?: string;
  basePort?: number;
  dockerExec?: DockerExec;
  network?: string;
}

export function createDockerDeployProvider(opts: DockerDeployProviderOptions = {}): DeployProvider {
  const docker = opts.docker ?? "docker";
  const image = opts.image ?? "node:24-alpine";
  const sharedNetwork = opts.network;
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

  const containerPresent = async (container: string): Promise<boolean> => {
    const r = await dexec(["inspect", "--format", "{{.Id}}", container]);
    if (r.code === 0) return true;
    if (/no such (?:object|container)|not found/i.test(r.stderr)) return false;
    throw new Error(`docker inspect ${container} failed: ${r.stderr.trim()}`);
  };

  return {
    profile: { managedScaleToZero: false },

    async apply(d: Deployment, version: DeploymentVersion): Promise<DeployEndpoint> {
      const container = name(d);
      const net = sharedNetwork ?? (await ensureNetwork(network(d)));
      await dexec(["rm", "-f", container]);
      const hostPort = sharedNetwork ? undefined : allocPort(container);
      const envArgs = Object.entries(version.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      const cleanup = async (): Promise<void> => {
        await dexec(["rm", "-f", container]);
        if (!sharedNetwork) await dexec(["network", "rm", net]);
        if (hostPort !== undefined) freePort(container);
      };
      const create = await dexec([
        "create",
        "--name",
        container,
        "--network",
        net,
        ...(sharedNetwork ? ["--network-alias", container] : []),
        "--memory",
        "512m",
        "--cpus",
        "1",
        "--pids-limit",
        "256",
        ...(hostPort !== undefined ? ["-p", `127.0.0.1:${hostPort}:${APP_PORT}`] : []),
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
      if (create.code !== 0) {
        await cleanup();
        throw new Error(`deploy create failed: ${create.stderr.trim()}`);
      }
      const copy = await dexec(["cp", `${version.snapshotDir}/.`, `${container}:/app`], 600_000);
      if (copy.code !== 0) {
        await cleanup();
        throw new Error(`deploy snapshot copy failed: ${copy.stderr.trim()}`);
      }
      const start = await dexec(["start", container]);
      if (start.code !== 0) {
        await cleanup();
        throw new Error(`deploy start failed: ${start.stderr.trim()}`);
      }
      return sharedNetwork ? { host: container, port: APP_PORT } : { host: "127.0.0.1", port: hostPort! };
    },

    async logs(d: Deployment, logOpts: { tailLines: number }): Promise<string | null> {
      const container = name(d);
      const ready = sharedNetwork
        ? await containerPresent(container).catch(() => false)
        : await migrateTarget(container);
      if (!ready) return null;
      const lines = Math.max(1, Math.min(2000, Math.floor(logOpts.tailLines)));
      const r = await dexec(["logs", "--tail", String(lines), container]);
      if (r.code !== 0) return null;
      return `${r.stdout}${r.stderr}`;
    },

    async destroy(d: Deployment): Promise<void> {
      const container = name(d);
      await dexec(["rm", "-f", container]);
      if (!sharedNetwork) await dexec(["network", "rm", network(d)]);
      freePort(container);
    },

    async resolveEndpoint(d): Promise<DeployEndpoint | null> {
      if (sharedNetwork) {
        if (d.endpoint?.host === "127.0.0.1") return null;
        return (await containerPresent(name(d))) ? d.endpoint : null;
      }
      return (await migrateTarget(name(d))) ? d.endpoint : null;
    },
  };
}
