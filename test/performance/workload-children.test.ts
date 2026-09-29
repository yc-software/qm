import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { Context, Model } from "@earendil-works/pi-ai";
import { environmentNote } from "../../src/core/attachments.ts";
import { createAgentTools } from "../../src/harness/agent-tools.ts";
import { resolveModel } from "../../src/model/pi-models.ts";
import { createMemoryMap } from "../../src/persistence/durable-map.ts";
import { createMemoryRunStore } from "../../src/runs/memory-run-store.ts";
import { createMemoryRunSignalStore } from "../../src/runs/run-signal-store.ts";
import { createMemorySessionStore } from "../../src/sessions/memory-session-store.ts";
import { createSessionMailbox, type SessionMessage } from "../../src/sessions/session-mailbox.ts";
import { createSessionSyscalls, deliverSubagentMail, requiresDelegation } from "../../src/sessions/session-syscalls.ts";
import type { ToolContext } from "../../src/tools/primitives.ts";
import { scopeId, type Conversation, type Principal } from "../../src/types.ts";
import { hashId } from "../../src/util/crypto.ts";
import { createWorkloadCompanion } from "./workload-companion.ts";
import { nativeMarker, nativeReply, validateNativeShapes, type NativeShape } from "./workload-native.ts";

const fixture = {
  schemaVersion: 1,
  fixtureId: "child-test",
  databaseName: "qm_perf_child_test",
  profileSha256: "f".repeat(64),
  qualified: false,
};
const modelId = "claude-sonnet-5";
const token = "qm-perf-child-test-synthetic-key";
const file = "Synthetic fixture read with a child completion";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const read = { kind: "read" as const, path: "shared/child.txt", bytes: Buffer.byteLength(file), sha256: sha(file) };
const childShape: NativeShape = {
  name: "initial",
  model: modelId,
  modelCalls: 1,
  toolCalls: 0,
  batches: [],
  operations: [],
  outputBytes: 96,
  repeatedFraction: 0.5,
  delayMs: 0,
  chunkCharacters: 17,
  chunkIntervalMs: 0,
  terminal: "reply",
};

function shapesFor(surface: string): NativeShape[] {
  return [
    {
      ...childShape,
      name: `parent-${surface}`,
      sessionTitle: `Fixture ${surface} parent`,
      modelCalls: 5,
      toolCalls: 4,
      batches: [1, 1, 1, 1],
      operations: [
        { kind: "session-open", name: `fixture-child-${surface}`, shape: `initial-${surface}`, model: modelId },
        read,
        { kind: "session-followup", openOperation: 0, shape: `followup-${surface}` },
        read,
      ],
    },
    { ...childShape, name: `initial-${surface}` },
    { ...childShape, name: `followup-${surface}` },
  ];
}

async function rig(surface: "loop" | "cron", responsive = false) {
  const shapes = shapesFor(surface),
    parentShape = shapes[0]!;
  const sessions = createMemorySessionStore(),
    { runs } = createMemoryRunStore();
  const signals = createMemoryRunSignalStore(),
    mailbox = createSessionMailbox(createMemoryMap<SessionMessage>());
  const actor: Principal = { id: "fixture-actor", type: "internal" };
  const scope = scopeId("personal", actor.id);
  const threadRef = `${surface}:fixture:fire:owned`;
  let parent = await sessions.getOrCreateByThread(threadRef, "dm", scope, undefined, surface);
  await sessions.updateTitle(parent.id, parentShape.sessionTitle!);
  await sessions.addParticipant(parent.id, actor.id);
  parent = (await sessions.get(parent.id))!;
  assert.equal(parent.title, parentShape.sessionTitle);
  const conversation: Conversation = { kind: "dm", threadRef, audience: [actor] };
  const { run } = await runs.enqueue({
    sessionId: threadRef,
    dedupKey: `${surface}:owned`,
    request: {
      actor,
      conversation,
      surface,
      origin: { kind: "automation" },
      text: nativeMarker(fixture.fixtureId, parentShape.name, "owned"),
      ...(responsive ? { surfaceTools: true } : {}),
    },
  });
  const claim = await runs.claimById(run.id, "fixture-parent", 60000);
  assert.ok(claim);
  const deps = { sessions, runs, signals, mailbox, maxAttempts: 1 };
  const api = createSessionSyscalls(deps).forTurn({
    session: parent,
    scopeId: scope,
    request: { ...run.request, runId: run.id },
  });
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const screened: string[] = [];
  const tools = createAgentTools(
    {
      current: {
        sessionSyscalls: api,
        read: async (path) => {
          assert.equal(path, read.path);
          return { content: file, sourceScopeId: scope };
        },
      } as ToolContext,
      scopeLabel: scope,
      emit: async (entry) => {
        emitted.push(entry);
      },
      screenToolResult: async (input) => {
        screened.push(input.source ?? input.tool);
        return { outcome: "allow" };
      },
    },
    { delegateWork: requiresDelegation(run.request, true) },
  ).filter((tool) => ["files", "sessions"].includes(tool.name));
  return { ...deps, shapes, parentShape, parent, run, claim, tools, emitted, screened, api };
}

const execute = async (tool: ReturnType<typeof createAgentTools>[number], id: string, input: unknown) =>
  (
    tool.execute as unknown as (
      id: string,
      input: unknown,
    ) => Promise<{ content: Array<{ type: "text"; text: string }> }>
  )(id, input);

test("installed client and native sessions preserve cron/loop parent budgets, owned followup and passive mailbox returns", async () => {
  const shapes = [...shapesFor("loop"), ...shapesFor("cron")];
  validateNativeShapes(shapes);
  const provider = {
    schemaVersion: 1 as const,
    fixtureId: fixture.fixtureId,
    model: modelId,
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
  const receipts: Record<string, unknown>[] = [];
  const companion = await createWorkloadCompanion(
    { ...provider, utilities: [], nativeShapes: shapes },
    provider,
    fixture,
    (row) => receipts.push(row),
    { QM_PERF_TEST_TOKEN: token },
  );
  companion.server.listen(0, "127.0.0.1");
  await once(companion.server, "listening");
  const address = companion.server.address();
  assert.ok(address && typeof address !== "string");
  const model = {
    ...resolveModel(modelId, false)!,
    baseUrl: `http://127.0.0.1:${address.port}`,
  } as Model<"anthropic-messages">;
  const allResponseIds: string[] = [];
  try {
    for (const surface of ["loop", "cron"] as const) {
      const r = await rig(surface);
      const context: Context = {
        tools: r.tools,
        messages: [{ role: "user", content: r.run.request.text, timestamp: Date.now() }],
      };
      const children = new Map<string, Context>();
      const wire: Record<string, unknown>[] = [];
      const childRuns: string[] = [];
      let operations = 0;
      for (let step = 0; step < r.parentShape.modelCalls; step++) {
        const answer = await stream(model, context, {
          apiKey: token,
          maxTokens: 8192,
          onPayload: (payload) => {
            wire.push(structuredClone(payload as Record<string, unknown>));
          },
        }).result();
        assert.notEqual(answer.stopReason, "error", answer.errorMessage);
        assert.ok(answer.responseId);
        allResponseIds.push(answer.responseId);
        context.messages.push(answer);
        const calls = answer.content.filter((block) => block.type === "toolCall");
        assert.equal(calls.length, r.parentShape.batches[step] ?? 0);
        for (const call of calls) {
          const tool = r.tools.find((candidate) => candidate.name === call.name)!;
          const ret = await execute(tool, call.id, call.arguments);
          context.messages.push({
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: ret.content,
            isError: false,
            timestamp: Date.now(),
          });
          operations++;
          if (call.name !== "sessions") continue;
          const owned = await r.sessions.childrenOf(r.parent.id);
          assert.equal(owned.length, 1);
          const child = owned[0]!;
          if (call.arguments.action === "followup_task") assert.equal(call.arguments.target, child.id);
          const queued = (await r.runs.inFlightForThread(child.threadRef))[0]!;
          assert.equal(queued.request.delegatingRunId, r.run.id);
          assert.equal(queued.request.sessionSenderId, r.parent.id);
          assert.equal(queued.request.surface, surface);
          assert.equal(queued.request.surfaceTools, undefined);
          assert.equal(queued.request.model, modelId);
          assert.equal(queued.request.harness, "pi");
          assert.equal(child.parentSessionId, r.parent.id);
          if (call.arguments.action === "open") {
            assert.equal(
              child.threadRef,
              `agent:main:subagent:${hashId([r.parent.id, r.run.id, String(call.arguments.requestId)], 40)}`,
            );
            assert.equal(queued.dedupKey, `subagent-open:${child.threadRef}`);
          } else {
            assert.equal(queued.dedupKey, `subagent-followup:${hashId([r.parent.id, r.run.id, call.id], 40)}`);
          }
          const childContext = children.get(child.id) ?? { tools: r.tools, messages: [] };
          children.set(child.id, childContext);
          childContext.messages.push({
            role: "user",
            content: `${queued.request.text}\n\n${environmentNote("Synthetic child environment")}`,
            timestamp: Date.now(),
          });
          const childAnswer = await stream(model, childContext, {
            apiKey: token,
            maxTokens: 8192,
            onPayload: (payload) => {
              wire.push(structuredClone(payload as Record<string, unknown>));
            },
          }).result();
          assert.notEqual(childAnswer.stopReason, "error", childAnswer.errorMessage);
          assert.ok(childAnswer.responseId);
          allResponseIds.push(childAnswer.responseId);
          assert.equal(childAnswer.content.filter((block) => block.type === "toolCall").length, 0);
          childContext.messages.push(childAnswer);
          const childReply = childAnswer.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("");
          const lease = await r.runs.claimById(queued.id, "fixture-child", 60000);
          assert.ok(lease);
          await r.runs.complete(queued.id, lease.leaseToken!, { status: "ok", reply: childReply });
          const settled = await deliverSubagentMail(
            { ...r, delegationEnabled: async () => true },
            (await r.runs.get(queued.id))!,
          );
          assert.equal(settled, true);
          await r.runs.markReturned(queued.id);
          assert.equal(await r.runs.getByDedupKey(`subagent-return:${queued.id}`), null);
          const mail = await r.mailbox.pending(r.parent.id);
          assert.equal(mail.length, 1);
          assert.equal(mail[0]!.id, `subagent-mail-${queued.id}`);
          assert.equal(mail[0]!.senderId, child.id);
          assert.equal(mail[0]!.recipientId, r.parent.id);
          childRuns.push(queued.id);
        }
      }
      assert.equal(operations, 4);
      assert.equal(children.size, 1);
      assert.equal(childRuns.length, 2);
      assert.equal((await r.runs.pendingReturns()).length, 0);
      assert.equal((await r.mailbox.pending(r.parent.id)).length, 0);
      assert.equal(r.screened.filter((source) => source === "session-delegation").length, 2);
      assert.equal(r.emitted.filter((entry) => entry.type === "tool_call").length, 4);
      assert.equal((await r.runs.inFlightForThread(r.parent.threadRef)).length, 1);
      await r.runs.complete(r.run.id, r.claim.leaseToken!, { status: "ok", reply: "fixture complete" });
      assert.equal((await r.runs.inFlightForThread(r.parent.threadRef)).length, 0);
      const withMail = wire.find((payload) => JSON.stringify(payload).includes("<wake reason="));
      assert.ok(withMail);
      for (const replacement of [
        (text: string) => text.replace('kind="final_answer"', 'kind="errored"'),
        (text: string) => text.replace(/sessionId="[a-f0-9-]+"/, 'sessionId="00000000-0000-0000-0000-000000000000"'),
        (text: string) => text.replace("<content>", "<content>changed"),
        (text: string) => text.replace(/ at="[^"]+"/, ' at="2026-99-99T00:00:00.000Z"'),
        (text: string) => "changed base " + text,
        (text: string) => text + "\nunknown",
        (text: string) => text + "\n" + text.slice(text.indexOf("Internal agent message")),
        (text: string) => text + ("\n" + text.slice(text.indexOf("Internal agent message"))).repeat(4),
      ]) {
        const altered = structuredClone(withMail);
        const messages = altered.messages as Array<{ content: unknown }>;
        let changed = false;
        for (const message of messages) {
          if (!Array.isArray(message.content)) continue;
          for (const result of message.content as Array<{ type?: string; content?: unknown }>) {
            if (
              result.type !== "tool_result" ||
              typeof result.content !== "string" ||
              !result.content.includes("<wake reason=")
            )
              continue;
            result.content = replacement(result.content);
            changed = true;
            break;
          }
          if (changed) break;
        }
        assert.equal(changed, true);
        assert.throws(() => nativeReply(altered, fixture.fixtureId, shapes), /mail|suffix|bytes/);
      }
      for (const childWire of wire.filter((payload) => JSON.stringify(payload).includes("<subagent-"))) {
        const altered = structuredClone(childWire);
        const messages = altered.messages as Array<{
          role: string;
          content: string | Array<{ type: string; text: string }>;
        }>;
        const origin = messages.findLast((message) => message.role === "user")!;
        const source =
          typeof origin.content === "string" ? origin.content : origin.content.map((block) => block.text).join("\n");
        origin.content = source.replace(r.parentShape.sessionTitle!, "wrong parent");
        assert.throws(() => nativeReply(altered, fixture.fixtureId, shapes), /wrapper/);
        origin.content = source.match(/\[qm-perf-native:[^\]]+\]/)![0];
        assert.throws(() => nativeReply(altered, fixture.fixtureId, shapes), /wrapper|sender/);
        origin.content = source + "\nextra";
        assert.throws(() => nativeReply(altered, fixture.fixtureId, shapes), /wrapper/);
      }
    }
    await companion.close();
    assert.equal(companion.provider.totals.calls, 0);
    const calls = receipts.filter((row) => row.type === "companion-call");
    const starts = receipts.filter((row) => row.type === "companion-start");
    assert.equal(calls.length, 14);
    assert.equal(starts.length, 14);
    assert.deepEqual(new Set(starts.map((row) => row.responseId)), new Set(calls.map((row) => row.responseId)));
    assert.equal(new Set(allResponseIds).size, 14);
    assert.deepEqual(new Set(calls.map((row) => row.responseId)), new Set(allResponseIds));
    assert.ok(calls.every((row) => row.error === null && row.qualified === false));
  } finally {
    await companion.close();
  }
});

test("responsive parent native return behavior is rejected and impossible fixed child plans fail closed", async () => {
  const r = await rig("cron", true);
  validateNativeShapes(r.shapes);
  const initial = {
    model: modelId,
    stream: true,
    messages: [{ role: "user", content: r.run.request.text }],
    tools: r.tools.map((tool) => ({ name: tool.name, input_schema: tool.parameters })),
  };
  const reply = nativeReply(initial, fixture.fixtureId, r.shapes)!;
  const call = reply.tools[0]!;
  const ret = await execute(
    r.tools.find((tool) => tool.name === "sessions")!,
    call.id,
    call.input,
  );
  assert.match(ret.content[0]!.text, /completion will wake you/);
  const continuation = {
    ...initial,
    messages: [
      ...initial.messages,
      { role: "assistant", content: reply.tools.map((tool) => ({ type: "tool_use", ...tool })) },
      { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: ret.content }] },
    ],
  };
  assert.throws(() => nativeReply(continuation, fixture.fixtureId, r.shapes), /background open/);
  const child = (await r.sessions.childrenOf(r.parent.id))[0]!;
  const queued = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  const lease = await r.runs.claimById(queued.id, "child", 60000);
  assert.ok(lease);
  await r.runs.complete(queued.id, lease.leaseToken!, { status: "ok", reply: "actual native responsive return" });
  await r.runs.complete(r.run.id, r.claim.leaseToken!, { status: "ok", reply: "parent done" });
  assert.equal(
    await deliverSubagentMail({ ...r, delegationEnabled: async () => true }, (await r.runs.get(queued.id))!),
    false,
  );
  assert.ok(await r.runs.getByDedupKey(`subagent-return:${queued.id}`));
  for (const mutate of [
    (shapes: NativeShape[]) => {
      shapes[0]!.sessionTitle = undefined;
    },
    (shapes: NativeShape[]) => {
      (shapes[0]!.operations[2] as { openOperation: number }).openOperation = 3;
    },
    (shapes: NativeShape[]) => {
      shapes[0]!.batches = [2, 1, 1];
      shapes[0]!.modelCalls = 4;
    },
    (shapes: NativeShape[]) => {
      shapes[2]!.model = "different-model";
    },
    (shapes: NativeShape[]) => {
      shapes[1]!.repeatedFraction = 1;
    },
    (shapes: NativeShape[]) => {
      shapes[1]!.operations = shapes[0]!.operations;
      shapes[1]!.toolCalls = 4;
      shapes[1]!.modelCalls = 5;
      shapes[1]!.batches = [1, 1, 1, 1];
      shapes[1]!.sessionTitle = "child";
    },
  ]) {
    const invalid = structuredClone(r.shapes);
    mutate(invalid);
    assert.throws(() => validateNativeShapes(invalid));
  }
});
