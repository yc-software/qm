import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createAgent, stableCwd } from "../src/agent/agent-run.ts";
import { omitFromModelContext } from "../src/agent/pi-context.ts";
import { buildModelRuntime } from "../src/model/model-runtime.ts";
import { getRequiredModel } from "../src/model/pi-models.ts";
import { createModelRoutes } from "../src/model/model-route.ts";
import type { AgentTurnInput } from "../src/agent/agent.ts";
import { storedItem } from "../src/sessions/items.ts";

const PI_BUILTIN_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "powershell",
  "tool_search",
  "codemode",
];
const PLANTED = "PLANTED-INSTRUCTION-7f3a";

function plant(dir: string, path: string, text: string): void {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), text);
}

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

test("a turn's Pi session exposes only QM tools and loads nothing from disk", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-lockdown-"));
  const saved = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
  process.env.HOME = join(root, "home");
  process.env.TMPDIR = join(root, "tmp");
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    rmSync(root, { recursive: true, force: true });
  });
  const cwd = stableCwd("pi");
  const skill = `---\nname: planted\ndescription: ${PLANTED}\n---\n${PLANTED}\n`;
  const extension = `export default function (pi) { pi.registerTool({ name: "planted_tool", label: "x", description: "${PLANTED}", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [] }) }); }\n`;
  for (const base of [process.env.HOME, cwd]) {
    plant(base, "AGENTS.md", PLANTED);
    plant(base, "SYSTEM.md", PLANTED);
    plant(base, ".pi/settings.json", JSON.stringify({ codemode: { mode: "only" }, defaultTools: ["bash"] }));
    plant(base, ".pi/mcp.json", JSON.stringify({ mcpServers: { planted: { command: "false" } } }));
    plant(base, ".pi/extensions/planted.js", extension);
    plant(base, ".pi/skills/planted/SKILL.md", skill);
    plant(base, ".pi/agent/AGENTS.md", PLANTED);
    plant(base, ".pi/agent/extensions/planted.js", extension);
    plant(base, ".pi/agent/skills/planted/SKILL.md", skill);
    plant(base, ".agents/skills/planted/SKILL.md", skill);
  }

  const requests: Array<{ system?: unknown; tools?: Array<{ name: string }>; messages: unknown[] }> = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body ?? "{}")) as (typeof requests)[number]);
    return sse("ok");
  }) as typeof globalThis.fetch;

  let seq = 10;
  const result = await createAgent({ routes: createModelRoutes({ apiKey: "sk-test" }) }).runTurn({
    session: { id: "lockdown" } as AgentTurnInput["session"],
    runId: "00000000-0000-4000-8000-000000000002",
    input: "hello",
    systemPrompt: "BASE",
    history: [],
    tools: {} as AgentTurnInput["tools"],
    scopeLabel: "personal:tester" as AgentTurnInput["scopeLabel"],
    orgScopeId: "org:test" as AgentTurnInput["orgScopeId"],
    emit: async (item) => storedItem(item, { sessionId: "lockdown", seq: seq++, createdAt: Date.now() }),
    recordModelCall: () => {},
  });

  assert.equal(result.reply, "ok");
  assert.equal(requests.length, 1);
  const names = (requests[0]!.tools ?? []).map((tool) => tool.name);
  assert.ok(names.length > 0, "QM's own tools are declared");
  for (const builtin of [...PI_BUILTIN_TOOLS, "planted_tool"]) assert.ok(!names.includes(builtin), builtin);
  assert.ok(!names.some((name) => name.startsWith("mcp__")), names.join(","));
  assert.ok(!JSON.stringify(requests[0]).includes(PLANTED));
});

test("messages omitted from model context are absent from the next full request", async (t) => {
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
  for (const body of bodies) assert.ok(!("thread" in JSON.parse(body)), "no server-side message thread");
  assert.equal(session.getLastAssistantText(), "FINAL-REPLY-2");
});
