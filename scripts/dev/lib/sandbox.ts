import { existsSync, openSync, readFileSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
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
  tunnel: () => Promise<string | null>;
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

  if (backend === "e2b") {
    const e2bKey = opts.baseEnv.E2B_API_KEY;
    if (!e2bKey) throw new Error("--sandbox e2b requires E2B_API_KEY in the environment");
    let e2bApiUrl = opts.baseEnv.PUBLIC_API_URL || null;
    if (!e2bApiUrl) {
      e2bApiUrl = await opts.tunnel();
      if (!e2bApiUrl)
        warnings.push(
          "cloudflared tunnel didn't come up -- agent self-API (crons/sends) won't be reachable from the sandbox",
        );
    }
    const e2bEnv: Record<string, string> = {
      SANDBOX_BACKEND: "e2b",
      E2B_API_KEY: e2bKey,
      E2B_NAME_PREFIX: opts.baseEnv.E2B_NAME_PREFIX || "qmdev",
    };
    if (opts.baseEnv.E2B_TEMPLATE_ID) e2bEnv.E2B_TEMPLATE_ID = opts.baseEnv.E2B_TEMPLATE_ID;
    if (e2bApiUrl) e2bEnv.PUBLIC_API_URL = e2bApiUrl;
    return { backend: "e2b", env: e2bEnv, detail: "e2b (api.e2b.dev)", publicApiUrl: e2bApiUrl, warnings };
  }

  if (backend === "smolmachines") {
    const smolToken = opts.baseEnv.SMOLMACHINES_TOKEN;
    if (!smolToken)
      throw new Error(
        "--sandbox smolmachines requires SMOLMACHINES_TOKEN in the environment (create an API key in the smolmachines console)",
      );
    let smolApiUrl = opts.baseEnv.PUBLIC_API_URL || null;
    if (!smolApiUrl) {
      smolApiUrl = await opts.tunnel();
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
    if (smolApiUrl) smolEnv.PUBLIC_API_URL = smolApiUrl;
    return {
      backend: "smolmachines",
      env: smolEnv,
      detail: "smolmachines (api.smolmachines.com)",
      publicApiUrl: smolApiUrl,
      warnings,
    };
  }

  if (backend === "agent37") {
    const apiKey = opts.baseEnv.AGENT37_API_KEY;
    if (!apiKey)
      throw new Error(
        "--sandbox agent37 requires AGENT37_API_KEY in the environment (mint one at https://agent37.com/dashboard/cloud/api-keys)",
      );
    let apiUrl = opts.baseEnv.PUBLIC_API_URL || null;
    if (!apiUrl) {
      apiUrl = await opts.tunnel();
      if (!apiUrl)
        warnings.push(
          "cloudflared tunnel didn't come up -- agent self-API (crons/sends) won't be reachable from the sandbox",
        );
    }
    const env: Record<string, string> = {
      SANDBOX_BACKEND: "agent37",
      AGENT37_API_KEY: apiKey,
      AGENT37_NAME_PREFIX: opts.baseEnv.AGENT37_NAME_PREFIX || "qmdev",
    };
    if (opts.baseEnv.AGENT37_API_BASE_URL) env.AGENT37_API_BASE_URL = opts.baseEnv.AGENT37_API_BASE_URL;
    if (opts.baseEnv.AGENT37_TEMPLATE) env.AGENT37_TEMPLATE = opts.baseEnv.AGENT37_TEMPLATE;
    if (apiUrl) env.PUBLIC_API_URL = apiUrl;
    return { backend: "agent37", env, detail: "Agent37 (api.agent37.com)", publicApiUrl: apiUrl, warnings };
  }

  if (backend === "superserve") {
    const apiKey = opts.baseEnv.SUPERSERVE_API_KEY?.trim();
    const template = opts.baseEnv.SUPERSERVE_TEMPLATE?.trim();
    if (!apiKey)
      throw new Error(
        "--sandbox superserve requires SUPERSERVE_API_KEY in the environment (create an API key in the Superserve console)",
      );
    if (!template)
      throw new Error(
        "--sandbox superserve requires SUPERSERVE_TEMPLATE in the environment (the ready qm-agent-<release> template that carries the agent toolchain)",
      );
    let apiUrl = opts.baseEnv.PUBLIC_API_URL || null;
    if (!apiUrl) {
      apiUrl = await opts.tunnel();
      if (!apiUrl)
        warnings.push(
          "cloudflared tunnel didn't come up -- agent self-API (crons/sends) won't be reachable from the sandbox",
        );
    }
    const env: Record<string, string> = {
      SANDBOX_BACKEND: "superserve",
      SUPERSERVE_API_KEY: apiKey,
      SUPERSERVE_TEMPLATE: template,
      SUPERSERVE_NAME_PREFIX:
        opts.baseEnv.SUPERSERVE_NAME_PREFIX ||
        `qmdev-${createHash("sha1").update(opts.worktree).digest("hex").slice(0, 12)}`,
    };
    if (opts.baseEnv.SUPERSERVE_BASE_URL) env.SUPERSERVE_BASE_URL = opts.baseEnv.SUPERSERVE_BASE_URL;
    if (opts.baseEnv.SUPERSERVE_EGRESS_ALLOW) env.SUPERSERVE_EGRESS_ALLOW = opts.baseEnv.SUPERSERVE_EGRESS_ALLOW;
    if (opts.baseEnv.SUPERSERVE_EGRESS_DENY) env.SUPERSERVE_EGRESS_DENY = opts.baseEnv.SUPERSERVE_EGRESS_DENY;
    if (!opts.baseEnv.SUPERSERVE_EGRESS_ALLOW && !opts.baseEnv.SUPERSERVE_EGRESS_DENY)
      warnings.push(
        "SUPERSERVE_EGRESS_ALLOW/SUPERSERVE_EGRESS_DENY unset -- superserve sandbox runs with open egress; set one to QA the enforced path",
      );
    if (apiUrl) env.PUBLIC_API_URL = apiUrl;
    return { backend: "superserve", env, detail: `Superserve (template ${template})`, publicApiUrl: apiUrl, warnings };
  }

  if (backend === "render") {
    const apiKey = opts.baseEnv.RENDER_API_KEY?.trim();
    const workspaceId = opts.baseEnv.RENDER_WORKSPACE_ID?.trim();
    const image = opts.baseEnv.RENDER_SANDBOX_IMAGE?.trim();
    if (!apiKey || !workspaceId || !image)
      throw new Error(
        "--sandbox render requires RENDER_API_KEY, RENDER_WORKSPACE_ID, and RENDER_SANDBOX_IMAGE (<repository>:<tag>@sha256:<digest>) in the environment",
      );
    let apiUrl = opts.baseEnv.PUBLIC_API_URL || null;
    if (!apiUrl) {
      apiUrl = await opts.tunnel();
      if (!apiUrl)
        warnings.push(
          "cloudflared tunnel didn't come up -- agent self-API (crons/sends) won't be reachable from the sandbox",
        );
    }
    const env: Record<string, string> = {
      SANDBOX_BACKEND: "render",
      RENDER_API_KEY: apiKey,
      RENDER_WORKSPACE_ID: workspaceId,
      RENDER_SANDBOX_IMAGE: image,
    };
    if (apiUrl) env.PUBLIC_API_URL = apiUrl;
    return { backend: "render", env, detail: `Render (image ${image})`, publicApiUrl: apiUrl, warnings };
  }

  if (backend === "do-managed-agents") {
    const managedAgentsToken = opts.baseEnv.DO_AGENTS_API_TOKEN?.trim();
    if (!managedAgentsToken)
      throw new Error(
        "--sandbox do-managed-agents requires DO_AGENTS_API_TOKEN in the environment (a DigitalOcean API token for a team with Managed Agents access)",
      );
    let managedAgentsApiUrl = opts.baseEnv.PUBLIC_API_URL || null;
    if (!managedAgentsApiUrl) {
      managedAgentsApiUrl = await opts.tunnel();
      if (!managedAgentsApiUrl)
        warnings.push(
          "cloudflared tunnel didn't come up -- agent self-API (crons/sends) won't be reachable from the sandbox",
        );
    }
    const env: Record<string, string> = {
      SANDBOX_BACKEND: "do-managed-agents",
      DO_AGENTS_API_TOKEN: managedAgentsToken,
      DO_AGENTS_NAME_PREFIX: opts.baseEnv.DO_AGENTS_NAME_PREFIX || "qmdev",
    };
    if (opts.baseEnv.DO_AGENTS_API_BASE_URL) env.DO_AGENTS_API_BASE_URL = opts.baseEnv.DO_AGENTS_API_BASE_URL;
    if (opts.baseEnv.DO_AGENTS_TEMPLATE) env.DO_AGENTS_TEMPLATE = opts.baseEnv.DO_AGENTS_TEMPLATE;
    if (opts.baseEnv.DO_AGENTS_SIZE_SLUG) env.DO_AGENTS_SIZE_SLUG = opts.baseEnv.DO_AGENTS_SIZE_SLUG;
    if (managedAgentsApiUrl) env.PUBLIC_API_URL = managedAgentsApiUrl;
    return {
      backend: "do-managed-agents",
      env,
      detail: `Managed Agents (${opts.baseEnv.DO_AGENTS_API_BASE_URL || "api.digitalocean.com"})`,
      publicApiUrl: managedAgentsApiUrl,
      warnings,
    };
  }

  if (backend === "porter") {
    const porterToken = opts.baseEnv.PORTER_DEPLOY_API_TOKEN;
    const projectId = opts.baseEnv.PORTER_DEPLOY_PROJECT_ID;
    const clusterId = opts.baseEnv.PORTER_DEPLOY_CLUSTER_ID;
    if (!porterToken || !projectId || !clusterId)
      throw new Error(
        "--sandbox porter requires PORTER_DEPLOY_API_TOKEN, PORTER_DEPLOY_PROJECT_ID, and PORTER_DEPLOY_CLUSTER_ID in the environment (create an API token in the Porter dashboard)",
      );
    let porterApiUrl = opts.baseEnv.PUBLIC_API_URL || null;
    if (!porterApiUrl) {
      porterApiUrl = await opts.tunnel();
      if (!porterApiUrl)
        warnings.push(
          "cloudflared tunnel didn't come up -- agent self-API (crons/sends) won't be reachable from the sandbox",
        );
    }
    const env: Record<string, string> = {
      SANDBOX_BACKEND: "porter",
      PORTER_DEPLOY_API_TOKEN: porterToken,
      PORTER_DEPLOY_PROJECT_ID: projectId,
      PORTER_DEPLOY_CLUSTER_ID: clusterId,
      PORTER_SANDBOX_NAME_PREFIX: opts.baseEnv.PORTER_SANDBOX_NAME_PREFIX || "qmdev",
      PORTER_DEPLOY_VISIBILITY: opts.baseEnv.PORTER_DEPLOY_VISIBILITY || "private",
    };
    if (opts.baseEnv.PORTER_DEPLOY_URL) env.PORTER_DEPLOY_URL = opts.baseEnv.PORTER_DEPLOY_URL;
    if (opts.baseEnv.PORTER_SANDBOX_IMAGE) env.PORTER_SANDBOX_IMAGE = opts.baseEnv.PORTER_SANDBOX_IMAGE;
    if (porterApiUrl) env.PUBLIC_API_URL = porterApiUrl;
    return {
      backend: "porter",
      env,
      detail: `Porter (project ${projectId}, cluster ${clusterId})`,
      publicApiUrl: porterApiUrl,
      warnings,
    };
  }

  const token = opts.baseEnv.SPRITES_TOKEN;
  if (!token)
    throw new Error("--sandbox sprites requires SPRITES_TOKEN in the environment (mint one with `sprite login`)");
  let publicApiUrl = opts.baseEnv.PUBLIC_API_URL || null;
  if (!publicApiUrl) {
    publicApiUrl = await opts.tunnel();
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
  if (publicApiUrl) env.PUBLIC_API_URL = publicApiUrl;
  return { backend: "sprites", env, detail: "Fly Sprites (api.sprites.dev)", publicApiUrl, warnings };
}

export async function startQuickTunnel(
  corePort: number,
  lock: string,
  log: (msg: string) => void,
): Promise<{ pid: number; url: string | null } | null> {
  if ((await run("cloudflared", ["--version"], { timeoutMs: 15_000 })).code !== 0) return null;
  const logPath = join(lock, "tunnel.log");
  const fd = openSync(logPath, "a");
  const logStart = statSync(logPath).size;
  const child = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${corePort}`, "--no-autoupdate"], {
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();
  if (!child.pid) return null;
  for (let i = 0; i < 20; i++) {
    const url = bestEffortValue(
      () =>
        readFileSync(logPath)
          .subarray(logStart)
          .toString("utf8")
          .match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0] ?? "",
    );
    if (url) {
      log(`agent self-API tunnel: ${url} -> :${corePort} (lets the sandbox reach this core for crons/sends)`);
      return { pid: child.pid, url };
    }
    await sleep(1000);
  }
  return { pid: child.pid, url: null };
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
