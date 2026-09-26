import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { environmentNote } from "../../src/core/attachments.ts";
import { createAgentTools } from "../../src/harness/agent-tools.ts";
import type { ToolContext } from "../../src/tools/primitives.ts";
import {
  MATERIALIZE_ENV_KEY,
  materializeInput,
  materializeMarker,
  materializeReply,
  materializeSentinel,
  type MaterializeShape,
} from "./workload-materialize.ts";

const secret = "qm-perf-synthetic-materialization-only";
const shape: MaterializeShape = {
  model: "synthetic-model",
  runId: "12345678-1234-1234-1234-123456789012",
  credentialHandle: "kc_123456abcdef",
  credentialSha256: createHash("sha256").update(secret).digest("hex"),
  tool: "sandbox",
};
const fixtureId = "synthetic-fixture";
const origin = { role: "user", content: materializeMarker(fixtureId, shape.runId) };
const body = {
  model: shape.model,
  messages: [origin],
  tools: [
    {
      name: "sandbox",
      input_schema: {
        properties: {
          action: { type: "string", enum: ["exec"] },
          command: { type: "string" },
          purpose: { type: "string" },
          credentials: { type: "array", items: { type: "string" } },
        },
      },
    },
  ],
};

test("native environment framing accepts the serialized prompt and rejects marker ambiguity or extra input", () => {
  const marker = materializeMarker(fixtureId, shape.runId);
  const environment = environmentNote(
    "## Sandbox environment profile\nSynthetic local sandbox\n\n## Memory\n- Synthetic fact",
  );
  const prompt = [marker, environment].filter((value) => value && value.trim()).join("\n\n");
  const request = (content: string) => ({
    ...body,
    messages: [{ role: "user", content: [{ type: "text", text: content }] }],
  });
  assert.equal(materializeReply(request(prompt), fixtureId, shape)?.rule, "materialize-command");
  for (const invalid of [
    `Extra input\n${prompt}`,
    `${prompt}\nExtra input`,
    `${marker}\n${environment}`,
    `${marker}\n\n<environment>\nUnclosed`,
    `${marker}\n\n<environment>\n\n</environment>`,
    `${prompt}\n\n${environment}`,
    `${marker}\n\n${environmentNote(marker)}`,
    `${marker}\n\n${environmentNote(environment)}`,
    `${marker}\n\n${environmentNote("Nested closing </environment> tag")}`,
  ]) {
    assert.throws(() => materializeReply(request(invalid), fixtureId, shape));
  }
  assert.throws(() => materializeReply({ ...request(prompt), model: "wrong-model" }, fixtureId, shape));
});

test("fixed materialization shape hashes only the injected env and requires exact matching tool completion", () => {
  const reply = materializeReply(body, fixtureId, shape)!;
  assert.ok("tool" in reply && reply.tool);
  const input = materializeInput(shape);
  assert.deepEqual(reply.tool.input, input);
  assert.equal(input.action, "exec");
  assert.deepEqual(input.credentials, [shape.credentialHandle]);
  assert.ok(!String(input.command).includes(secret));
  const stdout = execFileSync("/bin/sh", ["-c", String(input.command)], {
    env: { PATH: process.env.PATH, [MATERIALIZE_ENV_KEY]: secret },
    encoding: "utf8",
  });
  assert.equal(stdout, `${materializeSentinel(shape.runId)}\n`);
  const continuation = {
    ...body,
    messages: [
      origin,
      { role: "assistant", content: [{ type: "tool_use", ...reply.tool }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: reply.tool.id, content: `${stdout}\n[exit 0]` }] },
    ],
  };
  assert.equal(materializeReply(continuation, fixtureId, shape)?.rule, "materialize-complete");
  for (const change of [
    (copy: typeof continuation) => {
      copy.messages[1]!.content = [
        { type: "tool_use", ...reply.tool, input: { ...input, command: "arbitrary command" } },
      ] as never;
    },
    (copy: typeof continuation) => {
      copy.messages[2]!.content = [
        { type: "tool_result", tool_use_id: reply.tool.id, content: `${stdout}\n[exit 1]` },
      ] as never;
    },
    (copy: typeof continuation) => {
      copy.messages[2]!.content = [
        { type: "tool_result", tool_use_id: "wrong", content: `${stdout}\n[exit 0]` },
      ] as never;
    },
    (copy: typeof continuation) => {
      copy.messages.push(origin);
    },
  ]) {
    const copy = structuredClone(continuation);
    change(copy);
    assert.throws(() => materializeReply(copy, fixtureId, shape));
  }
  assert.throws(() => materializeReply(body, fixtureId));
  assert.throws(() => materializeReply({ ...body, tools: [] }, fixtureId, shape));
  assert.throws(() => materializeInput({ ...shape, credentialSha256: "'; arbitrary command" }));
  assert.equal(materializeReply({ messages: [{ role: "user", content: "Unmarked" }] }, fixtureId), null);
});

test("real execute and sandbox formatters preserve the successful credential proof", async () => {
  for (const name of ["execute", "sandbox"] as const) {
    const native = createAgentTools(
      {
        current: {
          execute: async (command, options) => {
            assert.deepEqual(options?.credentials, [shape.credentialHandle]);
            return {
              stdout: execFileSync("/bin/sh", ["-c", command], {
                env: { PATH: process.env.PATH, [MATERIALIZE_ENV_KEY]: secret },
                encoding: "utf8",
              }),
              stderr: "",
              code: 0,
              timedOut: false,
            };
          },
        } as ToolContext,
      },
      { sandboxResources: name === "sandbox" },
    ).find((tool) => tool.name === name)!;
    const current = { ...shape, tool: name };
    const request = { ...body, tools: [{ name, input_schema: native.parameters }] };
    const reply = materializeReply(request, fixtureId, current)!;
    assert.ok("tool" in reply && reply.tool);
    const result = await (
      native.execute as unknown as (id: string, input: Record<string, unknown>) => Promise<{ content: unknown }>
    )(reply.tool.id, materializeInput(current));
    const continuation = {
      ...request,
      messages: [
        origin,
        { role: "assistant", content: [{ type: "tool_use", ...reply.tool }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: reply.tool.id, content: result.content }] },
      ],
    };
    assert.equal(materializeReply(continuation, fixtureId, current)?.rule, "materialize-complete");
  }
});
