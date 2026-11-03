import { test } from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { createSeat, SEAT_OFF, SEAT_PERSONAL_ONLY, type Seat, type SeatOptions } from "../src/seat/seat.ts";
import { seatModel } from "../src/model/seat-model.ts";
import { currentModelRequestContext, withModelRequestContext } from "../src/model/request-context.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const context: Context = {
  systemPrompt: "You are the house assistant.",
  messages: [{ role: "user", content: "List the files in /tmp", timestamp: Date.now() }],
  tools: [
    { name: "execute", description: "Run a shell command.", parameters: Type.Object({ command: Type.String() }) },
  ],
};

function seats(url: string, opts: Partial<SeatOptions> = {}): Seat {
  return createSeat(url, {
    enabled: async (actorId) => actorId !== "off",
    ask: async () => ({ model: "m", content: [{ type: "text" as const, text: "draft" }], stopReason: "stop" }),
    pollMs: 20,
    ...opts,
  });
}

function play(seat: Seat, actorId: string, opts: { scopeId?: string; signal?: AbortSignal } = {}) {
  return withModelRequestContext(
    { actorId, scopeId: opts.scopeId ?? `personal:${actorId}`, sessionId: `session-${actorId}` },
    () => seat.streamSimple(seatModel(), context, opts.signal ? { signal: opts.signal } : {}).result(),
  );
}

async function waitForStep(seat: Seat, owner: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const [step] = await seat.pending(owner);
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
  const step = await other.step("alice", id);
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

  await other.move("alice", id, [
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
  assert.deepEqual(await other.pending("alice"), []);
});

test("a text move ends the model call with a plain reply", async () => {
  const seat = seats(testDatabaseUrl());
  const reply = play(seat, "alice");
  await seat.move("alice", await waitForStep(seat, "alice"), [{ type: "text", text: "All done." }]);
  const message = await reply;
  assert.equal(message.stopReason, "stop");
  assert.deepEqual(message.content, [{ type: "text", text: "All done." }]);
});

test("only the owner sees and answers a step, and a step takes one move", async () => {
  const seat = seats(testDatabaseUrl());
  const reply = play(seat, "alice");
  const id = await waitForStep(seat, "alice");
  assert.deepEqual(await seat.pending("bob"), []);
  assert.equal(await seat.step("bob", id), null);
  await assert.rejects(seat.move("bob", id, [{ type: "text", text: "hijack" }]), { code: "step_closed" });
  await assert.rejects(seat.ask("bob", id, new AbortController().signal), { code: "step_closed" });
  await seat.move("alice", id, [{ type: "text", text: "mine" }]);
  await assert.rejects(seat.move("alice", id, [{ type: "text", text: "again" }]), { code: "step_closed" });
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
    "hi",
  ])
    await assert.rejects(seat.move("alice", id, content), { code: "bad_request" });
  await seat.move("alice", id, [{ type: "text", text: "ok" }]);
  await reply;
});

test("the seat refuses people without the feature and conversations outside their personal scope", async () => {
  const seat = seats(testDatabaseUrl());
  await assert.rejects(seat.pending("off"), { code: "feature_disabled", message: SEAT_OFF });
  const off = await play(seat, "off");
  assert.equal(off.stopReason, "error");
  assert.equal(off.errorMessage, SEAT_OFF);
  const shared = await play(seat, "alice", { scopeId: "channel:C1" });
  assert.equal(shared.stopReason, "error");
  assert.equal(shared.errorMessage, SEAT_PERSONAL_ONLY);
  assert.deepEqual(await seat.pending("alice"), []);
});

test("cancelling the turn withdraws the step", async () => {
  const seat = seats(testDatabaseUrl());
  const controller = new AbortController();
  const reply = play(seat, "alice", { signal: controller.signal });
  const id = await waitForStep(seat, "alice");
  controller.abort();
  assert.equal((await reply).stopReason, "aborted");
  assert.deepEqual(await seat.pending("alice"), []);
  await assert.rejects(seat.move("alice", id, [{ type: "text", text: "late" }]), { code: "step_closed" });
});

test("turning the feature off ends a waiting model call instead of leaving the turn stuck", async () => {
  let on = true;
  const seat = seats(testDatabaseUrl(), { enabled: async () => on, leaseMs: 300 });
  const reply = play(seat, "alice");
  await waitForStep(seat, "alice");
  on = false;
  const message = await reply;
  assert.equal(message.stopReason, "error");
  assert.equal(message.errorMessage, SEAT_OFF);
});

test("an unanswered step times out with an error the turn can show", async () => {
  const seat = seats(testDatabaseUrl(), { timeoutMs: 200 });
  const message = await play(seat, "alice");
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage ?? "", /No move was made at the Agent Seat/);
  assert.deepEqual(await seat.pending("alice"), []);
});

test("a step whose holder stopped renewing is no longer offered or answerable", async () => {
  const url = testDatabaseUrl();
  const seat = seats(url);
  const controller = new AbortController();
  const reply = play(seat, "alice", { signal: controller.signal });
  const id = await waitForStep(seat, "alice");
  const db = createPgPool(url);
  try {
    await db.query("UPDATE seat_steps SET held_until = now() - interval '1 second' WHERE id = $1", [id]);
    assert.deepEqual(await seat.pending("alice"), []);
    await assert.rejects(seat.move("alice", id, [{ type: "text", text: "late" }]), { code: "step_closed" });
  } finally {
    await db.close();
    controller.abort();
    await reply;
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
    const draft = await seat.ask("alice", id, new AbortController().signal);
    assert.equal(draft.model, "claude-x");
    assert.deepEqual(asked, [
      {
        request: (await seat.step("alice", id))!.request,
        actorId: "alice",
        scopeId: "personal:alice",
        sessionId: "session-alice",
      },
    ]);
    await seat.move("alice", id, draft.content);
    assert.equal((await reply).stopReason, "toolUse");
  } finally {
    controller.abort();
    await reply;
  }
});
