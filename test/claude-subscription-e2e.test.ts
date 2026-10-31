import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { createAgent } from "../src/agent/agent-run.ts";

const SUBSCRIPTION_TOKEN = "sk-ant-oat01-personal-e2e";

function sse(events: unknown[]): Response {
  const body = events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function message(model: string, blocks: unknown[], stop: string): Response {
  const events: unknown[] = [
    {
      type: "message_start",
      message: {
        id: "msg_e2e",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
  ];
  blocks.forEach((block, index) => {
    const b = block as { type: string; text?: string; id?: string; name?: string; input?: unknown };
    if (b.type === "text") {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } });
    } else {
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: b.id, name: b.name, input: {} },
      });
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) },
      });
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push({ type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 5 } });
  events.push({ type: "message_stop" });
  return sse(events);
}

type Seen = Array<{ headers: Headers; body: Record<string, unknown> }>;

function fakeAnthropic(t: TestContext): Seen {
  const seen: Seen = [];
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://api.anthropic.com/")) return realFetch(input, init);
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    const raw = input instanceof Request ? await input.text() : String(init?.body ?? "{}");
    const body = JSON.parse(raw) as Record<string, unknown>;
    seen.push({ headers, body });
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    const system = JSON.stringify(body.system ?? "");
    const model = String(body.model);
    if (!system.includes("QM")) return message(model, [{ type: "text", text: "side call" }], "end_turn");
    const sawToolResult = JSON.stringify(messages).includes("tool_result");
    if (!sawToolResult) {
      const tools = (body.tools as Array<{ name: string }>) ?? [];
      const history = tools.find((tool) => tool.name.toLowerCase() === "history");
      assert.ok(history, `history tool offered: ${tools.map((tool) => tool.name).join(", ")}`);
      return message(
        model,
        [{ type: "tool_use", id: "toolu_e2e", name: history.name, input: { query: "anything" } }],
        "tool_use",
      );
    }
    return message(model, [{ type: "text", text: "pong from the Claude subscription" }], "end_turn");
  });
  return seen;
}

async function assertSubscriptionTurn(built: ReturnType<typeof buildApp>, seen: Seen, runId: string, token: string) {
  const finished = await built.runs.waitFor(runId, 20_000);
  assert.equal(finished.status, "done", JSON.stringify(finished.result));
  const turnCalls = seen.filter((call) => JSON.stringify(call.body.system ?? "").includes("QM"));
  assert.equal(turnCalls.length, 2, "one tool-use step and one closing step");
  for (const call of turnCalls) {
    assert.equal(call.headers.get("authorization"), `Bearer ${token}`);
    assert.equal(call.headers.get("x-api-key"), null, "no API key header rides along");
    assert.match(call.headers.get("anthropic-beta") ?? "", /oauth-2025-04-20/);
    assert.match(JSON.stringify(call.body.system), /You are Claude Code/);
  }
  const session = await built.sessions.getByThread(finished.sessionId);
  const entries = session ? await built.sessions.getEntries(session.id) : [];
  assert.ok(
    entries.some((e) => e.type === "tool_result" && (e.payload as { tool?: string }).tool === "history"),
    "the history tool ran",
  );
  assert.ok(
    entries.some(
      (e) =>
        e.type === "assistant" &&
        /pong from the Claude subscription/.test(String((e.payload as { text?: string }).text)),
    ),
    JSON.stringify(entries.map((e) => e.type)),
  );
}

test("a personal Claude subscription turn runs end to end on Pi with OAuth bearer auth, including a tool round trip", async (t) => {
  const seen = fakeAnthropic(t);

  const built = buildApp(testConfig({ anthropicApiKey: "sk-ant-api03-company" }), {
    agent: createAgent({ captureRequests: false, resolveProviderKeys: async () => ({}) }),
  });
  await built.userModelCredentials.setOAuth("U1", "anthropic", {
    accessToken: SUBSCRIPTION_TOKEN,
    refreshToken: "refresh-e2e",
    expiresAt: Date.now() + 3_600_000,
  });
  await built.config.setPersonalModelAuth("U1", true, "anthropic");
  const submitted = await built.app.turn({
    surface: "slack",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "claude-subscription-e2e" },
    text: "ping",
    liveActor: true,
    async: true,
  });
  built.runtime.start();
  try {
    await assertSubscriptionTurn(built, seen, submitted.runId!, SUBSCRIPTION_TOKEN);
    assert.ok(
      !seen.some((call) => (call.headers.get("x-api-key") ?? "").includes("company")),
      "no request in the personal turn used the company key",
    );
  } finally {
    await built.runtime.stop();
  }
});

test("a company Claude subscription token in ANTHROPIC_API_KEY serves company turns on the wired agent", async (t) => {
  const seen = fakeAnthropic(t);
  const companyToken = "sk-ant-oat01-company-e2e";
  const built = buildApp(testConfig({ anthropicApiKey: companyToken }), { agent: undefined });
  const submitted = await built.app.turn({
    surface: "slack",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "claude-company-subscription-e2e" },
    text: "ping",
    liveActor: true,
    async: true,
  });
  built.runtime.start();
  try {
    await assertSubscriptionTurn(built, seen, submitted.runId!, companyToken);
  } finally {
    await built.runtime.stop();
  }
});
