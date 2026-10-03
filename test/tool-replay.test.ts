import { test } from "node:test";
import assert from "node:assert/strict";
import { toolReplayPolicy, uncertainToolCalls } from "../src/harness/tool-replay.ts";
import type { SessionEntry } from "../src/types.ts";
import type { TapeRecord } from "../src/sessions/session-store.ts";

const entry = (type: string, payload: unknown) => ({ type, payload }) as SessionEntry;
const native = (payload: unknown) => ({ kind: "message", payload }) as TapeRecord;

test("only fixed read-only operations are replayable; shell, MCP and unknown tools are unsafe", () => {
  for (const call of [
    { tool: "execute", command: "echo hello" },
    { tool: "sandbox", action: "exec", command: "ls" },
    { tool: "files", action: "write" },
    { tool: "future_tool", action: "read" },
    { tool: "history", mcpServer: "remote" },
    { tool: "history", client: true },
  ])
    assert.equal(toolReplayPolicy(call), "unsafe");
  assert.equal(toolReplayPolicy({ tool: "files", action: "read" }), "safe");
});

test("an unknown shell outcome stays unsafe even when an abort error was recorded", () => {
  const call = entry("tool_call", { tool: "execute", callId: "shell", replay: "unsafe" });
  assert.deepEqual(uncertainToolCalls([call], []), ["execute"]);
  const unknown = entry("tool_result", { callId: "shell", outcomeUnknown: true });
  assert.deepEqual(uncertainToolCalls([call, unknown], []), ["execute"]);
  const completed = entry("tool_result", { callId: "shell", result: "done" });
  assert.deepEqual(uncertainToolCalls([call, completed], []), []);
});

test("safe retry requires both persisted and current policy; old unclassified calls fail closed", () => {
  for (const replay of [undefined, "unsafe", "safe"]) {
    const call = entry("tool_call", { tool: "files", action: "read", callId: "read", replay });
    assert.deepEqual(uncertainToolCalls([call], []), replay === "safe" ? [] : ["files"]);
  }
  assert.deepEqual(uncertainToolCalls([entry("tool_call", { tool: "execute", callId: "shell", replay: "safe" })], []), [
    "execute",
  ]);
});

test("native unfinished tool calls fail closed across Pi, Claude, Codex and OpenCode", () => {
  const cases = [
    [
      native({ role: "assistant", content: [{ type: "toolCall", id: "call", name: "execute" }] }),
      native({ role: "toolResult", toolCallId: "call", content: [] }),
    ],
    [
      native({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", id: "call", name: "execute" }] },
      }),
      native({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call", content: "done" }] } }),
    ],
    [
      native({ type: "function_call", call_id: "call", name: "execute" }),
      native({ type: "function_call_output", call_id: "call", output: "done" }),
    ],
    [
      native({
        info: { role: "assistant" },
        parts: [{ type: "tool", callID: "call", tool: "execute", state: { status: "running" } }],
      }),
      native({ parts: [{ type: "tool", callID: "call", tool: "execute", state: { status: "completed" } }] }),
    ],
  ];
  for (const [call, result] of cases) {
    assert.deepEqual(uncertainToolCalls([], [call!]), ["execute"]);
    assert.deepEqual(uncertainToolCalls([], [call!, result!]), []);
  }
});

test("an interrupted streamed model response is not a dispatched tool call", () => {
  assert.deepEqual(
    uncertainToolCalls(
      [],
      [
        native({
          role: "assistant",
          stopReason: "aborted",
          content: [{ type: "toolCall", id: "call", name: "execute" }],
        }),
      ],
    ),
    [],
  );
});

test("provider call IDs reused later cannot inherit an earlier completion", () => {
  const call = entry("tool_call", { tool: "execute", callId: "same", replay: "unsafe" });
  const result = entry("tool_result", { callId: "same", result: "done" });
  assert.deepEqual(uncertainToolCalls([call, result, call], []), ["execute"]);
  const nativeCall = native({ role: "assistant", content: [{ type: "toolCall", id: "same", name: "execute" }] });
  const nativeResult = native({ role: "toolResult", toolCallId: "same", content: [] });
  assert.deepEqual(uncertainToolCalls([], [nativeCall, nativeResult, nativeCall]), ["execute"]);
  assert.deepEqual(uncertainToolCalls([call, result], [nativeCall, nativeResult, nativeCall]), ["execute"]);
  assert.deepEqual(
    uncertainToolCalls([call, result, call, result], [nativeCall, nativeResult, nativeCall, nativeResult]),
    [],
  );
});

test("a completed Claude bridge call is not uncertain when its native result echo is missing", () => {
  const entries = [
    { seq: 1, type: "tool_call", payload: { callId: "toolu_x", tool: "execute" } },
    { seq: 2, type: "tool_result", payload: { callId: "toolu_x" } },
  ] as unknown as Parameters<typeof uncertainToolCalls>[0];
  const rows = [
    {
      kind: "message",
      harness: "claude",
      payload: {
        message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_x", name: "mcp__qm__execute" }] },
      },
    },
  ] as unknown as Parameters<typeof uncertainToolCalls>[1];
  assert.deepEqual(uncertainToolCalls(entries, rows), []);
});

test("a Claude native call the bridge never recorded is uncertain", () => {
  const rows = [
    {
      kind: "message",
      harness: "claude",
      payload: {
        message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_y", name: "mcp__qm__execute" }] },
      },
    },
  ] as unknown as Parameters<typeof uncertainToolCalls>[1];
  assert.deepEqual(uncertainToolCalls([], rows), ["mcp__qm__execute"]);
});
