import { spawn } from "node:child_process";

export type DockerExec = (
  args: string[],
  timeoutMs?: number,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export function spawnDockerExec(dockerBin: string): DockerExec {
  return (args, timeoutMs = 60_000) =>
    new Promise((res) => {
      const child = spawn(dockerBin, args);
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      const done = (r: { code: number; stdout: string; stderr: string }) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          res(r);
        }
      };
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("error", (e) => done({ code: -1, stdout, stderr: `${stderr}\n${e.message}` }));
      child.on("close", (code, signal) => {
        let termination = "";
        if (timedOut) termination = `docker command timed out after ${timeoutMs}ms${signal ? ` (${signal})` : ""}`;
        else if (signal) termination = `docker command terminated by ${signal}`;
        const diagnostic = termination
          ? `${stderr}${stderr && !stderr.endsWith("\n") ? "\n" : ""}${termination}`
          : stderr;
        done({ code: code ?? -1, stdout, stderr: diagnostic });
      });
    });
}
