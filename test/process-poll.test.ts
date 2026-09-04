import { test } from "node:test";
import assert from "node:assert/strict";
import { pollProcess, processIsGone } from "../src/sandbox/process-poll.ts";
import type { ProcessSandbox, ReadProcessResult, SandboxHandle } from "../src/sandbox/sandbox.ts";

const handle: SandboxHandle = { id: "vm", rootDir: "/workspace" };

function fakeSandbox(reads: ReadProcessResult[]) {
  let calls = 0;
  const sandbox = {
    async readProcess() {
      const read = reads[Math.min(calls, reads.length - 1)]!;
      calls += 1;
      return read;
    },
  } as unknown as ProcessSandbox;
  return { sandbox, callCount: () => calls };
}

const running = (chunks: string, cursor: number): ReadProcessResult => ({
  chunks,
  cursor,
  status: { state: "running" },
});

test("processIsGone: the bare-string sentinel counts as gone", () => {
  assert.equal(processIsGone("no such process session: p-1"), true);
  assert.equal(processIsGone(new Error("no such process session: p-1")), true);
});

test("processIsGone: an embedded phrase in a wrapped error does NOT confirm a kill", () => {
  assert.equal(processIsGone(new Error("fly api 500: upstream said 'no such process' while restarting")), false);
});

test("pollProcess stops when `until` fires, returning the output and cursor so far", async () => {
  const { sandbox, callCount } = fakeSandbox([running("a", 1), running("b", 2), running("c", 3)]);
  const res = await pollProcess(sandbox, handle, "p", {
    deadlineMs: 60_000,
    until: (_read, output) => output.includes("b"),
  });
  assert.equal(res.output, "ab");
  assert.equal(res.cursor, 2);
  assert.deepEqual(res.status, { state: "running" });
  assert.equal(callCount(), 2, "stopped before the exit/deadline, no third read");
});

test("pollProcess honors `until` on the very first read", async () => {
  const { sandbox, callCount } = fakeSandbox([running("a", 1)]);
  const res = await pollProcess(sandbox, handle, "p", { deadlineMs: 60_000, until: () => true });
  assert.equal(res.output, "a");
  assert.equal(res.cursor, 1);
  assert.equal(callCount(), 1);
});

test("pollProcess returns at the deadline on a never-exiting process, after at least one read", async () => {
  const { sandbox, callCount } = fakeSandbox([running("", 0)]);
  const res = await pollProcess(sandbox, handle, "p", { deadlineMs: 60 });
  assert.deepEqual(res.status, { state: "running" });
  assert.ok(callCount() >= 1, `expected at least one read, got ${callCount()}`);
});

test("pollProcess with deadlineMs <= 0 still performs exactly one read", async () => {
  const { sandbox, callCount } = fakeSandbox([running("late", 4)]);
  const res = await pollProcess(sandbox, handle, "p", { deadlineMs: 0 });
  assert.equal(res.output, "late");
  assert.equal(res.cursor, 4);
  assert.equal(callCount(), 1);
});

test("pollProcess with collect: false discards output instead of buffering it", async () => {
  const { sandbox } = fakeSandbox([
    running("chatty chunk", 1),
    { chunks: "final chunk", cursor: 2, status: { state: "exited", code: 0 } },
  ]);
  const res = await pollProcess(sandbox, handle, "p", { deadlineMs: 60_000, collect: false });
  assert.equal(res.output, "");
  assert.equal(res.cursor, 2);
  assert.deepEqual(res.status, { state: "exited", code: 0 });
});
