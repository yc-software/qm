import { spawn, type ChildProcessByStdio } from "node:child_process";
import { kill as killProcess } from "node:process";
import type { Readable, Writable } from "node:stream";
import { sleep } from "../util/async.ts";

export interface GrokProcess {
  child: ChildProcessByStdio<Writable, Readable, null>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stop(): Promise<void>;
}

export interface GrokProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  launcherPath?: string;
  eofGraceMs?: number;
  termGraceMs?: number;
  killGraceMs?: number;
}

function groupAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    killProcess(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function signalGroup(child: GrokProcess["child"], signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    killProcess(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
  }
}

async function waitUntilGone(pid: number | undefined, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (groupAlive(pid) && Date.now() < deadline) await sleep(Math.min(25, Math.max(1, deadline - Date.now())));
  return !groupAlive(pid);
}

export function startGrokProcess(
  binaryPath: string,
  args: readonly string[],
  options: GrokProcessOptions,
): GrokProcess {
  const child = spawn(options.launcherPath ?? binaryPath, [...(options.launcherPath ? [binaryPath] : []), ...args], {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  child.stdin.on("error", () => undefined);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  void exited.catch(() => undefined);
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      const pid = child.pid;
      if (!child.stdin.destroyed) child.stdin.end();
      if (await waitUntilGone(pid, options.eofGraceMs ?? 500)) return;
      signalGroup(child, "SIGTERM");
      if (await waitUntilGone(pid, options.termGraceMs ?? 500)) return;
      signalGroup(child, "SIGKILL");
      if (!(await waitUntilGone(pid, options.killGraceMs ?? 500)))
        throw new Error("Grok process group survived SIGKILL");
    })();
    return stopping;
  };
  return { child, exited, stop };
}
