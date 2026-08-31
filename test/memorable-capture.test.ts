import { test } from "node:test";
import assert from "node:assert/strict";
import { captureSession, type MemorableToolCall } from "../src/memorable/capture.ts";
import type { SessionEntry } from "../src/types.ts";

const WORKER_WORKFLOW_ID = /^[A-Za-z0-9._-]{1,200}$/;

function entry(type: SessionEntry["type"], payload: unknown, seq: number): SessionEntry {
  return { sessionId: "s1", seq, parentSeq: null, type, payload, scopeLabel: "personal:U1", createdAt: seq };
}

function work(seq: number, tag: string): SessionEntry[] {
  return [
    entry("tool_call", { tool: "execute", callId: `${tag}a`, command: `./${tag}.sh` }, seq),
    entry("tool_call", { tool: "write", callId: `${tag}b`, path: `${tag}.js` }, seq + 1),
  ];
}

test("captureSession extracts prompt, scope, and tool calls in order", () => {
  const entries: SessionEntry[] = [
    entry("user", { text: "Fix the failing order tests" }, 1),
    entry("tool_call", { tool: "execute", callId: "c1", command: "./test.sh" }, 2),
    entry("tool_result", { tool: "execute", callId: "c1", isError: true, code: 1, result: "fail" }, 3),
    entry("tool_call", { tool: "write", callId: "c2", path: "src/orders/validate.js", data: "x" }, 4),
    entry("assistant", { text: "done" }, 5),
  ];
  const capture = captureSession("s1", entries);
  assert.equal(capture.session_id, "s1");
  assert.equal(capture.scope_id, "personal:U1");
  assert.equal(capture.workflows.length, 1);
  const workflow = capture.workflows[0]!;
  assert.equal(workflow.workflow_id, "s1-1");
  assert.equal(workflow.prompt, "Fix the failing order tests");
  const calls: MemorableToolCall[] = workflow.tool_calls;
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((c) => c.name),
    ["execute", "write"],
  );
  assert.deepEqual(calls[0]?.input, { command: "./test.sh" });
  assert.deepEqual(calls[1]?.input, { path: "src/orders/validate.js", data: "x" });
});

test("captureSession cuts one workflow per prompt, not one per session", () => {
  const entries: SessionEntry[] = [
    entry("user", { text: "Fix the failing order tests" }, 1),
    ...work(2, "t"),
    entry("tool_result", { tool: "execute", callId: "ta", isError: false, code: 0 }, 4),
    entry("assistant", { text: "done" }, 5),
    entry("user", { text: "now bump the version and tag it" }, 6),
    entry("tool_call", { tool: "write", callId: "c2", path: "package.json" }, 7),
    entry("tool_call", { tool: "execute", callId: "c3", command: "git tag v2" }, 8),
    entry("tool_result", { tool: "execute", callId: "c3", isError: false, code: 0 }, 9),
  ];
  const { workflows } = captureSession("s1", entries);
  assert.equal(workflows.length, 2);
  assert.deepEqual(
    workflows.map((w) => w.workflow_id),
    ["s1-1", "s1-6"],
  );
  assert.equal(workflows[0]?.prompt, "Fix the failing order tests");
  assert.equal(workflows[1]?.prompt, "now bump the version and tag it");
  assert.deepEqual(
    workflows[0]?.tool_calls.map((c) => c.name),
    ["execute", "write"],
  );
  assert.deepEqual(
    workflows[1]?.tool_calls.map((c) => c.name),
    ["write", "execute"],
  );
});

test("captureSession drops a prompt that produced no tool calls", () => {
  const entries: SessionEntry[] = [
    entry("user", { text: "hey, what does this repo do?" }, 1),
    entry("assistant", { text: "it is a harness" }, 2),
    entry("user", { text: "ok, fix the order tests" }, 3),
    ...work(4, "t"),
  ];
  const { workflows } = captureSession("s1", entries);
  assert.equal(workflows.length, 1);
  assert.equal(workflows[0]?.workflow_id, "s1-3");
  assert.equal(workflows[0]?.prompt, "ok, fix the order tests");
});

test("captureSession keeps tool calls that precede the first prompt", () => {
  const entries: SessionEntry[] = [...work(1, "boot"), entry("user", { text: "fix it" }, 3), ...work(4, "fix")];
  const { workflows } = captureSession("s1", entries);
  assert.deepEqual(
    workflows.map((w) => w.workflow_id),
    ["s1-0", "s1-3"],
  );
  assert.equal(workflows[0]?.prompt, "");
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
  const calls = captureSession("s1", entries).workflows[0]!.tool_calls;
  assert.deepEqual(calls[0]?.result, { ok: false, exit_code: 1 });
  assert.deepEqual(calls[1]?.result, { ok: true });
  assert.equal(calls[2]?.result, undefined);
  assert.deepEqual(calls[3]?.result, { ok: true, exit_code: 0 });
});

test("captureSession gives each reused callId the outcome that followed it, not the last one", () => {
  const entries: SessionEntry[] = [
    entry("user", { text: "go" }, 1),
    entry("tool_call", { tool: "execute", callId: "c1", command: "./ok.sh" }, 2),
    entry("tool_result", { tool: "execute", callId: "c1", isError: false, code: 0 }, 3),
    entry("tool_call", { tool: "execute", callId: "c1", command: "./bad.sh" }, 4),
    entry("tool_result", { tool: "execute", callId: "c1", isError: true, code: 1 }, 5),
  ];
  const calls = captureSession("s1", entries).workflows[0]!.tool_calls;
  assert.deepEqual(calls[0]?.result, { ok: true, exit_code: 0 });
  assert.deepEqual(calls[1]?.result, { ok: false, exit_code: 1 });
});

test("captureSession marks quarantined results as failed, never guesses success", () => {
  const entries: SessionEntry[] = [
    entry("tool_call", { tool: "execute", callId: "c1", command: "curl x" }, 1),
    entry("tool_result", { tool: "execute", callId: "c1", quarantined: true, isError: true, result: "" }, 2),
    entry("tool_call", { tool: "write", callId: "c2", path: "a.js" }, 3),
  ];
  const calls = captureSession("s1", entries).workflows[0]!.tool_calls;
  assert.deepEqual(calls[0]?.result, { ok: false });
});

test("captureSession tolerates malformed payloads and missing user entry", () => {
  const entries: SessionEntry[] = [
    entry("tool_call", null, 1),
    entry("tool_call", { callId: "c1" }, 2),
    entry("tool_call", "junk", 3),
  ];
  const capture = captureSession("s1", entries);
  assert.deepEqual(capture.workflows, []);
});

test("captureSession emits a workflow_id the extraction worker will accept", () => {
  const entries: SessionEntry[] = [entry("user", { text: "fix it" }, 7), ...work(8, "t")];
  const { workflows } = captureSession("a1b2:c3/d4 e5", entries);
  assert.equal(workflows.length, 1);
  assert.match(workflows[0]!.workflow_id, WORKER_WORKFLOW_ID);
});

test("a session id longer than the id cap still yields one workflow_id per prompt", () => {
  const entries: SessionEntry[] = [
    entry("user", { text: "first" }, 1),
    ...work(2, "a"),
    entry("user", { text: "second" }, 4),
    ...work(5, "b"),
  ];
  const { workflows } = captureSession("s".repeat(250), entries);
  assert.equal(workflows.length, 2);
  for (const workflow of workflows) assert.match(workflow.workflow_id, WORKER_WORKFLOW_ID);
  assert.notEqual(workflows[0]!.workflow_id, workflows[1]!.workflow_id);
});

test("session ids that differ only outside the worker charset do not share a workflow_id", () => {
  const entries: SessionEntry[] = [entry("user", { text: "go" }, 1), ...work(2, "t")];
  const ids = ["a:b", "a/b", "a b", "a.b", "\u{1f525}\u{1f525}", ""].map(
    (raw) => captureSession(raw, entries).workflows[0]!.workflow_id,
  );
  for (const id of ids) assert.match(id, WORKER_WORKFLOW_ID);
  assert.equal(new Set(ids).size, ids.length);
});

test("captureSession strips terminal control sequences out of a prompt", () => {
  const nasty = "fix \u0000 the \u001b]0;pwned\u0007 bell \u001b[31mred\u001b[0m thing";
  const entries: SessionEntry[] = [entry("user", { text: nasty }, 1), ...work(2, "t")];
  const prompt = captureSession("s1", entries).workflows[0]!.prompt;
  assert.equal(/[\x00-\x08\x0b-\x1f\x7f]/.test(prompt), false);
  assert.equal(prompt.includes("pwned"), false);
  assert.equal(prompt.includes("]0;"), false);
  assert.equal(prompt, "fix  the  bell red thing");
});

test("a prompt made only of control characters does not cut a workflow", () => {
  const entries: SessionEntry[] = [
    entry("user", { text: "real prompt" }, 1),
    ...work(2, "a"),
    entry("user", { text: "\u0000\u0007\u001b[0m" }, 4),
    ...work(5, "b"),
  ];
  const { workflows } = captureSession("s1", entries);
  assert.equal(workflows.length, 1);
  assert.equal(workflows[0]!.prompt, "real prompt");
  assert.equal(workflows[0]!.tool_calls.length, 4);
});

test("a pasted stack trace is capped instead of being relayed whole", () => {
  const entries: SessionEntry[] = [entry("user", { text: "trace\n".repeat(80_000) }, 1), ...work(2, "t")];
  const prompt = captureSession("s1", entries).workflows[0]!.prompt;
  assert.ok(prompt.length <= 16_000, `prompt was ${prompt.length} chars`);
  assert.match(prompt, /^trace/);
});

test("a tool call carrying a whole file is capped before it leaves the process", () => {
  const entries: SessionEntry[] = [
    entry("user", { text: "write it" }, 1),
    entry("tool_call", { tool: "write", callId: "c1", path: "big.bin", data: "z".repeat(8_000_000) }, 2),
    entry("tool_call", { tool: "execute", callId: "c2", command: "./verify.sh" }, 3),
  ];
  const capture = captureSession("s1", entries);
  assert.ok(Buffer.byteLength(JSON.stringify(capture)) < 100_000);
  assert.equal((capture.workflows[0]!.tool_calls[0]!.input.data as string).length, 32_000);
  assert.equal(capture.workflows[0]!.tool_calls[1]!.input.command, "./verify.sh");
});
