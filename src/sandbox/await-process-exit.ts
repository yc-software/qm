import type { ProcessSandbox, ProcessState, SandboxHandle } from "./sandbox.ts";
import { pollProcess } from "./process-poll.ts";

export async function awaitProcessExit(
  sandbox: ProcessSandbox,
  handle: SandboxHandle,
  processId: string,
  graceMs: number,
): Promise<ProcessState> {
  const { status } = await pollProcess(sandbox, handle, processId, { deadlineMs: graceMs, collect: false });
  return status;
}
