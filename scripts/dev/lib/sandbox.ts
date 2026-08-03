import { existsSync, openSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { writePidFile } from "./lease.ts";
import { run } from "./proc.ts";
import { ensureDockerDaemon } from "./postgres.ts";
import { bestEffortValue, sleep } from "./util.ts";

export interface SandboxResolution {
  backend: "local" | "sprites" | "smolmachines";
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
  requested: "local" | "sprites" | "smolmachines" | "auto";
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

  if (backend === "smolmachines") {
    const smolToken = opts.baseEnv.SMOLMACHINES_TOKEN;
    if (!smolToken)
      throw new Error(
        "--sandbox smolmachines requires SMOLMACHINES_TOKEN in the environment (create an API key in the smolmachines console)",
      );
    let smolApiUrl = opts.baseEnv.PUBLIC_API_URL || null;
    if (!smolApiUrl) {
      smolApiUrl = await startQuickTunnel(opts.corePort, opts.lock, opts.log);
      if (!smolApiUrl)
        warnings.push(
          "cloudflared tunnel didn't come up -- agent self-API (crons/sends) won't be reachable from the sandbox",
        );
    }
    const smolEnv: Record<string, string> = {
      SANDBOX_BACKEND: "smolmachines",
      SMOLMACHINES_TOKEN: smolToken,
      SMOLMACHINES_NAME_PREFIX: opts.baseEnv.SMOLMACHINES_NAME_PREFIX || "qmdev",
    };
    if (opts.baseEnv.SMOLMACHINES_IMAGE) smolEnv.SMOLMACHINES_IMAGE = opts.baseEnv.SMOLMACHINES_IMAGE;
    if (opts.baseEnv.SMOLMACHINES_EGRESS_PROXY_URL)
      smolEnv.SMOLMACHINES_EGRESS_PROXY_URL = opts.baseEnv.SMOLMACHINES_EGRESS_PROXY_URL;
    else
      warnings.push(
        "SMOLMACHINES_EGRESS_PROXY_URL unset -- smolmachines sandbox runs with NO egress enforcement; set it to QA the forced-proxy path",
      );
    if (smolApiUrl) smolEnv.PUBLIC_API_URL = smolApiUrl;
    return {
      backend: "smolmachines",
      env: smolEnv,
      detail: "smolmachines (api.smolmachines.com)",
      publicApiUrl: smolApiUrl,
      warnings,
    };
  }

  const token = opts.baseEnv.SPRITES_TOKEN;
  if (!token)
    throw new Error("--sandbox sprites requires SPRITES_TOKEN in the environment (mint one with `sprite login`)");
  let publicApiUrl = opts.baseEnv.PUBLIC_API_URL || null;
  if (!publicApiUrl) {
    publicApiUrl = await startQuickTunnel(opts.corePort, opts.lock, opts.log);
    if (!publicApiUrl)
      warnings.push(
        "cloudflared tunnel didn't come up -- agent self-API (crons/sends) won't be reachable from the sandbox",
      );
  }
  const env: Record<string, string> = {
    SANDBOX_BACKEND: "sprites",
    SPRITES_TOKEN: token,
    SPRITES_NAME_PREFIX: opts.baseEnv.SPRITES_NAME_PREFIX || "qmdev",
  };
  // Force-through egress is opt-in in dev: set it only if the caller supplied a proxy URL.
  // Without it the sandbox has open egress — warn so a "proxy ON" QA run isn't silently toothless.
  if (opts.baseEnv.SPRITES_EGRESS_PROXY_URL) env.SPRITES_EGRESS_PROXY_URL = opts.baseEnv.SPRITES_EGRESS_PROXY_URL;
  else
    warnings.push(
      "SPRITES_EGRESS_PROXY_URL unset -- sprites sandbox runs with NO egress enforcement; set it to QA the forced-proxy path",
    );
  if (publicApiUrl) env.PUBLIC_API_URL = publicApiUrl;
  return { backend: "sprites", env, detail: "Fly Sprites (api.sprites.dev)", publicApiUrl, warnings };
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
