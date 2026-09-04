import type { ProcessSandbox, ProcessState, ReadProcessResult, SandboxHandle } from "./sandbox.ts";
import { errMessage } from "../util/errors.ts";
import { sleep } from "../util/async.ts";

export const processIsGone = (e: unknown): boolean => /^no such process/i.test(errMessage(e));

export interface PollProcessOptions {
  deadlineMs: number;
  waitMs?: number;
  sinceCursor?: number;
  collect?: boolean;
  until?: (read: ReadProcessResult, output: string) => boolean;
}

export interface PollProcessResult {
  output: string;
  cursor: number;
  status: ProcessState;
}

export async function pollProcess(
  sandbox: ProcessSandbox,
  handle: SandboxHandle,
  processId: string,
  opts: PollProcessOptions,
): Promise<PollProcessResult> {
  const waitMs = opts.waitMs ?? 1_000;
  const collect = opts.collect ?? true;
  const deadline = Date.now() + opts.deadlineMs;
  let cursor = opts.sinceCursor ?? 0;
  let output = "";
  for (;;) {
    const startedAt = Date.now();
    const read = await sandbox.readProcess(handle, processId, {
      sinceCursor: cursor,
      waitMs: Math.max(0, Math.min(deadline - startedAt, waitMs)),
    });
    cursor = read.cursor;
    if (collect) output += read.chunks;
    if (read.status.state === "exited" || opts.until?.(read, output) === true || Date.now() >= deadline) {
      return { output, cursor, status: read.status };
    }
    if (Date.now() - startedAt < 25) await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
  }
}
