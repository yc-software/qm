import { test } from "node:test";
import assert from "node:assert/strict";
import { createPiHarness } from "../src/harness/pi-harness.ts";
import type { HarnessLlmRequestRecord, HarnessTurnInput } from "../src/harness/harness.ts";
import type { NewEntry } from "../src/sessions/session-store.ts";
import type { SessionEntry } from "../src/types.ts";
import { setProviderBaseUrls } from "../src/model/provider-endpoints.ts";
import { verificationUpstream } from "./support/model-verification-upstream.ts";

function turnInput(sessionId: string, records: HarnessLlmRequestRecord[]): HarnessTurnInput {
  let seq = 0;
  return {
    session: { id: sessionId } as HarnessTurnInput["session"],
    input: "look something up",
    systemPrompt: "BASE",
    history: [],
    tools: {} as HarnessTurnInput["tools"],
    scopeLabel: "personal:tester" as HarnessTurnInput["scopeLabel"],
    orgScopeId: "org:test" as HarnessTurnInput["orgScopeId"],
    emit: async (entry: NewEntry) => ({ ...entry, seq: seq++, createdAt: Date.now() }) as unknown as SessionEntry,
    tape: async () => {},
    recordModelCall: () => {},
    recordLlmRequest: async (rec) => {
      records.push(rec);
    },
  };
}

test("a later call that fails before its request is built keeps the earlier calls' usage", async () => {
  const upstream = await verificationUpstream();
  const models: Record<string, string> = { "claude-haiku-4-5": "claude-haiku-4-5" };
  upstream.behavior.script = () => {
    delete models["claude-haiku-4-5"];
    return { inputTokens: 5000, toolUse: { name: "lookup", input: { q: "x" } } };
  };
  const harness = createPiHarness({
    apiKey: "sk-test",
    modelId: "claude-haiku-4-5",
    modelGateway: {
      url: upstream.url,
      apiKey: "gw-test",
      apiKeyHeader: "x-gateway-key",
      models,
      reservedModelIds: new Set(["claude-haiku-4-5"]),
    },
  });
  const records: HarnessLlmRequestRecord[] = [];
  try {
    await harness.turns.runTurn(turnInput("assoc-gateway-drop", records)).catch(() => undefined);
    assert.equal(upstream.requests.filter((r) => r.path.endsWith("/messages")).length, 1, "only the first call left");
    assert.equal(records.length, 1, "the call that reached the provider is recorded once");
    assert.ok(records[0]!.promptEnvelope !== undefined, "with its captured request");
    assert.equal(records[0]!.usage?.input, 5000, "and its usage, despite the later failed call");
    assert.equal(typeof records[0]!.durationMs, "number");
  } finally {
    setProviderBaseUrls({});
    await upstream.close();
  }
});

test("each call is recorded once its step is done, not held until the turn ends", async () => {
  const upstream = await verificationUpstream();
  const records: HarnessLlmRequestRecord[] = [];
  const recordedAtRequest: number[] = [];
  upstream.behavior.script = () => {
    recordedAtRequest.push(records.length);
    return recordedAtRequest.length < 3
      ? { inputTokens: 1000 * recordedAtRequest.length, toolUse: { name: "lookup", input: { q: "x" } } }
      : { inputTokens: 3000, text: "DONE" };
  };
  setProviderBaseUrls({ anthropic: upstream.url });
  const harness = createPiHarness({ apiKey: "sk-test", modelId: "claude-haiku-4-5" });
  try {
    await harness.turns.runTurn(turnInput("assoc-incremental", records));
    assert.deepEqual(recordedAtRequest, [0, 0, 1], "call 1 is written before call 3 is sent");
    assert.deepEqual(
      records.map((r) => [r.step, r.usage?.input]),
      [
        [0, 1000],
        [1, 2000],
        [2, 3000],
      ],
    );
  } finally {
    setProviderBaseUrls({});
    await upstream.close();
  }
});

test("with request capture off, each call still records its usage without an envelope", async () => {
  const upstream = await verificationUpstream();
  upstream.behavior.script = () => ({ inputTokens: 700, text: "DONE" });
  setProviderBaseUrls({ anthropic: upstream.url });
  const harness = createPiHarness({ apiKey: "sk-test", modelId: "claude-haiku-4-5", captureRequests: false });
  const records: HarnessLlmRequestRecord[] = [];
  try {
    await harness.turns.runTurn(turnInput("assoc-capture-off", records));
    assert.equal(records.length, 1);
    assert.equal(records[0]!.promptEnvelope, undefined);
    assert.equal(records[0]!.usage?.input, 700);
  } finally {
    setProviderBaseUrls({});
    await upstream.close();
  }
});
