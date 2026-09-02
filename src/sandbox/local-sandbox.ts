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
import { ephemeralCredLinkScript } from "../credentials/resident-paths.ts";
import { ephemeralCredLinkPaths } from "../credentials/resident-paths.ts";
import { shortHash } from "../util/crypto.ts";
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
  coreContainer?: string;
  agentHost?: string;
  networkInternal?: boolean;
  controlNetwork?: string;
  controlProxyImage?: string;
  daemonReadyTimeoutMs?: number;
  defaultTimeoutSec?: number;
  homeDir?: string;
  repoRoot?: string;
  dockerExec?: DockerExec;
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

export const localContainerName = (scopeId: string): string => `qm-sbx-${localSlug(scopeId)}`;
export const localVolumeName = (scopeId: string): string => `qm-home-${localSlug(scopeId)}`;
export const localNetworkName = (containerName: string): string =>
  `qm-net-${containerName.replace(/^qm-(sbx|scratch)-/, "")}`;
const localScratchName = (key: string): string => `qm-scratch-${localSlug(key)}`;
const localControlName = (name: string): string => `qm-control-${name}`;

function localSlug(id: string): string {
  const cleaned = id
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${cleaned.slice(0, 40).replace(/-+$/, "") || "scope"}-${shortHash(id)}`;
}

export function createLocalSandbox(workspace: WorkspaceStore, opts: LocalSandboxOptions = {}): Sandbox {
  if (opts.controlNetwork && opts.networkInternal !== true) {
    throw new Error("controlNetwork requires networkInternal=true");
  }
  if (!!opts.controlNetwork !== !!opts.controlProxyImage) {
    throw new Error("controlNetwork requires controlProxyImage");
  }
  if (opts.controlProxyImage && !/^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$/.test(opts.controlProxyImage)) {
    throw new Error("controlProxyImage requires an immutable digest");
  }
  const image = opts.image ?? DEFAULT_LOCAL_SANDBOX_IMAGE;
  const controlProxyImage = opts.controlNetwork ? opts.controlProxyImage : undefined;
  const dexec = opts.dockerExec ?? spawnDockerExec(opts.dockerBin ?? "docker");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const defaultTimeoutSec = opts.defaultTimeoutSec ?? 600;
  const homeDir = opts.homeDir ?? HOME_DIR;
  const workspaceDir = `${homeDir}/${WORKSPACE_BASENAME}`;
  const provisionQueue = createKeyedQueue<string>();

  const portByName = new Map<string, number>();
  const scopeByContainer = new Map<string, string>();
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
      const img = await dexec(["image", "inspect", "-f", "{{.Id}}", image]);
      if (img.code !== 0) {
        preflightDone = undefined;
        throw new Error(`local sandbox image ${image} not found — ${BUILD_HINT}`);
      }
      const imageId = img.stdout.trim();
      const label = await dexec([
        "image",
        "inspect",
        "-f",
        `{{if .Config.Labels}}{{index .Config.Labels "${FINGERPRINT_LABEL}"}}{{end}}`,
        image,
      ]);
      const labeled = label.code === 0 ? label.stdout.trim() : "";
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

  async function containerState(name: string): Promise<{ running: boolean; imageId: string } | null> {
    const r = await dexec(["inspect", "-f", "{{.State.Running}} {{.Image}}", name]);
    if (r.code !== 0) return null;
    const [running = "", imageId = ""] = r.stdout.trim().split(/\s+/);
    return { running: running === "true", imageId };
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
    let base: string;
    if (opts.controlNetwork) base = `http://${localControlName(name)}:${AGENT_PORT}${path}`;
    else if (opts.coreContainer) base = `http://${name}:${AGENT_PORT}${path}`;
    else base = `http://${opts.agentHost ?? "127.0.0.1"}:${await resolvePort(name)}${path}`;
    const signals = [AbortSignal.timeout(timeoutMs ?? 30_000), ...(signal ? [signal] : [])];
    const res = await fetchImpl(base, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      signal: AbortSignal.any(signals),
    });
    return { status: res.status, text: await res.text() };
  }

  async function waitDaemon(name: string): Promise<void> {
    const deadline = Date.now() + (opts.daemonReadyTimeoutMs ?? 30_000);
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
    const net = await ensureNetwork(name);
    await connectCore(net);
    await ensureControlProxy(name, net);
    await waitDaemon(name);
  }

  async function ensureRunning(name: string): Promise<void> {
    const state = await containerState(name);
    if (!state) throw new Error(`local sandbox container ${name} is gone`);
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

  async function ensureNetwork(name: string): Promise<string> {
    const net = localNetworkName(name);
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
  }

  async function connectCore(net: string): Promise<void> {
    if (opts.controlNetwork) return;
    if (!opts.coreContainer) return;
    const r = await dexec(["network", "connect", net, opts.coreContainer]);
    if (r.code !== 0 && !/already (?:exists|connected)/i.test(r.stderr)) {
      throw new Error(`docker network connect ${net} ${opts.coreContainer} failed: ${r.stderr.trim()}`);
    }
  }

  async function ensureControlProxy(name: string, net: string): Promise<void> {
    if (!opts.controlNetwork) return;
    if (!controlProxyImage) throw new Error("controlNetwork requires controlProxyImage");
    const proxy = localControlName(name);
    const expected = await dexec(["image", "inspect", "-f", "{{.Id}}", controlProxyImage]);
    if (expected.code !== 0) throw new Error(`control proxy image ${controlProxyImage} is unavailable`);
    const expectedImageId = expected.stdout.trim();
    let state = await containerState(proxy);
    if (state && (!(await controlProxyMatches(proxy, name, net)) || state.imageId !== expectedImageId)) {
      const removed = await dexec(["rm", "-f", proxy]);
      if (removed.code !== 0) throw new Error(`docker rm ${proxy} failed: ${removed.stderr.trim()}`);
      state = null;
    }
    if (!state) {
      const r = await dexec([
        "run",
        "-d",
        "--name",
        proxy,
        "--label",
        "qm.sandbox-control=1",
        "--label",
        `qm.control-target=${name}:${AGENT_PORT}`,
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
        controlProxyImage,
        "socat",
        `TCP-LISTEN:${AGENT_PORT},fork,reuseaddr`,
        `TCP:${name}:${AGENT_PORT}`,
      ]);
      if (r.code !== 0) throw new Error(`docker run ${proxy} failed: ${r.stderr.trim()}`);
    } else if (!state.running) {
      const r = await dexec(["start", proxy]);
      if (r.code !== 0) throw new Error(`docker start ${proxy} failed: ${r.stderr.trim()}`);
    }
    const connected = await dexec(["network", "connect", opts.controlNetwork, proxy]);
    if (connected.code !== 0 && !/already (?:exists|connected)/i.test(connected.stderr)) {
      throw new Error(`docker network connect ${opts.controlNetwork} ${proxy} failed: ${connected.stderr.trim()}`);
    }
  }

  async function controlProxyMatches(proxy: string, target: string, workloadNetwork: string): Promise<boolean> {
    const label = await dexec(["inspect", "-f", '{{index .Config.Labels "qm.sandbox-control"}}', proxy]);
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
        JSON.stringify(["socat", `TCP-LISTEN:${AGENT_PORT},fork,reuseaddr`, `TCP:${target}:${AGENT_PORT}`])
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
  }

  async function destroyControlProxy(name: string): Promise<void> {
    if (!opts.controlNetwork) return;
    const proxy = localControlName(name);
    const r = await dexec(["rm", "-f", proxy]);
    if (r.code !== 0 && !/no such (?:object|container)|not found/i.test(r.stderr)) {
      throw new Error(`docker rm ${proxy} failed: ${r.stderr.trim()}`);
    }
  }

  async function removeContainerIfPresent(name: string): Promise<void> {
    const r = await dexec(["rm", "-f", name]);
    if (r.code !== 0 && !/no such (?:object|container)|not found/i.test(r.stderr)) {
      throw new Error(`docker rm ${name} failed: ${r.stderr.trim()}`);
    }
  }

  async function disconnectCore(net: string): Promise<void> {
    if (!opts.coreContainer) return;
    await dexec(["network", "disconnect", net, opts.coreContainer]).catch(
      swallowAs("local-sandbox: network disconnect", undefined),
    );
  }

  async function runContainer(name: string, scope: string | undefined, withVolume: boolean): Promise<void> {
    const net = await ensureNetwork(name);
    const args = [
      "run",
      "-d",
      "--name",
      name,
      "--label",
      "qm.sandbox=1",
      ...(scope ? ["--label", `qm.scope=${scope}`] : []),
      "--label",
      `qm.org=${configOrgId()}`,
      "--label",
      "agent_env=dev",
      "--network",
      net,
      ...(withVolume && scope ? ["-v", `${localVolumeName(scope)}:${homeDir}`] : []),
      ...(opts.coreContainer || opts.controlNetwork ? [] : ["-p", `127.0.0.1:0:${AGENT_PORT}`]),
      ...(opts.controlNetwork ? [] : ["--add-host=host.docker.internal:host-gateway"]),
      ...(opts.cpus ? ["--cpus", String(opts.cpus)] : []),
      ...(opts.memoryMb ? ["--memory", `${opts.memoryMb}m`] : []),
      image,
    ];
    const r = await dexec(args, 120_000);
    if (r.code !== 0) throw new Error(`docker run ${name} failed: ${r.stderr.trim()}`);
    try {
      portByName.delete(name);
      await connectCore(net);
      await ensureControlProxy(name, net);
      await waitDaemon(name);
    } catch (error) {
      await destroyControlProxy(name).catch(swallowAs("local-sandbox: control proxy rollback", undefined));
      await dexec(["rm", "-f", name]).catch(swallowAs("local-sandbox: workload rollback", undefined));
      await dexec(["network", "rm", net]).catch(swallowAs("local-sandbox: network rollback", undefined));
      portByName.delete(name);
      throw error;
    }
  }

  async function ensureContainer(scope: string): Promise<{ name: string; coldStart: boolean }> {
    return provisionQueue(scope, async () => {
      const imageId = await preflight();
      const name = localContainerName(scope);
      scopeByContainer.set(name, scope);
      const state = await containerState(name);
      if (state && state.imageId === imageId) {
        if (!state.running) await startContainer(name);
        else {
          const net = await ensureNetwork(name);
          await connectCore(net);
          await ensureControlProxy(name, net);
        }
        activeByContainer.set(name, (activeByContainer.get(name) ?? 0) + 1);
        return { name, coldStart: false };
      }
      if (state) await dexec(["rm", "-f", name]);
      const volume = localVolumeName(scope);
      const hadVolume = (await dexec(["volume", "inspect", volume])).code === 0;
      if (!hadVolume) {
        const created = await dexec(["volume", "create", volume]);
        if (created.code !== 0) throw new Error(`docker volume create ${volume} failed: ${created.stderr.trim()}`);
      }
      await runContainer(name, scope, true);
      activeByContainer.set(name, (activeByContainer.get(name) ?? 0) + 1);
      return { name, coldStart: !hadVolume };
    });
  }

  async function ensureScratch(key: string): Promise<{ name: string; coldStart: boolean }> {
    return provisionQueue(`scratch:${key}`, async () => {
      await preflight();
      const name = localScratchName(key);
      scratchByKey.set(key, name);
      const state = await containerState(name);
      if (state) {
        if (!state.running) await startContainer(name);
        else {
          const net = await ensureNetwork(name);
          await connectCore(net);
          await ensureControlProxy(name, net);
        }
        activeByContainer.set(name, (activeByContainer.get(name) ?? 0) + 1);
        return { name, coldStart: false };
      }
      await runContainer(name, undefined, false);
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
      os: `Debian 12 (bookworm), glibc — local Docker container on a ${arch()} host`,
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
          if (tdOpts?.destroy) await removeContainerIfPresent(handle.id);
          else await dexec(["rm", "-f", handle.id]).catch(swallowAs("local-sandbox: scratch rm", undefined));
          await destroyControlProxy(handle.id);
          await disconnectCore(localNetworkName(handle.id));
          await dexec(["network", "rm", localNetworkName(handle.id)]).catch(
            swallowAs("local-sandbox: scratch network rm", undefined),
          );
          portByName.delete(handle.id);
          return;
        }

        if (tdOpts?.keepWarm) return;

        if (tdOpts?.destroy) {
          await destroyControlProxy(handle.id);
          await dexec(["rm", "-f", handle.id]).catch(swallowAs("local-sandbox: destroy rm", undefined));
          await disconnectCore(localNetworkName(handle.id));
          await dexec(["network", "rm", localNetworkName(handle.id)]).catch(
            swallowAs("local-sandbox: destroy network rm", undefined),
          );
          const scope = scopeByContainer.get(handle.id);
          if (scope)
            await dexec(["volume", "rm", localVolumeName(scope)]).catch(
              swallowAs("local-sandbox: destroy volume rm", undefined),
            );
          scopeByContainer.delete(handle.id);
          portByName.delete(handle.id);
          return;
        }

        const r = await dexec(["stop", "-t", "2", handle.id], 60_000);
        if (r.code !== 0)
          opts.onError?.({
            category: "sandbox_park",
            code: "docker_stop_failed",
            message: r.stderr.trim(),
            ...(scopeByContainer.get(handle.id) ? { scopeLabel: scopeByContainer.get(handle.id)! } : {}),
          });
        portByName.delete(handle.id);
      });
    },
  };

  return sandbox;
}
