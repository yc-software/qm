import { spawn } from "node:child_process";

export type DockerExec = (
  args: string[],
  timeoutMs?: number,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export function spawnDockerExec(dockerBin: string): DockerExec {
  return (args, timeoutMs = 60_000) =>
    new Promise((res) => {
      const child = spawn(dockerBin, args, { timeout: timeoutMs, killSignal: "SIGKILL" });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const done = (r: { code: number; stdout: string; stderr: string }) => {
        if (!settled) {
          settled = true;
          res(r);
        }
      };
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("error", (e) => done({ code: -1, stdout, stderr: `${stderr}\n${e.message}` }));
      child.on("close", (code) => done({ code: code ?? -1, stdout, stderr }));
    });
}
