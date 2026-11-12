import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgent } from "../src/agent/agent-run.ts";
import { createModelRoutes } from "../src/model/model-route.ts";
import type { AgentTurnInput } from "../src/agent/agent.ts";
import { forModelContext } from "../src/agent/context-compaction.ts";
import { reconstructMessagesFromHistory } from "../src/agent/replay.ts";
import { createStepRecorder } from "../src/agent/step-recorder.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { NewItem } from "../src/sessions/items.ts";
import { type Item, storedItem } from "../src/sessions/items.ts";
import type { SessionMessage } from "../src/sessions/session-mailbox.ts";
import { NeedsApproval, type ToolContext } from "../src/tools/primitives.ts";

const ANSWER = "the harbor ledger balances";
type Body = { messages?: unknown[] };
type Block = Record<string, unknown>;

function anthropicSse(blocks: Block[], stop: string): Response {
  const events: Array<Record<string, unknown>> = [
    {
      type: "message_start",
      message: {
        id: "msg",
        type: "message",
        role: "assistant",
        content: [],
        model: "m",
        stop_reason: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    },
  ];
  blocks.forEach((block, index) => {
    if (block.type === "text") {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    } else {
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      });
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
      });
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push({ type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 3 } });
  events.push({ type: "message_stop" });
  const body = events.map((event) => `event: ${event.type as string}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function inbox(opts: { receiveDelayMs?: number; crashOnAck?: boolean } = {}) {
  const rows = new Map<string, SessionMessage & { consumed?: boolean }>();
  let receives = 0;
  const log: string[] = [];
  rows.set("helper-answer", {
    id: "helper-answer",
    recipientId: "parent",
    senderId: "helper",
    actor: { id: "U1", type: "internal", displayName: "Alex" },
    audience: [{ id: "U1", type: "internal", displayName: "Alex" }],
    text: ANSWER,
    createdAt: 1,
    wake: true,
  });
  return {
    log,
    unread: () => [...rows.values()].filter((row) => !row.consumed).map((row) => row.id),
    syscalls: {
      async receive() {
        receives += 1;
        log.push(`receive#${receives}`);
        await new Promise((resolve) => setTimeout(resolve, opts.receiveDelayMs ?? 0));
        return [...rows.values()].filter((row) => !row.consumed).map(({ consumed: _consumed, ...row }) => row);
      },
      async acknowledge(ids: string[]) {
        if (opts.crashOnAck) {
          opts.crashOnAck = false;
          log.push("crash");
          throw new Error("worker died before the acknowledgement");
        }
        for (const id of ids) rows.get(id)!.consumed = true;
        log.push(`ack:${ids.join(",")}`);
      },
      async release(messages: SessionMessage[]) {
        for (const message of messages) rows.get(message.id)!.consumed = false;
        log.push(`release:${messages.map((m) => m.id).join(",")}`);
      },
    },
  };
}

let deployApproved = false;
let slowRun: (emitted: Item[]) => Promise<unknown> = async () => ({ stdout: "ok", stderr: "", code: 0 });

async function runTurn(
  history: Item[],
  replies: Array<() => Response>,
  syscalls: unknown,
  overrides: Partial<AgentTurnInput> = {},
) {
  const agent = createAgent({ routes: createModelRoutes({ apiKey: "sk-test" }) });
  const emitted: Item[] = [];
  const bodies: Body[] = [];
  let seq = (history.at(-1)?.seq ?? 0) + 1;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Body);
    const reply = replies[bodies.length - 1];
    assert.ok(reply, `unexpected model call #${bodies.length}`);
    return reply();
  }) as typeof globalThis.fetch;
  try {
    const result = await agent.runTurn({
      session: { id: "mail-batch" } as AgentTurnInput["session"],
      runId: `run-${seq}`,
      input: "check in",
      systemPrompt: "BASE",
      history,
      replyOptional: true,
      tools: {
        sessionSyscalls: syscalls,
        async history() {
          return ["user#1: the ledger is in shared/ledger.md"];
        },
        async execute(command: string) {
          if (command !== "deploy ledger") return slowRun(emitted);
          if (deployApproved) return { stdout: "deployed", stderr: "", code: 0 };
          await new Promise((resolve) => setTimeout(resolve, 20));
          throw new NeedsApproval("deploy ledger", "deploys need a human");
        },
      } as unknown as ToolContext,
      scopeLabel: "personal:tester" as AgentTurnInput["scopeLabel"],
      orgScopeId: "org:test" as AgentTurnInput["orgScopeId"],
      emit: async (item) => {
        const stored = storedItem(item, { sessionId: "mail-batch", seq: seq++, createdAt: Date.now() });
        emitted.push(stored);
        return stored;
      },
      recordModelCall: () => {},
      ...overrides,
    });
    return { result, emitted, bodies };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const sightings = (body: Body | undefined) => JSON.stringify(body?.messages ?? []).split(ANSWER).length - 1;
const call = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });

async function followUp(r: ReturnType<typeof inbox>, history: Item[]) {
  const replayed = forModelContext(history);
  const next = await runTurn(
    replayed,
    [
      () => anthropicSse([call("toolu_f1", "history", { query: "ledger" })], "tool_use"),
      () => anthropicSse([{ type: "text", text: "Reported." }], "end_turn"),
    ],
    r.syscalls,
  );
  return { next, replayedSightings: sightings({ messages: replayed.map((item) => item.text) }) };
}

const pausingBatch = (extra: Block[] = []) =>
  anthropicSse(
    [
      ...extra,
      call("toolu_mail", "history", { query: "carrier" }),
      call("toolu_pause", "execute", { command: "deploy ledger", purpose: "ship it" }),
    ],
    "tool_use",
  );

const durableResults = (items: Item[], callId: string) =>
  items.filter((item) => item.callId === callId && item.kind === "ToolResult");

test("a parallel batch that Pi continues never shows mail that went back to unread", async () => {
  const r = inbox({ receiveDelayMs: 60 });
  const first = await runTurn(
    [],
    [
      () => pausingBatch([call("toolu_odd", "no_such_tool", {})]),
      () => anthropicSse([{ type: "text", text: "Waiting on approval." }], "end_turn"),
    ],
    r.syscalls,
  );
  assert.equal(first.bodies.length, 2, "Pi continues: the unknown-tool result is not terminal");
  const seenInRun = sightings(first.bodies[1]);
  const unread = r.unread().includes("helper-answer");
  assert.equal(seenInRun + (unread ? 1 : 0), 1, `seen ${seenInRun} in this run, unread ${unread}: ${r.log.join(" ")}`);
  assert.equal(durableResults(first.emitted, "toolu_mail").length, 1, "the carrier's result is written exactly once");
  const { next, replayedSightings } = await followUp(r, first.emitted);
  assert.equal(replayedSightings + (unread ? 1 : 0), 1, "replay and redelivery together hold it once");
  assert.equal(sightings(next.bodies.at(-1)), 1, "the follow-up's model context holds the answer exactly once");
  assert.deepEqual(r.unread(), [], "the answer ends acknowledged");
});

test("a parallel batch that really ends leaves the mail unread and out of the durable transcript, then shows it once", async () => {
  const r = inbox({ receiveDelayMs: 60 });
  const first = await runTurn([], [() => pausingBatch()], r.syscalls);
  assert.equal(first.bodies.length, 1, "every result is terminal, so the batch ends");
  assert.equal(first.result.pausedOnApproval, true);
  assert.deepEqual(r.unread(), ["helper-answer"], `the answer goes back to unread: ${r.log.join(" ")}`);
  const durable = durableResults(first.emitted, "toolu_mail");
  assert.equal(durable.length, 1, "the carrier's result is written exactly once");
  assert.doesNotMatch(JSON.stringify(durable[0]), new RegExp(ANSWER), "the durable result carries no released mail");
  assert.match(durable[0]!.text ?? "", /shared\/ledger\.md/, "the tool's own output is kept");
  const { next, replayedSightings } = await followUp(r, first.emitted);
  assert.equal(replayedSightings, 0, "the replayed history does not hold the released answer");
  assert.equal(sightings(next.bodies.at(-1)), 1, "the follow-up's model context holds the answer exactly once");
  assert.deepEqual(r.unread(), []);
});

test("mail that lands before the pause in a continuing batch stays acknowledged and is seen once", async () => {
  const r = inbox();
  const first = await runTurn(
    [],
    [
      () => pausingBatch([call("toolu_odd", "no_such_tool", {})]),
      () => anthropicSse([{ type: "text", text: "Waiting on approval." }], "end_turn"),
    ],
    r.syscalls,
  );
  assert.equal(first.bodies.length, 2);
  assert.equal(sightings(first.bodies[1]), 1);
  assert.deepEqual(r.unread(), []);
  const { replayedSightings } = await followUp(r, first.emitted);
  assert.equal(replayedSightings, 1, "the delivered answer stays in the durable transcript");
});

const slowBatch = () =>
  anthropicSse(
    [
      call("toolu_mail", "history", { query: "carrier" }),
      call("toolu_slow", "execute", { command: "long build", purpose: "build" }),
    ],
    "tool_use",
  );

function everyCallAnswered(items: Item[]) {
  const messages = reconstructMessagesFromHistory(forModelContext(items)) as Array<{
    role: string;
    toolCallId?: string;
    content?: Array<{ type: string; id?: string }>;
  }>;
  const calls = messages.flatMap((m) =>
    m.role === "assistant" ? (m.content ?? []).filter((b) => b.type === "toolCall").map((b) => b.id) : [],
  );
  const answered = messages.filter((m) => m.role === "toolResult").map((m) => m.toolCallId);
  assert.deepEqual(answered.toSorted(), calls.toSorted(), "every replayed tool call has exactly one result");
}

test("a shown result is durable and acknowledged while a slow sibling still runs, not at the end of the batch", async () => {
  const r = inbox();
  let midBatch: { written: number; unread: string[] } | undefined;
  slowRun = async (emitted) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    midBatch = { written: durableResults(emitted, "toolu_mail").length, unread: r.unread() };
    return { stdout: "built", stderr: "", code: 0 };
  };
  const first = await runTurn(
    [],
    [() => slowBatch(), () => anthropicSse([{ type: "text", text: "Built." }], "end_turn")],
    r.syscalls,
  );
  assert.deepEqual(midBatch, { written: 1, unread: [] }, "written and acknowledged before the batch ends");
  assert.equal(durableResults(first.emitted, "toolu_mail").length, 1, "and written exactly once");
  assert.ok(!r.log.some((entry) => entry.startsWith("release")), "nothing is acknowledged and then undone");
  assert.equal(sightings(first.bodies[1]), 1);
  everyCallAnswered(first.emitted);
});

test("a turn stopped mid-batch keeps the shown result once, acknowledged, with every call answered on replay", async () => {
  const r = inbox();
  const stop = new AbortController();
  slowRun = async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    stop.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { stdout: "partial", stderr: "", code: 0 };
  };
  const first = await runTurn([], [() => slowBatch()], r.syscalls, { cancel: stop.signal });
  assert.equal(durableResults(first.emitted, "toolu_mail").length, 1);
  assert.match(JSON.stringify(durableResults(first.emitted, "toolu_mail")[0]), new RegExp(ANSWER));
  assert.deepEqual(r.unread(), [], "the answer is in the durable transcript, so it is acknowledged");
  everyCallAnswered(first.emitted);
  const { next, replayedSightings } = await followUp(r, first.emitted);
  assert.equal(replayedSightings, 1);
  assert.equal(sightings(next.bodies.at(-1)), 1, "the next turn sees it once, from history");
});

function recorder() {
  const items: Item[] = [];
  let seq = 0;
  const emit = async (item: NewItem) => {
    const stored = storedItem(item, { sessionId: "held", seq: seq++, createdAt: Date.now() });
    items.push(stored);
    return stored;
  };
  const steps = createStepRecorder({ emit }, (write) => void write());
  steps.assistant({
    role: "assistant",
    content: [{ type: "toolCall", id: "c1", name: "history", arguments: {} }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "m",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 0,
  } as AssistantMessage);
  const mail = `Internal agent message:\n${ANSWER}`;
  const content = [
    { type: "text" as const, text: "found it" },
    { type: "text" as const, text: mail },
  ];
  const logged = {
    kind: "ToolResult" as const,
    tool: "history",
    callId: "c1",
    isError: false,
    text: `found it\n\n${mail}`,
  };
  return { items, steps, mail, content, logged };
}

const results = (items: Item[]) => items.filter((item) => item.kind === "ToolResult");

for (const ending of ["settle then message_end", "message_end only", "stopped before either"] as const)
  test(`a held result is written exactly once, without unacknowledged mail, when ${ending}`, async () => {
    const { items, steps, mail, content, logged } = recorder();
    await steps.emit(logged);
    steps.holdResult("c1", [mail]);
    steps.toolReturned("c1", content, false);
    assert.equal(results(items).length, 0, "nothing is written before the result is settled");
    if (ending === "settle then message_end") {
      await steps.settleResult("c1", [content[0]!], [mail]);
      steps.toolResult({
        role: "toolResult",
        toolCallId: "c1",
        toolName: "history",
        content,
        isError: false,
        timestamp: 0,
      });
    } else if (ending === "message_end only")
      steps.toolResult({
        role: "toolResult",
        toolCallId: "c1",
        toolName: "history",
        content,
        isError: false,
        timestamp: 0,
      });
    else steps.settleResults();
    steps.settleResults();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(results(items).length, 1);
    assert.doesNotMatch(JSON.stringify(results(items)[0]), new RegExp(ANSWER));
    assert.match(results(items)[0]!.text ?? "", /found it/);
  });

test("a crash after the shown result is durable but before its acknowledgement does not show the mail twice", async () => {
  const r = inbox({ crashOnAck: true });
  slowRun = async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { stdout: "built", stderr: "", code: 0 };
  };
  const first = await runTurn(
    [],
    [() => slowBatch(), () => anthropicSse([{ type: "text", text: "Built." }], "end_turn")],
    r.syscalls,
  );
  assert.ok(r.log.includes("crash"));
  assert.deepEqual(r.unread(), ["helper-answer"], "the acknowledgement never landed");
  assert.equal(durableResults(first.emitted, "toolu_mail").length, 1);
  const { next, replayedSightings } = await followUp(r, first.emitted);
  assert.equal(replayedSightings, 1, "the retried turn replays the durable result");
  assert.equal(sightings(next.bodies.at(-1)), 1, "and does not receive the same mail again");
  assert.deepEqual(r.unread(), [], "the persisted delivery is acknowledged on the retry");
});

test("a real approval pause then approved resume delivers the held answer once and acknowledges it once", async () => {
  const r = inbox({ receiveDelayMs: 60 });
  const paused = await runTurn([], [() => pausingBatch()], r.syscalls);
  assert.equal(paused.result.pausedOnApproval, true);
  assert.deepEqual(r.unread(), ["helper-answer"]);
  deployApproved = true;
  try {
    const resumed = await runTurn(
      forModelContext(paused.emitted),
      [() => anthropicSse([{ type: "text", text: "Deployed." }], "end_turn")],
      r.syscalls,
      {
        approvedToolCalls: [
          {
            callId: "toolu_pause",
            requestId: "req-1",
            tool: "execute",
            input: { command: "deploy ledger", purpose: "ship it" },
          },
        ],
      },
    );
    assert.equal(sightings(resumed.bodies[0]), 1, "the resumed model call sees the answer once");
    assert.deepEqual(r.unread(), []);
    assert.equal(r.log.filter((entry) => entry.startsWith("ack:")).length, 1, "acknowledged exactly once");
    assert.ok(!r.log.some((entry) => entry.startsWith("release")));
    const { next, replayedSightings } = await followUp(r, [...paused.emitted, ...resumed.emitted]);
    assert.equal(replayedSightings, 1);
    assert.equal(sightings(next.bodies.at(-1)), 1, "a later turn still sees it once, from history");
  } finally {
    deployApproved = false;
  }
});

test("persisted mail reconciliation fails before model execution until acknowledgement recovers", async () => {
  const r = inbox({ crashOnAck: true });
  slowRun = async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { stdout: "built", stderr: "", code: 0 };
  };
  const first = await runTurn(
    [],
    [() => slowBatch(), () => anthropicSse([{ type: "text", text: "Built." }], "end_turn")],
    r.syscalls,
  );
  assert.deepEqual(r.unread(), ["helper-answer"]);
  const acknowledge = r.syscalls.acknowledge;
  r.syscalls.acknowledge = async () => {
    throw new Error("ack store unavailable");
  };
  let modelCalls = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(
      () =>
        runTurn(
          forModelContext(first.emitted),
          [
            () => {
              modelCalls++;
              return anthropicSse([{ type: "text", text: "Must not run." }], "end_turn");
            },
          ],
          r.syscalls,
        ),
      /ack store unavailable/,
    );
    assert.equal(modelCalls, 0);
    assert.deepEqual(r.unread(), ["helper-answer"]);
  }
  r.syscalls.acknowledge = acknowledge;
  const { next, replayedSightings } = await followUp(r, first.emitted);
  assert.equal(replayedSightings, 1);
  assert.equal(sightings(next.bodies.at(-1)), 1);
  assert.deepEqual(r.unread(), []);
});
