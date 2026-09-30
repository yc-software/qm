import test, { type TestContext } from "node:test";
import { createMemoryRunSignalStore } from "../src/runs/run-signal-store.ts";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assistantFailure,
  createOpenCodeHarness,
  latestAssistantParts,
  openCodeHarnessConfigOptions,
  openCodeMessageId,
} from "../src/harness/opencode-harness.ts";
import type { OpencodeClient } from "@opencode-ai/sdk";
import type { Config } from "../src/config.ts";
import type { HarnessLlmRequestRecord, HarnessTurnInput } from "../src/harness/harness.ts";
import type { ScopeId, Session, SessionEntry } from "../src/types.ts";

function fakeSidecar(dir: string, name: string, handlers: string): string {
  const script = join(dir, `${name}.js`);
  writeFileSync(
    script,
    `const http = require("node:http");
const port = Number((process.argv.find((a) => a.startsWith("--port=")) ?? "--port=0").slice("--port=".length));
const readBody = (req) => new Promise((res) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => res(d)); });
const json = (res, value) => { const t = JSON.stringify(value); res.writeHead(200, { "content-type": "application/json" }); res.end(t); };
const capture = async (sessionId, body) =>
  fetch(process.env.OPENCODE_BRIDGE_URL + "/session/" + sessionId + "/capture", {
    method: "POST",
    headers: { authorization: "Bearer " + process.env.OPENCODE_BRIDGE_SECRET, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/global/event") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write("\\n"); return; }
  if (req.method === "POST" && url.pathname === "/session") { await readBody(req); return json(res, { id: "ses_main" }); }
  const message = url.pathname.match(/^\\/session\\/([^/]+)\\/message$/);
  ${handlers}
  return json(res, {});
});
server.listen(port, "127.0.0.1", () => console.log("opencode server listening on http://127.0.0.1:" + port));
`,
  );
  const bin = join(dir, name);
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

const promptHandlers = (assistant: string) => `
  if (req.method === "POST" && message) {
    await readBody(req);
    await capture(message[1], { system: "s", messages: [{ role: "user" }] });
    return json(res, ${assistant});
  }
  if (req.method === "GET" && message) return json(res, [${assistant}]);
`;

const erroredAssistant = (error: string) => `{
  info: {
    id: "msg_1", sessionID: "ses_main", role: "assistant", time: { created: 1000 },
    error: ${error},
    parentID: "", modelID: "gpt-5", providerID: "openai", mode: "qm", path: { cwd: "/", root: "/" },
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  },
  parts: [],
}`;

const errorAssistant = erroredAssistant(
  `{ name: "ProviderAuthError", data: { providerID: "openai", message: "401 Incorrect API key provided" } }`,
);

const okAssistant = `{
  info: {
    id: "msg_1", sessionID: "ses_main", role: "assistant", time: { created: 1000, completed: 2929 },
    parentID: "", modelID: "gpt-5", providerID: "openai", mode: "qm", path: { cwd: "/", root: "/" },
    cost: 0.0353, tokens: { input: 100, output: 20, reasoning: 3, cache: { read: 50, write: 10 } },
    finish: "stop",
  },
  parts: [{ id: "prt_1", sessionID: "ses_main", messageID: "msg_1", type: "text", text: "hello from fake" }],
}`;

function turnInput(entries: SessionEntry[], llmRows: HarnessLlmRequestRecord[]): HarnessTurnInput {
  const scope = { kind: "org", id: "test" } as unknown as ScopeId;
  const session = { id: "session-1" } as Session;
  return {
    session,
    input: "hi",
    runtime: { modelId: "openai/gpt-5" },
    systemPrompt: "be concise",
    history: [],
    tools: {} as HarnessTurnInput["tools"],
    scopeLabel: scope,
    orgScopeId: scope,
    emit: async (entry) => {
      const saved = { ...entry, sessionId: session.id, seq: entries.length + 1, createdAt: Date.now() } as SessionEntry;
      entries.push(saved);
      return saved;
    },
    recordModelCall: () => {},
    recordLlmRequest: async (rec) => {
      llmRows.push(rec);
    },
  };
}

type Handlers = string | ((dir: string) => string);

function sidecarHarness(
  t: TestContext,
  handlers: Handlers,
  options: Omit<Parameters<typeof createOpenCodeHarness>[0], "binaryPath"> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "qm-opencode-test-"));
  const harness = createOpenCodeHarness({
    binaryPath: fakeSidecar(dir, "opencode", typeof handlers === "string" ? handlers : handlers(dir)),
    ...options,
  });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, harness };
}

const contextFetch = (sessionExpr: string, query = "") =>
  `fetch(process.env.OPENCODE_BRIDGE_URL + "/session/" + ${sessionExpr} + "/context${query}", {
    headers: { authorization: "Bearer " + process.env.OPENCODE_BRIDGE_SECRET },
  }).then((r) => r.json())`;

test("OpenCode surfaces a provider error as a non-retryable failure, never a successful empty reply", async (t) => {
  const { harness } = sidecarHarness(t, promptHandlers(errorAssistant));
  const entries: SessionEntry[] = [];
  const llmRows: HarnessLlmRequestRecord[] = [];
  await assert.rejects(harness.turns.runTurn(turnInput(entries, llmRows)), (error: Error) => {
    assert.equal(error.name, "NonRetryableTurnError");
    assert.match(error.message, /ProviderAuthError/);
    assert.match(error.message, /401 Incorrect API key provided/);
    return true;
  });
  assert.deepEqual(
    entries.map((entry) => entry.type),
    ["user"],
  );
  assert.equal(llmRows.length, 1);
  assert.equal(llmRows[0]!.step, 0);
});

test("OpenCode records real usage, cost, and timings for each captured model call", async (t) => {
  const { harness } = sidecarHarness(t, promptHandlers(okAssistant));
  const llmRows: HarnessLlmRequestRecord[] = [];
  const result = await harness.turns.runTurn(turnInput([], llmRows));
  assert.equal(result.reply, "hello from fake");
  assert.equal(result.modelCalls, 1);
  assert.equal(llmRows.length, 1);
  const row = llmRows[0]!;
  assert.equal(row.turnSeq, 1);
  assert.equal(row.step, 0);
  assert.equal(row.model, "openai/gpt-5");
  assert.equal(row.truncated, false);
  assert.deepEqual(row.promptEnvelope, { system: "s" }, "messages stay on the tape, not in the envelope");
  assert.deepEqual(row.transport, { modelId: "openai/gpt-5" });
  assert.equal(row.durationMs, 1929);
  assert.deepEqual(row.usage, {
    input: 100,
    output: 20,
    cacheRead: 50,
    cacheWrite: 10,
    totalTokens: 183,
    costUsd: 0.0353,
  });
});

test("OpenCode startup failure reports the sidecar's real output and honors the configured timeout", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-opencode-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, script, expected] of [
    ["noisy", `echo "FATAL: missing libfoo" >&2\nexec sleep 30`, /did not start within \d+s.*FATAL: missing libfoo/s],
    ["silent", "exec sleep 30", /did not start within \d+s: \(no output\)/],
  ] as const) {
    const binaryPath = join(dir, name);
    writeFileSync(binaryPath, `#!/bin/sh\n${script}\n`);
    chmodSync(binaryPath, 0o755);
    const harness = createOpenCodeHarness({ binaryPath, startupTimeoutMs: 400 });
    t.after(async () => harness.turns.close?.());
    await assert.rejects(harness.turns.runTurn(turnInput([], [])), expected);
  }
});

test("OpenCode keeps the run's retry budget for an APIError the provider marks retryable", async (t) => {
  const retryableAssistant = erroredAssistant(
    `{ name: "APIError", data: { message: "overloaded", isRetryable: true } }`,
  );
  const { harness } = sidecarHarness(t, promptHandlers(retryableAssistant));
  await assert.rejects(harness.turns.runTurn(turnInput([], [])), (error: Error) => {
    assert.equal(error.name, "Error");
    assert.match(error.message, /APIError.*overloaded/);
    return true;
  });
});

test("OpenCode delivers a truncated reply on output-length and treats an aborted message as a quiet stop", async (t) => {
  for (const [assistant, reply] of [
    [
      okAssistant.replace('finish: "stop",', 'error: { name: "MessageOutputLengthError", data: {} },'),
      "hello from fake",
    ],
    [erroredAssistant(`{ name: "MessageAbortedError", data: { message: "aborted" } }`), ""],
  ] as Array<[string, string]>) {
    const { harness } = sidecarHarness(t, promptHandlers(assistant));
    assert.equal((await harness.turns.runTurn(turnInput([], []))).reply, reply);
  }
});

test("OpenCode records requests without usage attribution when captures and assistant messages misalign", async (t) => {
  const { harness } = sidecarHarness(
    t,
    `
  if (req.method === "POST" && message) {
    await readBody(req);
    await capture(message[1], { system: "s", messages: [{ role: "user" }] });
    await capture(message[1], { system: "s", messages: [{ role: "user" }, { role: "assistant" }] });
    return json(res, ${okAssistant});
  }
  if (req.method === "GET" && message) return json(res, [${okAssistant}]);
`,
  );
  const llmRows: HarnessLlmRequestRecord[] = [];
  const result = await harness.turns.runTurn(turnInput([], llmRows));
  assert.equal(result.reply, "hello from fake");
  assert.deepEqual(
    llmRows.map((row) => row.promptEnvelope),
    [{ system: "s" }, { system: "s" }],
  );
  assert.deepEqual(
    llmRows.map((row) => ({ step: row.step, usage: row.usage, durationMs: row.durationMs })),
    [
      { step: 0, usage: null, durationMs: null },
      { step: 1, usage: null, durationMs: null },
    ],
  );
});

test("latestAssistantParts skips errored and aborted messages, returning the latest successful reply", async () => {
  const stub = (messages: unknown[]) =>
    ({ session: { messages: async () => ({ data: messages }) } }) as unknown as OpencodeClient;
  const errored = {
    info: { role: "assistant", error: { name: "APIError", data: { message: "boom" } } },
    parts: [],
  };
  const aborted = {
    info: { role: "assistant", error: { name: "MessageAbortedError", data: { message: "aborted" } } },
    parts: [],
  };
  const ok = { info: { role: "assistant" }, parts: [{ type: "text", text: "fine" }] };
  assert.deepEqual(await latestAssistantParts(stub([ok, errored]), "s"), ok.parts);
  assert.deepEqual(await latestAssistantParts(stub([ok, aborted]), "s"), ok.parts);
  assert.equal(await latestAssistantParts(stub([errored]), "s"), null);
  assert.equal(await latestAssistantParts(stub([]), "s"), null);
});

test("assistantFailure classifies provider errors and exempts aborts and output-length truncation", () => {
  for (const [name, data, retryable] of [
    ["ProviderAuthError", { message: "bad key" }, false],
    ["APIError", { message: "529", isRetryable: true }, true],
    ["APIError", { message: "400", isRetryable: false }, false],
    ["UnknownError", { message: "socket hang up" }, true],
  ] as const)
    assert.deepEqual(assistantFailure({ role: "assistant", error: { name, data } }), {
      message: `OpenCode provider error (${name}): ${data.message}`,
      retryable,
    });
  assert.equal(assistantFailure({ role: "assistant", error: { name: "MessageAbortedError" } }), null);
  assert.equal(assistantFailure({ role: "assistant", error: { name: "MessageOutputLengthError" } }), null);
  assert.equal(assistantFailure({ role: "assistant" }), null);
  assert.equal(assistantFailure(undefined), null);
});

test("OpenCode judge honors the configured judge model while oneShot keeps the default", async (t) => {
  const echoModelHandlers = `
  if (req.method === "POST" && message) {
    const posted = JSON.parse(await readBody(req));
    const text = posted.model.providerID + "/" + posted.model.modelID;
    return json(res, {
      info: {
        id: "msg_1", sessionID: "ses_main", role: "assistant", time: { created: 1000, completed: 2000 },
        parentID: "", modelID: posted.model.modelID, providerID: posted.model.providerID, mode: "qm",
        path: { cwd: "/", root: "/" },
        cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      },
      parts: [{ id: "prt_1", sessionID: "ses_main", messageID: "msg_1", type: "text", text }],
    });
  }
  if (req.method === "GET" && message) return json(res, []);
`;
  const { harness } = sidecarHarness(t, echoModelHandlers, {
    defaultModelId: "openai/gpt-5",
    judgeModelId: "anthropic/claude-haiku-4-5",
  });
  assert.equal(await harness.models.oneShot?.("system", "prompt"), "openai/gpt-5");
  assert.equal(await harness.models.judge?.("system", "prompt"), "anthropic/claude-haiku-4-5");
});

test("OpenCode config options forward a judge model only when its provider has a key", () => {
  assert.equal(
    openCodeHarnessConfigOptions({ judgeModelId: "claude-haiku-4-5", anthropicApiKey: "sk-ant" } as Config)
      .judgeModelId,
    "claude-haiku-4-5",
  );
  assert.equal(
    openCodeHarnessConfigOptions({ judgeModelId: "claude-haiku-4-5", openaiApiKey: "sk-oai" } as Config).judgeModelId,
    undefined,
    "a judge model on a keyless provider must not park every judge call on a provider error",
  );
  assert.equal(
    openCodeHarnessConfigOptions({ judgeModelId: "not-a-model", anthropicApiKey: "sk-ant" } as Config).judgeModelId,
    undefined,
  );
  assert.equal(openCodeHarnessConfigOptions({} as Config).judgeModelId, undefined);
});

test("custom providers materialize into the opencode config (enabled + provider map, key included)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-custom-"));
  const dump = join(dir, "config.json");
  const bin = fakeSidecar(dir, "custom", promptHandlers(okAssistant));
  const wrapped = join(dir, "custom-wrapped");
  writeFileSync(
    wrapped,
    `#!/bin/sh\nprintf '%s' "$OPENCODE_CONFIG_CONTENT" > ${JSON.stringify(dump)}\nexec ${JSON.stringify(bin)} "$@"\n`,
  );
  chmodSync(wrapped, 0o755);
  const harness = createOpenCodeHarness({
    binaryPath: wrapped,
    resolveCustomProviders: async () => [
      {
        spec: {
          id: "litellm",
          name: "LiteLLM",
          protocol: "openai" as const,
          baseUrl: "http://litellm.internal:4000/v1",
          models: [{ id: "deepseek-chat", name: "DeepSeek", contextWindow: 128000, maxTokens: 8192 }],
        },
        apiKey: "sk-lite",
      },
      {
        spec: {
          id: "responses-proxy",
          name: "Responses Proxy",
          protocol: "openai-responses" as const,
          baseUrl: "http://responses.internal/v1",
          models: [{ id: "responses-model" }],
        },
        apiKey: "sk-responses",
      },
    ],
  });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  await harness.turns.runTurn(turnInput([], []));
  const config = JSON.parse(readFileSync(dump, "utf8"));
  assert.ok(config.enabled_providers.includes("litellm"));
  assert.ok(config.enabled_providers.includes("responses-proxy"));
  const litellm = config.provider.litellm;
  assert.equal(litellm.npm, "@ai-sdk/openai-compatible");
  assert.equal(litellm.options.baseURL, "http://litellm.internal:4000/v1");
  assert.equal(litellm.options.apiKey, "sk-lite");
  assert.deepEqual(litellm.models["deepseek-chat"], { name: "DeepSeek", limit: { context: 128000, output: 8192 } });
  assert.equal(config.provider["responses-proxy"].npm, "@ai-sdk/openai");
  assert.equal(config.provider["responses-proxy"].options.apiKey, "sk-responses");
});

test("OpenCode advertises aliases only for tools available on the turn", async (t) => {
  for (const sandboxResources of [false, true]) {
    const captured = (dir: string) => join(dir, "context.json");
    const { dir, harness } = sidecarHarness(
      t,
      (dir) => `
      if (req.method === "POST" && message) {
        await readBody(req);
        const context = await ${contextFetch("message[1]")};
        require("node:fs").writeFileSync(${JSON.stringify(captured(dir))}, JSON.stringify(context));
        return json(res, ${okAssistant});
      }
      if (req.method === "GET" && message) return json(res, [${okAssistant}]);
    `,
      { sandboxResources },
    );
    await harness.turns.runTurn(turnInput([], []));
    const { systemPrompt } = JSON.parse(readFileSync(captured(dir), "utf8")) as { systemPrompt: string };
    assert.doesNotMatch(systemPrompt, /workspace_read|workspace_write/);
    if (sandboxResources) assert.doesNotMatch(systemPrompt, /workspace_execute/);
    else assert.match(systemPrompt, /workspace_execute is execute/);
  }
});

const NATIVE_OPENCODE_MESSAGE_IDS = [
  { id: "msg_0db05f98c001fMdjYWHxM9sh5P", created: 1790380997004 },
  { id: "msg_0db05f9bd001g2O0sXZ8G8uRZ0", created: 1790380997053 },
  { id: "msg_0db05f9df001L0AWD5YFiFs5Wr", created: 1790380997087 },
];

function nativeOpenCodeTimestamp(id: string): number {
  return Number(BigInt("0x" + id.slice("msg_".length, "msg_".length + 12)) / 4096n);
}

test("OpenCode steer message IDs sort against IDs minted by native OpenCode 1.18.31", () => {
  for (const native of NATIVE_OPENCODE_MESSAGE_IDS) {
    const before = openCodeMessageId(native.created - 1);
    const after = openCodeMessageId(native.created + 1);
    assert.match(before, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    assert.equal(before.length, native.id.length);
    assert.ok(before < native.id, `${before} must sort before native ${native.id}`);
    assert.ok(native.id < after, `${after} must sort after native ${native.id}`);
    assert.equal(nativeOpenCodeTimestamp(after), nativeOpenCodeTimestamp(native.id) + 1);
  }
  const first = openCodeMessageId(1790380997200);
  const second = openCodeMessageId(1790380997200);
  assert.ok(first < second, "IDs minted in the same millisecond keep creation order");
});

test("OpenCode includes steered PDF and extracted documents without copying echoed contents into tape", async (t) => {
  const signals = createMemoryRunSignalStore();
  const dir = mkdtempSync(join(tmpdir(), "qm-opencode-steer-doc-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const capturePath = join(dir, "steered.json");
  const binary = fakeSidecar(
    dir,
    "steer-docs",
    `
    if (req.method === "POST" && url.pathname.endsWith("/prompt_async")) {
      process.qaSteered = JSON.parse(await readBody(req));
      (await import("node:fs")).writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(process.qaSteered));
      return json(res, {});
    }
    if (url.pathname === "/session/status") return json(res, { ses_main: { type: "idle" } });
    if (req.method === "POST" && message) {
      process.qaInitial = JSON.parse(await readBody(req));
      while (!process.qaSteered) await new Promise(resolve => setTimeout(resolve, 10));
      while (!require("node:fs").existsSync(${JSON.stringify(capturePath + ".release")})) await new Promise(resolve => setTimeout(resolve, 5));
      await capture("ses_main", { messages: [
        { info: { id: "initial", role: "user" }, parts: process.qaInitial.parts },
        { info: { id: process.qaSteered.messageID, role: "user" }, parts: process.qaSteered.parts },
      ] });
      return json(res, ${okAssistant});
    }
    if (req.method === "GET" && message) return json(res, [
      { info: { id: "initial", role: "user" }, parts: process.qaInitial.parts },
      { info: { id: process.qaSteered.messageID, role: "user" }, parts: process.qaSteered.parts },
      ${okAssistant},
    ]);
  `,
  );
  const harness = createOpenCodeHarness({ binaryPath: binary, signals, turnWallClockMs: 10_000 });
  t.after(async () => harness.turns.close?.());
  const pdf = readFileSync(new URL("./fixtures/documents/sample.pdf", import.meta.url)).toString("base64");
  const docx = readFileSync(new URL("./fixtures/documents/sample.docx", import.meta.url)).toString("base64");
  const tape: unknown[] = [];
  const entries: SessionEntry[] = [];
  const turn = turnInput(entries, []);
  turn.runId = "opencode-steer-docs";
  turn.tape = async (row) => {
    tape.push(row);
  };
  turn.documents = [
    { name: "initial.txt", mimeType: "text/plain", dataBase64: Buffer.from("A".repeat(80_000)).toString("base64") },
  ];
  turn.prepareSteer = async (text) => ({
    text,
    documents: [
      { name: "steered.pdf", mimeType: "application/pdf", dataBase64: pdf },
      {
        name: "steered.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        dataBase64: docx,
      },
      {
        name: "overflow.txt",
        mimeType: "text/plain",
        dataBase64: Buffer.from("Z".repeat(30_000) + "OUTSIDE-BUDGET-492").toString("base64"),
      },
    ],
  });
  await signals.send(turn.runId, { kind: "steer", text: "read the documents", ts: "doc.1" });
  const steerWindowStart = Date.now();
  const running = harness.turns.runTurn(turn);
  const deadline = Date.now() + 8_000;
  while (!existsSync(capturePath)) {
    if (Date.now() > deadline) throw new Error("mock OpenCode did not receive steer");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const steerWindowEnd = Date.now();
  const steeredMessageId = (JSON.parse(readFileSync(capturePath, "utf8")) as { messageID: string }).messageID;
  assert.match(steeredMessageId, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  const steeredAt = nativeOpenCodeTimestamp(steeredMessageId);
  assert.ok(
    steeredAt >= steerWindowStart % 2 ** 36 && steeredAt <= steerWindowEnd % 2 ** 36,
    "the queued steer carries a native OpenCode time-ordered message ID",
  );
  assert.equal(entries.filter((entry) => entry.type === "user").length, 1, "queued input is not model intake");
  writeFileSync(capturePath + ".release", "continue");
  await running;
  assert.equal(entries.filter((entry) => entry.type === "user").length, 2);
  assert.equal((await signals.pending(turn.runId)).length, 0);
  const sent = readFileSync(capturePath, "utf8");
  assert.ok(sent.includes(pdf));
  assert.ok(!sent.includes("OUTSIDE-BUDGET-492"));
  assert.match(sent, /truncated to fit/);
  assert.ok(sent.includes("DOCX-QUARTZ-731"));
  assert.ok(!JSON.stringify(tape).includes(pdf));
  assert.ok(!JSON.stringify(tape).includes("DOCX-QUARTZ-731"));
});

for (const [modelId, fastMode, expected] of [
  ["claude-opus-5", true, { speed: "fast" }],
  ["gpt-5.6-sol", true, { serviceTier: "priority" }],
  ["claude-opus-5", false, {}],
  ["claude-sonnet-5", true, {}],
  ["unknown-model", true, {}],
] as const) {
  test(`OpenCode bridge resolves fast options for ${modelId} with fast=${fastMode}`, async (t) => {
    const { harness } = sidecarHarness(
      t,
      `
        if (req.method === "GET" && message) return json(res, []);
        if (req.method === "POST" && message) {
          await readBody(req);
          const context = await ${contextFetch("message[1]", `?model=${modelId}`)};
          const assistant = ${okAssistant};
          assistant.parts[0].text = JSON.stringify(context.modelOptions);
          return json(res, assistant);
        }
      `,
    );
    const turn = turnInput([], []);
    turn.runtime = { modelId: "claude-opus-5", fastMode };
    const result = await harness.turns.runTurn(turn);
    assert.deepEqual(JSON.parse(result.reply), expected);
  });
}

test("OpenCode child requests inherit fast mode and a reused runtime honors switching it off", async (t) => {
  const { harness } = sidecarHarness(
    t,
    `
      if (req.method === "GET" && url.pathname === "/session/ses_child") return json(res, { id: "ses_child", parentID: "ses_main" });
      if (req.method === "GET" && message) return json(res, []);
      if (req.method === "POST" && message) {
        await readBody(req);
        const options = [];
        for (const model of ["gpt-5.6-sol", "claude-sonnet-5"]) {
          const context = await ${contextFetch('"ses_child"', '?model=" + model + "')};
          if (context.history !== undefined || context.systemPrompt !== undefined) throw new Error("child borrowed parent prompt");
          options.push(context.modelOptions);
        }
        const assistant = ${okAssistant};
        assistant.parts[0].text = JSON.stringify(options);
        return json(res, assistant);
      }
    `,
  );
  for (const fastMode of [true, false]) {
    const turn = turnInput([], []);
    turn.runtime = { modelId: "claude-opus-5", fastMode };
    const result = await harness.turns.runTurn(turn);
    assert.deepEqual(JSON.parse(result.reply), [fastMode ? { serviceTier: "priority" } : {}, {}]);
  }
});

for (const mechanism of ["signal", "cancel", "both"] as const) {
  test(`OpenCode preserves explicit Stop provenance via ${mechanism}`, async (t) => {
    const signals = createMemoryRunSignalStore();
    const cancel = new AbortController();
    const { dir, harness } = sidecarHarness(
      t,
      (dir) => `
        if (req.method === "POST" && message) {
          await readBody(req);
          globalThis.pendingPrompt = res;
          require("node:fs").writeFileSync(${JSON.stringify(join(dir, "started"))}, "1");
          return;
        }
        if (req.method === "POST" && url.pathname.endsWith("/abort")) {
          if (globalThis.pendingPrompt) { json(globalThis.pendingPrompt, { info: {}, parts: [] }); globalThis.pendingPrompt = null; }
          return json(res, true);
        }
        if (req.method === "GET" && message) return json(res, []);
      `,
      { signals, turnWallClockMs: 5_000 },
    );
    const running = harness.turns.runTurn({ ...turnInput([], []), runId: "stop", cancel: cancel.signal });
    const deadline = Date.now() + 4_000;
    while (!existsSync(join(dir, "started"))) {
      if (Date.now() > deadline) throw new Error("mock OpenCode never started");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (mechanism !== "cancel") await signals.send("stop", { kind: "abort" });
    if (mechanism !== "signal") cancel.abort();
    const result = await running;
    assert.equal(result.stoppedByUser, mechanism === "cancel" ? undefined : true);
    if (mechanism !== "cancel") assert.equal(result.stopped, true);
  });
}

for (const surfaceTools of [false, true]) {
  test(`OpenCode finish_silently suppresses provider closing text (surface=${surfaceTools})`, async (t) => {
    const { harness } = sidecarHarness(
      t,
      `
        if (req.method === "POST" && message) {
          await readBody(req);
          const result = await fetch(process.env.OPENCODE_BRIDGE_URL + "/session/" + message[1] + "/tool", {
            method: "POST",
            headers: { authorization: "Bearer " + process.env.OPENCODE_BRIDGE_SECRET, "content-type": "application/json" },
            body: JSON.stringify({ tool: "finish_silently", callID: "quiet", args: { reason: "nothing new" } }),
          }).then((r) => r.json());
          if (!result.terminate) throw new Error("silence did not terminate");
          return json(res, ${okAssistant});
        }
        if (req.method === "GET" && message) return json(res, [${okAssistant}]);
      `,
    );
    const entries: SessionEntry[] = [];
    const result = await harness.turns.runTurn({
      ...turnInput(entries, []),
      pollFire: !surfaceTools,
      surfaceTools,
    });
    assert.equal(result.silent, true);
    assert.equal(result.reply, "");
    assert.equal(
      entries.some((entry) => entry.type === "assistant"),
      false,
    );
    assert.ok(entries.some((entry) => entry.type === "tool_result" && (entry.payload as { silent?: boolean }).silent));
  });
}
