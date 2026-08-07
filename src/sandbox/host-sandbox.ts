import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { arch } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { WorkspaceLayer } from "../types.ts";
import { createKeyedQueue } from "../util/async.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { createExecProcessSessions, type ExecProcessIo } from "./exec-process-session.ts";
import { materializeRoLayers } from "./ro-layers.ts";
import type {
  AgentComputerProfile,
  ExecOptions,
  ExecResult,
  ProvisionOptions,
  Sandbox,
  SandboxHandle,
} from "./sandbox.ts";

const OUTPUT_LIMIT = 4 * 1024 * 1024;

export interface HostSandboxOptions {
  rootDir?: string;
  workspacesRoot?: string;
  defaultTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

async function checkedPath(root: string, relPath: string): Promise<string> {
  if (!relPath || relPath.includes("\0") || isAbsolute(relPath))
    throw new Error(`workspace path must be relative: ${relPath}`);
  const target = resolve(root, relPath);
  if (!inside(root, target)) throw new Error(`workspace path escapes the configured root: ${relPath}`);
  let probe = target;
  while (inside(root, probe)) {
    try {
      const probeStats = await lstat(probe);
      if (probeStats.isSymbolicLink()) {
        const resolvedProbe = await realpath(probe).catch(() => null);
        if (!resolvedProbe || !inside(root, resolvedProbe))
          throw new Error(`workspace path escapes through a symlink: ${relPath}`);
        return target;
      }
      const resolvedProbe = await realpath(probe);
      if (!inside(root, resolvedProbe)) throw new Error(`workspace path escapes through a symlink: ${relPath}`);
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (probe === root) break;
      probe = dirname(probe);
    }
  }
  return target;
}

async function collectFiles(root: string, relDir: string): Promise<string[]> {
  const base = await checkedPath(root, relDir || ".");
  const entries = await readdir(base, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const out: string[] = [];
  for (const entry of entries) {
    const rel = relative(root, resolve(base, entry.name));
    if (entry.isFile()) out.push(rel);
    else if (entry.isDirectory()) out.push(...(await collectFiles(root, rel)));
  }
  return out;
}

function safeSegment(value: string): string | null {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) ? value : null;
}

export function hostWorkspaceDirectory(environmentId: string): string {
  const projectPrefix = "group:web-project-";
  if (environmentId.startsWith(projectPrefix)) {
    const projectId = safeSegment(environmentId.slice(projectPrefix.length));
    if (projectId) return `project-${projectId}`;
  }
  const channelPrefix = "channel:";
  if (environmentId.startsWith(channelPrefix)) {
    const channelId = safeSegment(environmentId.slice(channelPrefix.length));
    if (channelId) return `channel-${channelId}`;
  }
  const label = safeSegment(environmentId)?.slice(0, 72) ?? "environment";
  const hash = createHash("sha256").update(environmentId).digest("hex").slice(0, 16);
  return `${label}-${hash}`;
}

function environmentIdFrom(layers: WorkspaceLayer[], opts?: ProvisionOptions): string {
  const writable = layers.find((layer) => layer.mode === "rw")?.scopeId;
  const id = writable ?? opts?.routeScopeId;
  if (!id) throw new Error("host workspace requires a writable environment scope");
  return id;
}

export function createHostSandbox(workspace: WorkspaceStore, options: HostSandboxOptions): Sandbox {
  const rootDir = options.rootDir ? resolve(options.rootDir) : undefined;
  const workspacesRoot = options.workspacesRoot ? resolve(options.workspacesRoot) : undefined;
  if ((rootDir ? 1 : 0) + (workspacesRoot ? 1 : 0) !== 1)
    throw new Error("host sandbox requires exactly one of rootDir or workspacesRoot");
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 300_000;
  const queue = createKeyedQueue<string>();
  const profile: AgentComputerProfile = {
    backend: "host-workspace",
    writablePersistence: "resident_disk",
    processSessions: true,
    egressEnforcement: "none",
    spec: {
      os: `Host OS on ${arch()} (trusted workspace directories)`,
      runtimes: ["host runtimes"],
      tools: ["host PATH"],
    },
  };

  async function runCommand(handle: SandboxHandle, command: string, opts?: ExecOptions): Promise<ExecResult> {
    return queue(
      handle.id,
      () =>
        new Promise<ExecResult>((resolveResult) => {
          const child = spawn("/bin/sh", ["-lc", command], {
            cwd: handle.rootDir,
            env: { ...options.env, ...handle.env },
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "";
          let stderr = "";
          let timedOut = false;
          let settled = false;
          const append = (prior: string, chunk: Buffer): string => (prior + chunk.toString("utf8")).slice(-OUTPUT_LIMIT);
          child.stdout.on("data", (chunk: Buffer) => {
            stdout = append(stdout, chunk);
          });
          child.stderr.on("data", (chunk: Buffer) => {
            stderr = append(stderr, chunk);
          });
          const stop = (signal: NodeJS.Signals) => {
            if (!child.pid) return;
            try {
              process.kill(-child.pid, signal);
            } catch {
              child.kill(signal);
            }
          };
          const timeout = setTimeout(() => {
            timedOut = true;
            stop("SIGKILL");
          }, opts?.timeoutMs ?? defaultTimeoutMs);
          const onAbort = () => stop("SIGTERM");
          opts?.signal?.addEventListener("abort", onAbort, { once: true });
          child.on("error", (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            opts?.signal?.removeEventListener("abort", onAbort);
            resolveResult({ stdout, stderr: `${stderr}${error.message}`, code: 1, timedOut });
          });
          child.on("close", (code, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            opts?.signal?.removeEventListener("abort", onAbort);
            resolveResult({ stdout, stderr, code: timedOut ? 124 : (code ?? (signal ? 128 : 1)), timedOut });
          });
        }),
    );
  }

  const processes = createExecProcessSessions({ run: runCommand } satisfies ExecProcessIo);
  const sandbox: Sandbox = {
    profile,
    ...processes,

    async provision(layers, opts) {
      if (opts?.scratch) throw new Error("scratch execution is unavailable with host workspaces");
      const environmentId = environmentIdFrom(layers, opts);
      if (rootDir) {
        const homeDir = resolve(rootDir, "data/host-home");
        const tmpDir = resolve(rootDir, "data/host-tmp");
        await mkdir(homeDir, { recursive: true });
        await mkdir(tmpDir, { recursive: true });
        const rootStats = await stat(rootDir);
        if (!rootStats.isDirectory()) throw new Error(`HOST_WORKSPACE_ROOT is not a directory: ${rootDir}`);
        const handle: SandboxHandle = {
          id: "host-workspace",
          rootDir: await realpath(rootDir),
          homeDir: await realpath(homeDir),
          scopeId: environmentId,
          env: { ...opts?.env, HOME: await realpath(homeDir), TMPDIR: await realpath(tmpDir) },
        };
        await materializeRoLayers(
          workspace,
          layers,
          handle,
          {
            readFile: (h, path) => sandbox.readFile(h, path),
            writeFileBytes: (h, path, data) => sandbox.writeFileBytes(h, path, data),
            exec: async (script, timeoutSec) => {
              const result = await sandbox.run(handle, script, { timeoutMs: timeoutSec * 1000 });
              return { code: result.code, stderr: result.stderr };
            },
          },
          { manifest: ".qm-ro-layers.sha256", tar: ".qm-ro-layers.tar", label: "host workspace" },
        );
        return handle;
      }
      await mkdir(workspacesRoot!, { recursive: true });
      const configuredRoot = await realpath(workspacesRoot!);
      const contextDir = resolve(configuredRoot, hostWorkspaceDirectory(environmentId));
      const contextStats = await lstat(contextDir).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (contextStats?.isSymbolicLink()) throw new Error(`host workspace directory cannot be a symlink: ${contextDir}`);
      const workspaceDir = resolve(contextDir, "workspace");
      const homeDir = resolve(contextDir, "home");
      const tmpDir = resolve(contextDir, "tmp");
      await Promise.all([workspaceDir, homeDir, tmpDir].map((dir) => mkdir(dir, { recursive: true })));
      const [resolvedWorkspace, resolvedHome, resolvedTmp] = await Promise.all(
        [realpath(workspaceDir), realpath(homeDir), realpath(tmpDir)] as const,
      );
      if (![resolvedWorkspace, resolvedHome, resolvedTmp].every((dir) => inside(configuredRoot, dir)))
        throw new Error(`host workspace escapes the configured root: ${contextDir}`);
      const handle: SandboxHandle = {
        id: `host-workspace:${environmentId}`,
        rootDir: resolvedWorkspace,
        homeDir: resolvedHome,
        scopeId: environmentId,
        env: { ...opts?.env, HOME: resolvedHome, TMPDIR: resolvedTmp },
      };
      await materializeRoLayers(
        workspace,
        layers,
        handle,
        {
          readFile: (h, path) => sandbox.readFile(h, path),
          writeFileBytes: (h, path, data) => sandbox.writeFileBytes(h, path, data),
          exec: async (script, timeoutSec) => {
            const result = await sandbox.run(handle, script, { timeoutMs: timeoutSec * 1000 });
            return { code: result.code, stderr: result.stderr };
          },
        },
        { manifest: ".qm-ro-layers.sha256", tar: ".qm-ro-layers.tar", label: "host workspace" },
      );
      return handle;
    },

    run: runCommand,

    async readFileBytes(handle, relPath) {
      const path = await checkedPath(handle.rootDir, relPath);
      return readFile(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "EISDIR") return null;
        throw error;
      });
    },

    async readFile(handle, relPath) {
      const data = await sandbox.readFileBytes(handle, relPath);
      return data === null ? null : Buffer.from(data).toString("utf8");
    },

    async writeFileBytes(handle, relPath, data) {
      const path = await checkedPath(handle.rootDir, relPath);
      await queue(handle.id, async () => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, data);
      });
    },

    async writeFile(handle, relPath, data) {
      await sandbox.writeFileBytes(handle, relPath, Buffer.from(data, "utf8"));
    },

    async extractFiles(handle, entries) {
      for (const entry of entries) await sandbox.writeFileBytes(handle, entry.path, entry.data);
    },

    listDir(handle, relDir) {
      return collectFiles(handle.rootDir, relDir);
    },

    async removeDir(handle, relDir) {
      const path = await checkedPath(handle.rootDir, relDir);
      if (path === handle.rootDir) throw new Error(`refusing to remove host workspace ${basename(handle.rootDir)}`);
      await queue(handle.id, () => rm(path, { recursive: true, force: true }));
    },

    async teardown() {},
  };
  return sandbox;
}
