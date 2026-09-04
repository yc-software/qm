import { spawn, spawnSync } from "node:child_process";
import { openSync } from "node:fs";
import { connect } from "node:net";
import { bestEffort, sleep } from "./util.ts";

export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      timeout: opts.timeoutMs ?? 120_000,
      killSignal: "SIGKILL",
      stdio: [opts.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (code: number) => {
      if (!settled) {
        settled = true;
        resolve({ code, stdout, stderr });
      }
    };
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      stderr += `\n${e.message}`;
      done(-1);
    });
    child.on("close", (code) => done(code ?? -1));
    if (opts.input !== undefined) {
      child.stdin?.write(opts.input);
      child.stdin?.end();
    }
  });
}

export function pidAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function spawnDetached(opts: {
  cwd: string;
  logFile: string;
  argv: string[];
  env: Record<string, string>;
}): number {
  const [cmd, ...rest] = opts.argv;
  if (!cmd) throw new Error("spawnDetached: empty argv");
  const fd = openSync(opts.logFile, "a");
  const child = spawn(cmd, rest, {
    cwd: opts.cwd,
    detached: true,
    stdio: ["ignore", fd, fd],
    env: opts.env,
  });
  child.unref();
  if (!child.pid) throw new Error(`failed to spawn ${opts.argv.join(" ")}`);
  return child.pid;
}

export async function killTree(pid: number | null | undefined, graceMs = 5000): Promise<void> {
  if (!pidAlive(pid)) return;
  const target = pid as number;
  if (bestEffort(() => process.kill(-target, "SIGTERM")) !== undefined) {
    bestEffort(() => process.kill(target, "SIGTERM"));
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!pidAlive(target)) return;
    await sleep(200);
  }
  if (bestEffort(() => process.kill(-target, "SIGKILL")) !== undefined) {
    bestEffort(() => process.kill(target, "SIGKILL"));
  }
  const killDeadline = Date.now() + 2000;
  while (Date.now() < killDeadline && pidAlive(target)) await sleep(100);
}

export function tcpPortOpen(port: number, host = "127.0.0.1", timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    setTimeout(() => done(false), timeoutMs);
  });
}

export function portHolders(port: number): number[] {
  const res = spawnSync("lsof", ["-ti", `tcp:${port}`], { encoding: "utf8" });
  if (res.status !== 0 || !res.stdout) return [];
  return res.stdout
    .split("\n")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

export async function waitPortFree(port: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await tcpPortOpen(port))) return true;
    await sleep(250);
  }
  return false;
}

export async function freePort(port: number, label: string, log: (msg: string) => void): Promise<void> {
  const holders = portHolders(port);
  if (holders.length === 0) return;
  log(`freeing stale process(es) ${holders.join(",")} on :${port} (${label})`);
  for (const pid of holders) await killTree(pid, 3000);
  await waitPortFree(port, 5000);
}
