import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { createMockAgent } from "./support/mock-agent.ts";

test("turn tools replace stored page tools, with explicit empty and absent declarations distinct", async () => {
  const agent = createMockAgent();
  const run = agent.runTurn;
  const seen: unknown[] = [];
  agent.runTurn = async (turn) => {
    seen.push(turn.clientTools);
    return run(turn);
  };
  const built = buildApp(testConfig(), { agent });
  const request = {
    surface: "web",
    actor: { externalId: "U1" },
    conversation: { kind: "dm" as const, threadRef: "web:U1:tools" },
    text: "hello",
  };
  const tools = (name: string) => [{ name, description: "Read the open page", inputSchema: { type: "object" } }];
  const session = await built.sessions.getOrCreateByThread(
    request.conversation.threadRef,
    "dm",
    "personal:U1",
    undefined,
    "web",
    tools("ui__first"),
  );
  await built.sessions.addParticipant(session.id, "U1");
  for (const clientTools of [tools("ui__first"), tools("ui__second"), [], undefined]) {
    assert.equal((await built.app.turn({ ...request, ...(clientTools ? { clientTools } : {}) })).status, "ok");
    assert.deepEqual(seen.at(-1), clientTools?.length === 0 ? undefined : (clientTools ?? tools("ui__first")));
  }
});
