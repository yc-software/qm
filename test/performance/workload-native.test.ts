import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { Context, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { resolveModel } from "../../src/model/pi-models.ts";
import { createAgentTools } from "../../src/harness/agent-tools.ts";
import { createToolContext } from "../../src/tools/primitives.ts";
import { createMemoryMap } from "../../src/persistence/durable-map.ts";
import { createMemoryAdvisoryLock } from "../../src/persistence/advisory-lock.ts";
import {
  createSandboxResources,
  type SandboxResource,
  type SandboxDefault,
} from "../../src/sandbox/sandbox-resources.ts";
import { createSandboxRouter } from "../../src/sandbox/sandbox-routing.ts";
import type { Sandbox } from "../../src/sandbox/sandbox.ts";
import { personalScope } from "../../src/types.ts";
import { createWorkloadCompanion } from "./workload-companion.ts";
import {
  nativeMarker,
  nativeReply,
  nativeShapeReply,
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

test("standalone bootstrap uses the native non-admin create tool and validates its owned ready resource", async () => {
  const ownerId = "perf-00124@example.invalid";
  const scope = personalScope(ownerId);
  const operation = { kind: "sandbox-create" as const, ownerId, name: "qm-perf-bootstrap-native-test" };
  const bootstrap: NativeShape = {
    ...shape,
    name: "bootstrap",
    modelCalls: 2,
    toolCalls: 1,
    batches: [1],
    operations: [operation],
  };
  validateNativeShapes([bootstrap]);
  const records = createMemoryMap<SandboxResource>();
  const defaults = createMemoryMap<SandboxDefault>();
  const provisioned: string[] = [];
  const authorized: string[] = [];
  const backend = {
    profile: { backend: "sprites", writablePersistence: "resident_disk", processSessions: false },
    async provision(layers) {
      const id = layers.find((layer) => layer.mode === "rw")!.scopeId;
      provisioned.push(id);
      return { id, rootDir: "/workspace" };
    },
  } as Sandbox;
  const resources = createSandboxResources({
    enabled: true,
    records,
    defaults,
    rollout: createMemoryMap(),
    routes: createMemoryMap(),
    backends: { sprites: backend },
    defaultBackend: "sprites",
    lock: createMemoryAdvisoryLock(),
    canUseScope: async (actor, target) => {
      authorized.push(`${actor}:${target}`);
      return actor === ownerId && target === scope;
    },
  });
  await resources.initialize();
  const sandbox = createSandboxRouter({
    routes: createMemoryMap(),
    backends: { sprites: backend },
    defaultBackend: "sprites",
    resources,
  });
  const layers = [{ scopeId: scope, mountPath: "/", mode: "rw" as const }];
  const toolContext = createToolContext({
    sandbox,
    provision: async () => assert.fail("Bootstrap must not provision a default sandbox"),
    layers,
    commandPolicy: () => ({ mode: "denylist", rules: [] }),
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace: {} as never,
    deploy: {} as never,
    acl: {} as never,
    createdBy: ownerId,
    sandboxResources: resources,
    accessSandboxResource: async () => assert.fail("Create must not adopt another resource"),
    provisionResource: (access) =>
      sandbox.provision(layers, { sandboxId: typeof access === "string" ? access : access.resource.id }),
  });
  const tool = createAgentTools({ current: toolContext }, { sandboxResources: true }).find(
    (t) => t.name === "sandbox",
  )!;
  const token = "qm-perf-bootstrap-synthetic-token";
  const receipt: Record<string, unknown>[] = [];
  const companion = await createWorkloadCompanion(
    {
      schemaVersion: 1,
      fixtureId: fixture.fixtureId,
      host: "127.0.0.1",
      port: 0,
      tokenEnv: "TEST_TOKEN",
      utilities: [],
      nativeShapes: [bootstrap],
    },
    {
      schemaVersion: 1,
      fixtureId: fixture.fixtureId,
      model: modelId,
      tokenEnv: "TEST_TOKEN",
      host: "127.0.0.1",
      port: 0,
      shapes: [
        {
          name: "unused",
          modelCalls: 1,
          inputBytes: 64,
          outputBytes: 20,
          delayMs: 0,
          chunkBytes: 20,
          chunkIntervalMs: 0,
          repeatedFraction: 0.5,
        },
      ],
    },
    fixture,
    (row) => receipt.push(row),
    { TEST_TOKEN: token },
  );
  companion.server.listen(0, "127.0.0.1");
  await once(companion.server, "listening");
  const address = companion.server.address();
  assert.ok(address && typeof address !== "string");
  const model = {
    ...resolveModel(modelId, false)!,
    baseUrl: `http://127.0.0.1:${address.port}`,
  } as Model<"anthropic-messages">;
  const marker = nativeMarker(fixture.fixtureId, bootstrap.name, "bootstrap-proof");
  const context: Context = { tools: [tool], messages: [{ role: "user", content: marker, timestamp: Date.now() }] };
  try {
    const first = await stream(model, context, { apiKey: token, maxTokens: 8192 }).result();
    assert.equal(first.stopReason, "toolUse", first.errorMessage);
    const calls = first.content.filter((block) => block.type === "toolCall");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.arguments, nativeToolInput(operation).input);
    const result = await tool.execute(calls[0]!.id, calls[0]!.arguments as never, undefined, undefined, {} as never);
    const returned = result.content
      .map((block) => (block.type === "text" ? block.text : assert.fail("Expected native JSON text")))
      .join("\n");
    const resource = JSON.parse(returned);
    assert.deepEqual(JSON.parse(JSON.stringify(await records.get(resource.id))), resource);
    assert.equal(resource.createdBy, ownerId);
    assert.equal(resource.ownerScopeId, scope);
    assert.equal(resource.state, "ready");
    assert.equal((await records.all()).length, 1);
    assert.equal((await defaults.all()).length, 0);
    assert.equal(await resources.resolve(scope), null);
    assert.deepEqual(provisioned, [resource.backingScopeId, resource.backingScopeId]);
    assert.deepEqual(authorized, [`${ownerId}:${scope}`]);
    await assert.rejects(
      resources.create(ownerId, personalScope("perf-00125@example.invalid"), "sprites", operation.name),
      /sandbox access requires permission/,
    );
    assert.equal((await records.all()).length, 1);
    context.messages.push(first, {
      role: "toolResult",
      toolCallId: calls[0]!.id,
      toolName: tool.name,
      content: result.content,
      isError: false,
      timestamp: Date.now(),
    });
    const final = await stream(model, context, { apiKey: token, maxTokens: 8192 }).result();
    assert.equal(final.stopReason, "stop", final.errorMessage);
    assert.equal(companion.totals.calls, 2);
    assert.equal(companion.provider.totals.calls, 0);
    assert.deepEqual(
      receipt.filter((row) => row.type === "companion-call").map((row) => row.rule),
      ["native:bootstrap:0", "native:bootstrap:1"],
    );
    const initial = {
      model: modelId,
      stream: true,
      tools: [{ name: tool.name, input_schema: tool.parameters }],
      messages: [{ role: "user", content: marker }],
    };
    const emitted = nativeReply(initial, fixture.fixtureId, [bootstrap])!;
    const continuation = (value: unknown) => ({
      ...initial,
      messages: [
        ...initial.messages,
        { role: "assistant", content: emitted.tools.map((call) => ({ type: "tool_use", ...call })) },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: emitted.tools[0]!.id, content: JSON.stringify(value) }],
        },
      ],
    });
    assert.equal(nativeReply(continuation(resource), fixture.fixtureId, [bootstrap])!.native.terminal, true);
    for (const changed of [
      { ownerScopeId: personalScope("other") },
      { createdBy: "other" },
      { backend: "local" },
      { state: "failed" },
      { legacy: true },
      { cleanupPending: true },
      { cleanupPending: "false" },
      { error: "failed" },
      { name: "other" },
      { backingScopeId: "other" },
      { machineId: "" },
    ])
      assert.throws(
        () => nativeReply(continuation({ ...resource, ...changed }), fixture.fixtureId, [bootstrap]),
        /Ready native sandbox/,
      );
    assert.throws(() => nativeReply(continuation(null), fixture.fixtureId, [bootstrap]), /Ready native sandbox/);
    for (const origin of [
      `[Loop sync]\n${marker}`,
      `<cron-task>\n${marker}\n</cron-task>`,
      `<subagent-task>\n${marker}\n</subagent-task>`,
    ])
      assert.throws(
        () =>
          nativeShapeReply(initial, { origin, pairs: [] }, bootstrap, "bootstrap-proof", undefined, {
            fixtureId: fixture.fixtureId,
            shapes: [bootstrap],
          }),
        /standalone/,
      );
    for (const changed of [
      { modelCalls: 3, batches: [1, 1], toolCalls: 2, operations: [operation, operation] },
      { terminal: "loop-intake-empty" as const },
      { recovery: "empty-ending-once" as const, modelCalls: 3 },
      { operations: [{ ...operation, ownerId: "admin" }] },
      { operations: [{ ...operation, ownerId: ownerId + "\n" }] },
      { operations: [{ ...operation, name: "unbounded" }] },
      { operations: [{ ...operation, name: operation.name + "\n" }] },
      { operations: [{ ...operation, backend: "local" }] },
    ])
      assert.throws(() => validateNativeShapes([{ ...bootstrap, ...changed }]));
    assert.throws(
      () =>
        validateNativeShapes([
          bootstrap,
          {
            ...bootstrap,
            name: "parent",
            sessionTitle: "Fixture parent",
            operations: [{ kind: "session-open", name: "bootstrap-child", shape: bootstrap.name, model: modelId }],
          },
        ]),
      /nondelegating child/,
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

test("recovery budgets are explicit and cannot authorize direct native turns", () => {
  const recovered = { ...shape, modelCalls: shape.modelCalls + 1, recovery: "empty-ending-once" as const };
  validateNativeShapes([recovered]);
  assert.throws(() => validateNativeShapes([{ ...recovered, modelCalls: shape.modelCalls }]), /tool batch/);
  assert.throws(() => validateNativeShapes([{ ...recovered, recovery: "unknown" as never }]), /recovery mode/);
  assert.throws(
    () =>
      nativeReply(
        {
          model: modelId,
          stream: true,
          messages: [{ role: "user", content: nativeMarker(fixture.fixtureId, shape.name, "proof") }],
        },
        fixture.fixtureId,
        [recovered],
      ),
    /finite loop plan/,
  );
});
