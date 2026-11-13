import { after, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import * as Sentry from "@sentry/node";
import { initializeErrorReporting, traceQueued } from "../plugins/chassis/src/error-reporting.ts";
import { createAgent } from "../src/agent/agent-run.ts";
import { createModelRoutes } from "../src/model/model-route.ts";
import type { AgentTurnInput } from "../src/agent/agent.ts";
import { storedItem } from "../src/sessions/items.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { collectSpans } from "./support/sentry-spans.ts";

const sentry = await collectSpans();
initializeErrorReporting(Sentry, "worker", { SENTRY_DSN: sentry.dsn, SENTRY_TRACES_SAMPLE_RATE: "1" });
after(() => sentry.close());

function anthropicStream(block: Record<string, unknown>, delta: Record<string, unknown>, stopReason: string): string {
  return [
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
    { type: "content_block_start", index: 0, content_block: block },
    { type: "content_block_delta", index: 0, delta },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

test("a Pi tool step is traced as model requests, first tokens, and a step gap that holds the named tool", async (t) => {
  let requests = 0;
  const model = createServer(async (req, res) => {
    await new Promise((resolve) => req.resume().on("end", resolve));
    await new Promise((resolve) => setTimeout(resolve, 20));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      ++requests === 1
        ? anthropicStream(
            { type: "tool_use", id: "read-memory", name: "memory", input: {} },
            { type: "input_json_delta", partial_json: JSON.stringify({ action: "read" }) },
            "tool_use",
          )
        : anthropicStream({ type: "text", text: "" }, { type: "text_delta", text: "done" }, "end_turn"),
    );
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => model.close(() => resolve())));
  const modelUrl = `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1/messages`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) =>
    realFetch(modelUrl, { method: "POST", body: init?.body ?? null, signal: init?.signal ?? null })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const agent = createAgent({ routes: createModelRoutes({ apiKey: "sk-test" }) });
  t.after(() => agent.close?.());
  let seq = 0;
  const result = await traceQueued(undefined, "run", { "qm.origin": "human" }, () =>
    agent.runTurn({
      session: { id: "traced-tool-step" } as AgentTurnInput["session"],
      input: "read my memory",
      systemPrompt: "BASE",
      history: [],
      tools: {
        memoryRead: async () => {
          await new Promise((resolve) => setTimeout(resolve, 40));
          return "saved facts";
        },
      } as AgentTurnInput["tools"],
      scopeLabel: "personal:tester" as AgentTurnInput["scopeLabel"],
      orgScopeId: "org:test" as AgentTurnInput["orgScopeId"],
      emit: async (item) => storedItem(item, { sessionId: "traced-tool-step", seq: seq++, createdAt: Date.now() }),
      recordModelCall: () => {},
      cancel: AbortSignal.timeout(10_000),
    }),
  );
  assert.equal(result.reply, "done");
  const run = await sentry.segment((sent) => sent.name === "run");
  const byOp = (op: string) =>
    run.spans.filter((span) => span.op === op).sort((a, b) => a.start_timestamp - b.start_timestamp);
  const [firstToken, nextFirstToken, ...extraFirstTokens] = byOp("model.first_token");
  assert.ok(firstToken && nextFirstToken, "each model request has a first-token span");
  assert.equal(extraFirstTokens.length, 0);
  assert.equal(byOp("http.client").length, 2, "each model request has an HTTP span");
  const [gap, ...extraGaps] = byOp("step.gap");
  assert.ok(gap, "the tool step has a gap span");
  assert.equal(extraGaps.length, 0, "the final answer opens no gap");
  const [tool, ...extraTools] = byOp("step.tool");
  assert.ok(tool);
  assert.equal(extraTools.length, 0);
  assert.equal(tool.name, "memory");
  assert.equal(tool.parent_span_id, gap.span_id, "the tool runs inside its step's gap");
  assert.ok(tool.end_timestamp - tool.start_timestamp >= 0.035, "the tool span covers the tool's own work");
  assert.ok(gap.start_timestamp >= firstToken.end_timestamp, "the gap opens after the first response streamed");
  assert.ok(gap.end_timestamp <= nextFirstToken.start_timestamp + 0.001, "the gap closes at the next model request");
  assert.ok(tool.start_timestamp >= gap.start_timestamp && tool.end_timestamp <= gap.end_timestamp);
});

test("a human web turn persists its entries inside step.persist spans of the run", async () => {
  sentry.spans.length = 0;
  const built = buildApp(testConfig());
  const result = await built.app.turn({
    surface: "web",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "web:U1:trace" },
    text: "hello",
  });
  assert.equal(result.status, "ok");
  const run = await sentry.segment((sent) => sent.op === "queue.process");
  const persisted = run.spans.filter((span) => span.op === "step.persist");
  assert.ok(persisted.length >= 2, "the user entry and the reply are each persisted in a span");
});

test("a turn whose agent fails still sends its dispatch span", async () => {
  sentry.spans.length = 0;
  const built = buildApp(testConfig({ maxAttempts: 1 }));
  const failed = await built.app.turn({
    surface: "web",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "web:U1:trace-fail" },
    text: "!boom-always",
  });
  assert.equal(failed.status, "failed");
  const run = await sentry.segment((sent) => sent.op === "queue.process");
  assert.ok(run.spans.some((span) => span.op === "turn.dispatch"));
});
