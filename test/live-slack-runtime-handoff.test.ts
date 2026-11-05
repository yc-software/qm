import { test } from "node:test";
import assert from "node:assert/strict";
import { assertRuntimeHandoff } from "./live-slack/runtime-handoff.ts";
import { storedItem, type NewItem } from "../src/sessions/items.ts";

const at = { sessionId: "s", seq: 0, createdAt: 0 };
const stored = (item: NewItem) => storedItem(item, at);
const call = (callId: string, action: string) =>
  stored({ kind: "ToolCall", tool: "runtime", callId, body: { action } });
const result = (callId: string, body: Record<string, unknown>) =>
  stored({ kind: "ToolResult", tool: "runtime", callId, isError: false, text: "…[output cut]…", body });
const choice = { modelId: "another-model" };
const handoff = result("set-1", { ok: true, runtimeHandoff: { lifetime: "task", choice } });
const inspection = result("get-1", { ok: true, runtimeActive: choice });
const evidence = () => [call("set-1", "set"), handoff, call("get-1", "get"), inspection];

test("runtime handoff qualification reads the persisted runtime fields, not the shown result text", () => {
  assert.deepEqual(assertRuntimeHandoff(evidence()), choice);
});

test("runtime handoff qualification rejects prose, uncorrelated results, errors, and wrong actions", () => {
  const invalid = [
    [stored({ kind: "AgentMessage", text: JSON.stringify(handoff) })],
    [handoff, call("get-1", "get"), inspection],
    [call("set-1", "get"), handoff, call("get-1", "get"), inspection],
    [call("set-1", "set"), { ...handoff, isError: true }, call("get-1", "get"), inspection],
    [
      call("set-1", "set"),
      result("set-1", { ok: false, runtimeHandoff: { lifetime: "task", choice } }),
      call("get-1", "get"),
      inspection,
    ],
  ];
  for (const items of invalid) assert.throws(() => assertRuntimeHandoff(items), /handoff recorded/);
});

test("runtime inspection must follow the handoff and confirm the selected model", () => {
  assert.throws(() => assertRuntimeHandoff(evidence().slice(0, 2)), /inspection after handoff/);
  assert.throws(
    () => assertRuntimeHandoff([call("get-1", "get"), inspection, call("set-1", "set"), handoff]),
    /inspection after handoff/,
  );
  assert.throws(() =>
    assertRuntimeHandoff([
      call("set-1", "set"),
      handoff,
      call("get-1", "get"),
      result("get-1", { ok: true, runtimeActive: { ...choice, modelId: "old-model" } }),
    ]),
  );
});
