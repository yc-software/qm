import { existsSync, openSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { writePidFile } from "./lease.ts";
import { run } from "./proc.ts";
import { ensureDockerDaemon } from "./postgres.ts";
import { bestEffortValue, sleep } from "./util.ts";
import type { DevSandboxBackend, DevSandboxChoice } from "./types.ts";

export interface SandboxResolution {
  backend: DevSandboxBackend;
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
  requested: DevSandboxChoice;
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
  const env: Record<string, string> = { SANDBOX_BACKEND: backend, ...remote.defaults };
  for (const key of remote.required) {
    const value = opts.baseEnv[key]?.trim();
    if (!value) throw new Error(`--sandbox ${backend} requires ${key} in the environment (${remote.hint})`);
    env[key] = value;
  }
  for (const key of remote.optional ?? []) {
    const value = opts.baseEnv[key]?.trim();
    if (value) env[key] = value;
  }
  env.SANDBOX_NAME_PREFIX =
    opts.baseEnv.SANDBOX_NAME_PREFIX?.trim() ||
    `qmdev-${createHash("sha1").update(opts.worktree).digest("hex").slice(0, 12)}`;
  const egressProxyUrl = opts.baseEnv.SANDBOX_EGRESS_PROXY_URL?.trim();
  if (egressProxyUrl) env.SANDBOX_EGRESS_PROXY_URL = egressProxyUrl;
  else
    warnings.push(
      `SANDBOX_EGRESS_PROXY_URL unset -- ${backend} sandbox runs with NO egress enforcement; set it to QA the forced-proxy path`,
    );
  let publicApiUrl = opts.baseEnv.PUBLIC_API_URL || null;
  if (!publicApiUrl) {
    publicApiUrl = await startQuickTunnel(opts.corePort, opts.lock, opts.log);
    if (!publicApiUrl)
      warnings.push(
        "cloudflared tunnel didn't come up -- agent self-API (crons/sends) won't be reachable from the sandbox",
      );
  }
  if (publicApiUrl) env.PUBLIC_API_URL = publicApiUrl;
  return { backend, env, detail: remote.detail, publicApiUrl, warnings };
}

const REMOTE_BACKENDS: Record<
  Exclude<DevSandboxBackend, "local">,
  { required: string[]; optional?: string[]; defaults?: Record<string, string>; hint: string; detail: string }
> = {
  sprites: {
    required: ["SPRITES_TOKEN"],
    hint: "mint one with `sprite login`",
    detail: "Fly Sprites (api.sprites.dev)",
  },
  e2b: {
    required: ["E2B_API_KEY"],
    optional: ["E2B_TEMPLATE_ID"],
    hint: "an E2B API key",
    detail: "e2b (api.e2b.dev)",
  },
  smolmachines: {
    required: ["SMOLMACHINES_TOKEN"],
    hint: "create an API key in the smolmachines console",
    detail: "smolmachines (api.smolmachines.com)",
  },
  agent37: {
    required: ["AGENT37_API_KEY"],
    hint: "mint one at https://agent37.com/dashboard/cloud/api-keys",
    detail: "Agent37 (api.agent37.com)",
  },
  superserve: {
    required: ["SUPERSERVE_API_KEY", "SUPERSERVE_TEMPLATE"],
    hint: "an API key from the Superserve console and the ready qm-agent-<release> template",
    detail: "Superserve",
  },
  "do-managed-agents": {
    required: ["DO_AGENTS_API_TOKEN"],
    optional: ["DO_AGENTS_TEMPLATE"],
    hint: "a DigitalOcean API token for a team with Managed Agents access",
    detail: "Managed Agents (api.digitalocean.com)",
  },
  porter: {
    required: ["PORTER_DEPLOY_API_TOKEN", "PORTER_DEPLOY_PROJECT_ID", "PORTER_DEPLOY_CLUSTER_ID"],
    optional: ["PORTER_DEPLOY_URL", "PORTER_DEPLOY_VISIBILITY"],
    defaults: { PORTER_DEPLOY_VISIBILITY: "private" },
    hint: "create an API token in the Porter dashboard",
    detail: "Porter",
  },
};

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
