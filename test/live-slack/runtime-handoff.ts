import assert from "node:assert/strict";
import { isObj } from "../../src/util/objects.ts";
import type { Item } from "../../src/sessions/items.ts";

export function assertRuntimeHandoff(items: readonly Item[]): { harnessId: string; modelId: string } {
  const calls = new Map<string, { action: string; index: number }>();
  const results: Array<{ index: number; action: string; value: Record<string, unknown> }> = [];
  for (const [index, item] of items.entries()) {
    if (item.tool !== "runtime" || !item.callId) continue;
    if (item.kind === "ToolCall" && typeof item.body.action === "string") {
      calls.set(item.callId, { action: item.body.action, index });
      continue;
    }
    const call = calls.get(item.callId);
    if (item.kind !== "ToolResult" || item.isError !== false || !call || call.index >= index) continue;
    if (typeof item.text !== "string") continue;
    let value: unknown;
    try {
      value = JSON.parse(item.text);
    } catch {
      continue;
    }
    if (isObj(value) && value.ok === true) results.push({ index, action: call.action, value });
  }
  const handoff = results.find((result) => result.action === "set" && isObj(result.value.handoff));
  assert.ok(handoff && isObj(handoff.value.handoff), "no successful correlated runtime handoff recorded");
  const { lifetime, choice } = handoff.value.handoff;
  assert.equal(lifetime, "task");
  assert.ok(isObj(choice));
  assert.equal(choice.harnessId, "pi");
  assert.ok(typeof choice.modelId === "string" && choice.modelId.length > 0);
  const verification = results.find(
    (result) => result.index > handoff.index && result.action === "get" && isObj(result.value.active),
  );
  assert.ok(verification && isObj(verification.value.active), "no successful runtime inspection after handoff");
  assert.equal(verification.value.active.modelId, choice.modelId);
  assert.equal(verification.value.active.harnessId, choice.harnessId);
  return { harnessId: "pi", modelId: choice.modelId };
}
