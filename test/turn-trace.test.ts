import { after, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { once } from "node:events";
import { gunzipSync } from "node:zlib";
import * as Sentry from "@sentry/node";
import { flushErrorReporting, initializeErrorReporting, traceQueued } from "../plugins/chassis/src/error-reporting.ts";
import { createPiHarness } from "../src/harness/pi-harness.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import type { SessionEntry } from "../src/types.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";

const transactions: Record<string, any>[] = [];
const collector = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const lines = (req.headers["content-encoding"] === "gzip" ? gunzipSync(body) : body).toString().split("\n");
  for (let i = 1; i + 1 < lines.length; i += 2)
    if (JSON.parse(lines[i]!).type === "transaction") transactions.push(JSON.parse(lines[i + 1]!));
  res.end("{}");
});
collector.listen(0, "127.0.0.1");
await once(collector, "listening");
initializeErrorReporting(Sentry, "worker", {
  SENTRY_DSN: `http://public@127.0.0.1:${(collector.address() as AddressInfo).port}/1`,
  SENTRY_TRACES_SAMPLE_RATE: "1",
});
after(async () => {
  collector.closeAllConnections();
  await new Promise<void>((resolve) => collector.close(() => resolve()));
});

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
  const harness = createPiHarness({ apiKey: "sk-test" });
  t.after(() => harness.turns.close?.());
  let seq = 0;
  const result = await traceQueued(undefined, "run", { "qm.origin": "human" }, () =>
    harness.turns.runTurn({
      session: { id: "traced-tool-step" } as HarnessTurnInput["session"],
      input: "read my memory",
      systemPrompt: "BASE",
      history: [],
      tools: {
        memoryRead: async () => {
          await new Promise((resolve) => setTimeout(resolve, 40));
          return "saved facts";
        },
      } as HarnessTurnInput["tools"],
      scopeLabel: "personal:tester" as HarnessTurnInput["scopeLabel"],
      orgScopeId: "org:test" as HarnessTurnInput["orgScopeId"],
      emit: async (entry) => ({ ...entry, seq: seq++, createdAt: Date.now() }) as unknown as SessionEntry,
      recordModelCall: () => {},
      cancel: AbortSignal.timeout(10_000),
    }),
  );
  assert.equal(result.reply, "done");
  for (let i = 0; i < 40 && !transactions.some((event) => event.transaction === "run"); i++) {
    await flushErrorReporting();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const run = transactions.find((event) => event.transaction === "run");
  assert.ok(run, "the run transaction arrived");
  const spans: Array<{
    op: string;
    description: string;
    span_id: string;
    parent_span_id: string;
    start_timestamp: number;
    timestamp: number;
  }> = run.spans;
  const byOp = (op: string) =>
    spans.filter((span) => span.op === op).sort((a, b) => a.start_timestamp - b.start_timestamp);
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
  assert.equal(tool.description, "memory");
  assert.equal(tool.parent_span_id, gap.span_id, "the tool runs inside its step's gap");
  assert.ok(tool.timestamp - tool.start_timestamp >= 0.035, "the tool span covers the tool's own work");
  assert.ok(gap.start_timestamp >= firstToken.timestamp, "the gap opens after the first response streamed");
  assert.ok(gap.timestamp <= nextFirstToken.start_timestamp + 0.001, "the gap closes at the next model request");
  assert.ok(tool.start_timestamp >= gap.start_timestamp && tool.timestamp <= gap.timestamp);
});

test("a human web turn persists its entries inside step.persist spans of the run", async () => {
  transactions.length = 0;
  const built = buildApp(testConfig());
  const result = await built.app.turn({
    surface: "web",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "web:U1:trace" },
    text: "hello",
  });
  assert.equal(result.status, "ok");
  for (let i = 0; i < 40 && !transactions.some((event) => event.contexts?.trace?.op === "queue.process"); i++) {
    await flushErrorReporting();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const run = transactions.find((event) => event.contexts?.trace?.op === "queue.process");
  assert.ok(run, "the run transaction arrived");
  const persisted = run.spans.filter((span: { op: string }) => span.op === "step.persist");
  assert.ok(persisted.length >= 2, "the user entry and the reply are each persisted in a span");
});

test("a turn whose harness fails still sends its dispatch span", async () => {
  transactions.length = 0;
  const built = buildApp(testConfig());
  await assert.rejects(
    built.app.turn({
      surface: "web",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "web:U1:trace-fail" },
      text: "!boom-always",
    }),
    /boom/,
  );
  for (let i = 0; i < 40 && !transactions.some((event) => event.contexts?.trace?.op === "queue.process"); i++) {
    await flushErrorReporting();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const run = transactions.find((event) => event.contexts?.trace?.op === "queue.process");
  assert.ok(run, "the run transaction arrived");
  assert.ok(run.spans.some((span: { op: string }) => span.op === "turn.dispatch"));
});
