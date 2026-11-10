import { test } from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { createSeat, SEAT_OFF, SEAT_PERSONAL_ONLY, type Seat, type SeatOptions } from "../src/seat/seat.ts";
import { seatModel } from "../src/model/seat-model.ts";
import { currentModelRequestContext, withModelRequestContext } from "../src/model/request-context.ts";
import { createPostgresRunSignalStore } from "../src/runs/postgres-run-signal-store.ts";
import { ambientTenant } from "../src/tenants/context.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const context: Context = {
  systemPrompt: "You are the house assistant.",
  messages: [{ role: "user", content: "List the files in /tmp", timestamp: Date.now() }],
  tools: [
    { name: "execute", description: "Run a shell command.", parameters: Type.Object({ command: Type.String() }) },
  ],
};

const ended = new Set<string>();

function seats(url: string, opts: Partial<SeatOptions> = {}): Seat {
  return createSeat(url, {
    enabled: async (actorId) => actorId !== "off",
    ask: async () => ({ model: "m", content: [{ type: "text" as const, text: "draft" }], stopReason: "stop" }),
    signals: createPostgresRunSignalStore(url),
    runLive: async (runId) => !ended.has(runId),
    ...opts,
  });
}

function play(seat: Seat, actorId: string, opts: { scopeId?: string; signal?: AbortSignal; runId?: string } = {}) {
  return withModelRequestContext(
    { actorId, scopeId: opts.scopeId ?? `personal:${actorId}`, sessionId: `session-${actorId}` },
    () =>
      seat
        .streamSimple(seatModel(), context, opts.signal ? { signal: opts.signal } : {}, opts.runId ?? `run-${actorId}`)
        .result(),
  );
}

async function waitForStep(seat: Seat, owner: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const [step] = await seat.pending(ambientTenant(), owner);
    if (step) return step.id;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("no step arrived");
}

test("a model call waits as a step that another instance reads verbatim and answers with a tool call", async () => {
  const url = testDatabaseUrl();
  const holder = seats(url);
  const other = seats(url);
  const reply = play(holder, "alice");
  const id = await waitForStep(other, "alice");
  const step = await other.step(ambientTenant(), "alice", id);
  assert.equal(step?.sessionId, "session-alice");
  const request = step!.request as {
    system: Array<{ text: string }>;
    tools: Array<{ name: string; input_schema: unknown }>;
    messages: Array<{ role: string; content: unknown }>;
  };
  assert.equal(request.system[0]?.text, "You are the house assistant.");
  assert.deepEqual(
    request.tools.map((tool) => tool.name),
    ["execute"],
  );
  assert.deepEqual(request.messages.at(-1)?.role, "user");
  assert.match(JSON.stringify(request.messages), /List the files in \/tmp/);

  await other.move(ambientTenant(), "alice", id, [
    { type: "text", text: "Looking." },
    { type: "tool_use", name: "execute", input: { command: "ls /tmp" } },
  ]);
  const message: AssistantMessage = await reply;
  assert.equal(message.stopReason, "toolUse");
  assert.deepEqual(
    message.content.map((part) => (part.type === "toolCall" ? { tool: part.name, args: part.arguments } : part)),
    [
      { type: "text", text: "Looking." },
      { tool: "execute", args: { command: "ls /tmp" } },
    ],
  );
  assert.deepEqual(await other.pending(ambientTenant(), "alice"), []);
});

test("a text move ends the model call with a plain reply", async () => {
  const seat = seats(testDatabaseUrl());
  const reply = play(seat, "alice");
  await seat.move(ambientTenant(), "alice", await waitForStep(seat, "alice"), [{ type: "text", text: "All done." }]);
  const message = await reply;
  assert.equal(message.stopReason, "stop");
  assert.deepEqual(message.content, [{ type: "text", text: "All done." }]);
});

test("only the owner sees and answers a step, and a step takes one move", async () => {
  const seat = seats(testDatabaseUrl());
  const reply = play(seat, "alice");
  const id = await waitForStep(seat, "alice");
  assert.deepEqual(await seat.pending(ambientTenant(), "bob"), []);
  assert.equal(await seat.step(ambientTenant(), "bob", id), null);
  await assert.rejects(seat.move(ambientTenant(), "bob", id, [{ type: "text", text: "hijack" }]), {
    code: "step_closed",
  });
  await assert.rejects(seat.ask(ambientTenant(), "bob", id, new AbortController().signal), { code: "step_closed" });
  await seat.move(ambientTenant(), "alice", id, [{ type: "text", text: "mine" }]);
  await assert.rejects(seat.move(ambientTenant(), "alice", id, [{ type: "text", text: "again" }]), {
    code: "step_closed",
  });
  assert.deepEqual((await reply).content, [{ type: "text", text: "mine" }]);
});

test("moves must be text or tool calls with object input", async () => {
  const seat = seats(testDatabaseUrl());
  const reply = play(seat, "alice");
  const id = await waitForStep(seat, "alice");
  for (const content of [
    [],
    [{ type: "text", text: "  " }],
    [{ type: "tool_use", name: "execute", input: "ls" }],
    [{ type: "tool_use", name: "execute", input: ["ls"] }],
    "hi",
  ])
    await assert.rejects(seat.move(ambientTenant(), "alice", id, content), { code: "bad_request" });
  await seat.move(ambientTenant(), "alice", id, [{ type: "text", text: "ok" }]);
  await reply;
});

test("the seat refuses people without the feature and conversations outside their personal scope", async () => {
  const seat = seats(testDatabaseUrl());
  await assert.rejects(seat.pending(ambientTenant(), "off"), { code: "feature_disabled", message: SEAT_OFF });
  const off = await play(seat, "off");
  assert.equal(off.stopReason, "error");
  assert.equal(off.errorMessage, SEAT_OFF);
  const shared = await play(seat, "alice", { scopeId: "channel:C1" });
  assert.equal(shared.stopReason, "error");
  assert.equal(shared.errorMessage, SEAT_PERSONAL_ONLY);
  assert.deepEqual(await seat.pending(ambientTenant(), "alice"), []);
});

test("cancelling the turn withdraws the step", async () => {
  const seat = seats(testDatabaseUrl());
  const controller = new AbortController();
  const reply = play(seat, "alice", { signal: controller.signal });
  const id = await waitForStep(seat, "alice");
  controller.abort();
  assert.equal((await reply).stopReason, "aborted");
  assert.deepEqual(await seat.pending(ambientTenant(), "alice"), []);
  await assert.rejects(seat.move(ambientTenant(), "alice", id, [{ type: "text", text: "late" }]), {
    code: "step_closed",
  });
});

test("an unanswered step times out with an error the turn can show", async () => {
  const seat = seats(testDatabaseUrl(), { timeoutMs: 200 });
  const message = await play(seat, "alice");
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage ?? "", /No move was made at the Agent Seat/);
  assert.deepEqual(await seat.pending(ambientTenant(), "alice"), []);
});

test("a step whose run ended is no longer offered or answerable, and a retried call replaces it", async () => {
  const url = testDatabaseUrl();
  const crashed = seats(url);
  const first = new AbortController();
  const stale = play(crashed, "alice", { signal: first.signal, runId: "run-retried" });
  const staleId = await waitForStep(crashed, "alice");
  const retry = seats(url);
  const second = new AbortController();
  const fresh = play(retry, "alice", { signal: second.signal, runId: "run-retried" });
  let freshId = staleId;
  while (freshId === staleId) freshId = (await retry.pending(ambientTenant(), "alice"))[0]?.id ?? staleId;
  assert.deepEqual(
    (await retry.pending(ambientTenant(), "alice")).map((step) => step.id),
    [freshId],
  );
  ended.add("run-retried");
  try {
    assert.deepEqual(await retry.pending(ambientTenant(), "alice"), []);
    await assert.rejects(retry.move(ambientTenant(), "alice", freshId, [{ type: "text", text: "late" }]), {
      code: "step_closed",
    });
  } finally {
    first.abort();
    second.abort();
    await Promise.all([stale, fresh]);
  }
});

test("ask replays the stored request as the step owner and returns the model's draft", async () => {
  const asked: Array<{ request: unknown; actorId?: string; scopeId?: string; sessionId?: string }> = [];
  const seat = seats(testDatabaseUrl(), {
    ask: async (request) => {
      const { actorId, scopeId, sessionId } = currentModelRequestContext();
      asked.push({ request, actorId, scopeId, sessionId });
      return {
        model: "claude-x",
        content: [{ type: "tool_use" as const, name: "execute", input: { command: "ls" } }],
        stopReason: "toolUse",
      };
    },
  });
  const controller = new AbortController();
  const reply = play(seat, "alice", { signal: controller.signal });
  try {
    const id = await waitForStep(seat, "alice");
    const draft = await seat.ask(ambientTenant(), "alice", id, new AbortController().signal);
    assert.equal(draft.model, "claude-x");
    assert.deepEqual(asked, [
      {
        request: (await seat.step(ambientTenant(), "alice", id))!.request,
        actorId: "alice",
        scopeId: "personal:alice",
        sessionId: "session-alice",
      },
    ]);
    await seat.move(ambientTenant(), "alice", id, draft.content);
    assert.equal((await reply).stopReason, "toolUse");
  } finally {
    controller.abort();
    await reply;
  }
});
