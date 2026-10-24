import { test } from "node:test";
import assert from "node:assert/strict";
import { assertRuntimeHandoff } from "./live-slack/runtime-handoff.ts";

const call = (callId: string, action: string) => ({ type: "tool_call", payload: { tool: "runtime", callId, action } });
const result = (callId: string, value: unknown) => ({
  type: "tool_result",
  payload: { tool: "runtime", callId, isError: false, result: JSON.stringify(value) },
});
const choice = { harnessId: "pi", modelId: "another-model" };
const handoff = result("set-1", { ok: true, handoff: { lifetime: "task", choice } });
const inspection = result("get-1", { ok: true, active: choice });
const evidence = () => [call("set-1", "set"), handoff, call("get-1", "get"), inspection];

test("runtime handoff qualification reads persisted JSON tool results", () => {
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
      result("set-1", { ok: false, handoff: { lifetime: "task", choice } }),
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
        result("get-1", { ok: true, active }),
      ]),
    );
});

test("runtime inspection is read from the head of a parked long result", () => {
  const full = JSON.stringify({ ok: true, active: choice, modelsByHarness: { pi: ["x".repeat(20_000)] } });
  const parked = (text: string) => ({
    type: "tool_result",
    payload: {
      tool: "runtime",
      callId: "get-1",
      isError: false,
      result: `${text.slice(0, 8192)}\n…[output cut]…\n${text.slice(-8192)}`,
      output: { blob: "b", chars: text.length, shownChars: 16_384 },
    },
  });
  const entries = [call("set-1", "set"), handoff, call("get-1", "get"), parked(full)];
  assert.deepEqual(assertRuntimeHandoff(entries), choice);
  const unparked = [
    call("set-1", "set"),
    handoff,
    call("get-1", "get"),
    { ...parked(full), payload: { ...parked(full).payload, output: undefined } },
  ];
  assert.throws(() => assertRuntimeHandoff(unparked), /inspection after handoff/);
  const failed = JSON.stringify({ ok: false, active: choice, error: "x".repeat(20_000) });
  assert.throws(
    () => assertRuntimeHandoff([call("set-1", "set"), handoff, call("get-1", "get"), parked(failed)]),
    /inspection after handoff/,
  );
});
