import { spawn } from "node:child_process";
import { getOperationSignal } from "./async.ts";

export interface CapturedProcess {
  code: number;
  stdout: string;
  stderr: string;
}

export function spawnCaptured(
  executable: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBuffer?: number } = {},
): Promise<CapturedProcess> {
  return new Promise((resolve, reject) => {
    const signal = getOperationSignal();
    signal?.throwIfAborted();
    const detached = process.platform !== "win32";
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env, detached });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: Error | undefined;
    const kill = () => {
      if (detached && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure ??= error as Error;
        }
      } else child.kill("SIGKILL");
    };
    const timer =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            failure ??= Object.assign(new Error(`${executable} timed out after ${options.timeoutMs}ms`), {
              killed: true,
            });
            kill();
          }, options.timeoutMs)
        : undefined;
    signal?.addEventListener("abort", kill, { once: true });
    if (signal?.aborted) kill();
    const collect = (parts: Buffer[], chunk: Buffer, size: number) => {
      if (failure) return;
      if (size > (options.maxBuffer ?? Infinity)) {
        failure = new Error(`${executable} output exceeds maxBuffer (${options.maxBuffer})`);
        kill();
      } else parts.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk, (stdoutBytes += chunk.length)));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk, (stderrBytes += chunk.length)));
    child.on("error", (error) => {
      failure ??= error;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      const result = {
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      };
      if (signal?.aborted) reject(signal.reason);
      else if (failure) reject(Object.assign(failure, result));
      else resolve(result);
    });
  });
}
