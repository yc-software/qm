import assert from "node:assert/strict";
import { isObj } from "../../src/util/objects.ts";

export function assertRuntimeHandoff(entries: unknown[]): { harnessId: string; modelId: string } {
  const calls = new Map<string, { action: string; index: number }>();
  const results: Array<{ index: number; action: string; payload: Record<string, unknown> }> = [];
  for (const [index, entry] of entries.entries()) {
    if (!isObj(entry) || !isObj(entry.payload)) continue;
    const payload = entry.payload;
    if (payload.tool !== "runtime" || typeof payload.callId !== "string") continue;
    if (entry.type === "tool_call" && typeof payload.action === "string") {
      calls.set(payload.callId, { action: payload.action, index });
      continue;
    }
    const call = calls.get(payload.callId);
    if (entry.type !== "tool_result" || payload.isError !== false || payload.ok !== true) continue;
    if (call && call.index < index) results.push({ index, action: call.action, payload });
  }
  const handoff = results.find((result) => result.action === "set" && isObj(result.payload.runtimeHandoff));
  assert.ok(handoff && isObj(handoff.payload.runtimeHandoff), "no successful correlated runtime handoff recorded");
  const { lifetime, choice } = handoff.payload.runtimeHandoff;
  assert.equal(lifetime, "task");
  assert.ok(isObj(choice));
  assert.equal(choice.harnessId, "pi");
  assert.ok(typeof choice.modelId === "string" && choice.modelId.length > 0);
  const verification = results.find(
    (result) => result.index > handoff.index && result.action === "get" && isObj(result.payload.active),
  );
  assert.ok(verification && isObj(verification.payload.active), "no successful runtime inspection after handoff");
  assert.equal(verification.payload.active.modelId, choice.modelId);
  assert.equal(verification.payload.active.harnessId, choice.harnessId);
  return { harnessId: "pi", modelId: choice.modelId };
}
