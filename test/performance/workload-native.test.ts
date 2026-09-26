import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { Context, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { resolveModel } from "../../src/model/pi-models.ts";
import { createWorkloadCompanion } from "./workload-companion.ts";
import {
  nativeMarker,
  nativeReply,
  nativeSandboxOutput,
  nativeToolInput,
  validateNativeShapes,
  type NativeShape,
} from "./workload-native.ts";

const text = "Synthetic durable fixture bytes";
const modelId = "claude-sonnet-5";
const fixture = {
  schemaVersion: 1,
  fixtureId: "native-test",
  databaseName: "qm_perf_native_test",
  profileSha256: "f".repeat(64),
  qualified: false,
};
const shape: NativeShape = {
  name: "multi",
  model: modelId,
  modelCalls: 3,
  toolCalls: 5,
  batches: [3, 2],
  operations: [
    {
      kind: "read",
      path: "shared/native.txt",
      bytes: Buffer.byteLength(text),
      sha256: createHash("sha256").update(text).digest("hex"),
    },
    ...Array.from({ length: 4 }, () => ({
      kind: "sandbox" as const,
      sandboxId: "fixture-owned",
      bytes: 256,
      seed: "a".repeat(64),
      sleepMs: 0,
    })),
  ],
  outputBytes: 40,
  repeatedFraction: 0.5,
  delayMs: 0,
  chunkCharacters: 13,
  chunkIntervalMs: 0,
  terminal: "reply",
};
const tools = [
  {
    name: "files",
    description: "Native file read",
    parameters: Type.Object({ action: Type.Literal("read"), path: Type.String() }),
  },
  {
    name: "sandbox",
    description: "Native fixed execution",
    parameters: Type.Object({
      action: Type.String({ enum: ["exec"] }),
      command: Type.String(),
      purpose: Type.String(),
      sandbox_id: Type.String(),
      timeout_seconds: Type.Integer(),
    }),
  },
];

test("installed client executes exact native multi-tool batches and validates every returned byte", async () => {
  validateNativeShapes([shape]);
  const token = "qm-perf-native-test-synthetic-key";
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
  const records: Record<string, unknown>[] = [];
  const profile = {
    schemaVersion: 1 as const,
    fixtureId: fixture.fixtureId,
    host: "127.0.0.1",
    port: 0,
    tokenEnv: provider.tokenEnv,
    utilities: [],
    nativeShapes: [shape],
  };
  const companion = await createWorkloadCompanion(profile, provider, fixture, (row) => records.push(row), {
    QM_PERF_TEST_TOKEN: token,
  });
  companion.server.listen(0, "127.0.0.1");
  await once(companion.server, "listening");
  const address = companion.server.address();
  assert.ok(address && typeof address !== "string");
  const model = {
    ...resolveModel(modelId, false)!,
    baseUrl: `http://127.0.0.1:${address.port}`,
  } as Model<"anthropic-messages">;
  const context: Context = {
    tools,
    messages: [{ role: "user", content: nativeMarker(fixture.fixtureId, shape.name, "one"), timestamp: Date.now() }],
  };
  let executed = 0;
  try {
    for (let step = 0; step < shape.modelCalls; step++) {
      const answer = await stream(model, context, { apiKey: token, maxTokens: 8192 }).result();
      assert.notEqual(answer.stopReason, "error", answer.errorMessage);
      const calls = answer.content.filter((block) => block.type === "toolCall");
      assert.equal(calls.length, shape.batches[step] ?? 0);
      context.messages.push(answer);
      for (const call of calls) {
        const operation = shape.operations[executed++]!;
        assert.deepEqual({ name: call.name, input: call.arguments }, nativeToolInput(operation));
        let returned = text;
        if (operation.kind === "sandbox") {
          const command = String(call.arguments.command);
          assert.ok(command.startsWith("python3 -c '") && command.endsWith("'"));
          const stdout = execFileSync("python3", ["-c", command.slice(12, -1)], { encoding: "utf8" });
          assert.equal(stdout, nativeSandboxOutput(operation) + "\n");
          returned = stdout + "\n[exit 0]";
        }
        context.messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: returned }],
          isError: false,
          timestamp: Date.now(),
        });
      }
      assert.equal(answer.stopReason, calls.length ? "toolUse" : "stop");
    }
    assert.equal(executed, 5);
    assert.equal(companion.totals.calls, 3);
    assert.equal(companion.provider.totals.calls, 0);
    assert.deepEqual(
      records.filter((row) => row.type === "companion-call").map((row) => row.rule),
      ["native:multi:0", "native:multi:1", "native:multi:2"],
    );
  } finally {
    await companion.close();
  }
});

test("native shapes reject impossible budgets, arbitrary commands, stale markers and mismatched loop phases", () => {
  assert.throws(() => validateNativeShapes([{ ...shape, toolCalls: 4 }]), /budget|batch/);
  assert.throws(() => validateNativeShapes([{ ...shape, batches: [5, 0] }]), /nonempty/);
  assert.throws(
    () =>
      validateNativeShapes([
        {
          ...shape,
          operations: [
            { kind: "sandbox", sandboxId: "owned", bytes: 1, seed: "'; arbitrary", sleepMs: 0 },
            ...shape.operations.slice(1),
          ],
        },
      ]),
    /seed/,
  );
  const marker = nativeMarker(fixture.fixtureId, shape.name, "one");
  const request = (content: unknown) => ({
    model: modelId,
    stream: true,
    messages: [
      { role: "user", content: marker },
      { role: "assistant", content: "old" },
      { role: "user", content },
    ],
  });
  assert.equal(nativeReply(request("new unmarked turn"), fixture.fixtureId, [shape]), null);
  assert.throws(() => nativeReply(request(marker + " " + marker), fixture.fixtureId, [shape]), /One matching/);
  const loop = { ...shape, terminal: "loop-intake-empty" as const };
  assert.throws(
    () => nativeReply(request(`[Loop work]\n${marker}\n[End loop work]`), fixture.fixtureId, [loop]),
    /intake/,
  );
});

test("native continuation rejects missing, changed and failed results and terminates an intake without extra stages", () => {
  const marker = nativeMarker(fixture.fixtureId, shape.name, "proof");
  const initial = {
    model: modelId,
    stream: true,
    messages: [{ role: "user", content: marker }],
    tools: tools.map((tool) => ({ name: tool.name, input_schema: tool.parameters })),
  };
  const first = nativeReply(initial, fixture.fixtureId, [shape])!;
  const calls = first.tools.map((tool) => ({ type: "tool_use", ...tool }));
  const results = first.tools.map((tool, index) => ({
    type: "tool_result",
    tool_use_id: tool.id,
    is_error: false,
    content:
      shape.operations[index]!.kind === "read"
        ? text
        : nativeSandboxOutput(
            shape.operations[index] as Extract<NativeShape["operations"][number], { kind: "sandbox" }>,
          ) + "\n\n[exit 0]",
  }));
  const request = (content: unknown) => ({
    ...initial,
    messages: [...initial.messages, { role: "assistant", content: calls }, { role: "user", content }],
  });
  assert.equal(nativeReply(request(results), fixture.fixtureId, [shape])!.native.step, 1);
  assert.throws(() => nativeReply(request(results.slice(1)), fixture.fixtureId, [shape]), /Complete/);
  assert.throws(
    () =>
      nativeReply(request([{ ...results[0], content: "wrong bytes" }, ...results.slice(1)]), fixture.fixtureId, [
        shape,
      ]),
    /bytes changed/,
  );
  assert.throws(
    () => nativeReply(request([{ ...results[0], is_error: true }, ...results.slice(1)]), fixture.fixtureId, [shape]),
    /Successful/,
  );
  assert.throws(
    () => nativeReply(request([results[0], results[0], results[2]]), fixture.fixtureId, [shape]),
    /Successful/,
  );
  const intake = {
    ...shape,
    modelCalls: 1,
    toolCalls: 0,
    batches: [],
    operations: [],
    terminal: "loop-intake-empty" as const,
  };
  const answer = nativeReply(
    { ...initial, messages: [{ role: "user", content: `[Loop intake]\n${marker}\n[End loop intake]` }] },
    fixture.fixtureId,
    [intake],
  )!;
  assert.equal(answer.text, '{"items":[]}');
  assert.equal(answer.tools.length, 0);
  assert.equal(answer.native.terminal, true);
});
