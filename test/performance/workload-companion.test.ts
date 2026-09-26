import assert from "node:assert/strict";
import { once } from "node:events";
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { Context, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createPiHarness, oneShot, stableCwd, TITLE_GENERATION_PROMPT } from "../../src/harness/pi-harness.ts";
import { setProviderBaseUrls } from "../../src/model/provider-endpoints.ts";
import { auxiliaryModelForProvider, resolveModel } from "../../src/model/pi-models.ts";
import { companionReply, createWorkloadCompanion, promptSha256, type CompanionProfile } from "./workload-companion.ts";
import { turnMarker, type ProviderProfile } from "./workload-provider.ts";
import type { WorkloadFixture } from "./workload.ts";
import {
  materializeInput,
  materializeMarker,
  materializeSentinel,
  type MaterializeShape,
} from "./workload-materialize.ts";

const fixture: WorkloadFixture = {
  schemaVersion: 1,
  fixtureId: "companion-test",
  databaseName: "qm_perf_companion_test",
  profileSha256: "synthetic-companion-population",
  qualified: false,
};
const token = "qm-perf-companion-test-key-only";
const modelId = "claude-sonnet-5";
const pacing = { delayMs: 1, chunkCharacters: 4, chunkIntervalMs: 0 };
const provider: ProviderProfile = {
  schemaVersion: 1,
  fixtureId: fixture.fixtureId,
  model: modelId,
  tokenEnv: "QM_PERF_TEST_TOKEN",
  host: "127.0.0.1",
  port: 0,
  shapes: [
    {
      name: "one",
      modelCalls: 1,
      inputBytes: 64,
      outputBytes: 32,
      delayMs: 1,
      chunkBytes: 8,
      chunkIntervalMs: 0,
      repeatedFraction: 0.5,
    },
  ],
};
provider.shapes.push({ ...provider.shapes[0]!, name: "two", modelCalls: 2, readPath: "shared/read.txt" });
const filesTool = {
  name: "files",
  description: "Synthetic fixture file reader",
  parameters: Type.Object({ action: Type.Literal("read"), path: Type.String() }),
};
const wireTools = [{ name: filesTool.name, input_schema: filesTool.parameters }];
const compactResponse = "## Goal\nRetain synthetic fixture context.";
const profile: CompanionProfile = {
  schemaVersion: 1,
  fixtureId: fixture.fixtureId,
  host: "127.0.0.1",
  port: 0,
  tokenEnv: provider.tokenEnv,
  utilities: [
    {
      name: "title",
      model: modelId,
      systemSha256: promptSha256(
        `${TITLE_GENERATION_PROMPT}\nCurrent working directory: ${stableCwd("qm-perf-companion-test")}`,
      ),
      response: "Check synthetic café",
      ...pacing,
    },
    {
      name: "compact",
      model: modelId,
      systemSha256: "c464889dcfa60441e642f291445b49523f263e6fb2725d0c25075543a2ec3f8f",
      response: compactResponse,
      ...pacing,
    },
    {
      name: "ack",
      model: auxiliaryModelForProvider("anthropic")!,
      systemSha256: "e687801da66416db45be36398544db227380ec442c4cdb950b93b901473f35db",
      response: '{"emoji":"eyes"}',
      ...pacing,
    },
  ],
  loop: { model: modelId, shipAction: "fixture-review", ...pacing },
};

function user(content: string) {
  return { role: "user", content, timestamp: Date.now() } as const;
}

function loopPrompt(stage: string, marker: string) {
  return `[Loop ${stage}]\nSynthetic fixture only\n[End loop ${stage}]\n${marker}`;
}

test("installed Pi streams, direct acknowledgment JSON, native loop stages and frozen turns share a fail-closed endpoint", async () => {
  const records: Record<string, unknown>[] = [];
  const companion = await createWorkloadCompanion(profile, provider, fixture, (record) => records.push(record), {
    QM_PERF_TEST_TOKEN: token,
  });
  companion.server.listen(0, "127.0.0.1");
  await once(companion.server, "listening");
  const address = companion.server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const model = { ...resolveModel(modelId, false)!, baseUrl } as Model<"anthropic-messages">;
  try {
    assert.equal(
      await oneShot(
        "qm-perf-companion-test",
        model,
        { anthropic: token },
        TITLE_GENERATION_PROMPT,
        "<transcript>Synthetic café fixture</transcript>",
      ),
      "Check synthetic café",
    );
    setProviderBaseUrls({ anthropic: baseUrl });
    const harness = createPiHarness({ defaultModelId: modelId, titleModelId: modelId, apiKey: token });
    assert.equal(await harness.models.pickAckEmoji?.("Synthetic test", ["eyes", "mag"]), "eyes");
    const compactCalls: string[] = [];
    assert.equal(
      await harness.models.compactHistory!({
        session: {
          id: "compact-test",
          type: "dm",
          scopeId: "personal:synthetic",
          threadRef: "compact-test",
          createdAt: 0,
        },
        history: [
          {
            sessionId: "compact-test",
            seq: 1,
            parentSeq: null,
            type: "user",
            payload: { text: "Synthetic fixture task" },
            scopeLabel: "personal:synthetic",
            createdAt: 0,
          },
        ],
        recordModelCall: ({ model }) => {
          compactCalls.push(model);
        },
      }),
      compactResponse,
    );
    assert.deepEqual(compactCalls, [modelId], "Native compaction uses the turn model, not the auxiliary model");
    const marker = `[qm-perf-loop:${fixture.fixtureId}:one]`;
    const intake = await stream(
      model,
      { messages: [user(loopPrompt("intake", marker))] },
      { apiKey: token, maxTokens: 256 },
    ).result();
    assert.equal(intake.stopReason, "stop", intake.errorMessage);
    const source = JSON.parse(
      intake.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join(""),
    );
    assert.ok(source.items[0].sourceKey.startsWith(`${marker}/`));
    const work = await stream(
      model,
      { messages: [user(loopPrompt("intake", marker)), intake, user(loopPrompt("work", source.items[0].sourceKey))] },
      { apiKey: token, maxTokens: 256 },
    ).result();
    assert.equal(work.stopReason, "stop", work.errorMessage);
    const outputs = JSON.parse(
      work.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join(""),
    );
    assert.equal(outputs.outputs[0].shipAction, "fixture-review");
    const judge = await stream(
      model,
      {
        messages: [
          user(loopPrompt("intake", marker)),
          intake,
          user(loopPrompt("work", marker)),
          work,
          user(loopPrompt("judge", JSON.stringify({ sourceKey: source.items[0].sourceKey }))),
        ],
      },
      { apiKey: token, maxTokens: 256 },
    ).result();
    assert.equal(judge.stopReason, "stop", judge.errorMessage);
    const verdict = JSON.parse(
      judge.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join(""),
    );
    assert.deepEqual(verdict.checks, []);
    assert.equal(verdict.outcome, "met");
    const turn = await stream(
      model,
      {
        messages: [user(turnMarker(fixture.fixtureId, "one", "one"))],
        tools: [filesTool],
      },
      { apiKey: token, maxTokens: 256 },
    ).result();
    assert.equal(turn.stopReason, "stop", turn.errorMessage);
    const context: Context = { messages: [user(turnMarker(fixture.fixtureId, "two", "read"))], tools: [filesTool] };
    const first = await stream(model, context, { apiKey: token }).result();
    assert.equal(first.stopReason, "toolUse", first.errorMessage);
    const tool = first.content.find((block) => block.type === "toolCall");
    assert.ok(tool && tool.type === "toolCall");
    assert.deepEqual(tool.arguments, { action: "read", path: "shared/read.txt" });
    context.messages.push(first, {
      role: "toolResult",
      toolCallId: tool.id,
      toolName: "files",
      content: [{ type: "text", text: "Synthetic read contents" }],
      isError: false,
      timestamp: Date.now(),
    });
    const continued = await stream(model, context, { apiKey: token }).result();
    assert.equal(continued.stopReason, "stop", continued.errorMessage);
    assert.equal(companion.provider.totals.calls, 3);
    assert.equal(companion.totals.calls, 6);
    const post = (body: unknown, key = token) =>
      fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key },
        body: JSON.stringify(body),
      });
    const badBodies = [
      { model: modelId, stream: true, system: "Unknown utility", messages: [user("No marker")] },
      { model: modelId, stream: true, system: `${TITLE_GENERATION_PROMPT} altered`, messages: [user("Synthetic")] },
      {
        model: "unknown-model",
        stream: false,
        system: `${TITLE_GENERATION_PROMPT}\nCurrent working directory: ${stableCwd("qm-perf-companion-test")}`,
        messages: [user("Synthetic")],
      },
      {
        model: modelId,
        stream: false,
        system: `${TITLE_GENERATION_PROMPT}\nCurrent working directory: ${stableCwd("qm-perf-companion-test")}`,
        tools: [{ name: "files" }],
        messages: [user("Synthetic")],
      },
      { model: modelId, stream: true, messages: [user(loopPrompt("intake", "[qm-perf-loop:wrong:one]"))] },
      { model: modelId, stream: true, messages: [user(loopPrompt("work", "unmarked"))] },
      {
        model: modelId,
        stream: true,
        messages: [
          user(turnMarker(fixture.fixtureId, "one", "old")),
          { role: "assistant", content: "Earlier" },
          user("New unmarked request"),
        ],
      },
      ...[
        "",
        [{ type: "image", source: { type: "base64", media_type: "image/png", data: "synthetic" } }],
        `New request [qm-perf:${fixture.fixtureId}:`,
      ].map((content) => ({
        model: modelId,
        stream: true,
        tools: wireTools,
        messages: [
          user(turnMarker(fixture.fixtureId, "one", "old")),
          { role: "assistant", content: "Earlier" },
          { role: "user", content },
        ],
      })),
      {
        model: modelId,
        stream: true,
        tools: wireTools,
        messages: [
          user(turnMarker(fixture.fixtureId, "two", "read")),
          { role: "assistant", content: [{ type: "tool_use", id: tool.id, name: "files", input: tool.arguments }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "wrong-call", content: "Synthetic read" }] },
        ],
      },
    ];
    for (const body of badBodies) {
      const response = await post(body);
      assert.equal(response.status, 400);
      await response.text();
    }
    assert.equal((await post({}, "wrong-token")).status, 401);
    assert.equal(companion.provider.totals.calls, 3, "unknown requests must not reach frozen provider");
    assert.equal(companion.totals.errors, badBodies.length);
    const markerResponse = await fetch(`${baseUrl}/__qm_performance`, { headers: { "x-api-key": token } });
    const identity = (await markerResponse.json()) as { qualified: boolean; fixtureId: string };
    assert.equal(identity.qualified, false);
    assert.equal(identity.fixtureId, fixture.fixtureId);
    assert.ok(records.some((record) => record.rule === "ack" && record.streaming === false));
    assert.ok(records.some((record) => record.rule === "title" && record.streaming === true));
    assert.ok(
      records
        .filter((record) => record.type === "companion-call")
        .every((record) => record.qualified === false && !JSON.stringify(record).includes(token)),
    );
  } finally {
    setProviderBaseUrls({});
    await companion.close();
  }
});

test("loop matching rejects ambiguous stages and ignores markers in prior turns", () => {
  const marker = `[qm-perf-loop:${fixture.fixtureId}:one]`;
  const request = (messages: unknown[]) => ({ model: modelId, messages, stream: true });
  assert.throws(
    () => companionReply(request([user(loopPrompt("work", marker) + "\n" + loopPrompt("judge", marker))]), profile),
    /Ambiguous/,
  );
  assert.throws(
    () => companionReply(request([user(loopPrompt("work", marker + " [qm-perf-loop:companion-test:two]"))]), profile),
    /Unique/,
  );
  assert.throws(
    () => companionReply(request([user(loopPrompt("intake", marker)), user(loopPrompt("work", "unmarked"))]), profile),
    /Unique/,
  );
});

test("idempotent shutdown drains active companion and frozen-provider evidence before the sink closes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "qm-perf-companion-close-"));
  const fd = openSync(join(directory, "events.jsonl"), "wx", 0o600);
  let sinkClosed = false;
  const records: Record<string, unknown>[] = [];
  const delayedProfile = { ...profile, utilities: profile.utilities.map((rule) => ({ ...rule, delayMs: 10_000 })) };
  const delayedProvider = { ...provider, shapes: provider.shapes.map((shape) => ({ ...shape, delayMs: 10_000 })) };
  const companion = await createWorkloadCompanion(
    delayedProfile,
    delayedProvider,
    fixture,
    (record) => {
      writeSync(fd, JSON.stringify(record) + "\n");
      records.push(record);
    },
    { QM_PERF_TEST_TOKEN: token },
  );
  companion.server.listen(0, "127.0.0.1");
  await once(companion.server, "listening");
  const address = companion.server.address();
  assert.ok(address && typeof address !== "string");
  const post = (body: unknown) =>
    fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": token },
      body: JSON.stringify(body),
    })
      .then((response) => response.text())
      .catch(() => "aborted");
  const requests = [
    post({
      model: modelId,
      stream: true,
      system: `${TITLE_GENERATION_PROMPT}\nCurrent working directory: ${stableCwd("qm-perf-companion-test")}`,
      messages: [user("Synthetic title")],
    }),
    post({
      model: modelId,
      stream: true,
      tools: wireTools,
      messages: [user(turnMarker(fixture.fixtureId, "one", "shutdown"))],
    }),
  ];
  try {
    const deadline = Date.now() + 2000;
    while (companion.totals.calls !== 1 || companion.provider.totals.active !== 1) {
      assert.ok(Date.now() < deadline, "Both delayed handlers must start before shutdown");
      await sleep(5);
    }
    assert.equal(companion.totals.active, 2);
    const closing = companion.close();
    assert.equal(companion.close(), closing);
    await closing;
    assert.equal(companion.totals.active, 0);
    assert.equal(companion.provider.totals.active, 0);
    assert.equal(records.filter((record) => record.type === "companion-call").length, 2);
    assert.equal(records.filter((record) => record.type === "provider-call").length, 1);
    assert.ok(records.every((record) => record.error !== null));
    closeSync(fd);
    sinkClosed = true;
    await Promise.all(requests);
    await sleep(0);
    assert.equal(records.length, 3, "No terminal evidence may arrive after close resolves");
    await companion.close();
  } finally {
    await companion.close();
    if (!sinkClosed) closeSync(fd);
    await Promise.all(requests);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("installed Pi receives the fixed native sandbox credential call and matching completion", async () => {
  const shape: MaterializeShape = {
    model: modelId,
    runId: "12345678-1234-1234-1234-123456789012",
    credentialHandle: "kc_123456abcdef",
    credentialSha256: "a".repeat(64),
    tool: "sandbox",
  };
  const companion = await createWorkloadCompanion({ ...profile, materialize: shape }, provider, fixture, () => {}, {
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
  const tools = [
    {
      name: "sandbox",
      description: "Native execution schema",
      parameters: Type.Object({
        action: Type.String({ enum: ["exec"] }),
        command: Type.String(),
        purpose: Type.String(),
        credentials: Type.Array(Type.String()),
        timeout_seconds: Type.Optional(Type.Integer()),
      }),
    },
  ];
  const origin = user(materializeMarker(fixture.fixtureId, shape.runId));
  try {
    const first = await stream(model, { messages: [origin], tools }, { apiKey: token, maxTokens: 2048 }).result();
    assert.equal(first.stopReason, "toolUse", first.errorMessage);
    const call = first.content.find((block) => block.type === "toolCall");
    assert.ok(call && call.type === "toolCall");
    assert.equal(call.name, "sandbox");
    assert.deepEqual(call.arguments, materializeInput(shape));
    const result = {
      role: "toolResult" as const,
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text" as const, text: `${materializeSentinel(shape.runId)}\n\n[exit 0]` }],
      isError: false,
      timestamp: Date.now(),
    };
    const last = await stream(
      model,
      { messages: [origin, first, result], tools },
      { apiKey: token, maxTokens: 2048 },
    ).result();
    assert.equal(last.stopReason, "stop", last.errorMessage);
    assert.ok(
      last.content.some(
        (block) => block.type === "text" && block.text === `QM_PERF_MATERIALIZATION_COMPLETE_${shape.runId}`,
      ),
    );
    assert.equal(companion.totals.calls, 2);
    assert.equal(companion.totals.forwarded, 0);
  } finally {
    await companion.close();
  }
});
