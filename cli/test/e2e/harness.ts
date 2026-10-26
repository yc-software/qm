import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILENAME, type QmConfig } from "../../src/config.ts";
import { deploymentDir } from "../../src/state.ts";
import { readEnvFile } from "../../src/util.ts";

export const cliDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const repoRoot = join(cliDir, "..");
export const bin = join(cliDir, "bin", "qm.ts");
export const repoEnvFile = join(repoRoot, ".env");

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

export function repoEnv(): Record<string, string> {
  return Object.fromEntries(readEnvFile(repoEnvFile));
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  out: string;
}

export interface RunOpts {
  cwd?: string;
  env?: Record<string, string | undefined>;
  withRepoEnv?: boolean;
  timeoutMs?: number;
}

export function runCli(args: string[], opts: RunOpts = {}): CliResult {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(opts.withRepoEnv === false ? {} : repoEnv()),
  };
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const r = spawnSync(process.execPath, ["--", bin, ...args], {
    encoding: "utf8",
    cwd: opts.cwd ?? cliDir,
    env,
    timeout: opts.timeoutMs ?? 180_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  const code = r.status ?? (r.signal || r.error ? 124 : 1);
  return { code, stdout, stderr, out: stripAnsi(stdout + stderr) };
}

export function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `qm-e2e-${prefix}-`));
}

export function tmpGitRepo(prefix: string): string {
  const dir = tmp(prefix);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

export function rmDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export function writeConfig(
  dir: string,
  config: Partial<QmConfig> & { orgId: string; target: "docker" | "aws" },
): string {
  const full = {
    contract: 1,
    publicUrl: "http://localhost:8080",
    plugins: [],
    skills: [],
    env: {},
    imageOverrides: {},
    services: ["core"],
    sandbox: {
      app: `${config.orgId}-sandboxes`,
    },
    ...config,
  };
  const path = join(dir, CONFIG_FILENAME);
  writeFileSync(path, JSON.stringify(full, null, 2) + "\n");
  return path;
}

const STANDIN_DOCKERFILE = `FROM alpine:latest
ARG WEB_UI_BASE
CMD ["sh","-c","echo 'listening on :8080'; echo 'connected as @e2ebot'; echo 'surface on http://localhost'; echo '[admin-plugin] http'; echo 'public front door on'; echo 'tail sentinel'; while true; do sleep 3600; done"]
`;

export function standInCheckout(services: readonly string[]): string {
  const root = tmp("checkout");
  for (const svc of services) {
    const dir = join(root, "deploy", svc);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Dockerfile"), STANDIN_DOCKERFILE);
  }
  return root;
}

export function standInPlugin(depDir: string, name: string): void {
  const dir = join(depDir, "plugins", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "Dockerfile"), STANDIN_DOCKERFILE);
}

let dockerCache: boolean | undefined;
export function dockerAvailable(): boolean {
  if (dockerCache !== undefined) return dockerCache;
  try {
    execFileSync("docker", ["version", "-f", "{{.Server.Version}}"], { stdio: "ignore" });
    dockerCache = true;
  } catch {
    dockerCache = false;
  }
  return dockerCache;
}

export function deploymentContainers(orgId: string): string[] {
  try {
    return execFileSync("docker", ["ps", "-a", "--filter", `label=qm.org=${orgId}`, "--format", "{{.Names}}"], {
      encoding: "utf8",
    })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

const existingDockerNames = (kind: "volume" | "network", candidates: string[]): string[] => {
  try {
    const present = new Set(
      execFileSync("docker", [kind, "ls", "--format", "{{.Name}}"], { encoding: "utf8" })
        .split("\n")
        .map((s) => s.trim()),
    );
    return candidates.filter((c) => present.has(c));
  } catch {
    return [];
  }
};
export const deploymentVolumes = (orgId: string): string[] =>
  existingDockerNames("volume", [`qm-${orgId}-pgdata`, `qm-${orgId}-coredata`]);
export const deploymentNetworks = (orgId: string): string[] => existingDockerNames("network", [`qm-${orgId}`]);

export function preexistingServiceImages(services: readonly string[]): string[] {
  try {
    const present = new Set(
      execFileSync("docker", ["images", "--format", "{{.Repository}}:{{.Tag}}"], { encoding: "utf8" })
        .split("\n")
        .map((s) => s.trim()),
    );
    return services.map((s) => `qm-${s}:local`).filter((t) => present.has(t));
  } catch {
    return [];
  }
}

export function dockerCleanup(orgId: string): void {
  try {
    for (const name of deploymentContainers(orgId)) {
      try {
        execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
      } catch {
        void 0;
      }
    }
    for (const v of deploymentVolumes(orgId)) {
      try {
        execFileSync("docker", ["volume", "rm", "-f", v], { stdio: "ignore" });
      } catch {
        void 0;
      }
    }
    for (const n of deploymentNetworks(orgId)) {
      try {
        execFileSync("docker", ["network", "rm", n], { stdio: "ignore" });
      } catch {
        void 0;
      }
    }
  } catch {
    void 0;
  }
  rmDir(deploymentDir(orgId));
}

export function removeStandInImages(services: readonly string[], orgId: string): void {
  const tags = [...services.map((s) => `qm-${s}:local`), `qm-${orgId}-widget:local`];
  for (const tag of tags) {
    try {
      execFileSync("docker", ["rmi", "-f", tag], { stdio: "ignore" });
    } catch {
      void 0;
    }
  }
}
