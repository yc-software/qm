import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { scopeId } from "../src/types.ts";

test("session entries can be restricted to named durable tools", async () => {
  const sessions = createMemorySessionStore();
  const scope = scopeId("personal", "entry-tools");
  const session = await sessions.getOrCreateByThread("entry-tools", "dm", scope);
  const attempt = await sessions.acquireLease(session.id, "turn");
  assert.ok(attempt.lease);
  await sessions.appendMany(attempt.lease, [
    {
      type: "tool_result",
      payload: { tool: "workflow_gate", callId: "workflow", accepted: true },
      scopeLabel: scope,
    },
    {
      type: "tool_result",
      payload: { tool: "skills", callId: "skill", found: true },
      scopeLabel: scope,
    },
  ]);

  const entries = await sessions.getEntries(session.id, { tools: ["workflow_gate"] });

  assert.equal(entries.length, 1);
  assert.equal((entries[0]?.payload as { tool?: string }).tool, "workflow_gate");
});
