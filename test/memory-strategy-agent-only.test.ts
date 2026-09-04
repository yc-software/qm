import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryStrategy } from "../src/memory/strategy.ts";
import { AGENT_ONLY_PROMPT_LINES, createAgentOnlyStrategy } from "../src/memory/strategies/agent-only.ts";
import { createResolutionService } from "../src/resolution/resolution-service.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import type { Conversation, Principal } from "../src/types.ts";

const actor: Principal = { id: "u1", type: "internal" };
const conversation: Conversation = { kind: "dm", threadRef: "t1", audience: [actor] };

test("agent-only strategy: no automatic extraction, curation guidance in promptLines", () => {
  const strategy = createAgentOnlyStrategy();
  assert.equal(strategy.onTurnEnd, undefined);
  assert.equal(strategy.maintain, undefined);
  const lines = strategy.promptLines?.() ?? [];
  assert.deepEqual(lines, AGENT_ONLY_PROMPT_LINES);
  const text = lines.join("\n");
  assert.match(text, /Nothing is saved to memory automatically/);
  assert.match(text, /Update, don't duplicate/);
  assert.match(text, /Delete memories/);
  assert.match(text, /already remembered/);
  assert.match(text, /only matter to the current conversation/);
});

test("createMemoryStrategy('agent-only') returns the agent-only strategy", () => {
  const harness = {} as never;
  const memory = {} as never;
  const workspace = {} as never;
  const { strategy } = createMemoryStrategy("agent-only", { harness, memory, workspace });
  assert.equal(strategy.onTurnEnd, undefined);
  assert.deepEqual(strategy.promptLines?.(), AGENT_ONLY_PROMPT_LINES);
});

test("resolution systemPrompt no longer embeds the memory section — it moved to shared-core + the orchestrator strategy block", async () => {
  const resolution = createResolutionService("default-org", createMemoryConfigStore("default-org"), createAclStore());
  const res = await resolution.resolve(conversation, actor);
  assert.ok(!res.systemPrompt.includes(AGENT_ONLY_PROMPT_LINES[0] as string));
});
