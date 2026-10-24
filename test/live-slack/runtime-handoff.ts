import assert from "node:assert/strict";
import { isObj } from "../../src/util/objects.ts";

export function assertRuntimeHandoff(entries: unknown[]): { harnessId: string; modelId: string } {
  const calls = new Map<string, { action: string; index: number }>();
  const results: Array<{ index: number; action: string; payload: Record<string, unknown> }> = [];
  const seen: unknown[] = [];
  for (const [index, entry] of entries.entries()) {
    if (!isObj(entry) || !isObj(entry.payload)) continue;
    const payload = entry.payload;
    if (payload.tool !== "runtime") continue;
    const { callId, action, ok, isError, resultTruncated, active, runtimeHandoff } = payload;
    seen.push({ index, type: entry.type, callId, action, ok, isError, resultTruncated, active, runtimeHandoff });
    if (typeof callId !== "string") continue;
    if (entry.type === "tool_call" && typeof action === "string") {
      calls.set(callId, { action, index });
      continue;
    }
    const call = calls.get(callId);
    if (entry.type !== "tool_result" || isError !== false || ok !== true) continue;
    if (call && call.index < index) results.push({ index, action: call.action, payload });
  }
  const handoff = results.find((result) => result.action === "set" && isObj(result.payload.runtimeHandoff));
  const evidence = JSON.stringify(seen);
  assert.ok(
    handoff && isObj(handoff.payload.runtimeHandoff),
    `no successful correlated runtime handoff recorded; runtime entries: ${evidence}`,
  );
  const { lifetime, choice } = handoff.payload.runtimeHandoff;
  assert.equal(lifetime, "task");
  assert.ok(isObj(choice));
  assert.equal(choice.harnessId, "pi");
  assert.ok(typeof choice.modelId === "string" && choice.modelId.length > 0);
  const verification = results.find(
    (result) => result.index > handoff.index && result.action === "get" && isObj(result.payload.active),
  );
  assert.ok(
    verification && isObj(verification.payload.active),
    `no successful runtime inspection after handoff; runtime entries: ${evidence}`,
  );
  assert.equal(verification.payload.active.modelId, choice.modelId);
  assert.equal(verification.payload.active.harnessId, choice.harnessId);
  return { harnessId: "pi", modelId: choice.modelId };
}
