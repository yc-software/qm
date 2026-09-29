import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { Context, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createPiHarness, EMPTY_ENDING_NOTE } from "../../src/harness/pi-harness.ts";
import { createMemorySessionStore } from "../../src/sessions/memory-session-store.ts";
import type { ToolContext } from "../../src/tools/primitives.ts";
import { isPollSurface } from "../../src/triggers/run-trigger.ts";
import { setProviderBaseUrls } from "../../src/model/provider-endpoints.ts";
import { environmentNote } from "../../src/core/attachments.ts";
import { createCronStore } from "../../src/cron/cron-store.ts";
import { createIdempotencyStore } from "../../src/idempotency/idempotency-store.ts";
import { createLoopFireService } from "../../src/loops/loop-fire.ts";
import { createLoopItemLedger, loopItemId } from "../../src/loops/item-ledger.ts";
import { createLoopStore } from "../../src/loops/loop-store.ts";
import { createLoopOutputStore } from "../../src/loops/output-store.ts";
import { createShipGrantStore } from "../../src/loops/ship-grant-store.ts";
import { resolveModel } from "../../src/model/pi-models.ts";
import { scopeId, type Loop, type TurnRequest, type TurnResult } from "../../src/types.ts";
import { createMemoryMap } from "../../src/persistence/durable-map.ts";
import { syntheticId } from "./seed.ts";
import { createWorkloadCompanion } from "./workload-companion.ts";
import { createLoopResponder, renderLoopPlanTasks, type LoopPlan, type LoopStage } from "./workload-loop.ts";
import type { NativeShape } from "./workload-native.ts";

const text = "Synthetic durable read for native loop stages";
const token = "qm-perf-loop-test-synthetic-key";
const fixture = {
  schemaVersion: 1,
  fixtureId: "loop-test",
  databaseName: "qm_perf_loop_test",
  profileSha256: "f".repeat(64),
  qualified: false,
};
const shape: NativeShape = {
  name: "loop-read",
  model: "claude-sonnet-5",
  modelCalls: 2,
  toolCalls: 1,
  batches: [1],
  operations: [
    {
      kind: "read",
      path: "shared/loop.txt",
      bytes: Buffer.byteLength(text),
      sha256: createHash("sha256").update(text).digest("hex"),
    },
  ],
  outputBytes: 24,
  repeatedFraction: 0.5,
  delayMs: 0,
  chunkCharacters: 17,
  chunkIntervalMs: 0,
  terminal: "reply",
};
const tools = [
  {
    name: "files",
    description: "Native file read",
    parameters: Type.Object({ action: Type.Literal("read"), path: Type.String() }),
  },
];
const wireTools = [
  { name: "files", input_schema: { properties: { action: { const: "read" }, path: { type: "string" } } } },
];
const provider = {
  schemaVersion: 1 as const,
  fixtureId: fixture.fixtureId,
  model: shape.model,
  tokenEnv: "QM_PERF_TEST_TOKEN",
  host: "127.0.0.1",
  port: 0,
  shapes: [
    {
      name: "frozen",
      modelCalls: 1,
      inputBytes: 64,
      outputBytes: 20,
      delayMs: 0,
      chunkBytes: 20,
      chunkIntervalMs: 0,
      repeatedFraction: 0.5,
    },
  ],
};

async function setup(run: (request: TurnRequest) => Promise<TurnResult>) {
  const backing = createMemoryMap<Loop>();
  const loops = createLoopStore(backing),
    items = createLoopItemLedger(),
    outputs = createLoopOutputStore();
  const fire = createLoopFireService({
    loops,
    items,
    outputs,
    crons: createCronStore(),
    grants: createShipGrantStore(),
    trigger: {
      deliveries: {
        enqueue: async () => {
          throw new Error("No delivery allowed");
        },
      } as never,
      idempotency: createIdempotencyStore(),
      identity: { refresh: async () => {}, classify: () => ({ type: "internal" }) } as never,
      run,
    },
  });
  const plans: LoopPlan[] = [];
  for (const source of ["held", "all", "gmail", "slack"]) {
    const { loop: created } = await loops.create({
      owner: "fixture-actor",
      createdBy: "fixture-actor",
      ownerScopeId: scopeId("personal", "fixture-actor"),
      name: `Fixture ${source}`,
      playbook: "Read the synthetic fixture and prepare held work.",
      successCondition: "Synthetic work is held for review",
      shipActions: [{ action: "draft", gate: "hold" }],
      caps: { maxOpenOutputs: 3, maxItemAttempts: 1 },
      ...(source === "held"
        ? {}
        : {
            surface: source === "all" ? "inbox" : `inbox:${source}`,
            sources: source === "all" ? ["gmail", "slack"] : [source],
          }),
    });
    let loop = created;
    if (source === "held") {
      loop = { ...created, id: syntheticId("loops", 1) };
      await backing.delete(created.id);
      await backing.put(loop.id, loop);
    }
    plans.push({
      definition: loop,
      sourceKey: `[qm-perf-loop:${fixture.fixtureId}:${source}]`,
      occurrences: (source === "held" ? [0, 1, 2] : [0, 1]).map((index) => {
        let stages: LoopStage[] = ["intake"];
        if (source !== "held") stages = ["sync"];
        else if (index !== 1) stages = ["intake", "work", "judge"];
        return {
          id: `fire-${index}`,
          item: source === "held",
          ...(index === 2 ? { sourceKey: `[qm-perf-loop:${fixture.fixtureId}:held-next]` } : {}),
          stages: stages.map((stage) => ({ stage, shape: shape.name })),
        };
      }),
    });
  }
  return { loops, items, outputs, fire, plans };
}

function body(task: string) {
  return { model: shape.model, stream: true, tools: wireTools, messages: [{ role: "user", content: task }] };
}

function continuation(
  request: ReturnType<typeof body>,
  reply: { text: string; tools: Array<{ id: string; name: string; input: unknown }> },
) {
  return {
    ...request,
    messages: [
      ...request.messages,
      {
        role: "assistant",
        content: [{ type: "text", text: reply.text }, ...reply.tools.map((tool) => ({ type: "tool_use", ...tool }))],
      },
      {
        role: "user",
        content: reply.tools.map((tool) => ({ type: "tool_result", tool_use_id: tool.id, content: text })),
      },
    ],
  };
}

test("installed client drives recurring native held and inbox tasks with dedup and a fresh third key", async () => {
  const receipts: Record<string, any>[] = [];
  const contexts = new Map<string, Context>();
  const calls: Array<{ request: TurnRequest; responseIds: string[] }> = [];
  const native = await setup(async (request) => {
    const context: Context = contexts.get(request.conversation.threadRef) ?? { tools, messages: [] };
    contexts.set(request.conversation.threadRef, context);
    context.messages.push({
      role: "user",
      content: `${request.text}\n\n${environmentNote("Synthetic fixture context")}`,
      timestamp: Date.now(),
    });
    const responseIds: string[] = [];
    let reply = "";
    for (let step = 0; step < shape.modelCalls; step++) {
      const answer = await stream(model, context, { apiKey: token, maxTokens: 8192 }).result();
      assert.notEqual(answer.stopReason, "error", answer.errorMessage);
      assert.ok(answer.responseId);
      responseIds.push(answer.responseId);
      context.messages.push(answer);
      const operations = answer.content.filter((block) => block.type === "toolCall");
      assert.equal(operations.length, shape.batches[step] ?? 0);
      for (const operation of operations) {
        assert.equal(operation.name, "files");
        assert.deepEqual(operation.arguments, { action: "read", path: "shared/loop.txt" });
        context.messages.push({
          role: "toolResult",
          toolCallId: operation.id,
          toolName: operation.name,
          content: [{ type: "text", text }],
          isError: false,
          timestamp: Date.now(),
        });
      }
      reply = answer.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
    }
    calls.push({ request, responseIds });
    return { status: "ok", reply, sessionId: `native-stage-${calls.length}` };
  });
  const profile = { ...provider, utilities: [], nativeShapes: [shape], loopPlans: native.plans };
  const companion = await createWorkloadCompanion(profile, provider, fixture, (row) => receipts.push(row), {
    QM_PERF_TEST_TOKEN: token,
  });
  companion.server.listen(0, "127.0.0.1");
  await once(companion.server, "listening");
  const address = companion.server.address();
  assert.ok(address && typeof address !== "string");
  const model = {
    ...resolveModel(shape.model, false)!,
    baseUrl: `http://127.0.0.1:${address.port}`,
  } as Model<"anthropic-messages">;
  try {
    for (const plan of native.plans) {
      const first = await native.fire.fire(plan.definition.id, `${plan.definition.id}:fire-0`);
      assert.notEqual(first.status, "failed", first.note);
      const second = await native.fire.fire(plan.definition.id, `${plan.definition.id}:fire-1`);
      assert.notEqual(second.status, "failed", second.note);
      const prior = calls.length;
      const duplicate = await native.fire.fire(plan.definition.id, `${plan.definition.id}:fire-1`);
      assert.equal(duplicate.note, "duplicate fire key");
      assert.equal(calls.length, prior);
    }
    const held = native.plans[0]!;
    assert.equal((await native.items.byLoop(held.definition.id)).length, 1);
    assert.equal((await native.outputs.awaitingReview(held.definition.id)).length, 1);
    assert.equal(companion.loops!.snapshot().complete, false);
    const third = await native.fire.fire(held.definition.id, `${held.definition.id}:fire-2`);
    assert.equal(third.summary?.enqueued, 1);
    assert.equal(third.summary?.worked, 1);
    assert.equal(third.summary?.ready.length, 1);
    const items = await native.items.byLoop(held.definition.id);
    const outputs = await native.outputs.awaitingReview(held.definition.id);
    assert.equal(items.length, 2);
    assert.deepEqual(
      new Set(items.map((item) => item.id)),
      new Set([held.sourceKey, held.occurrences[2]!.sourceKey!].map((key) => loopItemId(held.definition.id, key))),
    );
    assert.equal(held.definition.id, syntheticId("loops", 1));
    assert.equal(outputs.length, 2);
    assert.equal(outputs[0]!.state, "ready");
    assert.equal(held.definition.shipActions[0]!.gate, "hold");
    assert.equal(calls.length, 13);
    assert.equal(contexts.size, 9);
    assert.equal(new Set(calls.slice(0, 3).map((call) => call.request.conversation.threadRef)).size, 1);
    assert.equal(companion.loops!.snapshot().complete, true);
    await companion.close();
    const accepted = receipts.filter((row) => row.type === "companion-call");
    assert.equal(accepted.length, 26);
    assert.equal(new Set(accepted.map((row) => row.responseId)).size, 26);
    assert.deepEqual(
      new Set(calls.flatMap((call) => call.responseIds)),
      new Set(accepted.map((row) => row.responseId)),
    );
    assert.ok(
      accepted.every(
        (row) => row.error === null && row.loop.responseComplete && row.loop.provisional && row.qualified === false,
      ),
    );
    assert.equal(
      accepted.reduce((count, row) => count + row.native.toolCalls, 0),
      13,
    );
    assert.equal(companion.totals.forwarded, 0);
    for (const plan of native.plans.slice(1)) {
      const starts = accepted.filter((row) => row.loop.loopId === plan.definition.id && row.native.step === 0);
      assert.equal(starts.length, 2);
      assert.equal(starts[0]!.requestSha256, starts[1]!.requestSha256);
      assert.notEqual(starts[0]!.responseId, starts[1]!.responseId);
    }
  } finally {
    await companion.close();
  }
});

test("finite loop admission rejects retries, malformed tasks, budgets and failed responses", async () => {
  const native = await setup(async () => {
    throw new Error("Unused");
  });
  const plan = native.plans[0]!;
  const tasks = await renderLoopPlanTasks(plan);
  for (const modify of [
    (task: string) => task + "\nchanged",
    (task: string) => task + "\n\n<environment>\nvalid\n</environment>\nextra",
    (task: string) => task.replace("[Loop intake]", "[Loop work]"),
  ]) {
    const responder = await createLoopResponder([plan], [shape], fixture.fixtureId);
    assert.throws(() => responder.begin(body(modify(tasks.intake!))), /Unknown|environment/);
    assert.equal(responder.snapshot().failed, true);
  }
  const responder = await createLoopResponder([plan], [shape], fixture.fixtureId);
  const request = body(tasks.intake!);
  const first = responder.begin(request)!;
  assert.equal(responder.snapshot().complete, false);
  first.finish(true);
  assert.throws(() => responder.begin(request), /Duplicate or skipped/);
  assert.equal(responder.snapshot().failed, true);
  const aborted = await createLoopResponder([plan], [shape], fixture.fixtureId);
  aborted.begin(request)!.finish(false);
  assert.throws(() => aborted.begin(request), /poisoned/);
  const concurrent = await createLoopResponder([plan], [shape], fixture.fixtureId);
  const pending = concurrent.begin(request)!;
  assert.throws(() => concurrent.begin(request), /concurrent/);
  pending.finish(true);
  assert.equal(concurrent.snapshot().failed, true);
  const badResult = await createLoopResponder([plan], [shape], fixture.fixtureId);
  const read = badResult.begin(request)!;
  read.finish(true);
  const result = continuation(request, read.reply);
  (result.messages.at(-1)!.content as Array<{ content: string }>)[0]!.content = "changed";
  assert.throws(() => badResult.begin(result), /bytes changed/);
  assert.equal(badResult.snapshot().failed, true);
  const badPlan = structuredClone(plan);
  badPlan.occurrences[1]!.stages.push({ stage: "work", shape: shape.name });
  await assert.rejects(createLoopResponder([badPlan], [shape], fixture.fixtureId), /progression/);
  const sync = native.plans[1]!;
  const noTools = { ...shape, modelCalls: 1, toolCalls: 0, batches: [], operations: [] };
  const finite = await createLoopResponder([sync], [noTools], fixture.fixtureId);
  const syncRequest = body((await renderLoopPlanTasks(sync)).sync!);
  for (let index = 0; index < 2; index++) finite.begin(syncRequest)!.finish(true);
  assert.equal(finite.snapshot().complete, true);
  assert.throws(() => finite.begin(syncRequest), /exhausted/);
  assert.equal(finite.snapshot().complete, false);
  const wrongModel = await createLoopResponder([plan], [shape], fixture.fixtureId);
  assert.throws(() => wrongModel.begin({ ...request, model: "wrong" }), /model/);
  const insufficientDistinct = structuredClone(plan);
  insufficientDistinct.definition.caps!.maxOpenOutputs = 2;
  await assert.rejects(createLoopResponder([insufficientDistinct], [shape], fixture.fixtureId), /distinct held/);
  const malformedId = structuredClone(plan);
  malformedId.definition.id = malformedId.definition.id.toUpperCase();
  await assert.rejects(createLoopResponder([malformedId], [shape], fixture.fixtureId), /native loop ID/);
  const badCap = structuredClone(plan);
  badCap.definition.caps!.maxOpenOutputs = 1;
  await assert.rejects(createLoopResponder([badCap], [shape], fixture.fixtureId), /headroom/);
});

test("aborted accepted HTTP response poisons the plan before another occurrence can start", async () => {
  for (const recovery of [undefined, "empty-ending-once", "overloaded-retry-once"] as const) {
    const native = await setup(async () => {
      throw new Error("Unused");
    });
    const plan = native.plans[1]!;
    const records: Record<string, any>[] = [];
    const delayed = {
      ...shape,
      modelCalls: recovery ? shape.modelCalls + 1 : shape.modelCalls,
      recovery,
      delayMs: 1000,
    };
    const companion = await createWorkloadCompanion(
      { ...provider, utilities: [], nativeShapes: [delayed], loopPlans: [plan] },
      provider,
      fixture,
      (row) => records.push(row),
      { QM_PERF_TEST_TOKEN: token },
    );
    companion.server.listen(0, "127.0.0.1");
    await once(companion.server, "listening");
    const address = companion.server.address();
    assert.ok(address && typeof address !== "string");
    const request = body((await renderLoopPlanTasks(plan)).sync!);
    const abort = new AbortController();
    const response = fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": token, "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: abort.signal,
    });
    try {
      const deadline = Date.now() + 2000;
      while (!companion.loops!.snapshot().states[0]!.active && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(companion.loops!.snapshot().states[0]!.active, true);
      abort.abort();
      await assert.rejects(response);
      await companion.close();
      assert.equal(companion.loops!.snapshot().failed, true);
      assert.equal(companion.loops!.snapshot().complete, false);
      const starts = records.filter((record) => record.type === "companion-start");
      const calls = records.filter((record) => record.type === "companion-call");
      assert.equal(starts.length, 1);
      assert.equal(calls.length, 1);
      assert.equal(starts[0]!.responseId, calls[0]!.responseId);
      assert.equal(calls[0]!.loop.responseComplete, false);
      assert.ok(calls[0]!.error);
    } finally {
      abort.abort();
      await response.catch(() => {});
      await companion.close();
    }
  }
});

test("native Pi sync uses its terminal byte budget and exact optional recovery without extra calls", async () => {
  let dispatch: (request: TurnRequest) => Promise<TurnResult>;
  const native = await setup((request) => dispatch(request));
  for (const recovery of [undefined, "empty-ending-once", "overloaded-retry-once"] as const) {
    const plan = structuredClone(native.plans[1]!);
    plan.occurrences = plan.occurrences.slice(0, 1);
    const variant = { ...shape, modelCalls: recovery ? 3 : 2, recovery };
    const receipts: Record<string, any>[] = [];
    const companion = await createWorkloadCompanion(
      { ...provider, utilities: [], nativeShapes: [variant], loopPlans: [plan] },
      provider,
      fixture,
      (row) => receipts.push(row),
      { QM_PERF_TEST_TOKEN: token },
    );
    companion.server.listen(0, "127.0.0.1");
    await once(companion.server, "listening");
    const address = companion.server.address();
    assert.ok(address && typeof address !== "string");
    setProviderBaseUrls({ anthropic: `http://127.0.0.1:${address.port}` });
    const harness = createPiHarness({ defaultModelId: shape.model, apiKey: token });
    const store = createMemorySessionStore();
    const session = await store.getOrCreateByThread(
      `native-recovery-${recovery ?? "default"}`,
      "dm",
      scopeId("personal", "fixture-actor"),
    );
    const { lease } = await store.acquireLease(session.id);
    assert.ok(lease);
    const llm: unknown[] = [];
    let reads = 0;
    try {
      let result: Awaited<ReturnType<typeof harness.turns.runTurn>> | undefined;
      dispatch = async (request) => {
        assert.equal(request.surface, "loop");
        result = await harness.turns.runTurn({
          session,
          input: request.text!,
          systemPrompt: "Synthetic loop fixture",
          history: [],
          tools: {
            read: async (path: string) => {
              assert.equal(path, "shared/loop.txt");
              reads++;
              return { content: text, sourceScopeId: session.scopeId };
            },
          } as ToolContext,
          scopeLabel: session.scopeId,
          orgScopeId: scopeId("org", "fixture"),
          runId: `test-${recovery ?? "default"}`,
          pollFire: isPollSurface(request.surface),
          turnWallClockMs: 60000,
          emit: (entry) => store.append(lease, entry),
          tape: async (record) => {
            await store.appendTape(lease, record);
          },
          recordModelCall: () => {},
          recordLlmRequest: async (record) => {
            llm.push(record);
          },
        });
        return { status: "ok", reply: result.reply, sessionId: session.id };
      };
      const fired = await native.fire.fire(plan.definition.id, `native-recovery-${recovery ?? "default"}`);
      assert.equal(fired.status, "silent", fired.note);
      assert.ok(result);
      assert.equal((await native.items.byLoop(plan.definition.id)).length, 0);
      assert.equal(result.modelCalls, variant.modelCalls);
      assert.equal(reads, variant.toolCalls);
      assert.equal(llm.length, variant.modelCalls);
      assert.equal(Buffer.byteLength(result.reply), variant.outputBytes);
      await companion.close();
      assert.equal(companion.loops!.snapshot().complete, true);
      assert.equal(companion.totals.errors, 0);
      assert.equal(companion.totals.forwarded, 0);
      const calls = receipts.filter((row) => row.type === "companion-call");
      assert.equal(calls.length, variant.modelCalls);
      assert.ok(calls.every((row) => row.error === null && row.loop.responseComplete));
      assert.deepEqual(
        calls.map((row) => row.native.step),
        Array.from({ length: variant.modelCalls }, (_, index) => index),
      );
      assert.equal(
        calls.reduce((count, row) => count + row.native.toolCalls, 0),
        1,
      );
      assert.equal(calls.filter((row) => row.native.terminal).length, 1);
      const tape = await store.getTape(session.id);
      const starts = receipts.filter((row) => row.type === "companion-start");
      assert.deepEqual(
        starts.map((row) => row.responseId),
        calls.map((row) => row.responseId),
      );
      const trigger = tape.find((row) => row.kind === "message" && row.entrySeq !== undefined)!.payload as {
        content: Array<{ type: string; text: string }>;
      };
      assert.ok(trigger.content.every((block) => block.type === "text"));
      assert.equal(
        starts[0]!.nativeOriginSha256,
        createHash("sha256")
          .update(trigger.content.map((block) => block.text).join("\n"))
          .digest("hex"),
      );
      const messages = tape
        .filter((row) => row.kind === "message")
        .map((row) => row.payload as { role: string; responseId?: string; stopReason?: string });
      const assistants = messages.filter((message) => message.role === "assistant");
      assert.deepEqual(
        assistants.map((message) => message.responseId),
        calls.map((row) => row.responseId),
      );
      const notes = messages.filter(
        (message) => message.role === "user" && JSON.stringify(message).includes(EMPTY_ENDING_NOTE),
      );
      assert.equal(notes.length, recovery === "empty-ending-once" ? 1 : 0);
      assert.equal(
        assistants.filter((message) => message.stopReason === "error").length,
        recovery === "overloaded-retry-once" ? 1 : 0,
      );
      if (recovery === "overloaded-retry-once") {
        assert.equal(calls[0]!.requestSha256, calls[1]!.requestSha256);
        assert.equal(calls[0]!.native.outcome, "overloaded-error");
        assert.equal(
          calls[0]!.native.plannedErrorSha256,
          createHash("sha256")
            .update(
              JSON.stringify({
                type: "error",
                error: { type: "overloaded_error", message: "Synthetic overloaded response for native retry check" },
              }),
            )
            .digest("hex"),
        );
      }
    } finally {
      await harness.turns.close?.();
      await store.releaseLease(lease);
      await companion.close();
      setProviderBaseUrls({});
    }
  }
});

test("planned loop recovery rejects changed, duplicated, skipped and unfinished continuations", async () => {
  const native = await setup(async () => {
    throw new Error("Unused");
  });
  const plan = structuredClone(native.plans[1]!);
  plan.occurrences = plan.occurrences.slice(0, 1);
  const request = body((await renderLoopPlanTasks(plan)).sync!);
  for (const recovery of ["empty-ending-once", "overloaded-retry-once"] as const) {
    const variant = { ...shape, modelCalls: 3, recovery };
    const failed = await createLoopResponder([plan], [variant], fixture.fixtureId);
    failed.begin(request)!.finish(false);
    assert.throws(() => failed.begin(request), /poisoned/);
    const active = await createLoopResponder([plan], [variant], fixture.fixtureId);
    active.begin(request)!;
    assert.throws(() => active.begin(request), /concurrent/);
    const responder = await createLoopResponder([plan], [variant], fixture.fixtureId);
    const first = responder.begin(request)!;
    assert.equal(first.reply.native.terminal, false);
    first.finish(true);
    assert.equal(responder.snapshot().states[0]!.occurrence, 0);
    assert.equal(responder.snapshot().complete, false);
    if (recovery === "overloaded-retry-once") {
      assert.throws(() => responder.begin({ ...request, max_tokens: 321 }), /retry request bytes/);
      const duplicate = await createLoopResponder([plan], [variant], fixture.fixtureId);
      duplicate.begin(request)!.finish(true);
      duplicate.begin(request)!.finish(true);
      assert.throws(() => duplicate.begin(request), /Duplicate or skipped/);
    } else {
      const afterTool = continuation(request, first.reply);
      responder.begin(afterTool)!.finish(true);
      assert.equal(responder.snapshot().states[0]!.occurrence, 0);
      assert.throws(() => responder.begin(afterTool), /empty-ending/);
      for (const change of ["note", "system", "duplicate"] as const) {
        const rejected = await createLoopResponder([plan], [variant], fixture.fixtureId);
        const call = rejected.begin(request)!;
        call.finish(true);
        const ready = continuation(request, call.reply);
        rejected.begin(ready)!.finish(true);
        const note = {
          role: "user",
          content: [
            {
              type: "text",
              text: change === "note" ? EMPTY_ENDING_NOTE + " changed" : EMPTY_ENDING_NOTE,
              cache_control: { type: "ephemeral" },
            },
          ],
        };
        const next = {
          ...ready,
          ...(change === "system" ? { system: "changed" } : {}),
          messages: [...ready.messages, note, ...(change === "duplicate" ? [note] : [])],
        };
        assert.throws(() => rejected.begin(next), /empty-ending|Duplicate|ending note/);
        assert.equal(rejected.snapshot().failed, true);
      }
    }
  }
});
