import { createHash, randomUUID } from "node:crypto";
import { orgId as configOrgId } from "../config.ts";
import { arch } from "node:os";
import { join } from "node:path";
import { readdir, readFile as fsReadFile } from "node:fs/promises";
import type { WorkspaceLayer } from "../types.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { createKeyedQueue, sleep } from "../util/async.ts";
import { swallowAs, errMessage } from "../util/errors.ts";
import { shq } from "../util/shell.ts";
import { nonInteractiveShellPrefix } from "./sandbox-env.ts";
import { createExecProcessSessions, type ExecProcessIo } from "./exec-process-session.ts";
import { materializeRoLayers } from "./ro-layers.ts";
import { createExecBackup, createExecFileOps, posixJoin } from "./exec-file-ops.ts";
import { spawnDockerExec, type DockerExec } from "./docker-exec.ts";
import { connectDockerNetwork, ensureDockerNetwork, removeDockerNetwork } from "./docker-network.ts";
import { ephemeralCredLinkScript } from "../credentials/resident-paths.ts";
import { ephemeralCredLinkPaths } from "../credentials/resident-paths.ts";
import { killableScript, killScript } from "./exec-kill.ts";
import type {
  AgentComputerProfile,
  ExecOptions,
  ExecResult,
  ProvisionOptions,
  Sandbox,
  SandboxHandle,
  TeardownOptions,
} from "./sandbox.ts";

const DEFAULT_LOCAL_SANDBOX_IMAGE = "qm-sandbox-local:latest";
const HOME_DIR = "/root";
const WORKSPACE_BASENAME = "workspace";
const AGENT_PORT = 8080;
const RO_LAYERS_TAR = ".ro-layers.tar";
const RO_LAYERS_MANIFEST = ".ro-layers.manifest";
const FINGERPRINT_LABEL = "qm.sandbox-fingerprint";
const BUILD_HINT = "run `npm run sandbox:local:build`";

export type { DockerExec };

export interface LocalSandboxOptions {
  image?: string;
  dockerBin?: string;
  cpus?: number;
  memoryMb?: number;
  defaultTimeoutSec?: number;
  homeDir?: string;
  repoRoot?: string;
  dockerExec?: DockerExec;
  coreContainer?: string;
  orgId?: string;
  fetchImpl?: typeof fetch;
  onError?: (e: { category: string; code: string; message: string; scopeLabel?: string }) => void;
}

const FINGERPRINT_FIXED_SOURCES = ["fly/Dockerfile", "local/Dockerfile", "aws/microvm-agent/agent.mjs"];

export async function computeSandboxImageFingerprint(repoRoot: string): Promise<string | null> {
  try {
    const tools = (await readdir(join(repoRoot, "fly/tools"))).sort().map((f) => `fly/tools/${f}`);
    const paths = [...FINGERPRINT_FIXED_SOURCES, ...tools].sort();
    const fp = createHash("sha256");
    for (const p of paths) {
      fp.update(p);
      fp.update("\0");
      fp.update(
        createHash("sha256")
          .update(await fsReadFile(join(repoRoot, p)))
          .digest(),
      );
      fp.update("\n");
    }
    return fp.digest("hex");
  } catch {
    return null;
  }
}

export const localContainerName = (scopeId: string, orgId = configOrgId()): string =>
  `qm-sbx-${localSlug(`${orgId}\0${scopeId}`)}`;
export const localVolumeName = (scopeId: string, orgId = configOrgId()): string =>
  `qm-home-${localSlug(`${orgId}\0${scopeId}`)}`;
export const localNetworkName = (containerName: string): string =>
  `qm-net-${containerName.replace(/^qm-(sbx|scratch)-/, "")}`;
const localScratchName = (key: string, orgId: string): string => `qm-scratch-${localSlug(`${orgId}\0${key}`)}`;
export const localMigrationOwnerName = (scopeId: string, orgId = configOrgId()): string =>
  `qm-volume-${localSlug(`${orgId}\0${scopeId}`)}`;
const legacyContainerName = (scopeId: string): string => `qm-sbx-${legacySlug(scopeId)}`;
const legacyVolumeName = (scopeId: string): string => `qm-home-${legacySlug(scopeId)}`;

function localSlug(id: string): string {
  const cleaned = id
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const digest = createHash("sha256").update(id).digest("hex").slice(0, 20);
  return `${cleaned.slice(0, 31).replace(/-+$/, "") || "scope"}-${digest}`;
}

function legacySlug(id: string): string {
  const cleaned = id
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const digest = createHash("sha256").update(id).digest("hex").slice(0, 6);
  return `${cleaned.slice(0, 40).replace(/-+$/, "") || "scope"}-${digest}`;
}

export function createLocalSandbox(workspace: WorkspaceStore, opts: LocalSandboxOptions = {}): Sandbox {
  const image = opts.image ?? DEFAULT_LOCAL_SANDBOX_IMAGE;
  const dexec = opts.dockerExec ?? spawnDockerExec(opts.dockerBin ?? "docker");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const defaultTimeoutSec = opts.defaultTimeoutSec ?? 600;
  const homeDir = opts.homeDir ?? HOME_DIR;
  const orgId = opts.orgId ?? configOrgId();
  const workspaceDir = `${homeDir}/${WORKSPACE_BASENAME}`;
  const provisionQueue = createKeyedQueue<string>();

  const portByName = new Map<string, number>();
  const scopeByContainer = new Map<string, string>();
  const volumeByContainer = new Map<string, string>();
  const scratchByKey = new Map<string, string>();
  const activeByContainer = new Map<string, number>();

  let preflightDone: Promise<string> | undefined;
  let staleWarned = false;

  async function preflight(): Promise<string> {
    preflightDone ??= (async () => {
      const version = await dexec(["version"], 15_000);
      if (version.code !== 0) {
        preflightDone = undefined;
        throw new Error("SANDBOX_BACKEND=local requires a running Docker daemon (is Docker Desktop running?)");
      }
      const img = await dexec([
        "image",
        "inspect",
        "-f",
        `{{.Id}} {{if .Config.Labels}}{{index .Config.Labels "${FINGERPRINT_LABEL}"}}{{end}}`,
        image,
      ]);
      if (img.code !== 0) {
        preflightDone = undefined;
        throw new Error(`local sandbox image ${image} not found — ${BUILD_HINT}`);
      }
      const [imageId = "", labeled = ""] = img.stdout.trim().split(/\s+/);
      if (!staleWarned) {
        const want = await computeSandboxImageFingerprint(opts.repoRoot ?? process.cwd());
        if (want && labeled && labeled !== want) {
          staleWarned = true;
          console.warn(`[local-sandbox] sandbox image ${image} is stale — ${BUILD_HINT}`);
        }
      }
      return imageId;
    })();
    return preflightDone;
  }

  async function createVolume(scope: string, volume: string, migration = false): Promise<void> {
    const created = await dexec([
      "volume",
      "create",
      "--label",
      `qm.org=${orgId}`,
      "--label",
      `qm.scope=${scope}`,
      ...(migration ? ["--label", "qm.migration=legacy-v1"] : []),
      volume,
    ]);
    if (created.code !== 0) throw new Error(`docker volume create ${volume} failed: ${created.stderr.trim()}`);
  }

  async function finishLegacyMigration(scope: string, name: string): Promise<void> {
    await dexec(["rm", "-f", name]);
    await removeDockerNetwork(dexec, localNetworkName(name), opts.coreContainer);
    const removed = await dexec(["volume", "rm", legacyVolumeName(scope)]);
    if (removed.code !== 0) throw new Error(`local sandbox migration source cleanup failed: ${removed.stderr.trim()}`);
  }

  async function migrationComplete(scope: string, volume: string): Promise<boolean> {
    const ownerName = localMigrationOwnerName(scope, orgId);
    const inspected = await dexec([
      "inspect",
      "-f",
      '{{.State.Running}} {{index .Config.Labels "qm.volume-owner"}} {{index .Config.Labels "qm.volume-org"}} {{index .Config.Labels "qm.scope"}}',
      ownerName,
    ]);
    if (inspected.code !== 0) return false;
    const [running = "", owner = "", inspectedOrg = "", inspectedScope = ""] = inspected.stdout.trim().split(/\s+/);
    if (owner !== "1" || inspectedOrg !== orgId || inspectedScope !== scope) return false;
    if ((await containerVolume(ownerName)) !== volume) return false;
    if (running === "true") return true;
    return (await dexec(["start", ownerName])).code === 0;
  }

  async function createMigrationOwner(scope: string, volume: string): Promise<void> {
    if (await migrationComplete(scope, volume)) return;
    const ownerName = localMigrationOwnerName(scope, orgId);
    if ((await dexec(["inspect", ownerName])).code === 0) {
      throw new Error(`local sandbox migration owner ${ownerName} is not owned by ${orgId}/${scope}`);
    }
    const created = await dexec([
      "run",
      "-d",
      "--name",
      ownerName,
      "--restart",
      "unless-stopped",
      "--label",
      "qm.volume-owner=1",
      "--label",
      `qm.volume-org=${orgId}`,
      "--label",
      `qm.scope=${scope}`,
      "-v",
      `${volume}:${homeDir}:ro`,
      image,
      "sh",
      "-c",
      "while :; do sleep 86400; done",
    ]);
    if (created.code !== 0 || !(await migrationComplete(scope, volume))) {
      throw new Error(`local sandbox migration owner create failed: ${created.stderr.trim()}`);
    }
  }

  async function migrateLegacyVolume(scope: string, name: string, wasRunning: boolean): Promise<string> {
    const source = legacyVolumeName(scope);
    const target = localVolumeName(scope, orgId);
    if ((await dexec(["volume", "inspect", target])).code === 0) {
      if (await migrationComplete(scope, target)) {
        await finishLegacyMigration(scope, name);
        return target;
      }
      const removed = await dexec(["volume", "rm", target]);
      if (removed.code !== 0) throw new Error(`local sandbox migration reset failed: ${removed.stderr.trim()}`);
    }
    if (wasRunning) {
      const stopped = await dexec(["stop", "-t", "2", name], 60_000);
      if (stopped.code !== 0) throw new Error(`local sandbox migration stop failed: ${stopped.stderr.trim()}`);
    }
    await createVolume(scope, target, true);
    const copied = await dexec([
      "run",
      "--rm",
      "-v",
      `${source}:/from:ro`,
      "-v",
      `${target}:/to`,
      image,
      "sh",
      "-c",
      "cp -a /from/. /to/",
    ]);
    if (copied.code !== 0) {
      await dexec(["volume", "rm", target]);
      if (wasRunning) await dexec(["start", name]);
      throw new Error(`local sandbox volume migration failed: ${copied.stderr.trim()}`);
    }
    await createMigrationOwner(scope, target);
    await finishLegacyMigration(scope, name);
    return target;
  }

  async function volumeLabel(volume: string, label: string): Promise<string> {
    const result = await dexec(["volume", "inspect", "-f", `{{index .Labels "${label}"}}`, volume]);
    return result.code === 0 ? result.stdout.trim() : "";
  }

  async function assertVolumeOwnership(scope: string, volume: string): Promise<void> {
    const [inspectedOrg, inspectedScope] = await Promise.all([
      volumeLabel(volume, "qm.org"),
      volumeLabel(volume, "qm.scope"),
    ]);
    if (inspectedOrg !== orgId || inspectedScope !== scope) {
      throw new Error(`local sandbox volume ${volume} is not owned by ${orgId}/${scope}`);
    }
  }

  async function containerState(
    name: string,
  ): Promise<{ running: boolean; imageId: string; orgId: string; scope: string; provision: string } | null> {
    const r = await dexec([
      "inspect",
      "-f",
      '{{.State.Running}} {{.Image}} {{index .Config.Labels "qm.org"}} {{index .Config.Labels "qm.scope"}} {{index .Config.Labels "qm.provision"}}',
      name,
    ]);
    if (r.code !== 0) return null;
    const [running = "", imageId = "", inspectedOrgId = "", scope = "", provision = ""] = r.stdout.trim().split(/\s+/);
    return { running: running === "true", imageId, orgId: inspectedOrgId, scope, provision };
  }

  async function containerVolume(name: string): Promise<string> {
    const r = await dexec([
      "inspect",
      "-f",
      `{{range .Mounts}}{{if eq .Destination "${homeDir}"}}{{.Name}}{{end}}{{end}}`,
      name,
    ]);
    return r.code === 0 ? r.stdout.trim() : "";
  }

  async function resolvePort(name: string): Promise<number> {
    const cached = portByName.get(name);
    if (cached) return cached;
    const r = await dexec(["port", name, `${AGENT_PORT}/tcp`]);
    const m = r.stdout
      .split("\n")[0]
      ?.trim()
      .match(/:(\d+)$/);
    if (r.code !== 0 || !m)
      throw new Error(`local sandbox ${name}: cannot resolve agent port: ${r.stderr.trim() || r.stdout.trim()}`);
    const port = Number(m[1]);
    portByName.set(name, port);
    return port;
  }

  async function daemon(
    name: string,
    path: string,
    body?: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<{ status: number; text: string }> {
    const address = opts.coreContainer ? `${name}:${AGENT_PORT}` : `127.0.0.1:${await resolvePort(name)}`;
    const signals = [AbortSignal.timeout(timeoutMs ?? 30_000), ...(signal ? [signal] : [])];
    const res = await fetchImpl(`http://${address}${path}`, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      signal: AbortSignal.any(signals),
    });
    return { status: res.status, text: await res.text() };
  }

  async function waitDaemon(name: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    let lastErr = "";
    while (Date.now() < deadline) {
      try {
        const res = await daemon(name, "/health", undefined, 3000);
        if (res.status === 200) return;
        lastErr = `http ${res.status}`;
      } catch (e) {
        lastErr = errMessage(e);
      }
      await sleep(300);
    }
    throw new Error(`local sandbox ${name}: exec daemon never became reachable: ${lastErr}`);
  }

  async function startContainer(name: string): Promise<void> {
    portByName.delete(name);
    const r = await dexec(["start", name]);
    if (r.code !== 0) throw new Error(`docker start ${name} failed: ${r.stderr.trim()}`);
    await waitDaemon(name);
  }

  async function ensureRunning(name: string): Promise<void> {
    const state = await containerState(name);
    if (!state) throw new Error(`local sandbox container ${name} is gone`);
    await ensureNetwork(name, true);
    if (!state.running) await startContainer(name);
  }

  async function execRaw(name: string, command: string, timeoutSec: number, signal?: AbortSignal): Promise<ExecResult> {
    const res = await daemon(name, "/exec", { cmd: command, timeoutSec }, (timeoutSec + 15) * 1000, signal);
    if (res.status !== 200) throw new Error(`local sandbox exec failed (${res.status}): ${res.text.slice(0, 300)}`);
    const j = JSON.parse(res.text) as { stdout: string; stderr: string; code: number; timedOut: boolean };
    return { stdout: j.stdout ?? "", stderr: j.stderr ?? "", code: j.code, timedOut: !!j.timedOut };
  }

  async function writeAbsBytes(name: string, absPath: string, data: Uint8Array): Promise<void> {
    const res = await daemon(name, "/write", { path: absPath, b64: Buffer.from(data).toString("base64") }, 120_000);
    if (res.status !== 200)
      throw new Error(`local sandbox write ${absPath} failed (${res.status}): ${res.text.slice(0, 200)}`);
  }

  async function readAbsBytes(name: string, absPath: string): Promise<Uint8Array | null> {
    const res = await daemon(name, "/read", { path: absPath }, 120_000);
    if (res.status === 404) return null;
    if (res.status !== 200)
      throw new Error(`local sandbox read ${absPath} failed (${res.status}): ${res.text.slice(0, 200)}`);
    return Buffer.from((JSON.parse(res.text) as { b64: string }).b64, "base64");
  }

  async function ensureNetwork(name: string, connectSandbox = false): Promise<string> {
    const net = localNetworkName(name);
    await ensureDockerNetwork(dexec, net, {
      ...(opts.coreContainer ? { member: opts.coreContainer } : {}),
      ...(opts.coreContainer ? { memberAlias: "core" } : {}),
      labels: { "qm.org": orgId },
    });
    if (connectSandbox && !(await connectDockerNetwork(dexec, net, name))) {
      throw new Error(`docker network connect ${net} ${name} failed: network not found`);
    }
    return net;
  }

  async function removeNetwork(name: string, disconnectSandbox = false): Promise<void> {
    if (disconnectSandbox) {
      const disconnected = await dexec(["network", "disconnect", "-f", localNetworkName(name), name]);
      if (disconnected.code !== 0 && !/not found|no such|not connected/i.test(disconnected.stderr)) {
        throw new Error(
          `docker network disconnect ${localNetworkName(name)} ${name} failed: ${disconnected.stderr.trim()}`,
        );
      }
    }
    await removeDockerNetwork(dexec, localNetworkName(name), opts.coreContainer);
  }

  async function runContainer(name: string, scope: string | undefined, volume?: string): Promise<void> {
    const net = await ensureNetwork(name);
    const provision = randomUUID();
    const args = [
      "run",
      "-d",
      "--name",
      name,
      "--label",
      "qm.sandbox=1",
      ...(scope ? ["--label", `qm.scope=${scope}`] : []),
      "--label",
      `qm.org=${orgId}`,
      "--label",
      `qm.provision=${provision}`,
      "--label",
      "agent_env=dev",
      "--network",
      net,
      ...(scope && volume ? ["-v", `${volume}:${homeDir}`] : []),
      ...(opts.coreContainer ? [] : ["-p", `127.0.0.1:0:${AGENT_PORT}`]),
      "--add-host=host.docker.internal:host-gateway",
      ...(opts.cpus ? ["--cpus", String(opts.cpus)] : []),
      ...(opts.memoryMb ? ["--memory", `${opts.memoryMb}m`] : []),
      image,
    ];
    const r = await dexec(args, 120_000);
    if (r.code !== 0) {
      if ((await containerState(name))?.provision === provision) {
        await dexec(["rm", "-f", name]);
        await removeNetwork(name).catch(swallowAs("local-sandbox: failed run network rm", undefined));
      }
      throw new Error(`docker run ${name} failed: ${r.stderr.trim()}`);
    }
    portByName.delete(name);
    try {
      await waitDaemon(name);
    } catch (error) {
      if ((await containerState(name))?.provision === provision) {
        await dexec(["rm", "-f", name]);
        await removeNetwork(name).catch(swallowAs("local-sandbox: failed readiness network rm", undefined));
      }
      throw error;
    }
  }

  async function ensureContainer(scope: string): Promise<{ name: string; coldStart: boolean }> {
    return provisionQueue(scope, async () => {
      const imageId = await preflight();
      const name = localContainerName(scope, orgId);
      const state = await containerState(name);
      let volume = localVolumeName(scope, orgId);
      const targetExists = (await dexec(["volume", "inspect", volume])).code === 0;
      if (state && (state.orgId !== orgId || state.scope !== scope)) {
        throw new Error(`local sandbox container ${name} is not owned by ${orgId}/${scope}`);
      }
      if (state && !targetExists) throw new Error(`local sandbox container ${name} has no durable volume ${volume}`);
      if (targetExists) await assertVolumeOwnership(scope, volume);
      if (state && (await containerVolume(name)) !== volume) {
        throw new Error(`local sandbox container ${name} does not mount ${volume}`);
      }
      if (!state) {
        const legacyName = legacyContainerName(scope);
        const legacyState = await containerState(legacyName);
        const legacyVolume = legacyVolumeName(scope);
        const legacyExists = (await dexec(["volume", "inspect", legacyVolume])).code === 0;
        if (
          targetExists &&
          (await volumeLabel(volume, "qm.migration")) === "legacy-v1" &&
          !legacyExists &&
          !(await migrationComplete(scope, volume))
        ) {
          throw new Error(`local sandbox migration target ${volume} is incomplete`);
        }
        const resumableMigration = targetExists && (await volumeLabel(volume, "qm.migration")) === "legacy-v1";
        if (legacyState?.orgId === orgId && legacyState.scope === scope && (!targetExists || resumableMigration)) {
          if ((await containerVolume(legacyName)) !== legacyVolume) {
            throw new Error(`legacy local sandbox container ${legacyName} does not mount ${legacyVolume}`);
          }
          volume = await migrateLegacyVolume(scope, legacyName, legacyState.running);
        } else if (targetExists && legacyExists && !legacyState) {
          if ((await volumeLabel(volume, "qm.migration")) === "legacy-v1") {
            if (!(await migrationComplete(scope, volume))) {
              throw new Error(`local sandbox migration target ${volume} is incomplete`);
            }
            await finishLegacyMigration(scope, legacyName);
          }
        } else if (legacyState && !targetExists) {
          throw new Error(`legacy local sandbox container ${legacyName} is not owned by ${orgId}/${scope}`);
        } else if (!legacyState && legacyExists) {
          throw new Error(
            `legacy local sandbox volume ${legacyVolumeName(scope)} has no owning container; copy it into ${volume} labeled qm.org=${orgId} and qm.scope=${scope}`,
          );
        }
      }
      scopeByContainer.set(name, scope);
      volumeByContainer.set(name, volume);
      if (state && state.imageId === imageId) {
        await ensureNetwork(name, true);
        if (!state.running) await startContainer(name);
        activeByContainer.set(name, (activeByContainer.get(name) ?? 0) + 1);
        return { name, coldStart: false };
      }
      if (state) await dexec(["rm", "-f", name]);
      const hadVolume = (await dexec(["volume", "inspect", volume])).code === 0;
      if (!hadVolume) {
        await createVolume(scope, volume);
      }
      await runContainer(name, scope, volume);
      activeByContainer.set(name, (activeByContainer.get(name) ?? 0) + 1);
      return { name, coldStart: !hadVolume };
    });
  }

  async function ensureScratch(key: string): Promise<{ name: string; coldStart: boolean }> {
    return provisionQueue(`scratch:${key}`, async () => {
      await preflight();
      const name = localScratchName(key, orgId);
      scratchByKey.set(key, name);
      const state = await containerState(name);
      if (state) {
        if (state.orgId !== orgId || state.scope) {
          throw new Error(`local scratch container ${name} is not owned by ${orgId}`);
        }
        await ensureNetwork(name, true);
        if (!state.running) await startContainer(name);
        activeByContainer.set(name, (activeByContainer.get(name) ?? 0) + 1);
        return { name, coldStart: false };
      }
      await runContainer(name, undefined);
      activeByContainer.set(name, (activeByContainer.get(name) ?? 0) + 1);
      return { name, coldStart: true };
    });
  }

  function teardownQueueKey(handle: SandboxHandle): string {
    if (handle.scratch) {
      for (const [k, name] of scratchByKey) if (name === handle.id) return `scratch:${k}`;
      return handle.id;
    }
    return scopeByContainer.get(handle.id) ?? handle.id;
  }

  const profile: AgentComputerProfile = {
    backend: "local-docker",
    writablePersistence: "resident_disk",
    processSessions: true,
    egressEnforcement: "none",
    spec: {
      os: `Debian 12 (bookworm), glibc — local Docker container on a ${arch()} host (dev only)`,
      runtimes: ["Node 24", "Python 3 (venv on PATH — `pip install` just works)"],
      tools: ["git", "curl", "wget", "jq", "unzip", "gnupg", "python3", "gh", "aws (CLI v2)"],
      notInstalled: ["gcloud", "kubectl", "flyctl", "glab"],
      ...(opts.cpus ? { cpus: opts.cpus } : {}),
      ...(opts.memoryMb ? { memoryMb: opts.memoryMb } : {}),
      homeDir,
      workdir: workspaceDir,
    },
  };

  const procIo: ExecProcessIo = {
    async run(handle, command, execOpts): Promise<ExecResult> {
      const timeoutSec = execOpts?.timeoutMs ? Math.ceil(execOpts.timeoutMs / 1000) : defaultTimeoutSec;
      await ensureRunning(handle.id);
      return execRaw(handle.id, command, timeoutSec);
    },
  };
  const procSessions = createExecProcessSessions(procIo);

  const execFileOps = createExecFileOps({
    label: "local",
    exec: (id, script, t) => execRaw(id, script, t),
    writeInline: (id, abs, data) => writeAbsBytes(id, abs, data),
  });

  const execBackup = createExecBackup({
    label: "local",
    exec: (id, script, t) => execRaw(id, script, t),
    readAbsBytes,
    defaultHomeDir: homeDir,
    ephemeralCredentialPrefixes: ephemeralCredLinkPaths().map(({ rel }) => rel),
  });

  const sandbox: Sandbox = {
    profile,
    startProcess: procSessions.startProcess,
    readProcess: procSessions.readProcess,
    writeStdin: procSessions.writeStdin,
    signalProcess: procSessions.signalProcess,
    listProcesses: procSessions.listProcesses,
    ...execFileOps,

    async provision(layers: WorkspaceLayer[], provOpts?: ProvisionOptions): Promise<SandboxHandle> {
      const scratch = provOpts?.scratch;
      const writable = layers.find((l) => l.mode === "rw") ?? layers[0];
      const scope = writable?.scopeId ?? "default";
      const body = scratch ? await ensureScratch(scratch.key) : await ensureContainer(scope);
      const name = body.name;

      const env = provOpts?.env && Object.keys(provOpts.env).length ? provOpts.env : undefined;
      const handle: SandboxHandle = {
        id: name,
        rootDir: workspaceDir,
        homeDir,
        coldStart: body.coldStart,
        ...(scratch ? { scratch: true } : {}),
        ...(env ? { env } : {}),
      };

      try {
        const prep = await execRaw(name, `mkdir -p ${shq(workspaceDir)} && ${ephemeralCredLinkScript(homeDir)}`, 30);
        if (prep.code !== 0) throw new Error(`local sandbox provision prep failed: ${prep.stderr.slice(0, 200)}`);

        await materializeRoLayers(
          workspace,
          layers,
          handle,
          {
            readFile: (h, rel) => sandbox.readFile(h, rel),
            writeFileBytes: (h, rel, data) => sandbox.writeFileBytes(h, rel, data),
            exec: (script, t) => execRaw(name, script, t),
          },
          { manifest: RO_LAYERS_MANIFEST, tar: RO_LAYERS_TAR, label: "local" },
        );

        return handle;
      } catch (err) {
        await sandbox.teardown(handle).catch(swallowAs("local-sandbox: teardown after failed provision", undefined));
        throw err;
      }
    },

    async run(handle, command, execOpts?: ExecOptions): Promise<ExecResult> {
      const timeoutSec = execOpts?.timeoutMs ? Math.ceil(execOpts.timeoutMs / 1000) : defaultTimeoutSec;
      await ensureRunning(handle.id);
      const exports = Object.entries(handle.env ?? {})
        .map(([k, v]) => `export ${k}=${shq(v)}`)
        .join("; ");
      const script = `${nonInteractiveShellPrefix()}${exports ? exports + "; " : ""}cd ${handle.rootDir} 2>/dev/null; ${command}`;
      const signal = execOpts?.signal;
      if (!signal) return execRaw(handle.id, script, timeoutSec);
      const killUid = randomUUID();
      const fireKill = () => {
        execRaw(handle.id, killScript(killUid), 15).catch(swallowAs("local-sandbox: kill in-flight exec", undefined));
      };
      if (signal.aborted) fireKill();
      const onAbort = () => fireKill();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        return await execRaw(handle.id, killableScript(script, killUid), timeoutSec, signal);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },

    async writeFileBytes(handle, relPath, data): Promise<void> {
      await writeAbsBytes(handle.id, posixJoin(handle.rootDir, relPath), data);
    },
    async writeFile(handle, relPath, data): Promise<void> {
      await sandbox.writeFileBytes(handle, relPath, Buffer.from(data, "utf8"));
    },
    async readFileBytes(handle, relPath): Promise<Uint8Array | null> {
      return readAbsBytes(handle.id, posixJoin(handle.rootDir, relPath));
    },
    async readFile(handle, relPath): Promise<string | null> {
      const bytes = await sandbox.readFileBytes(handle, relPath);
      return bytes === null ? null : Buffer.from(bytes).toString("utf8");
    },

    backupComputer: execBackup.backupComputer,

    async teardown(handle, tdOpts?: TeardownOptions): Promise<void> {
      return provisionQueue(teardownQueueKey(handle), async () => {
        const remaining = (activeByContainer.get(handle.id) ?? 1) - 1;
        if (remaining > 0) {
          activeByContainer.set(handle.id, remaining);
          return;
        }
        activeByContainer.delete(handle.id);

        if (handle.scratch) {
          for (const [k, name] of scratchByKey) if (name === handle.id) scratchByKey.delete(k);
          if (tdOpts?.destroy) await dexec(["rm", "-f", handle.id]);
          else await dexec(["rm", "-f", handle.id]).catch(swallowAs("local-sandbox: scratch rm", undefined));
          await removeNetwork(handle.id).catch(swallowAs("local-sandbox: scratch network rm", undefined));
          portByName.delete(handle.id);
          return;
        }

        if (tdOpts?.keepWarm) return;

        if (tdOpts?.destroy) {
          await dexec(["rm", "-f", handle.id]).catch(swallowAs("local-sandbox: destroy rm", undefined));
          await removeNetwork(handle.id).catch(swallowAs("local-sandbox: destroy network rm", undefined));
          const volume = volumeByContainer.get(handle.id);
          const scope = scopeByContainer.get(handle.id);
          if (scope) await dexec(["rm", "-f", localMigrationOwnerName(scope, orgId)]);
          if (volume)
            await dexec(["volume", "rm", volume]).catch(swallowAs("local-sandbox: destroy volume rm", undefined));
          scopeByContainer.delete(handle.id);
          volumeByContainer.delete(handle.id);
          portByName.delete(handle.id);
          return;
        }

        const r = await dexec(["stop", "-t", "2", handle.id], 60_000);
        if (r.code !== 0) {
          opts.onError?.({
            category: "sandbox_park",
            code: "docker_stop_failed",
            message: r.stderr.trim(),
            ...(scopeByContainer.get(handle.id) ? { scopeLabel: scopeByContainer.get(handle.id)! } : {}),
          });
        } else {
          await removeNetwork(handle.id, true).catch(swallowAs("local-sandbox: parked network rm", undefined));
        }
        portByName.delete(handle.id);
      });
    },
  };

  return sandbox;
}
