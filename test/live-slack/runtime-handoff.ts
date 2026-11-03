import assert from "node:assert/strict";
import { isObj } from "../../src/util/objects.ts";
import type { Item } from "../../src/sessions/items.ts";

export function assertRuntimeHandoff(items: readonly Item[]): { modelId: string } {
  const calls = new Map<string, { action: string; index: number }>();
  const results: Array<{ index: number; action: string; body: Record<string, unknown> }> = [];
  for (const [index, item] of items.entries()) {
    if (item.tool !== "runtime" || !item.callId) continue;
    if (item.kind === "ToolCall" && typeof item.body.action === "string") {
      calls.set(item.callId, { action: item.body.action, index });
      continue;
    }
    const call = calls.get(item.callId);
    if (item.kind !== "ToolResult" || item.isError !== false || item.body.ok !== true || !call || call.index >= index)
      continue;
    results.push({ index, action: call.action, body: item.body });
  }
  const handoff = results.find((result) => result.action === "set" && isObj(result.body.runtimeHandoff));
  assert.ok(handoff && isObj(handoff.body.runtimeHandoff), "no successful correlated runtime handoff recorded");
  const { lifetime, choice } = handoff.body.runtimeHandoff;
  assert.equal(lifetime, "task");
  assert.ok(isObj(choice));
  assert.ok(typeof choice.modelId === "string" && choice.modelId.length > 0);
  const verification = results.find(
    (result) => result.index > handoff.index && result.action === "get" && isObj(result.body.runtimeActive),
  );
  assert.ok(verification && isObj(verification.body.runtimeActive), "no successful runtime inspection after handoff");
  assert.equal(verification.body.runtimeActive.modelId, choice.modelId);
  return { modelId: choice.modelId };
}
