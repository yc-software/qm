import { test } from "node:test";
import assert from "node:assert/strict";
import { assertRuntimeHandoff } from "./live-slack/runtime-handoff.ts";

const call = (callId: string, action: string) => ({ type: "tool_call", payload: { tool: "runtime", callId, action } });
const result = (callId: string, action: string, summary: Record<string, unknown>) => ({
  type: "tool_result",
  payload: {
    tool: "runtime",
    callId,
    action,
    isError: false,
    result: '{"ok":true,"active":…[output cut: showing the first 8192 and last 8192 of 40000 chars]…}',
    ...summary,
  },
});
const choice = { harnessId: "pi", modelId: "another-model" };
const handoff = result("set-1", "set", { ok: true, runtimeHandoff: { lifetime: "task", choice } });
const inspection = result("get-1", "get", { ok: true, active: choice });
const evidence = () => [call("set-1", "set"), handoff, call("get-1", "get"), inspection];

test("runtime handoff qualification reads the recorded runtime summary even when the result text was cut", () => {
  assert.deepEqual(assertRuntimeHandoff(evidence()), choice);
});

test("runtime handoff qualification rejects prose, uncorrelated results, errors, and wrong actions", () => {
  const invalid = [
    [{ type: "assistant", payload: { text: JSON.stringify(handoff) } }],
    [handoff, call("get-1", "get"), inspection],
    [call("set-1", "get"), handoff, call("get-1", "get"), inspection],
    [
      call("set-1", "set"),
      { ...handoff, payload: { ...handoff.payload, isError: true } },
      call("get-1", "get"),
      inspection,
    ],
    [
      call("set-1", "set"),
      result("set-1", "set", { ok: false, runtimeHandoff: { lifetime: "task", choice } }),
      call("get-1", "get"),
      inspection,
    ],
  ];
  for (const entries of invalid) assert.throws(() => assertRuntimeHandoff(entries), /handoff recorded/);
});

test("runtime inspection must follow the handoff and confirm the selected model and harness", () => {
  assert.throws(() => assertRuntimeHandoff(evidence().slice(0, 2)), /inspection after handoff/);
  assert.throws(
    () => assertRuntimeHandoff([call("get-1", "get"), inspection, call("set-1", "set"), handoff]),
    /inspection after handoff/,
  );
  for (const active of [
    { ...choice, modelId: "old-model" },
    { ...choice, harnessId: "other" },
  ])
    assert.throws(() =>
      assertRuntimeHandoff([
        call("set-1", "set"),
        handoff,
        call("get-1", "get"),
        result("get-1", "get", { ok: true, active }),
      ]),
    );
});
