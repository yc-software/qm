import { spawn, spawnSync } from "node:child_process";
import { openSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { connect } from "node:net";
import { bestEffort, sleep } from "./util.ts";

/**
 * On Windows, child_process.spawn cannot execute the `.cmd`/`.bat` shims that
 * npm, tsx & co. place on PATH: the bare name fails with ENOENT and the
 * explicit `.cmd` fails with EINVAL (current Node rejects batch files without a
 * shell). Resolve the command against PATH ourselves and route batch shims
 * through cmd.exe, the way npm's own CLI does (#551). `.exe`/`.com` resolves to
 * its full path and spawns directly; non-Windows platforms are untouched.
 */
function resolveWindowsCommand(cmd: string): string | null {
  // PATHEXT extensions come first, extensionless last: Node's install dir ships
  // an extensionless `npm` sh-script for bash environments, and matching it
  // before npm.cmd would hand spawn a non-executable file.
  const exts = [...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean), ""];
  const dirs = /[\\/]/.test(cmd)
    ? [""]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = dir ? join(dir, cmd + ext) : cmd + ext;
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // Not present at this candidate; keep scanning.
      }
    }
  }
  return null;
}

export function winSpawnArgv(cmd: string, args: string[]): { cmd: string; args: string[]; verbatim: boolean } {
  if (process.platform !== "win32") return { cmd, args, verbatim: false };
  const resolved = resolveWindowsCommand(cmd);
  if (resolved && /\.(cmd|bat)$/i.test(resolved)) {
    // cmd.exe re-parses everything after /c as one command line: when the shim
    // path contains spaces (e.g. "C:\Program Files\nodejs\npm.cmd"), per-argument
    // quoting makes cmd execute only up to the first quote. Quote each part
    // ourselves and hand cmd a single pre-quoted command line, wrapped in an
    // outer pair of quotes that /s strips. `verbatim` keeps Node from escaping
    // the embedded quotes with backslashes, which cmd.exe cannot parse.
    const commandLine = [resolved, ...args].map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(" ");
    return { cmd: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `"${commandLine}"`], verbatim: true };
  }
  return { cmd: resolved ?? cmd, args, verbatim: false };
}

export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const spawnArgv = winSpawnArgv(cmd, args);
    const child = spawn(spawnArgv.cmd, spawnArgv.args, {
      cwd: opts.cwd,
      env: opts.env,
      timeout: opts.timeoutMs ?? 120_000,
      killSignal: "SIGKILL",
      windowsVerbatimArguments: spawnArgv.verbatim,
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
  const spawnArgv = winSpawnArgv(cmd, rest);
  const child = spawn(spawnArgv.cmd, spawnArgv.args, {
    cwd: opts.cwd,
    detached: true,
    stdio: ["ignore", fd, fd],
    env: opts.env,
    windowsVerbatimArguments: spawnArgv.verbatim,
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
