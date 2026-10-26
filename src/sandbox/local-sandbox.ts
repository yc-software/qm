import { createHash } from "node:crypto";
import { orgId as configOrgId } from "../config.ts";
import { arch } from "node:os";
import { join } from "node:path";
import { readdir, readFile as fsReadFile } from "node:fs/promises";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { sleep } from "../util/async.ts";
import { errMessage } from "../util/errors.ts";
import { dockerContainerNetworks, ensureDockerNetwork, spawnDockerExec, type DockerExec } from "./docker-exec.ts";
import { sandboxScopeName } from "./exec-sandbox-base.ts";
import { createProviderSandbox, type SandboxShared, type StoredSandboxRecord } from "./provider-sandbox.ts";
import type { ExecResult, Sandbox } from "./sandbox.ts";

const DEFAULT_LOCAL_SANDBOX_IMAGE = "qm-sandbox-local:latest";
const HOME_DIR = "/root";
const AGENT_PORT = 8080;
const FINGERPRINT_LABEL = "qm.sandbox-fingerprint";
const BUILD_HINT = "run `npm run sandbox:local:build`";
const DEFAULT_PREFIX = "qm";

export type { DockerExec };

export type StoredLocalSandbox = StoredSandboxRecord;

export interface LocalSandboxOptions extends SandboxShared {
  image?: string;
  dockerBin?: string;
  coreContainer?: string;
  homeDir?: string;
  repoRoot?: string;
  dockerExec?: DockerExec;
  fetchImpl?: typeof fetch;
  store: DurableMap<StoredLocalSandbox>;
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

const sibling = (kind: "home" | "net", containerName: string, prefix: string): string =>
  `${prefix}-${kind}-${containerName.slice(prefix.length + 1)}`;
export const localContainerName = (scopeId: string, prefix = DEFAULT_PREFIX): string =>
  sandboxScopeName(prefix, scopeId);
export const localVolumeName = (scopeId: string, prefix = DEFAULT_PREFIX): string =>
  sibling("home", localContainerName(scopeId, prefix), prefix);
export const localNetworkName = (containerName: string, prefix = DEFAULT_PREFIX): string =>
  sibling("net", containerName, prefix);

export function createLocalSandbox(workspace: WorkspaceStore, opts: LocalSandboxOptions): Sandbox {
  const image = opts.image ?? DEFAULT_LOCAL_SANDBOX_IMAGE;
  const dexec = opts.dockerExec ?? spawnDockerExec(opts.dockerBin ?? "docker");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const homeDir = opts.homeDir ?? HOME_DIR;
  const prefix = opts.namePrefix ?? DEFAULT_PREFIX;
  const networkOf = (name: string): string => localNetworkName(name, prefix);
  const volumeOf = (name: string): string => sibling("home", name, prefix);

  const portByName = new Map<string, number>();
  const attached = new Set<string>();

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
      return img.stdout.trim();
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

  async function attachCore(name: string): Promise<void> {
    if (!opts.coreContainer || attached.has(name)) return;
    const net = await ensureDockerNetwork(dexec, networkOf(name));
    const r = await dexec(["network", "connect", net, opts.coreContainer]);
    if (r.code !== 0 && !(await dockerContainerNetworks(dexec, opts.coreContainer))?.includes(net)) {
      throw new Error(`docker network connect ${net} ${opts.coreContainer} failed: ${r.stderr.trim()}`);
    }
    attached.add(name);
  }

  async function daemon(
    name: string,
    path: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<{ status: number; text: string }> {
    await attachCore(name);
    const url = opts.coreContainer
      ? `http://${name}:${AGENT_PORT}${path}`
      : `http://127.0.0.1:${await resolvePort(name)}${path}`;
    const res = await fetchImpl(url, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      signal: AbortSignal.timeout(timeoutMs ?? 30_000),
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

  async function runContainer(name: string, withVolume: boolean): Promise<void> {
    await preflight();
    const net = await ensureDockerNetwork(dexec, networkOf(name));
    if (withVolume && (await dexec(["volume", "inspect", volumeOf(name)])).code !== 0) {
      const created = await dexec(["volume", "create", volumeOf(name)]);
      if (created.code !== 0)
        throw new Error(`docker volume create ${volumeOf(name)} failed: ${created.stderr.trim()}`);
    }
    const r = await dexec(
      [
        "run",
        "-d",
        "--name",
        name,
        "--label",
        "qm.sandbox=1",
        "--label",
        `qm.org=${configOrgId()}`,
        "--label",
        "agent_env=dev",
        "--network",
        net,
        ...(withVolume ? ["-v", `${volumeOf(name)}:${homeDir}`] : []),
        ...(opts.coreContainer ? [] : ["-p", `127.0.0.1:0:${AGENT_PORT}`]),
        "--add-host=host.docker.internal:host-gateway",
        ...(opts.cpus ? ["--cpus", String(opts.cpus)] : []),
        ...(opts.memoryMb ? ["--memory", `${opts.memoryMb}m`] : []),
        image,
      ],
      120_000,
    );
    if (r.code !== 0) throw new Error(`docker run ${name} failed: ${r.stderr.trim()}`);
    portByName.delete(name);
    await waitDaemon(name);
  }

  async function recreate(name: string): Promise<void> {
    await dexec(["rm", "-f", name]);
    await runContainer(name, true);
  }

  async function ensureRunning(name: string): Promise<void> {
    const state = await containerState(name);
    if (!state) throw new Error(`local sandbox container ${name} is gone`);
    if (!state.running) await startContainer(name);
  }

  async function execRaw(name: string, command: string, timeoutSec: number): Promise<ExecResult> {
    await ensureRunning(name);
    const res = await daemon(name, "/exec", { cmd: command, timeoutSec }, (timeoutSec + 15) * 1000);
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

  async function destroy(name: string): Promise<void> {
    const remove = async (args: string[]) => {
      const result = await dexec(args);
      if (result.code !== 0) throw new Error(`docker ${args.join(" ")}: ${result.stderr.trim()}`);
    };
    await remove(["rm", "-f", name]);
    portByName.delete(name);
    attached.delete(name);
    if (opts.coreContainer) {
      const result = await dexec(["network", "disconnect", "-f", networkOf(name), opts.coreContainer]);
      if (result.code !== 0 && (await dockerContainerNetworks(dexec, opts.coreContainer))?.includes(networkOf(name)))
        throw new Error(`docker network disconnect ${networkOf(name)}: ${result.stderr.trim()}`);
    }
    await remove(["network", "rm", "-f", networkOf(name)]);
    await remove(["volume", "rm", "-f", volumeOf(name)]);
  }

  return createProviderSandbox(
    workspace,
    {
      backend: "local-docker",
      homeDir,
      os: `Debian 12 (bookworm), glibc — local Docker container on a ${arch()} host`,
      runtimes: ["Node 24", "Python 3 (venv on PATH — `pip install` just works)"],
      tools: ["git", "curl", "wget", "jq", "unzip", "gnupg", "python3", "gh", "aws"],
      ...(opts.cpus ? { cpus: opts.cpus } : {}),
      ...(opts.memoryMb ? { memoryMb: opts.memoryMb } : {}),
      egressEnforcement: "none",
      exec: execRaw,
      writeAbsBytes,
      readAbsBytes,
      async inspect(name) {
        const imageId = await preflight();
        const state = await containerState(name);
        if (!state) return null;
        const current = state.imageId === imageId;
        return {
          state: state.running && current ? "running" : "parked",
          detail: `container ${name} ${state.running ? "running" : "stopped"}${current ? "" : " on a superseded image"}`,
        };
      },
      create: (name, { scratch }) => runContainer(name, !scratch),
      async resume(name) {
        const imageId = await preflight();
        const state = await containerState(name);
        if (!state || state.imageId !== imageId) await recreate(name);
        else if (!state.running) await startContainer(name);
      },
      async park(name, { keepWarm }) {
        if (keepWarm) return;
        portByName.delete(name);
        const r = await dexec(["stop", "-t", "2", name], 60_000);
        if (r.code !== 0) throw new Error(`docker stop ${name} failed: ${r.stderr.trim()}`);
      },
      restart: recreate,
      destroy,
      isLive: () => false,
    },
    opts,
    opts.store,
  );
}
