import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HarnessLlmRequestRecord, HarnessTurnInput } from "../src/harness/harness.ts";
import { createGrokHarness, grokHarnessConfigOptions } from "../src/harness/grok-harness.ts";
import type { NewEntry } from "../src/sessions/session-store.ts";
import type { ScopeId, SessionEntry } from "../src/types.ts";

function fakeGrokBinary(directory: string): string {
  const path = join(directory, "fake-grok");
  writeFileSync(
    path,
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const command = process.argv[2];
if (command === "login") {
  const token = fs.readFileSync(path.join(process.env.GROK_HOME, "access-token"), "utf8");
  fs.writeFileSync(path.join(process.env.GROK_HOME, "auth.json"), JSON.stringify({ external: { auth_mode: "external", key: token } }), { mode: 0o600 });
  process.stderr.write("identity must not escape\\n");
  process.exit(0);
}
if (command !== "agent" || process.argv[3] !== "stdio" || process.argv.length !== 4) process.exit(2);
fs.appendFileSync(${JSON.stringify(join(directory, "agent-runs"))}, "run\\n");
fs.writeFileSync(${JSON.stringify(join(directory, "agent-pid"))}, String(process.pid));
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\\n");
let mcpSessionId;
let listedTools = [];
const rpc = async (server, method, params, id) => {
  const response = await fetch(server.url, {
    method: "POST",
    headers: Object.fromEntries([...server.headers.map((header) => [header.name, header.value]), ["accept", "application/json, text/event-stream"], ["content-type", "application/json"], ["mcp-protocol-version", "2025-06-18"], ...(mcpSessionId ? [["mcp-session-id", mcpSessionId]] : [])]),
    body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) }),
  });
  const body = await response.text();
  mcpSessionId = response.headers.get("mcp-session-id") || mcpSessionId;
  if (!body) return undefined;
  const payload = body.startsWith("event:") ? body.split("\\n").find((line) => line.startsWith("data: ")).slice(6) : body;
  return JSON.parse(payload).result;
};
let sessionId = "fresh-session";
let heldPrompt;
let deferSurface = false;
let malformedSurface = false;
let ignoreCancellation = false;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id !== undefined && !message.method) return;
  if (message.method === "initialize") return send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: "cached_token", name: "Cached" }] } });
  if (message.method === "authenticate") return send({ id: message.id, result: {} });
  if (message.method === "session/new") {
    sessionId = "fresh-" + Math.random().toString(16).slice(2);
    deferSurface = message.params._meta?.systemPromptOverride === "late surface";
    malformedSurface = message.params._meta?.systemPromptOverride === "malformed surface";
    void (async () => {
      const server = message.params.mcpServers[0];
      fs.writeFileSync(${JSON.stringify(join(directory, "bridge-url"))}, server.url);
      await rpc(server, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "1" } }, 1);
      await rpc(server, "notifications/initialized", {}, undefined);
      const listed = await rpc(server, "tools/list", {}, 2);
      listedTools = listed.tools;
      if (!deferSurface) send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: [], _meta: { tools: malformedSurface ? ["use_tool", { name: 42 }] : ["use_tool"] } } } });
      send({ id: message.id, result: { sessionId, models: { currentModelId: "grok-4.6", availableModels: [{ modelId: "grok-4.6" }] } } });
    })();
    return;
  }
  if (message.method === "session/set_model") {
    fs.writeFileSync(${JSON.stringify(join(directory, "reasoning-effort"))}, message.params._meta?.reasoningEffort || "auto");
    void (async () => {
      while (!listedTools.length) await new Promise((resolve) => setTimeout(resolve, 5));
      send({ id: message.id, result: {} });
    })();
    return;
  }
  if (message.method === "session/prompt") {
    const text = message.params.prompt.find((part) => part.type === "text").text;
    if (text.includes("tool before inventory")) {
      send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "early", title: "Early", status: "pending" } } });
      return;
    }
    if (text.includes("malformed response")) {
      process.stdout.write("{invalid json\\n");
      process.exit(0);
    }
    if (text.includes("early eof")) process.exit(0);
    if (text.includes("ignore cancellation")) {
      heldPrompt = message.id;
      ignoreCancellation = true;
      process.on("SIGTERM", () => undefined);
      setInterval(() => undefined, 1000);
      send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", messageId: "answer", content: { type: "text", text: "partial" } } } });
      return;
    }
    if (text.includes("wait for cancellation")) {
      heldPrompt = message.id;
      send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", messageId: "answer", content: { type: "text", text: "partial" } } } });
      return;
    }
    const reply = text.includes("earlier answer") ? "replayed" : "hello";
    send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_thought_chunk", messageId: "thought", content: { type: "text", text: "considered" } } } });
    send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "observed", title: "Observed", status: "completed" } } });
    send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "usage_update", used: 7, size: 100 } } });
    send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", messageId: "answer", content: { type: "text", text: reply.slice(0, 2) } } } });
    send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", messageId: "answer", content: { type: "text", text: reply.slice(2) } } } });
    send({ id: message.id, result: { stopReason: "end_turn", _meta: { modelId: "grok-4.6", usage: { inputTokens: 100, outputTokens: 10, totalTokens: 115, cachedReadTokens: 3, cacheCreationTokens: 2, reasoningTokens: 4, modelCalls: 1, apiDurationMs: 250, costUsdTicks: 5000000 } } } });
    return;
  }
  if (message.method === "session/cancel" && heldPrompt !== undefined && !ignoreCancellation) {
    send({ id: heldPrompt, result: { stopReason: "cancelled", _meta: { modelId: "grok-4.6" } } });
    heldPrompt = undefined;
  }
});
`,
    { mode: 0o700 },
  );
  chmodSync(path, 0o700);
  return path;
}

function turn(overrides: Partial<HarnessTurnInput> = {}) {
  const entries: SessionEntry[] = [];
  const requests: HarnessLlmRequestRecord[] = [];
  const calls: Array<{ model: string; inputTokens: number; entryCount: number }> = [];
  const deltas: string[] = [];
  const progress: Array<{ toolCalls: number; tokens?: number }> = [];
  let blocks = 0;
  const scope = "org:test" as ScopeId;
  const input: HarnessTurnInput = {
    session: { id: "grok-test" } as HarnessTurnInput["session"],
    input: "say hello",
    systemPrompt: "secret system prompt",
    history: [],
    tools: {} as HarnessTurnInput["tools"],
    scopeLabel: scope,
    orgScopeId: scope,
    grokAuth: { accessToken: "access-only" },
    readOnly: true,
    emit: async (entry: NewEntry) => {
      const saved = {
        ...entry,
        sessionId: "grok-test",
        seq: entries.length + 1,
        createdAt: Date.now(),
      } as SessionEntry;
      entries.push(saved);
      return saved;
    },
    recordModelCall: (record) => calls.push(record),
    recordLlmRequest: (record) => {
      requests.push(record);
    },
    onDelta: (delta) => deltas.push(delta),
    onTextBlockStart: () => blocks++,
    onProgress: (value) => progress.push(value),
    ...overrides,
  };
  return { input, entries, requests, calls, deltas, progress, blocks: () => blocks };
}

test("Grok runs a fresh ACP process and records typed output and usage", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "qm-grok-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const harness = createGrokHarness({
    binaryPath: fakeGrokBinary(directory),
    verifyRuntime: false,
    setupTimeoutMs: 5_000,
  });
  t.after(async () => harness.turns.close?.());
  const observed = turn({ thinkingLevel: "xhigh" });

  const result = await harness.turns.runTurn(observed.input);

  assert.equal(result.reply, "hello");
  assert.equal(result.modelCalls, 1);
  assert.deepEqual(result.cacheUsage, { cacheRead: 3, cacheWrite: 2, uncachedInput: 100 });
  assert.deepEqual(observed.deltas, ["he", "llo"]);
  assert.equal(observed.blocks(), 1);
  assert.deepEqual(observed.progress, [{ toolCalls: 1 }, { toolCalls: 1, tokens: 7 }]);
  assert.deepEqual(
    observed.entries.map((entry) => entry.type),
    ["user", "thinking", "assistant"],
  );
  assert.deepEqual(observed.calls, [{ model: "grok-4.6", inputTokens: 100, entryCount: 0 }]);
  assert.equal(observed.requests.length, 1);
  const request = observed.requests[0]!;
  assert.deepEqual(request.usage, {
    input: 100,
    output: 10,
    cacheRead: 3,
    cacheWrite: 2,
    totalTokens: 115,
    costUsd: 0.0005,
  });
  assert.equal((request.promptEnvelope as { system?: string }).system, "secret system prompt");
  assert.equal(readFileSync(join(directory, "reasoning-effort"), "utf8"), "xhigh");
});

test("Grok reconstructs durable QM history into every fresh session", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "qm-grok-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const harness = createGrokHarness({
    binaryPath: fakeGrokBinary(directory),
    verifyRuntime: false,
    setupTimeoutMs: 5_000,
  });
  t.after(async () => harness.turns.close?.());
  await harness.turns.runTurn(turn({ input: "first turn" }).input);
  const prior: SessionEntry[] = [
    {
      sessionId: "grok-test",
      seq: 1,
      parentSeq: null,
      type: "user",
      payload: { text: "earlier question" },
      scopeLabel: "org:test" as ScopeId,
      createdAt: 1,
    },
    {
      sessionId: "grok-test",
      seq: 2,
      parentSeq: 1,
      type: "assistant",
      payload: { text: "earlier answer" },
      scopeLabel: "org:test" as ScopeId,
      createdAt: 2,
    },
  ];
  const observed = turn({ input: "second turn", history: prior });

  const result = await harness.turns.runTurn(observed.input);

  assert.equal(result.reply, "replayed");
  assert.equal(readFileSync(join(directory, "agent-runs"), "utf8"), "run\nrun\n");
  const request = observed.requests[0]!;
  assert.match(String((request.promptEnvelope as { prompt?: { text?: string } }).prompt?.text), /earlier answer/);
});

test("Grok cancellation returns a stopped turn and removes its process", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "qm-grok-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const harness = createGrokHarness({
    binaryPath: fakeGrokBinary(directory),
    verifyRuntime: false,
    setupTimeoutMs: 5_000,
  });
  t.after(async () => harness.turns.close?.());
  const controller = new AbortController();
  const observed = turn({ input: "wait for cancellation", cancel: controller.signal });
  const pending = harness.turns.runTurn(observed.input);
  const homesBeforeCancel = readdirSync(tmpdir()).filter((name) => name.startsWith(`qm-grok-${process.pid}-`));
  while (!observed.deltas.length) await new Promise((resolve) => setTimeout(resolve, 10));

  controller.abort();
  const result = await pending;

  assert.deepEqual(result, { reply: "", stopped: true });
  assert.deepEqual(
    readdirSync(tmpdir()).filter((name) => name.startsWith(`qm-grok-${process.pid}-`)),
    homesBeforeCancel,
  );
});

test("Grok cancellation kills an unresponsive ACP process and releases all turn resources", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "qm-grok-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const harness = createGrokHarness({
    binaryPath: fakeGrokBinary(directory),
    verifyRuntime: false,
    setupTimeoutMs: 5_000,
    process: { eofGraceMs: 25, termGraceMs: 25, killGraceMs: 500 },
  });
  t.after(async () => harness.turns.close?.());
  const controller = new AbortController();
  const observed = turn({ input: "ignore cancellation", cancel: controller.signal });
  const homesBeforeTurn = readdirSync(tmpdir()).filter((name) => name.startsWith(`qm-grok-${process.pid}-`));
  const pending = harness.turns.runTurn(observed.input);
  while (!observed.deltas.length) await new Promise((resolve) => setTimeout(resolve, 10));
  const agentPid = Number(readFileSync(join(directory, "agent-pid"), "utf8"));
  const bridgeUrl = readFileSync(join(directory, "bridge-url"), "utf8");
  const started = Date.now();

  controller.abort();
  const result = await pending;

  assert.deepEqual(result, { reply: "", stopped: true });
  assert.ok(Date.now() - started < 2_000);
  assert.throws(
    () => process.kill(agentPid, 0),
    (error: NodeJS.ErrnoException) => error.code === "ESRCH",
  );
  await assert.rejects(fetch(bridgeUrl));
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.deepEqual(
    readdirSync(tmpdir()).filter((name) => name.startsWith(`qm-grok-${process.pid}-`)),
    homesBeforeTurn,
  );
});

test("Grok timeout, malformed ACP, and early EOF fail without persistent runtime state", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "qm-grok-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const harness = createGrokHarness({
    binaryPath: fakeGrokBinary(directory),
    verifyRuntime: false,
    setupTimeoutMs: 2_000,
    turnWallClockMs: 50,
  });
  t.after(async () => harness.turns.close?.());

  await assert.rejects(harness.turns.runTurn(turn({ input: "ignore cancellation" }).input), /exceeded/);
  await assert.rejects(harness.turns.runTurn(turn({ input: "malformed response", turnWallClockMs: 2_000 }).input));
  await assert.rejects(harness.turns.runTurn(turn({ input: "early eof", turnWallClockMs: 2_000 }).input));
  await assert.rejects(
    harness.turns.runTurn(
      turn({ input: "tool before inventory", systemPrompt: "late surface", turnWallClockMs: 2_000 }).input,
    ),
    /tool call before tool-surface verification/,
  );
  await assert.rejects(
    harness.turns.runTurn(turn({ systemPrompt: "malformed surface", turnWallClockMs: 2_000 }).input),
    /unexpected tool surface/,
  );
  assert.deepEqual(
    readdirSync(tmpdir()).filter((name) => name.startsWith(`qm-grok-${process.pid}-`)),
    [],
  );
});

test("Grok subscription auth is required per turn", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "qm-grok-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const harness = createGrokHarness({ binaryPath: fakeGrokBinary(directory), verifyRuntime: false });
  t.after(async () => harness.turns.close?.());
  const observed = turn({ grokAuth: undefined });

  await assert.rejects(harness.turns.runTurn(observed.input), /Connect a Grok subscription/);
});

test("Grok runtime verification runs for a configured Grok harness and stays lazy otherwise", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "qm-grok-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const missing = join(directory, "missing-grok");
  const dynamic = grokHarnessConfigOptions({
    production: false,
    harness: "pi",
    grokProcessEnv: {},
    turnWallClockMs: 0,
  } as Parameters<typeof grokHarnessConfigOptions>[0]);
  const configured = grokHarnessConfigOptions({
    production: false,
    harness: "grok",
    grokLauncherPath: "/tmp/grok-launcher",
    grokProcessEnv: {},
    turnWallClockMs: 0,
  } as Parameters<typeof grokHarnessConfigOptions>[0]);
  const production = grokHarnessConfigOptions({
    production: true,
    harness: "pi",
    grokProcessEnv: {},
    turnWallClockMs: 0,
  } as Parameters<typeof grokHarnessConfigOptions>[0]);

  assert.equal(dynamic.verifyOnCreate, false);
  assert.equal(configured.verifyOnCreate, true);
  assert.equal(configured.process?.launcherPath, "/tmp/grok-launcher");
  assert.equal(production.verifyOnCreate, false);
  assert.doesNotThrow(() => createGrokHarness({ ...dynamic, binaryPath: missing }));
  assert.throws(() => createGrokHarness({ ...configured, binaryPath: missing }));
  assert.doesNotThrow(() => createGrokHarness({ ...production, binaryPath: missing }));
});
