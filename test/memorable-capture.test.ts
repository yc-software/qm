import { test } from "node:test";
import assert from "node:assert/strict";
import { captureSession, type MemorableToolCall } from "../src/memorable/capture.ts";
import type { SessionEntry } from "../src/types.ts";

function entry(type: SessionEntry["type"], payload: unknown, seq: number): SessionEntry {
  return { sessionId: "s1", seq, parentSeq: null, type, payload, scopeLabel: "personal:U1", createdAt: seq };
}

test("captureSession extracts task, scope, and tool calls in order", () => {
  const entries: SessionEntry[] = [
    entry("user", { text: "Fix the failing order tests" }, 1),
    entry("tool_call", { tool: "execute", callId: "c1", command: "./test.sh" }, 2),
    entry("tool_result", { tool: "execute", callId: "c1", isError: true, code: 1, result: "fail" }, 3),
    entry("tool_call", { tool: "write", callId: "c2", path: "src/orders/validate.js", data: "x" }, 4),
    entry("assistant", { text: "done" }, 5),
  ];
  const capture = captureSession("s1", entries);
  const calls: MemorableToolCall[] = capture.tool_calls;
  assert.equal(calls.length, 2);
  assert.equal(capture.session_id, "s1");
  assert.equal(capture.scope_id, "personal:U1");
  assert.equal(capture.task_description, "Fix the failing order tests");
  assert.deepEqual(
    capture.tool_calls.map((c) => c.name),
    ["execute", "write"],
  );
  assert.deepEqual(capture.tool_calls[0]?.input, { command: "./test.sh" });
  assert.deepEqual(capture.tool_calls[1]?.input, { path: "src/orders/validate.js", data: "x" });
});

test("captureSession joins outcomes by callId; ok from isError, exit_code only for execute", () => {
  const entries: SessionEntry[] = [
    entry("tool_call", { tool: "execute", callId: "c1", command: "./test.sh" }, 1),
    entry("tool_result", { tool: "execute", callId: "c1", isError: true, code: 1, result: "fail" }, 2),
    entry("tool_call", { tool: "write", callId: "c2", path: "a.js" }, 3),
    entry("tool_result", { tool: "write", callId: "c2", isError: false, result: "ok" }, 4),
    entry("tool_call", { tool: "read", callId: "c3", path: "b.js" }, 5),
    entry("tool_call", { tool: "execute", callId: "c4", command: "./test.sh" }, 6),
    entry("tool_result", { tool: "execute", callId: "c4", isError: false, code: 0, result: "pass" }, 7),
  ];
  const calls = captureSession("s1", entries).tool_calls;
  assert.deepEqual(calls[0]?.result, { ok: false, exit_code: 1 });
  assert.deepEqual(calls[1]?.result, { ok: true });
  assert.equal(calls[2]?.result, undefined);
  assert.deepEqual(calls[3]?.result, { ok: true, exit_code: 0 });
});

test("captureSession marks quarantined results as failed, never guesses success", () => {
  const entries: SessionEntry[] = [
    entry("tool_call", { tool: "execute", callId: "c1", command: "curl x" }, 1),
    entry("tool_result", { tool: "execute", callId: "c1", quarantined: true, isError: true, result: "" }, 2),
  ];
  const calls = captureSession("s1", entries).tool_calls;
  assert.deepEqual(calls[0]?.result, { ok: false });
});

test("captureSession tolerates malformed payloads and missing user entry", () => {
  const entries: SessionEntry[] = [
    entry("tool_call", null, 1),
    entry("tool_call", { callId: "c1" }, 2),
    entry("tool_call", "junk", 3),
  ];
  const capture = captureSession("s1", entries);
  assert.equal(capture.task_description, "");
  assert.deepEqual(capture.tool_calls, []);
});
