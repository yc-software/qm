import { getOperationSignal } from "../util/async.ts";
import { spawnCaptured } from "../util/process.ts";
import { errMessage } from "../util/errors.ts";

export type DockerExec = (
  args: string[],
  timeoutMs?: number,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export function spawnDockerExec(dockerBin: string): DockerExec {
  return async (args, timeoutMs = 60_000) => {
    try {
      return await spawnCaptured(dockerBin, args, { timeoutMs });
    } catch (error) {
      getOperationSignal()?.throwIfAborted();
      const captured = error as { stdout?: string; stderr?: string };
      return { code: -1, stdout: captured.stdout ?? "", stderr: `${captured.stderr ?? ""}\n${errMessage(error)}` };
    }
  };
}
