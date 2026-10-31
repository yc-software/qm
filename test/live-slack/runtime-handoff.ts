import assert from "node:assert/strict";
import { isObj } from "../../src/util/objects.ts";

export function assertRuntimeHandoff(entries: unknown[]): { modelId: string } {
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
    if (
      entry.type !== "tool_result" ||
      payload.isError !== false ||
      payload.ok !== true ||
      !call ||
      call.index >= index
    )
      continue;
    results.push({ index, action: call.action, payload });
  }
  const handoff = results.find((result) => result.action === "set" && isObj(result.payload.runtimeHandoff));
  assert.ok(handoff && isObj(handoff.payload.runtimeHandoff), "no successful correlated runtime handoff recorded");
  const { lifetime, choice } = handoff.payload.runtimeHandoff;
  assert.equal(lifetime, "task");
  assert.ok(isObj(choice));
  assert.ok(typeof choice.modelId === "string" && choice.modelId.length > 0);
  const verification = results.find(
    (result) => result.index > handoff.index && result.action === "get" && isObj(result.payload.runtimeActive),
  );
  assert.ok(
    verification && isObj(verification.payload.runtimeActive),
    "no successful runtime inspection after handoff",
  );
  assert.equal(verification.payload.runtimeActive.modelId, choice.modelId);
  return { modelId: choice.modelId };
}
