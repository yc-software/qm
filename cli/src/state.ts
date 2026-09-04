import { homedir } from "node:os";
import { join } from "node:path";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { CliError } from "./log.ts";

const xdgConfigHome = (): string => process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");

const cliStateDir = (): string => join(xdgConfigHome(), "qm");

function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const deploymentDir = (orgId: string): string => join(cliStateDir(), "deployments", orgId);

const pause = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

export function withDeploymentLock<T>(orgId: string, fn: () => T): T {
  const dir = ensureDir(deploymentDir(orgId));
  const lock = join(dir, "up.lock");
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, "pid"), String(process.pid));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      try {
        const pid = Number(readFileSync(join(lock, "pid"), "utf8"));
        if (!Number.isInteger(pid) || pid <= 0) stale = Date.now() - statSync(lock).mtimeMs > 5_000;
        else process.kill(pid, 0);
      } catch (probe) {
        const code = (probe as NodeJS.ErrnoException).code;
        stale =
          code === "ESRCH" || (code === "ENOENT" && existsSync(lock) && Date.now() - statSync(lock).mtimeMs > 5_000);
      }
      if (stale) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new CliError(`another qm up is already running for org ${orgId}`);
      pause(50);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export interface DeploymentState {
  orgId: string;
  network: string;
  pgPassword?: string;
}

export function readDeploymentState(orgId: string): DeploymentState | undefined {
  const path = join(deploymentDir(orgId), "state.json");
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DeploymentState;
  } catch {
    return undefined;
  }
}

export function writeDeploymentState(state: DeploymentState): void {
  const dir = ensureDir(deploymentDir(state.orgId));
  const path = join(dir, "state.json");
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}
