import { spawn } from "node:child_process";

export type CommandExec = (
  args: string[],
  timeoutMs?: number,
  input?: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export function spawnCommandExec(binary: string): CommandExec {
  return (args, timeoutMs = 60_000, input) =>
    new Promise((resolve) => {
      const child = spawn(binary, args, { timeout: timeoutMs, killSignal: "SIGKILL" });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const done = (code: number) => {
        if (settled) return;
        settled = true;
        resolve({ code, stdout, stderr });
      };
      child.stdout.on("data", (data) => (stdout += data.toString()));
      child.stderr.on("data", (data) => (stderr += data.toString()));
      child.stdin.on("error", (error) => {
        stderr += `\n${error.message}`;
        child.kill("SIGKILL");
        done(-1);
      });
      child.on("error", (error) => {
        stderr += `\n${error.message}`;
        done(-1);
      });
      child.on("close", (code) => done(code ?? -1));
      child.stdin.end(input);
    });
}
