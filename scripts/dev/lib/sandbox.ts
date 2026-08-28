import { existsSync, openSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { writePidFile } from "./lease.ts";
import { run } from "./proc.ts";
import { ensureDockerDaemon } from "./postgres.ts";
import { bestEffortValue, sleep } from "./util.ts";

type RemoteBackend = "sprites" | "smolmachines" | "boxd";

interface RemoteBackendEnv {
  token: string;
  mint: string;
  prefix: string;
  egressProxyUrl: string;
  passthrough: string[];
  detail: string;
}

const REMOTE_BACKENDS: Record<RemoteBackend, RemoteBackendEnv> = {
  sprites: {
    token: "SPRITES_TOKEN",
    mint: "mint one with `sprite login`",
    prefix: "SPRITES_NAME_PREFIX",
    egressProxyUrl: "SPRITES_EGRESS_PROXY_URL",
    passthrough: [],
    detail: "Fly Sprites (api.sprites.dev)",
  },
  smolmachines: {
    token: "SMOLMACHINES_TOKEN",
    mint: "create an API key in the smolmachines console",
    prefix: "SMOLMACHINES_NAME_PREFIX",
    egressProxyUrl: "SMOLMACHINES_EGRESS_PROXY_URL",
    passthrough: ["SMOLMACHINES_IMAGE"],
    detail: "smolmachines (api.smolmachines.com)",
  },
  boxd: {
    token: "BOXD_API_KEY",
    mint: "mint one with `boxd auth keys create`",
    prefix: "BOXD_NAME_PREFIX",
    egressProxyUrl: "BOXD_EGRESS_PROXY_URL",
    passthrough: ["BOXD_BASE_URL", "BOXD_ORG"],
    detail: "boxd (boxd.sh)",
  },
};

export interface SandboxResolution {
  backend: "local" | RemoteBackend;
  env: Record<string, string>;
  detail: string;
  publicApiUrl: string | null;
  warnings: string[];
}

function worktreeSupportsLocalSandbox(worktree: string): boolean {
  return existsSync(join(worktree, "src/sandbox/local-sandbox.ts"));
}

async function localImagePresent(image: string): Promise<boolean> {
  return (await run("docker", ["image", "inspect", image], { timeoutMs: 30_000 })).code === 0;
}

export async function resolveSandbox(opts: {
  worktree: string;
  requested: "local" | RemoteBackend | "auto";
  corePort: number;
  lock: string;
  baseEnv: Record<string, string>;
  log: (msg: string) => void;
}): Promise<SandboxResolution> {
  const warnings: string[] = [];
  let backend = opts.requested;
  if (backend === "auto") backend = "local";
  if (backend === "local" && !worktreeSupportsLocalSandbox(opts.worktree)) {
    throw new Error(
      "this worktree's code has no local sandbox backend (src/sandbox/local-sandbox.ts missing) -- use --sandbox sprites",
    );
  }

  if (backend === "local") {
    if (!(await ensureDockerDaemon(opts.log))) {
      throw new Error("SANDBOX_BACKEND=local requires a running Docker daemon (is Docker Desktop running?)");
    }
    const image = opts.baseEnv.LOCAL_SANDBOX_IMAGE || "qm-sandbox-local:latest";
    if (!(await localImagePresent(image))) {
      warnings.push(
        `local sandbox image ${image} not built -- execute turns will fail until you run: npm run sandbox:local:build`,
      );
    }
    const publicApiUrl = opts.baseEnv.PUBLIC_API_URL || `http://host.docker.internal:${opts.corePort}`;
    return {
      backend: "local",
      env: {
        SANDBOX_BACKEND: "local",
        LOCAL_SANDBOX_IMAGE: image,
        PUBLIC_API_URL: publicApiUrl,
      },
      detail: `local Docker (${image})`,
      publicApiUrl,
      warnings,
    };
  }

  const remote = REMOTE_BACKENDS[backend];
  const token = opts.baseEnv[remote.token];
  if (!token) {
    throw new Error(`--sandbox ${backend} requires ${remote.token} in the environment (${remote.mint})`);
  }
  let publicApiUrl = opts.baseEnv.PUBLIC_API_URL || null;
  if (!publicApiUrl) {
    publicApiUrl = await startQuickTunnel(opts.corePort, opts.lock, opts.log);
    if (!publicApiUrl)
      warnings.push(
        "cloudflared tunnel didn't come up -- agent self-API (crons/sends) won't be reachable from the sandbox",
      );
  }
  const env: Record<string, string> = {
    SANDBOX_BACKEND: backend,
    [remote.token]: token,
    [remote.prefix]: opts.baseEnv[remote.prefix] || "qmdev",
  };
  for (const name of remote.passthrough) {
    const value = opts.baseEnv[name];
    if (value) env[name] = value;
  }
  const egressProxyUrl = opts.baseEnv[remote.egressProxyUrl];
  if (egressProxyUrl) env[remote.egressProxyUrl] = egressProxyUrl;
  else
    warnings.push(
      `${remote.egressProxyUrl} unset -- ${backend} sandbox runs with NO egress enforcement; set it to QA the forced-proxy path`,
    );
  if (publicApiUrl) env.PUBLIC_API_URL = publicApiUrl;
  return { backend, env, detail: remote.detail, publicApiUrl, warnings };
}

async function startQuickTunnel(corePort: number, lock: string, log: (msg: string) => void): Promise<string | null> {
  if ((await run("cloudflared", ["--version"], { timeoutMs: 15_000 })).code !== 0) return null;
  const logPath = join(lock, "tunnel.log");
  const fd = openSync(logPath, "a");
  const child = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${corePort}`, "--no-autoupdate"], {
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();
  if (!child.pid) return null;
  writePidFile(lock, "tunnel.pid", child.pid);
  for (let i = 0; i < 20; i++) {
    const url = bestEffortValue(
      () => readFileSync(logPath, "utf8").match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0] ?? "",
    );
    if (url) {
      log(`agent self-API tunnel: ${url} -> :${corePort} (lets the sandbox reach this core for crons/sends)`);
      return url;
    }
    await sleep(1000);
  }
  return null;
}

export async function destroyLocalDevSandboxes(log: (msg: string) => void): Promise<void> {
  const list = await run(
    "docker",
    [
      "ps",
      "-aq",
      "--filter",
      "label=qm.sandbox=1",
      "--filter",
      "label=agent_env=dev",
      "--filter",
      "status=exited",
      "--filter",
      "status=created",
    ],
    { timeoutMs: 30_000 },
  );
  const ids = (list.stdout ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!ids.length) return;
  log(`sandbox: removing ${ids.length} parked local dev sandbox container(s) (volumes kept; running boxes untouched)`);
  await run("docker", ["rm", "-f", ...ids], { timeoutMs: 60_000 });
}
