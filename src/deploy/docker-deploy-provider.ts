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
    if (inspected.code !== 0) return false;
    let attached: Record<string, unknown>;
    try {
      attached = JSON.parse(inspected.stdout) as Record<string, unknown>;
    } catch {
      return false;
    }
    const target = `${container}-net`;
    try {
      await ensureNetwork(target);
    } catch {
      return false;
    }
    if (!(target in attached) && (await dexec(["network", "connect", target, container])).code !== 0) return false;
    if (LEGACY_NETWORK in attached && (await dexec(["network", "disconnect", LEGACY_NETWORK, container])).code !== 0)
      return false;
    return true;
  };

  let migrationRetryable = false;
  const migrateLegacyNetworks = async (): Promise<boolean> => {
    const listed = await dexec([
      "network",
      "inspect",
      "--format",
      "{{range .Containers}}{{println .Name}}{{end}}",
      LEGACY_NETWORK,
    ]);
    migrationRetryable = listed.code === 0;
    if (listed.code !== 0) return /no such network|not found/i.test(listed.stderr);
    let migrated = true;
    for (const container of listed.stdout
      .split(/\s+/)
      .filter((candidate) => /^agent-deploy-[a-zA-Z0-9_-]+$/.test(candidate))) {
      if (!(await migrateContainer(container))) migrated = false;
    }
    if (!migrated) return false;
    const removed = await dexec(["network", "rm", LEGACY_NETWORK]);
    if (removed.code === 0 || /no such network|not found/i.test(removed.stderr)) return true;
    const remaining = await dexec([
      "network",
      "inspect",
      "--format",
      "{{range .Containers}}{{println .Name}}{{end}}",
      LEGACY_NETWORK,
    ]);
    return (
      remaining.code === 0 &&
      !remaining.stdout.split(/\s+/).some((candidate) => /^agent-deploy-[a-zA-Z0-9_-]+$/.test(candidate))
    );
  };

  let migrationComplete = false;
  let migrationInFlight: Promise<boolean> | undefined;
  let migrationRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let migrationRetryDelayMs = 1000;
  const runMigration = (): Promise<boolean> => {
    if (migrationComplete) return Promise.resolve(true);
    if (migrationInFlight) return migrationInFlight;
    migrationInFlight = migrateLegacyNetworks()
      .then((complete) => {
        migrationComplete = complete;
        if (complete) {
          if (migrationRetryTimer) clearTimeout(migrationRetryTimer);
          migrationRetryTimer = undefined;
          migrationRetryDelayMs = 1000;
        } else if (!migrationRetryTimer) {
          const delay = migrationRetryable ? migrationRetryDelayMs : 30_000;
          migrationRetryDelayMs = Math.min(delay * 2, 30_000);
          migrationRetryTimer = setTimeout(() => {
            migrationRetryTimer = undefined;
            void runMigration();
          }, delay);
          migrationRetryTimer.unref();
        }
        return complete;
      })
      .finally(() => {
        migrationInFlight = undefined;
      });
    return migrationInFlight;
  };
  const ensureMigration = async (): Promise<void> => {
    if ((await runMigration()) || (await runMigration())) return;
    throw new Error("legacy Docker network migration incomplete");
  };
  void runMigration();

  return {
    profile: { managedScaleToZero: false },

    async apply(d: Deployment, version: DeploymentVersion): Promise<DeployEndpoint> {
      await ensureMigration();
      const net = await ensureNetwork(network(d));
      await dexec(["rm", "-f", name(d)]);
      const hostPort = allocPort(name(d));
      const envArgs = Object.entries(version.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      const r = await dexec([
        "run",
        "-d",
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
        version.entrypoint,
      ]);
      if (r.code !== 0) {
        await dexec(["rm", "-f", name(d)]);
        await dexec(["network", "rm", net]);
        freePort(name(d));
        throw new Error(`deploy run failed: ${r.stderr.trim()}`);
      }
      return { host: "127.0.0.1", port: hostPort };
    },

    async logs(d: Deployment, opts: { tailLines: number }): Promise<string | null> {
      await ensureMigration();
      const lines = Math.max(1, Math.min(2000, Math.floor(opts.tailLines)));
      const r = await dexec(["logs", "--tail", String(lines), name(d)]);
      if (r.code !== 0) return null;
      return `${r.stdout}${r.stderr}`;
    },

    async destroy(d: Deployment): Promise<void> {
      await ensureMigration();
      await dexec(["rm", "-f", name(d)]);
      await dexec(["network", "rm", network(d)]);
      freePort(name(d));
    },

    async resolveEndpoint(d): Promise<DeployEndpoint | null> {
      await ensureMigration();
      return (await migrateContainer(name(d))) ? d.endpoint : null;
    },
  };
}
