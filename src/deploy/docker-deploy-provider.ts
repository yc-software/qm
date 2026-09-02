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
  endpointHost?: string;
  networkInternal?: boolean;
  controlNetwork?: string;
  controlProxyImage?: string;
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
  if (opts.controlNetwork && opts.networkInternal !== true) {
    throw new Error("controlNetwork requires networkInternal=true");
  }
  if (!!opts.controlNetwork !== !!opts.controlProxyImage) {
    throw new Error("controlNetwork requires controlProxyImage");
  }
  if (opts.controlProxyImage && !/^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$/.test(opts.controlProxyImage)) {
    throw new Error("controlProxyImage requires an immutable digest");
  }
  const docker = opts.docker ?? "docker";
  const image = opts.image ?? "node:24-alpine";
  const endpointHost = opts.endpointHost ?? "127.0.0.1";
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
  const controlName = (d: Deployment) => `qm-control-${name(d)}`;
  const network = (d: Deployment) => `${name(d)}-net`;
  const ensureNetwork = async (net: string): Promise<string> => {
    const existing = await dexec(["network", "inspect", "-f", "{{.Internal}}", net]);
    if (existing.code === 0) {
      if (opts.networkInternal && existing.stdout.trim() !== "true") {
        throw new Error(`docker network ${net} must be internal`);
      }
    } else {
      if (!/no such network|network .* not found/i.test(existing.stderr)) {
        throw new Error(`docker network inspect ${net} failed: ${existing.stderr.trim()}`);
      }
      const r = await dexec(["network", "create", ...(opts.networkInternal ? ["--internal"] : []), net]);
      if (r.code !== 0 && !/already exists/i.test(r.stderr)) {
        throw new Error(`docker network create ${net} failed: ${r.stderr.trim()}`);
      }
      if (opts.controlNetwork) {
        const created = await dexec(["network", "inspect", "-f", "{{.Internal}}", net]);
        if (created.code !== 0) {
          throw new Error(`docker network inspect ${net} failed: ${created.stderr.trim()}`);
        }
        if (created.stdout.trim() !== "true") throw new Error(`docker network ${net} must be internal`);
      }
    }
    return net;
  };
  const ensureControlProxy = async (d: Deployment, net: string): Promise<void> => {
    if (!opts.controlNetwork) return;
    if (!opts.controlProxyImage) throw new Error("controlNetwork requires controlProxyImage");
    const proxy = controlName(d);
    const expected = await dexec(["image", "inspect", "-f", "{{.Id}}", opts.controlProxyImage]);
    if (expected.code !== 0) throw new Error(`control proxy image ${opts.controlProxyImage} is unavailable`);
    const inspected = await dexec(["inspect", "-f", "{{.State.Running}} {{.Image}}", proxy]);
    let needsCreate = inspected.code !== 0;
    if (inspected.code === 0) {
      const [running, imageId] = inspected.stdout.trim().split(/\s+/);
      if (!(await controlProxyMatches(proxy, d, net)) || imageId !== expected.stdout.trim()) {
        const removed = await dexec(["rm", "-f", proxy]);
        if (removed.code !== 0)
          throw new Error(`deploy control proxy ${proxy} removal failed: ${removed.stderr.trim()}`);
        needsCreate = true;
      } else if (running !== "true") {
        const started = await dexec(["start", proxy]);
        if (started.code !== 0) throw new Error(`deploy control proxy ${proxy} start failed: ${started.stderr.trim()}`);
      }
    }
    if (needsCreate) {
      const r = await dexec([
        "run",
        "-d",
        "--name",
        proxy,
        "--label",
        "qm.deploy-control=1",
        "--label",
        `qm.control-target=${name(d)}:${APP_PORT}`,
        "--read-only",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=16m",
        "--user",
        "65532:65532",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--pids-limit",
        "64",
        "--memory",
        "64m",
        "--cpus",
        "0.25",
        "--network",
        net,
        "--network-alias",
        "control",
        opts.controlProxyImage,
        "socat",
        `TCP-LISTEN:${APP_PORT},fork,reuseaddr`,
        `TCP:${name(d)}:${APP_PORT}`,
      ]);
      if (r.code !== 0) {
        throw new Error(`deploy control proxy ${proxy} failed: ${r.stderr.trim()}`);
      }
    }
    const connected = await dexec(["network", "connect", opts.controlNetwork, proxy]);
    if (connected.code !== 0 && !/already (?:exists|connected)/i.test(connected.stderr)) {
      throw new Error(`docker network connect ${opts.controlNetwork} ${proxy} failed: ${connected.stderr.trim()}`);
    }
  };
  const controlProxyMatches = async (proxy: string, d: Deployment, workloadNetwork: string): Promise<boolean> => {
    const label = await dexec(["inspect", "-f", '{{index .Config.Labels "qm.deploy-control"}}', proxy]);
    if (label.code !== 0 || label.stdout.trim() !== "1") return false;
    const networks = await dexec(["inspect", "-f", "{{json .NetworkSettings.Networks}}", proxy]);
    if (networks.code !== 0) return false;
    try {
      const attached = JSON.parse(networks.stdout) as Record<string, unknown>;
      if (
        JSON.stringify(Object.keys(attached).sort()) !== JSON.stringify([workloadNetwork, opts.controlNetwork!].sort())
      )
        return false;
    } catch {
      return false;
    }
    const command = await dexec(["inspect", "-f", "{{json .Config.Cmd}}", proxy]);
    if (command.code !== 0) return false;
    try {
      if (
        JSON.stringify(JSON.parse(command.stdout)) !==
        JSON.stringify(["socat", `TCP-LISTEN:${APP_PORT},fork,reuseaddr`, `TCP:${name(d)}:${APP_PORT}`])
      )
        return false;
    } catch {
      return false;
    }
    const hardening = await dexec([
      "inspect",
      "-f",
      "{{.Config.User}}|{{.HostConfig.ReadonlyRootfs}}|{{json .HostConfig.CapDrop}}|{{json .HostConfig.SecurityOpt}}|{{.HostConfig.PidsLimit}}|{{.HostConfig.Memory}}|{{.HostConfig.NanoCpus}}|{{json .HostConfig.Tmpfs}}",
      proxy,
    ]);
    if (hardening.code !== 0) return false;
    const [user, readOnly, capDrop, securityOpt, pids, memory, cpus, tmpfs] = hardening.stdout.trim().split("|");
    try {
      return (
        user === "65532:65532" &&
        readOnly === "true" &&
        JSON.parse(capDrop ?? "[]").includes("ALL") &&
        JSON.parse(securityOpt ?? "[]").includes("no-new-privileges:true") &&
        pids === "64" &&
        memory === "67108864" &&
        cpus === "250000000" &&
        JSON.parse(tmpfs ?? "{}")["/tmp"] === "rw,noexec,nosuid,size=16m"
      );
    } catch {
      return false;
    }
  };
  const destroyControlProxy = async (d: Deployment): Promise<void> => {
    if (!opts.controlNetwork) return;
    const proxy = controlName(d);
    const r = await dexec(["rm", "-f", proxy]);
    if (r.code !== 0 && !/no such (?:object|container)|not found/i.test(r.stderr)) {
      throw new Error(`deploy control proxy ${proxy} removal failed: ${r.stderr.trim()}`);
    }
  };
  const removeContainerIfPresent = async (container: string): Promise<void> => {
    const r = await dexec(["rm", "-f", container]);
    if (r.code !== 0 && !/no such (?:object|container)|not found/i.test(r.stderr)) {
      throw new Error(`docker rm ${container} failed: ${r.stderr.trim()}`);
    }
  };
  const hasPublishedPorts = async (container: string): Promise<boolean | null> => {
    const inspected = await dexec(["inspect", "-f", "{{json .HostConfig.PortBindings}}", container]);
    if (inspected.code !== 0) {
      if (/no such (?:object|container)|not found/i.test(inspected.stderr)) return null;
      throw new Error(`docker inspect ${container} failed: ${inspected.stderr.trim()}`);
    }
    try {
      const bindings = JSON.parse(inspected.stdout) as Record<string, unknown> | null;
      return bindings !== null && Object.keys(bindings).length > 0;
    } catch {
      throw new Error(`docker inspect ${container} returned invalid published-port state`);
    }
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
      await dexec(["rm", "-f", name(d)]);
      const hostPort = opts.controlNetwork ? undefined : allocPort(name(d));
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
        ...(hostPort === undefined ? [] : ["-p", `127.0.0.1:${hostPort}:${APP_PORT}`]),
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
      try {
        await ensureControlProxy(d, net);
      } catch (e) {
        await dexec(["rm", "-f", name(d)]);
        await dexec(["network", "rm", net]);
        freePort(name(d));
        throw e;
      }
      return opts.controlNetwork ? { host: controlName(d), port: APP_PORT } : { host: endpointHost, port: hostPort! };
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
        await destroyControlProxy(d);
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
      if (opts.controlNetwork) {
        if ((await hasPublishedPorts(name(d))) !== false) return null;
        if (!(await migrateTarget(name(d)))) return null;
        await ensureControlProxy(d, network(d));
        return { host: controlName(d), port: APP_PORT };
      }
      if (!(await migrateTarget(name(d)))) return null;
      return d.endpoint;
    },
  };
}
