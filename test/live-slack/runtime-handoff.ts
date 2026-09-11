import assert from "node:assert/strict";
import { isObj } from "../../src/util/objects.ts";

export function assertRuntimeHandoff(entries: unknown[]): { harnessId: string; modelId: string } {
  const calls = new Map<string, { action: string; index: number }>();
  const results: Array<{ index: number; action: string; value: Record<string, unknown> }> = [];
  for (const [index, entry] of entries.entries()) {
    if (!isObj(entry) || !isObj(entry.payload)) continue;
    const payload = entry.payload;
    if (payload.tool !== "runtime" || typeof payload.callId !== "string") continue;
    if (entry.type === "tool_call" && typeof payload.action === "string") {
      calls.set(payload.callId, { action: payload.action, index });
      continue;
    }
    const call = calls.get(payload.callId);
    if (entry.type !== "tool_result" || payload.isError !== false || !call || call.index >= index) continue;
    if (typeof payload.result !== "string") continue;
    let value: unknown;
    try {
      value = JSON.parse(payload.result);
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
