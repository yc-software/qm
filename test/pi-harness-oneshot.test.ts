import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import {
  buildDetectionPrompt,
  createPiHarness,
  oneShot,
  parseDetectVerdict,
  piHarnessConfigOptions,
  isProviderRefusal,
  piLastAssistantTextOrThrow,
  piTurnError,
  providerRefusalError,
  refusalFallbackNote,
  refusalFallbackModelId,
  REFUSAL_FALLBACK_MODEL_IDS,
  renderDetectPrompt,
  resolveConfiguredModelId,
  sanitizeLlmPayload,
  trimPayloadToByteBudget,
  seedRawMessagesIntoSession,
  thinkingBlocksFromContent,
  toPiMessage,
  transportFromModel,
} from "../src/harness/pi-harness.ts";
import { DEFAULT_AGENT_MODEL_ID, auxiliaryModelFor, getRequiredModel, resolveModel } from "../src/model/pi-models.ts";
import { reconstructMessagesFromHistory } from "../src/harness/replay.ts";
import type { SessionEntry } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

function countTempDirs(prefix: string): number {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(prefix)).length;
}

test("toPiMessage gives assistant seeds a usage block so Pi's pre-prompt compaction check can't crash", () => {
  const user = toPiMessage({ role: "user", text: "ship it" }) as Record<string, unknown>;
  assert.equal("usage" in user, false, "user seeds carry no usage (Pi UserMessage has none)");

  const asst = toPiMessage({ role: "assistant", text: "done" }) as {
    stopReason?: string;
    usage?: { totalTokens: number };
  };
  assert.equal(asst.stopReason, "stop");
  assert.ok(asst.usage, "assistant seed has a usage block");
  assert.equal(asst.usage!.totalTokens, 0);
});

test("seedRawMessagesIntoSession pushes the reconstructed tool round (incl. toolResult) onto the live array + persists", () => {
  const liveMessages: unknown[] = [];
  const persisted: unknown[] = [];
  const stubSession = {
    agent: { state: { messages: liveMessages } },
    sessionManager: { appendMessage: (m: unknown) => persisted.push(m) },
  };
  const history: SessionEntry[] = [
    {
      sessionId: "s",
      seq: 1,
      parentSeq: null,
      type: "user",
      payload: { text: "sign up" },
      scopeLabel: "org:default-org",
      createdAt: 1,
    },
    {
      sessionId: "s",
      seq: 2,
      parentSeq: null,
      type: "tool_call",
      payload: { tool: "execute", command: "browse", callId: "c1" },
      scopeLabel: "org:default-org",
      createdAt: 2,
    },
    {
      sessionId: "s",
      seq: 3,
      parentSeq: null,
      type: "tool_result",
      payload: { tool: "execute", callId: "c1", result: "user: a / pass: b", isError: false },
      scopeLabel: "org:default-org",
      createdAt: 3,
    },
    {
      sessionId: "s",
      seq: 4,
      parentSeq: null,
      type: "assistant",
      payload: { text: "done" },
      scopeLabel: "org:default-org",
      createdAt: 4,
    },
  ];
  seedRawMessagesIntoSession(stubSession, reconstructMessagesFromHistory(history));

  assert.deepEqual(
    (liveMessages as Array<{ role: string }>).map((m) => m.role),
    ["user", "assistant", "toolResult", "assistant"],
  );
  assert.deepEqual(persisted, liveMessages);
  const toolResult = liveMessages[2] as { role: string; toolCallId: string; content: Array<{ text: string }> };
  assert.equal(toolResult.toolCallId, "c1");
  assert.match(toolResult.content[0]!.text, /pass: b/);
});

test("seedRawMessagesIntoSession is a no-op for empty input and degrades gracefully without Pi internals", () => {
  seedRawMessagesIntoSession({ agent: { state: { messages: [] } } }, []);
  assert.doesNotThrow(() => seedRawMessagesIntoSession({}, reconstructMessagesFromHistory([])));
});

test("piHarnessConfigOptions maps every Config knob the harness consumes, field by field", () => {
  const opts = piHarnessConfigOptions(
    testConfig({
      modelId: "model-base",
      detectModelId: "model-detect",
      titleModelId: "model-title",
      anthropicApiKey: "sk-test",
      piCaptureRequests: false,
      piSystemCacheSplit: true,
      scratchExecEnabled: true,
      sharedOwnerAuthIsolation: true,
      reachExecEnabled: true,
      signingSecret: "sek",
      apiBaseUrl: "https://core.test",
      turnWallClockMs: 111_000,
      execTimeoutDefaultMs: 22_000,
      execTimeoutMaxMs: 33_000,
      backgroundJobTtlMs: 44_000,
      backgroundJobTtlMaxMs: 55_000,
    }),
  );
  assert.deepEqual(opts, {
    defaultModelId: "model-base",
    detectModelId: "model-detect",
    titleModelId: "model-title",
    apiKey: "sk-test",
    captureRequests: false,
    systemCacheSplit: true,
    scratchExec: true,
    ownerAuthExec: true,
    reachExec: true,
    controlTools: true,
    turnWallClockMs: 111_000,
    execTimeoutMs: 22_000,
    execTimeoutCeilingMs: 33_000,
    backgroundJobTtlMs: 44_000,
    backgroundJobTtlMaxMs: 55_000,
  });
});

test("piHarnessConfigOptions leaves controlTools off unless a self-API (signing secret + api base) is configured", () => {
  assert.equal(piHarnessConfigOptions(testConfig()).controlTools, false);
  assert.equal(
    piHarnessConfigOptions(testConfig({ signingSecret: "sek" })).controlTools,
    false,
    "secret alone isn't enough",
  );
  assert.equal(
    piHarnessConfigOptions(testConfig({ apiBaseUrl: "https://core.test" })).controlTools,
    false,
    "api base alone isn't enough",
  );
  assert.equal(
    piHarnessConfigOptions(testConfig({ signingSecret: "sek", apiBaseUrl: "https://core.test" })).controlTools,
    true,
  );
});

test("piHarnessConfigOptions carries the deployment provider into Pi auxiliary model selection", () => {
  const opts = piHarnessConfigOptions(testConfig({ modelProvider: "openai", openaiApiKey: "sk-openai-test" }));
  assert.equal(opts.defaultModelId, "gpt-5.6-sol");
  assert.equal(auxiliaryModelFor(opts.defaultModelId!), "gpt-5.6-luna");
});

test("Pi title generation surfaces a missing auxiliary-model credential", async () => {
  const harness = createPiHarness({
    defaultModelId: "gpt-5.6-sol",
    resolveProviderKeys: async () => ({}),
  });
  await assert.rejects(
    harness.models.generateTitle!("User:\nPrioritize the public qm issues"),
    /missing openai credential for title model gpt-5\.6-luna/i,
  );
});

test("piHarnessConfigOptions omits the optional fields when the config leaves them unset", () => {
  const opts = piHarnessConfigOptions(testConfig());
  for (const key of ["defaultModelId", "detectModelId", "titleModelId", "apiKey"] as const) {
    assert.equal(key in opts, false, `${key} must be omitted, not undefined`);
  }
});

test("oneShot removes its temp dirs even when the session call throws", async () => {
  const prefix = "pi-onesh-test";
  const before = countTempDirs(prefix);

  const fakeModel = { id: "claude-sonnet-4-5" } as unknown as Parameters<typeof oneShot>[1];

  await assert.rejects(oneShot(prefix, fakeModel, "test-key", "system", "prompt"));

  const after = countTempDirs(prefix);
  assert.equal(after, before, "oneShot must leave no temp dirs behind");
});

test("oneShot completes an authenticated Pi 0.82 turn", async (t) => {
  let apiKey: string | undefined;
  let requestBody = "";
  const server = createServer((request, response) => {
    apiKey = request.headers["x-api-key"] as string | undefined;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      requestBody += String(chunk);
    });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const events = [
        {
          type: "message_start",
          message: {
            id: "msg_test",
            type: "message",
            role: "assistant",
            model: "claude-haiku-4-5",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "working" } },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
      ];
      for (const event of events) {
        response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );

  const address = server.address();
  assert(address && typeof address !== "string");
  const baseModel = getBuiltinModel("anthropic", "claude-haiku-4-5");
  assert(baseModel);
  const model = { ...baseModel, baseUrl: `http://127.0.0.1:${address.port}` };

  assert.equal(await oneShot("pi-positive-test", model, "test-key", "system", "hello"), "working");
  assert.equal(apiKey, "test-key");
  assert.match(requestBody, /system/);
  assert.match(requestBody, /hello/);
});

test("Pi assistant error messages fail the turn instead of becoming a blank reply", () => {
  const session = {
    getLastAssistantText: () => undefined,
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "provider quota exhausted",
        content: [],
      },
    ],
  } as unknown as Parameters<typeof piLastAssistantTextOrThrow>[0];

  assert.throws(() => piLastAssistantTextOrThrow(session), /provider quota exhausted/);
});

test("Pi provider JSON errors are surfaced as readable chat errors", () => {
  const session = {
    getLastAssistantText: () => undefined,
    messages: [
      {
        role: "assistant",
        stopReason: "error",
        errorMessage:
          '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low."},"request_id":"req_123"}',
        content: [],
      },
    ],
  } as unknown as Parameters<typeof piLastAssistantTextOrThrow>[0];

  assert.throws(
    () => piLastAssistantTextOrThrow(session),
    /Model provider API error \(invalid_request_error\): Your credit balance is too low\./,
  );
});

test("piTurnError recovers the session's structured error when the agent loop rejects generically", () => {
  const session = {
    getLastAssistantText: () => undefined,
    messages: [
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
        content: [],
      },
    ],
  } as unknown as Parameters<typeof piTurnError>[0];

  const err = piTurnError(session, new Error("An unknown error occurred"));
  assert.match(err.message, /Model provider API error \(overloaded_error\): Overloaded/);
});

test("piTurnError falls back to the thrown error when the session has no structured error", () => {
  const session = {
    getLastAssistantText: () => undefined,
    messages: [{ role: "assistant", stopReason: "stop", content: [] }],
  } as unknown as Parameters<typeof piTurnError>[0];

  assert.equal(piTurnError(session, new Error("socket hang up")).message, "socket hang up");
  assert.equal(piTurnError(session, "boom").message, "boom");
});

test("piTurnError ignores a PRIOR turn's stale error when nothing new was appended this prompt", () => {
  const session = {
    getLastAssistantText: () => undefined,
    messages: [
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
        content: [],
      },
    ],
  } as unknown as Parameters<typeof piTurnError>[0];

  const err = piTurnError(session, new Error("socket hang up"), 1);
  assert.equal(err.message, "socket hang up");
  const recovered = piTurnError(session, new Error("An unknown error occurred"), 0);
  assert.match(recovered.message, /Model provider API error \(overloaded_error\): Overloaded/);
});

test("parseDetectVerdict: a YES whose rationale contains 'no' still replies (anchored on the verdict token)", () => {
  assert.equal(parseDetectVerdict("YES (a direct answer to you, no mention needed)", false).respond, true);
  assert.equal(parseDetectVerdict("YES — no question mark, but it's feedback aimed at you", true).respond, true);
  assert.equal(parseDetectVerdict("Verdict: YES (no mention needed)", false).respond, true);
  assert.equal(parseDetectVerdict("**YES** — follow-up to your work", false).respond, true);
});

test("parseDetectVerdict: NO verdicts stay silent even when the rationale contains 'yes'", () => {
  assert.equal(parseDetectVerdict("NO (they said yes to each other, not to you)", false).respond, false);
  assert.equal(parseDetectVerdict("Answer: no — chit-chat", false).respond, false);
  assert.equal(parseDetectVerdict("", false).respond, false);
  assert.equal(parseDetectVerdict("Maybe?", false).respond, false, "an unrecognized verdict fails quiet");
  assert.equal(parseDetectVerdict("Eyes on this one", false).respond, false, "'yes' inside a word does not count");
});

test("parseDetectVerdict: REACT verdicts return reactions without replying", () => {
  const r = parseDetectVerdict("REACT :pray:", true);
  assert.equal(r.respond, false);
  assert.deepEqual(r.reactions, ["pray"]);
  const noEmoji = parseDetectVerdict("REACT", true);
  assert.equal(noEmoji.respond, false);
  assert.equal(noEmoji.reactions, undefined);
  assert.equal(parseDetectVerdict("REACT :pray:", false).respond, false, "reactions disabled → REACT is not a YES");
});

test("turn-detection prompt treats plain-text assistant handle + sensitive question as a reply", () => {
  const prompt = buildDetectionPrompt("Use :pray: for thanks.");
  assert.match(prompt, /plain-text assistant name\/handle/);
  assert.match(prompt, /"agent prod"/);
  assert.match(prompt, /Do NOT choose NO just because the topic is legal/);
});

test("turn-detection prompt says conversational flow can imply the assistant should answer", () => {
  const prompt = buildDetectionPrompt();
  assert.match(prompt, /conversation flow/);
  assert.match(prompt, /no mention needed/);
  assert.match(prompt, /can you send the chart/);
});

test("turn-detection prompt treats implied assistant-target follow-ups as addressed", () => {
  const prompt = buildDetectionPrompt();
  assert.match(prompt, /implied target is the assistant/);
  assert.match(prompt, /even if the assistant is not explicitly mentioned/);
  assert.match(prompt, /what do you mean by that\?/);
  assert.match(prompt, /what is available now\?/);
  assert.match(prompt, /<@U123> what do you mean by that\?[^]*NO/);
});

test("sanitizeLlmPayload captures the prompt envelope and drops the message array", () => {
  const payload = {
    model: "claude-opus-4-8",
    system: [{ type: "text", text: "be helpful" }],
    tools: [{ name: "execute" }],
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  };

  const { envelope, truncated } = sanitizeLlmPayload(payload);
  assert.equal(truncated, false);
  assert.deepEqual(envelope, {
    model: "claude-opus-4-8",
    system: [{ type: "text", text: "be helpful" }],
    tools: [{ name: "execute" }],
  });
});

const imageBlock = (data: string) => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });

test("trimPayloadToByteBudget returns the payload untouched when it fits", () => {
  const payload = { messages: [{ role: "user", content: [imageBlock("AAAA".repeat(100))] }] };
  assert.equal(trimPayloadToByteBudget(payload, 10_000_000), payload, "same reference — no clone, no cache churn");
  assert.equal(trimPayloadToByteBudget(null, 10), null);
  assert.equal(trimPayloadToByteBudget("nope", 10), "nope");
});

test("trimPayloadToByteBudget sheds the OLDEST images first and keeps the newest", () => {
  const big = "AAAA".repeat(2_000_000);
  const payload = {
    messages: [
      { role: "user", content: [{ type: "text", text: "first" }, imageBlock(big)] },
      { role: "user", content: [imageBlock(big)] },
      { role: "user", content: [imageBlock(big)] },
    ],
  };
  const out = trimPayloadToByteBudget(payload, 18_000_000) as any;
  assert.notEqual(out, payload);
  assert.equal(out.messages[0].content[1].type, "text", "oldest image replaced with a placeholder");
  assert.match(out.messages[0].content[1].text, /image removed/);
  assert.equal(out.messages[1].content[0].type, "text", "second-oldest also shed to reach slack headroom");
  assert.equal(out.messages[2].content[0].type, "image", "newest image survives");
  assert.ok(JSON.stringify(out).length <= 18_000_000, "result fits the budget");
  assert.equal((payload.messages[0]!.content[1] as any).type, "image", "input payload not mutated");
});

test("trimPayloadToByteBudget reaches images nested in tool_result content", () => {
  const big = "AAAA".repeat(5_000_000);
  const payload = {
    messages: [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [imageBlock(big)] }] },
      { role: "user", content: [{ type: "text", text: "latest" }] },
    ],
  };
  const out = trimPayloadToByteBudget(payload, 18_000_000) as any;
  const inner = out.messages[0].content[0].content[0];
  assert.equal(inner.type, "text");
  assert.match(inner.text, /image removed/);
  assert.equal(out.messages[0].content[0].tool_use_id, "t1", "tool_result envelope preserved");
  assert.ok(JSON.stringify(out).length <= 18_000_000);
});

test("trimPayloadToByteBudget also trims the OpenAI Responses wire shape", () => {
  const dataUrl = `data:image/png;base64,${"AAAA".repeat(5_000_000)}`;
  const payload = {
    input: [
      { role: "user", content: [{ type: "input_image", detail: "auto", image_url: dataUrl }] },
      { role: "user", content: [{ type: "input_text", text: "latest" }] },
    ],
  };
  const out = trimPayloadToByteBudget(payload, 18_000_000) as any;
  assert.deepEqual(out.input[0].content[0], {
    type: "input_text",
    text: out.input[0].content[0].text,
  });
  assert.match(out.input[0].content[0].text, /image removed/);
  assert.ok(JSON.stringify(out).length <= 18_000_000);
});

test("trimPayloadToByteBudget keeps a shed image block's cache_control breakpoint", () => {
  const big = "AAAA".repeat(5_000_000);
  const payload = {
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: big },
            cache_control: { type: "ephemeral" },
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "latest" }] },
    ],
  };
  const out = trimPayloadToByteBudget(payload, 18_000_000) as any;
  assert.deepEqual(out.messages[0].content[0].cache_control, { type: "ephemeral" });
  assert.equal(out.messages[0].content[0].type, "text");
});

test("transportFromModel keeps the model id + string headers (the anthropic-beta that the body omits)", () => {
  const model = { id: "claude-opus-4-8", headers: { "anthropic-beta": "fast,interleaved", "x-num": 7 } };
  assert.deepEqual(
    transportFromModel(model),
    {
      modelId: "claude-opus-4-8",
      headers: { "anthropic-beta": "fast,interleaved" },
    },
    "non-string header values are dropped",
  );
  assert.equal(transportFromModel({}), undefined, "no id and no headers → no transport");
  assert.equal(transportFromModel(null), undefined, "no model → no transport");
});

test("sanitizeLlmPayload attaches transport from the model arg alongside the redacted body", () => {
  const model = { id: "claude-opus-4-8", headers: { "anthropic-beta": "fast-mode" } };
  const out = sanitizeLlmPayload({ messages: [{ role: "user", content: "hi" }] }, model);
  assert.deepEqual(out.transport, { modelId: "claude-opus-4-8", headers: { "anthropic-beta": "fast-mode" } });
  assert.equal(out.truncated, false);
  assert.equal(sanitizeLlmPayload({ messages: [] }).transport, undefined);
});

test("sanitizeLlmPayload redacts image bytes that appear outside the message array", () => {
  const big = "AAAA".repeat(2000);
  const payload = {
    system: [{ type: "image", source: { type: "base64", media_type: "image/png", data: big } }],
    messages: [],
  };

  const { envelope } = sanitizeLlmPayload(payload);
  const block = (envelope as any).system[0];
  assert.match(block.source.data, /<base64 image\/png omitted: \d+ chars>/, "image bytes never persist");
});

test("renderDetectPrompt uses prior assistant replies, not assembled prior user prompts", () => {
  const prompt = renderDetectPrompt({
    session: {} as any,
    message: "yes, send it",
    recentContext: "carol: Can you send the chart?",
    systemPrompt: "You are Agent Prod.",
    history: [
      {
        type: "user",
        payload: { text: "## The conversation right now\nnoisy rendered Slack block\n\nCan you send the chart?" },
      },
      {
        type: "assistant",
        payload: { text: "I can send the chart if you share it again." },
      },
    ] as any,
    recordModelCall() {},
  });

  assert.match(prompt, /Your earlier replies in this thread/);
  assert.match(prompt, /I can send the chart if you share it again/);
  assert.doesNotMatch(prompt, /noisy rendered Slack block/);
  assert.match(prompt, /NEWEST message:\nyes, send it/);
});

test("thinkingBlocksFromContent extracts reasoning, KEEPS signatures (complete WAL), keeps redacted, skips text/tool/empty", () => {
  const content = [
    { type: "thinking", thinking: "Let me check the docs first.", thinkingSignature: "AAAA-opaque-base64-token" },
    { type: "text", text: "On it." },
    { type: "toolCall", id: "t1", name: "execute", arguments: { command: "ls" } },
    { type: "thinking", thinking: "   ", thinkingSignature: "sig" },
    { type: "thinking", thinking: "", thinkingSignature: "encrypted-payload", redacted: true },
    { type: "thinking", thinking: "No signature here." },
  ];
  const out = thinkingBlocksFromContent(content);
  assert.deepEqual(out, [
    { thinking: "Let me check the docs first.", thinkingSignature: "AAAA-opaque-base64-token" },
    { thinking: "", redacted: true, thinkingSignature: "encrypted-payload" },
    { thinking: "No signature here." },
  ]);
});

test("thinkingBlocksFromContent is defensive: non-arrays and non-thinking content yield nothing", () => {
  assert.deepEqual(thinkingBlocksFromContent(undefined), []);
  assert.deepEqual(thinkingBlocksFromContent(null), []);
  assert.deepEqual(thinkingBlocksFromContent("a string"), []);
  assert.deepEqual(thinkingBlocksFromContent([{ type: "text", text: "hi" }]), []);
});

test("resolveConfiguredModelId: known ids pass through, unknown ids fall back to the default", () => {
  assert.equal(resolveConfiguredModelId("claude-opus-4-8"), "claude-opus-4-8");
  assert.equal(resolveConfiguredModelId(undefined), DEFAULT_AGENT_MODEL_ID);
  assert.equal(resolveConfiguredModelId("claude-dropped-by-pi-ai"), DEFAULT_AGENT_MODEL_ID);
  assert.equal(resolveConfiguredModelId("claude-dropped-by-pi-ai", "claude-opus-4-8"), "claude-opus-4-8");
});

test("isProviderRefusal matches Anthropic's ToS-refusal wording and nothing else", () => {
  assert.equal(
    isProviderRefusal(
      "Anthropic API error (invalid_request_error): This request was blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs. To learn more, visit https://www.anthropic.com/legal/commercial-terms. API integrators: you can reduce refusals for your users by configuring a fallback model — see https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback.",
    ),
    true,
  );
  assert.equal(isProviderRefusal("This request seems to violate Anthropic’s usage policy."), true);
  assert.equal(isProviderRefusal("Anthropic API error (overloaded_error): Overloaded"), false);
  assert.equal(isProviderRefusal("prompt is too long: 250000 tokens > 200000 maximum"), false);
  assert.equal(isProviderRefusal(undefined), false);
});

test("providerRefusalError finds this prompt's refusal but never a prior turn's", () => {
  const refusalMsg = {
    role: "assistant",
    stopReason: "error",
    errorMessage:
      "This request was blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs.",
    content: [],
  };
  const session = {
    getLastAssistantText: () => undefined,
    messages: [refusalMsg, { role: "user", content: [] }],
  } as unknown as Parameters<typeof providerRefusalError>[0];
  assert.match(providerRefusalError(session) ?? "", /Terms of Service/);
  assert.equal(providerRefusalError(session, 2), null);
});

test("refusalFallbackNote names both models, carries the provider's refusal, and tells the agent to inform the user", () => {
  const note = refusalFallbackNote(
    "Claude Fable 5",
    "Claude Opus 4.8",
    "This request was blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering.",
  );
  assert.match(note, /Claude Fable 5/);
  assert.match(note, /Claude Opus 4.8/);
  assert.match(note, /restrictions on reverse engineering/);
  assert.match(note, /telling the user/);
});

test("refusal fallback drawdown: Fable -> Opus, Opus -> Sonnet, never the refused model back", () => {
  assert.equal(refusalFallbackModelId("claude-fable-5"), "claude-opus-5");
  assert.equal(refusalFallbackModelId("claude-opus-5"), "claude-sonnet-5");
  for (const id of REFUSAL_FALLBACK_MODEL_IDS) {
    assert.notEqual(refusalFallbackModelId(id), id);
    assert.equal(resolveModel(id)?.provider, "anthropic");
  }
});

test("resolveConfiguredModelId: an unresolvable default is rejected too, so auxiliaries never chase a dead id", () => {
  assert.equal(resolveConfiguredModelId(undefined, "anthropic/claude-sonnet-4-5"), DEFAULT_AGENT_MODEL_ID);
  assert.equal(resolveConfiguredModelId("also-not-real", "anthropic/claude-sonnet-4-5"), DEFAULT_AGENT_MODEL_ID);
  assert.doesNotThrow(() =>
    getRequiredModel(auxiliaryModelFor(resolveConfiguredModelId(undefined, "anthropic/claude-sonnet-4-5"))),
  );
});
