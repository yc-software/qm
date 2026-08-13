import type { Deployment, DeploymentVersion } from "./deploy-store.ts";
import type { DeployEndpoint, DeployProvider } from "./deploy-provider.ts";
import { relative } from "node:path/posix";
import { createHash, randomUUID } from "node:crypto";
import { spawnDockerExec, type DockerExec } from "../sandbox/docker-exec.ts";
import { connectDockerNetwork, ensureDockerNetwork, removeDockerNetwork } from "../sandbox/docker-network.ts";

const NETWORK = "agent-deploynet";
const APP_PORT = 8080;

export interface DockerDeployProviderOptions {
  image?: string;
  docker?: string;
  dockerExec?: DockerExec;
  coreContainer?: string;
  coreDataVolume?: string;
  coreDataDir?: string;
  network?: string;
  orgId?: string;
}

export function createDockerDeployProvider(opts: DockerDeployProviderOptions = {}): DeployProvider {
  if (Boolean(opts.coreDataVolume) !== Boolean(opts.coreDataDir)) {
    throw new Error("Docker core data volume and directory must be set together");
  }
  const docker = opts.docker ?? "docker";
  const image = opts.image ?? "node:24-alpine";
  const network = opts.network ?? NETWORK;
  const owner = opts.orgId ?? "default";
  const dexec = opts.dockerExec ?? spawnDockerExec(docker);
  let volumeSubpathSupport: Promise<void> | undefined;

  const resourceKey = (d: Deployment) => createHash("sha256").update(`${owner}\0${d.id}`).digest("hex").slice(0, 24);
  const name = (d: Deployment) => `agent-deploy-${resourceKey(d)}`;
  const legacyName = (d: Deployment) => `agent-deploy-${d.id.slice(0, 12)}`;
  const deploymentNetwork = (d: Deployment) => `${network}-${resourceKey(d)}`;
  const ensureNetwork = async (d: Deployment): Promise<void> => {
    await ensureDockerNetwork(dexec, deploymentNetwork(d), {
      ...(opts.coreContainer ? { member: opts.coreContainer } : {}),
      ...(opts.coreContainer ? { memberAlias: "core" } : {}),
      labels: { "qm.org": owner, "qm.deploy.id": d.id },
    });
  };
  const containerInfo = async (
    d: Deployment,
  ): Promise<{ running: boolean; version: number; orgId: string; deploymentId: string; provision: string } | null> => {
    const inspected = await dexec([
      "inspect",
      "-f",
      '{{.State.Running}} {{index .Config.Labels "qm.deploy.version"}} {{index .Config.Labels "qm.org"}} {{index .Config.Labels "qm.deploy.id"}} {{index .Config.Labels "qm.provision"}}',
      name(d),
    ]);
    if (inspected.code !== 0) return null;
    const [running = "", version = "", orgId = "", deploymentId = "", provision = ""] = inspected.stdout
      .trim()
      .split(/\s+/);
    return { running: running === "true", version: Number(version), orgId, deploymentId, provision };
  };
  const removeOwnedContainer = async (d: Deployment, provision?: string): Promise<boolean> => {
    const info = await containerInfo(d);
    if (!info) return true;
    if (info.orgId !== owner || info.deploymentId !== d.id) {
      throw new Error(`Docker deployment container ${name(d)} is not owned by ${owner}/${d.id}`);
    }
    if (provision && info.provision !== provision) return false;
    await dexec(["rm", "-f", name(d)]);
    return true;
  };
  const rejectAmbiguousLegacyContainer = async (d: Deployment): Promise<void> => {
    const mounts = await dexec(["inspect", "-f", "{{json .Mounts}}", legacyName(d)]);
    if (mounts.code !== 0) return;
    let parsed: Array<{ Source?: string; Destination?: string; Type?: string; RW?: boolean }>;
    try {
      parsed = JSON.parse(mounts.stdout) as Array<{
        Source?: string;
        Destination?: string;
        Type?: string;
        RW?: boolean;
      }>;
    } catch {
      return;
    }
    const snapshots = new Set(d.versions.map((version) => version.snapshotDir));
    const exactLegacyBind = parsed.some(
      (mount) =>
        mount.Type === "bind" &&
        mount.Destination === "/app" &&
        mount.RW === false &&
        mount.Source &&
        snapshots.has(mount.Source),
    );
    if (!exactLegacyBind) return;
    if (!opts.coreContainer) {
      const legacyRemoved = await dexec(["rm", "-f", legacyName(d)]);
      if (legacyRemoved.code !== 0 && !/not found|no such/i.test(legacyRemoved.stderr)) {
        throw new Error(`docker rm ${legacyName(d)} failed: ${legacyRemoved.stderr.trim()}`);
      }
      const removed = await dexec(["network", "rm", NETWORK]);
      if (removed.code !== 0 && !/active endpoints|not found|no such/i.test(removed.stderr)) {
        throw new Error(`docker network rm ${NETWORK} failed: ${removed.stderr.trim()}`);
      }
      return;
    }
    throw new Error(
      `legacy Docker deployment ${legacyName(d)} has no organization label; verify its owner, remove it explicitly, and retry`,
    );
  };
  const cleanup = async (d: Deployment, provision?: string): Promise<void> => {
    if (!(await removeOwnedContainer(d, provision))) return;
    await removeDockerNetwork(dexec, deploymentNetwork(d), opts.coreContainer);
  };
  const ensureVolumeSubpathSupport = async (): Promise<void> => {
    if (!opts.coreDataVolume) return;
    volumeSubpathSupport ??= (async () => {
      const result = await dexec(["version", "-f", "{{.Server.Version}}"]).catch(() => ({
        code: 1,
        stdout: "",
        stderr: "",
      }));
      const major = Number(result.stdout.trim().match(/^(\d+)/)?.[1]);
      if (result.code !== 0 || !Number.isFinite(major) || major < 26) {
        throw new Error("Docker Engine 26 or newer is required for containerized core deployments");
      }
    })();
    try {
      await volumeSubpathSupport;
    } catch (error) {
      volumeSubpathSupport = undefined;
      throw error;
    }
  };
  const endpoint = async (d: Deployment, version: DeploymentVersion): Promise<DeployEndpoint | null> => {
    const info = await containerInfo(d);
    if (!info?.running || info.version !== version.version || info.orgId !== owner || info.deploymentId !== d.id)
      return null;
    for (const [label, expected] of [
      ["qm.org", owner],
      ["qm.deploy.id", d.id],
    ] as const) {
      const inspected = await dexec(["network", "inspect", "-f", `{{index .Labels "${label}"}}`, deploymentNetwork(d)]);
      if (inspected.code !== 0 || inspected.stdout.trim() !== expected) return null;
    }
    if (opts.coreContainer) {
      if (!(await connectDockerNetwork(dexec, deploymentNetwork(d), opts.coreContainer, "core"))) return null;
      return { host: name(d), port: APP_PORT };
    }
    const port = await dexec(["port", name(d), `${APP_PORT}/tcp`]);
    const match = port.stdout
      .split("\n")[0]
      ?.trim()
      .match(/:(\d+)$/);
    if (port.code !== 0 || !match) return null;
    return { host: "127.0.0.1", port: Number(match[1]) };
  };
  const mount = (version: DeploymentVersion): string[] => {
    if (!opts.coreDataVolume || !opts.coreDataDir) return ["-v", `${version.snapshotDir}:/app:ro`];
    const subpath = relative(opts.coreDataDir, version.snapshotDir);
    if (!subpath || subpath === ".." || subpath.startsWith("../") || subpath.includes(",")) {
      throw new Error(`deploy snapshot is outside Docker core data: ${version.snapshotDir}`);
    }
    return ["--mount", `type=volume,src=${opts.coreDataVolume},dst=/app,readonly,volume-subpath=${subpath}`];
  };

  return {
    profile: { managedScaleToZero: false },

    async apply(d: Deployment, version: DeploymentVersion): Promise<DeployEndpoint> {
      const mountArgs = mount(version);
      await ensureVolumeSubpathSupport();
      await rejectAmbiguousLegacyContainer(d);
      await removeOwnedContainer(d);
      await ensureNetwork(d);
      const provision = randomUUID();
      const envArgs = Object.entries(version.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      const r = await dexec([
        "run",
        "-d",
        "--name",
        name(d),
        "--label",
        `qm.deploy.version=${version.version}`,
        "--label",
        `qm.org=${owner}`,
        "--label",
        `qm.deploy.id=${d.id}`,
        "--label",
        `qm.provision=${provision}`,
        "--network",
        deploymentNetwork(d),
        "--memory",
        "512m",
        "--cpus",
        "1",
        "--pids-limit",
        "256",
        ...(opts.coreContainer ? [] : ["-p", `127.0.0.1::${APP_PORT}`]),
        ...mountArgs,
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
        await cleanup(d, provision);
        throw new Error(`deploy run failed: ${r.stderr.trim()}`);
      }
      const resolved = await endpoint(d, version);
      if (resolved) return resolved;
      await cleanup(d, provision);
      throw new Error(`deploy run failed: cannot resolve endpoint for ${name(d)}`);
    },

    async destroy(d: Deployment): Promise<void> {
      await rejectAmbiguousLegacyContainer(d);
      await cleanup(d);
    },

    resolveEndpoint: endpoint,
  };
}
