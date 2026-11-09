import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { omitFromModelContext } from "../src/agent/agent-run.ts";
import { buildModelRuntime } from "../src/model/model-runtime.ts";
import { getRequiredModel } from "../src/model/pi-models.ts";

function sse(text: string): Response {
  const events: Array<Record<string, unknown>> = [
    {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-test",
        stop_reason: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ];
  const body = events.map((event) => `event: ${event.type as string}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("messages omitted from model context are absent from the next request", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-context-edits-"));
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  });
  const bodies: string[] = [];
  const replies = ["DRAFT-REPLY-1", "FINAL-REPLY-2"];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ""));
    return sse(replies[bodies.length - 1] ?? "extra");
  }) as typeof globalThis.fetch;
  const settingsManager = SettingsManager.inMemory({ cacheWarming: "off" }, { projectTrusted: false });
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    systemPrompt: "BASE",
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    model: getRequiredModel("claude-opus-5"),
    modelRuntime: await buildModelRuntime("sk-test"),
    resourceLoader,
    settingsManager,
    noTools: "all",
    tools: [],
    sessionManager: SessionManager.inMemory(),
    cwd: dir,
    agentDir: dir,
  });
  t.after(() => session.dispose());

  await session.prompt("RETRACTED-PROMPT");
  omitFromModelContext(session, new Set(session.agent.state.messages.filter((m) => m.role !== "system")));
  await session.prompt("NEXT-PROMPT");

  assert.equal(bodies.length, 2);
  assert.match(bodies[1]!, /NEXT-PROMPT/);
  assert.doesNotMatch(bodies[1]!, /RETRACTED-PROMPT|DRAFT-REPLY-1/);
  assert.equal(session.getLastAssistantText(), "FINAL-REPLY-2");
});
