import { cleanupFailedProvision } from "./sandbox.ts";
import { createHash, randomUUID } from "node:crypto";
import { orgId as configOrgId } from "../config.ts";
import { arch } from "node:os";
import { join } from "node:path";
import { readdir, readFile as fsReadFile } from "node:fs/promises";
import { createKeyedQueue, sleep } from "../util/async.ts";
import { swallowAs, errMessage } from "../util/errors.ts";
import { shq } from "../util/shell.ts";
import { nonInteractiveShellPrefix } from "./sandbox-env.ts";
import { createExecProcessSessions, type ExecProcessIo } from "./exec-process-session.ts";
import { createExecExport, createExecFileOps, posixJoin } from "./exec-file-ops.ts";
import { dockerContainerNetworks, ensureDockerNetwork, spawnDockerExec, type DockerExec } from "./docker-exec.ts";
import { ephemeralCredLinkScript } from "../credentials/resident-paths.ts";
import { ephemeralCredLinkPaths } from "../credentials/resident-paths.ts";
import { hashId, shortHash } from "../util/crypto.ts";
import { sandboxTenant } from "./tenant-sandbox-shape.ts";
import { killableScript, killScript } from "./exec-kill.ts";
import { execFailureDetail } from "./sandbox.ts";
import type {
  AgentComputerProfile,
  ExecOptions,
  ExecResult,
  ProvisionOptions,
  Sandbox,
  SandboxHandle,
  TeardownOptions,
  ImageFor,
} from "./sandbox.ts";

const DEFAULT_LOCAL_SANDBOX_IMAGE = "qm-sandbox-local:latest";
const HOME_DIR = "/root";
const WORKSPACE_BASENAME = "workspace";
const AGENT_PORT = 8080;
const FINGERPRINT_LABEL = "qm.sandbox-fingerprint";
const BUILD_HINT = "run `npm run sandbox:local:build`";
const PREP_TIMEOUT_SEC = 30;

export type { DockerExec };

export interface LocalSandboxOptions {
  imageFor?: ImageFor;
  image?: string;
  dockerBin?: string;
  cpus?: number;
  coreContainer?: string;
  defaultTimeoutSec?: number;
  homeDir?: string;
  repoRoot?: string;
  dockerExec?: DockerExec;
  fetchImpl?: typeof fetch;
  onError?: (e: { category: string; code: string; message: string; scopeLabel?: string }) => void;
}

const FINGERPRINT_FIXED_SOURCES = ["fly/Dockerfile", "local/Dockerfile", "cli/templates/aws/microvm-agent/agent.mjs"];

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
const volumeForContainer = (name: string): string => name.replace("qm-sbx-", "qm-home-");
export const localVolumeName = (scopeId: string): string => volumeForContainer(localContainerName(scopeId));
export const localNetworkName = (containerName: string): string =>
  `qm-net-${containerName.replace(/^qm-(sbx|scratch)-/, "")}`;
const localScratchName = (key: string): string => `qm-scratch-${localSlug(key)}`;

function localSlug(id: string): string {
  const tenant = sandboxTenant();
  if (tenant !== undefined) return hashId([tenant, id], 32);
  const cleaned = id
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${cleaned.slice(0, 40).replace(/-+$/, "") || "scope"}-${shortHash(id)}`;
}

export function createLocalSandbox(opts: LocalSandboxOptions = {}): Sandbox {
  const image = opts.image ?? DEFAULT_LOCAL_SANDBOX_IMAGE;
  const dexec = opts.dockerExec ?? spawnDockerExec(opts.dockerBin ?? "docker");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const defaultTimeoutSec = opts.defaultTimeoutSec ?? 600;
  const homeDir = opts.homeDir ?? HOME_DIR;
  const workspaceDir = `${homeDir}/${WORKSPACE_BASENAME}`;
  const provisionQueue = createKeyedQueue<string>();

  const portByName = new Map<string, number>();
  const scopeByContainer = new Map<string, string>();
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
      if (opts.coreContainer) {
        const forwarding = await dexec(["exec", opts.coreContainer, "cat", "/proc/sys/net/ipv4/ip_forward"]);
        if (forwarding.code !== 0 || forwarding.stdout.trim() !== "0") {
          preflightDone = undefined;
          throw new Error(
            `local sandboxes require net.ipv4.ip_forward=0 in the core container: ${forwarding.stderr.trim() || forwarding.stdout.trim()}`,
          );
        }
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

  async function containerState(
    name: string,
  ): Promise<{ running: boolean; imageId: string; rawSocketsDisabled: boolean } | null> {
    const r = await dexec([
      "inspect",
      "-f",
      "[{{json .State.Running}},{{json .Image}},{{json .HostConfig.CapDrop}}]",
      name,
    ]);
    if (r.code !== 0) return null;
    try {
      const [running, imageId, droppedCapabilities] = JSON.parse(r.stdout) as [boolean, string, string[] | null];
      return { running, imageId, rawSocketsDisabled: droppedCapabilities?.includes("CAP_NET_RAW") ?? false };
    } catch (cause) {
      throw new Error(`docker inspect ${name} returned invalid container state: ${r.stdout}`, { cause });
    }
  }

  async function removeDockerResource(args: string[]): Promise<void> {
    const result = await dexec(args);
    if (result.code !== 0) throw new Error(`docker ${args.join(" ")}: ${result.stderr.trim()}`);
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
    await preflight();
    const base = opts.coreContainer
      ? `http://${name}:${AGENT_PORT}${path}`
      : `http://127.0.0.1:${await resolvePort(name)}${path}`;
    const signals = [AbortSignal.timeout(timeoutMs ?? 30_000), ...(signal ? [signal] : [])];
    const res = await fetchImpl(base, {
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
    await connectCore(await ensureNetwork(name));
    await waitDaemon(name);
  }

  async function ensureRunning(name: string): Promise<void> {
    const state = await containerState(name);
    if (!state) throw new Error(`local sandbox container ${name} is gone`);
    if (!state.rawSocketsDisabled)
      throw new Error(`local sandbox container ${name} retains NET_RAW and must be provisioned again before use`);
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
    return ensureDockerNetwork(dexec, localNetworkName(name));
  }

  async function connectCore(net: string): Promise<void> {
    if (!opts.coreContainer) return;
    await preflight();
    const r = await dexec(["network", "connect", net, opts.coreContainer]);
    if (r.code !== 0 && !(await dockerContainerNetworks(dexec, opts.coreContainer))?.includes(net)) {
      throw new Error(`docker network connect ${net} ${opts.coreContainer} failed: ${r.stderr.trim()}`);
    }
  }

  async function disconnectCore(net: string): Promise<void> {
    if (!opts.coreContainer) return;
    await dexec(["network", "disconnect", net, opts.coreContainer]).catch(
      swallowAs("local-sandbox: network disconnect", undefined),
    );
  }

  async function runContainer(
    name: string,
    scope: string | undefined,
    withVolume: boolean,
    memoryGb?: number,
    chosen?: string,
  ): Promise<void> {
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
      "--cap-drop=CAP_NET_RAW",
      ...(withVolume && scope ? ["-v", `${localVolumeName(scope)}:${homeDir}`] : []),
      ...(opts.coreContainer ? [] : ["-p", `127.0.0.1:0:${AGENT_PORT}`]),
      "--add-host=host.docker.internal:host-gateway",
      ...(opts.cpus ? ["--cpus", String(opts.cpus)] : []),
      ...(memoryGb ? ["--memory", `${memoryGb}g`] : []),
      chosen ?? image,
    ];
    const r = await dexec(args, 120_000);
    if (r.code !== 0) throw new Error(`docker run ${name} failed: ${r.stderr.trim()}`);
    portByName.delete(name);
    await connectCore(net);
    await waitDaemon(name);
  }

  async function ensureContainer(scope: string, memoryGb?: number): Promise<{ name: string; coldStart: boolean }> {
    const name = localContainerName(scope);
    return provisionQueue(name, async () => {
      let imageId = await preflight();
      const chosen = await opts.imageFor?.(scope);
      if (chosen) {
        const inspected = await dexec(["image", "inspect", "-f", "{{.Id}}", chosen]);
        if (inspected.code !== 0) throw new Error(`local sandbox image ${chosen} not found`);
        imageId = inspected.stdout.trim();
      }
      scopeByContainer.set(name, scope);
      const state = await containerState(name);
      if (state && state.imageId === imageId && state.rawSocketsDisabled) {
        if (!state.running) await startContainer(name);
        else await connectCore(await ensureNetwork(name));
        activeByContainer.set(name, (activeByContainer.get(name) ?? 0) + 1);
        return { name, coldStart: false };
      }
      if (state) await removeDockerResource(["rm", "-f", name]);
      const volume = localVolumeName(scope);
      const hadVolume = (await dexec(["volume", "inspect", volume])).code === 0;
      if (!hadVolume) {
        const created = await dexec(["volume", "create", volume]);
        if (created.code !== 0) throw new Error(`docker volume create ${volume} failed: ${created.stderr.trim()}`);
      }
      await runContainer(name, scope, true, memoryGb, chosen);
      activeByContainer.set(name, (activeByContainer.get(name) ?? 0) + 1);
      return { name, coldStart: !hadVolume };
    });
  }

  async function ensureScratch(key: string): Promise<{ name: string; coldStart: boolean }> {
    const name = localScratchName(key);
    return provisionQueue(name, async () => {
      await preflight();
      const state = await containerState(name);
      if (state?.rawSocketsDisabled) {
        if (!state.running) await startContainer(name);
        else await connectCore(await ensureNetwork(name));
        activeByContainer.set(name, (activeByContainer.get(name) ?? 0) + 1);
        return { name, coldStart: false };
      }
      if (state) await removeDockerResource(["rm", "-f", name]);
      await runContainer(name, undefined, false);
      activeByContainer.set(name, (activeByContainer.get(name) ?? 0) + 1);
      return { name, coldStart: true };
    });
  }

  const profile: AgentComputerProfile = {
    backend: "local-docker",
    sizesMemory: true,
    writablePersistence: "resident_disk",
    processSessions: true,
    parksOnTeardown: true,
    egressEnforcement: "none",
    spec: {
      os: `Debian 12 (bookworm), glibc — local Docker container on a ${arch()} host`,
      runtimes: ["Node 24", "Python 3 (venv on PATH — `pip install` just works)"],
      tools: ["git", "curl", "wget", "jq", "unzip", "gnupg", "python3", "gh", "aws (CLI v2)"],
      notInstalled: ["gcloud", "kubectl", "flyctl", "glab"],
      ...(opts.cpus ? { cpus: opts.cpus } : {}),
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

  const execExport = createExecExport({
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

    async provision(scope: string, provOpts?: ProvisionOptions): Promise<SandboxHandle> {
      const scratch = provOpts?.scratch;
      const body = scratch ? await ensureScratch(scratch.key) : await ensureContainer(scope, provOpts?.memoryGb);
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
        const prep = await execRaw(
          name,
          `mkdir -p ${shq(workspaceDir)} && ${ephemeralCredLinkScript(homeDir)}`,
          PREP_TIMEOUT_SEC,
        );
        if (prep.code !== 0)
          throw new Error(
            `local sandbox provision prep failed: ${execFailureDetail(prep, PREP_TIMEOUT_SEC).slice(0, 200)}`,
          );

        return handle;
      } catch (err) {
        await cleanupFailedProvision(sandbox, handle, err);
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
      const onAbort = () => fireKill();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        signal.throwIfAborted();
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

    exportFiles: execExport.exportFiles,

    async destroyScope(scopeId: string): Promise<void> {
      const name = localContainerName(scopeId);
      return provisionQueue(name, async () => {
        const network = localNetworkName(name);
        await removeDockerResource(["rm", "-f", name]);
        if (opts.coreContainer) {
          const result = await dexec(["network", "disconnect", "-f", network, opts.coreContainer]);
          if (result.code !== 0 && (await dockerContainerNetworks(dexec, opts.coreContainer))?.includes(network))
            throw new Error(`docker network disconnect ${network}: ${result.stderr.trim()}`);
        }
        await removeDockerResource(["network", "rm", "-f", network]);
        await removeDockerResource(["volume", "rm", "-f", localVolumeName(scopeId)]);
        activeByContainer.delete(name);
        scopeByContainer.delete(name);
        portByName.delete(name);
      });
    },

    async teardown(handle, tdOpts?: TeardownOptions): Promise<void> {
      return provisionQueue(handle.id, async () => {
        const remaining = (activeByContainer.get(handle.id) ?? 1) - 1;
        if (remaining > 0) {
          activeByContainer.set(handle.id, remaining);
          return;
        }
        activeByContainer.delete(handle.id);

        if (handle.scratch) {
          if (tdOpts?.destroy) await dexec(["rm", "-f", handle.id]);
          else await dexec(["rm", "-f", handle.id]).catch(swallowAs("local-sandbox: scratch rm", undefined));
          await disconnectCore(localNetworkName(handle.id));
          await dexec(["network", "rm", localNetworkName(handle.id)]).catch(
            swallowAs("local-sandbox: scratch network rm", undefined),
          );
          portByName.delete(handle.id);
          return;
        }

        if (tdOpts?.keepWarm) return;

        if (tdOpts?.destroy) {
          await dexec(["rm", "-f", handle.id]).catch(swallowAs("local-sandbox: destroy rm", undefined));
          await disconnectCore(localNetworkName(handle.id));
          await dexec(["network", "rm", localNetworkName(handle.id)]).catch(
            swallowAs("local-sandbox: destroy network rm", undefined),
          );
          await dexec(["volume", "rm", volumeForContainer(handle.id)]).catch(
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
