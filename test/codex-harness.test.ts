import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import {
  codexChildEnv,
  codexNonRetryable,
  codexProviderFailure,
  codexUsageTotals,
  codexChildToolAllowed,
  codexReasoningEffort,
  codexReplayCallId,
  codexTaskTitle,
  codexTokenUsageUpdate,
  codexToolContext,
  codexTurnInputText,
  createCodexHarness,
  prepareCodexHome,
} from "../src/harness/codex-harness.ts";
import type { HarnessLlmRequestRecord, HarnessTurnInput } from "../src/harness/harness.ts";
import { NonRetryableTurnError } from "../src/core/turn-error.ts";
import type { ScopeId, Session, SessionEntry } from "../src/types.ts";
import { createMemoryTaskStore } from "../src/tasks/memory-task-store.ts";
import { CodexAppServer } from "../src/harness/codex-app-server.ts";
import { DEFAULT_CODEX_MODEL_ID } from "../src/model/pi-models.ts";

const replaySmokeItems = [
  { type: "message", role: "user", content: [{ type: "input_text", text: "earlier question" }] },
  { type: "message", role: "assistant", content: [{ type: "output_text", text: "earlier answer" }] },
  { type: "function_call", call_id: "call-1", name: "execute", arguments: JSON.stringify({ command: "true" }) },
  { type: "function_call_output", call_id: "call-1", output: "[exit 0]" },
];

test("Codex replay keeps paired tool ids within the provider's 64-character limit", () => {
  const longId = "tool-call-".repeat(9);
  const normalized = codexReplayCallId(longId);
  assert.equal(normalized.length, 64);
  assert.equal(codexReplayCallId(longId), normalized);
  assert.equal(codexReplayCallId("short-id"), "short-id");
});

function fakeCodexBinary(dir: string): string {
  const path = join(dir, "fake-codex");
  writeFileSync(
    path,
    `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ id: msg.id, result: { userAgent: "fake" } });
  if (msg.method === "initialized") return;
  if (msg.method === "thread/start") {
    if (msg.params.sandbox !== "read-only" || msg.params.approvalPolicy !== "never" || !Array.isArray(msg.params.dynamicTools) ||
        !Array.isArray(msg.params.environments) || msg.params.environments.length !== 0 ||
        msg.params.config?.features?.shell_tool !== false || msg.params.config?.features?.unified_exec !== false ||
        process.env.CORE_SIGNING_SECRET || process.env.DATABASE_URL || process.env.HOME !== msg.params.cwd ||
        !process.env.CODEX_HOME?.startsWith(msg.params.cwd)) {
      return send({ id: msg.id, error: { code: -1, message: "unsafe or missing adapter settings" } });
    }
    return send({ id: msg.id, result: { thread: { id: "thread-1" }, model: "fake-model" } });
  }
  if (msg.method === "thread/inject_items") return send({ id: msg.id, result: {} });
  if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-1", status: "inProgress", items: [] } } });
    send({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", tokenUsage: { total: { inputTokens: 100 }, last: { inputTokens: 100 } } } });
    send({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", tokenUsage: { total: { inputTokens: 100 }, last: { inputTokens: 100 } } } });
    send({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "collabAgentToolCall", id: "collab-1", tool: "spawnAgent", status: "inProgress", senderThreadId: "thread-1", receiverThreadIds: ["child-1"], prompt: "return ALPHA", agentsStates: { "child-1": { status: "running", message: null } } } } });
    send({ method: "thread/tokenUsage/updated", params: { threadId: "child-1", tokenUsage: { total: { inputTokens: 70 }, last: { inputTokens: 70 } } } });
    send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "collabAgentToolCall", id: "collab-1", tool: "spawnAgent", status: "completed", senderThreadId: "thread-1", receiverThreadIds: ["child-1"], prompt: "return ALPHA", agentsStates: { "child-1": { status: "completed", message: "ALPHA" } } } } });
    send({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", tokenUsage: { total: { inputTokens: 250 }, last: { inputTokens: 150 } } } });
    send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "hello" } });
    send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", id: "item-1", text: "hello", phase: "final_answer", memoryCitation: null } } });
    return send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [], itemsView: "notLoaded" } } });
  }
  if (msg.method === "turn/interrupt" || msg.method === "turn/steer") return send({ id: msg.id, result: {} });
});
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function terminatingCodexBinary(dir: string): string {
  const path = join(dir, "terminating-codex");
  writeFileSync(
    path,
    `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let lateTool;
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ id: msg.id, result: {} });
  if (msg.method === "initialized") return;
  if (msg.method === "thread/start") return send({ id: msg.id, result: { thread: { id: "thread-stop" } } });
  if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-stop", status: "inProgress", items: [] } } });
    return send({ id: "finish-call", method: "item/tool/call", params: { threadId: "thread-stop", turnId: "turn-stop", callId: "finish-1", tool: "finish_silently", arguments: { reason: "nothing new" } } });
  }
  if (msg.id === "finish-call" && msg.result) {
    lateTool = setTimeout(() => send({ id: "late-call", method: "item/tool/call", params: { threadId: "thread-stop", turnId: "turn-stop", callId: "late-1", tool: "history", arguments: { query: "must not run" } } }), 25);
    return;
  }
  if (msg.id === "late-call" && msg.result) {
    return send({ method: "turn/completed", params: { threadId: "thread-stop", turn: { id: "turn-stop", status: "completed", items: [{ type: "agentMessage", text: "BAD", phase: "final_answer" }] } } });
  }
  if (msg.method === "turn/interrupt") {
    clearTimeout(lateTool);
    send({ id: msg.id, result: {} });
    return send({ method: "turn/completed", params: { threadId: "thread-stop", turn: { id: "turn-stop", status: "interrupted", items: [] } } });
  }
});
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function concurrentCodexBinary(dir: string): string {
  const path = join(dir, "concurrent-codex");
  writeFileSync(
    path,
    `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let starts = 0;
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ id: msg.id, result: {} });
  if (msg.method === "initialized") return;
  if (msg.method === "thread/start") {
    starts++;
    if (starts === 1) return send({ id: msg.id, result: { thread: { id: "thread-live" } } });
    return;
  }
  if (msg.method === "turn/start" && msg.params.threadId === "thread-live") {
    send({ id: msg.id, result: { turn: { id: "turn-live", status: "inProgress", items: [] } } });
    return setTimeout(() => send({ method: "turn/completed", params: { threadId: "thread-live", turn: { id: "turn-live", status: "completed", items: [{ type: "agentMessage", text: "FIRST-OK", phase: "final_answer" }] } } }), 250);
  }
});
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function nonresponsiveCodexBinary(dir: string): string {
  const path = join(dir, "nonresponsive-codex");
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(join(dir, "starts"))}, "start\\n");
process.stdin.resume();
`,
  );
  chmodSync(path, 0o755);
  return path;
}

test("Codex forwards external-content screening into its native tool bridge", () => {
  const screenExternalContent: NonNullable<HarnessTurnInput["screenExternalContent"]> = async () => ({
    decision: "auto",
  });
  const ref = codexToolContext({ screenExternalContent } as HarnessTurnInput);
  assert.equal(ref.screenExternalContent, screenExternalContent);
});

test("Codex harness drives app-server JSON-RPC with a read-only jail", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-test-"));
  const tasks = createMemoryTaskStore();
  const harness = createCodexHarness({ binaryPath: fakeCodexBinary(dir), env: process.env, tasks });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  const entries: SessionEntry[] = [];
  const deltas: string[] = [];
  const modelCalls: number[] = [];
  const scope = { kind: "org", id: "test" } as unknown as ScopeId;
  const session = { id: "session-1" } as Session;
  const result = await harness.turns.runTurn({
    session,
    input: "hi",
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
    recordModelCall: ({ inputTokens }) => modelCalls.push(inputTokens),
    onDelta: (delta) => deltas.push(delta),
  });

  assert.equal(result.reply, "hello");
  assert.deepEqual(deltas, ["hello"]);
  assert.deepEqual(modelCalls, [100, 70, 150]);
  assert.deepEqual(
    entries.map((entry) => entry.type),
    ["user", "tool_call", "tool_result", "assistant"],
  );
  assert.deepEqual(
    (await tasks.list()).map(({ title, status }) => ({ title, status })),
    [{ title: "return ALPHA", status: "completed" }],
  );
});

test("Codex task titles stay concise when the provider includes the parent request", () => {
  assert.equal(
    codexTaskTitle("The user asked for two workers. You are the WEST subagent. Return a useful summary."),
    "WEST subagent",
  );
  assert.equal(codexTaskTitle("Return ALPHA"), "Return ALPHA");
});

test("Codex maps the web effort control to native reasoning effort", () => {
  assert.equal(codexReasoningEffort("low"), "low");
  assert.equal(codexReasoningEffort("xhigh"), "xhigh");
  assert.equal(codexReasoningEffort("off"), undefined);
});

test("Codex reads cumulative app-server token usage without double-counting updates", () => {
  const first = codexTokenUsageUpdate({ tokenUsage: { total: { inputTokens: 120 }, last: { inputTokens: 120 } } });
  assert.deepEqual(first, { inputTokens: 120, totalInputTokens: 120 });
  assert.equal(
    codexTokenUsageUpdate({ tokenUsage: { total: { inputTokens: 120 }, last: { inputTokens: 120 } } }, 120),
    null,
  );
  assert.deepEqual(
    codexTokenUsageUpdate({ tokenUsage: { total: { inputTokens: 275 }, last: { inputTokens: 155 } } }, 120),
    { inputTokens: 155, totalInputTokens: 275 },
  );
});

test("Codex seeds prior surface turns when the durable log is empty", () => {
  const text = codexTurnInputText({
    history: [],
    priorTurns: [
      { role: "user", text: "Earlier question", name: "Alice" },
      { role: "assistant", text: "Earlier answer" },
    ],
    input: "Current question",
    environment: "Current environment",
  });
  assert.match(text, /<message from="human" author="Alice">Earlier question<\/message>/);
  assert.match(text, /<message from="agent">Earlier answer<\/message>/);
  assert.match(text, /Current question\n\nCurrent environment$/);
  assert.equal(
    codexTurnInputText({
      history: [{ type: "user" } as SessionEntry],
      priorTurns: [{ role: "user", text: "duplicate" }],
      input: "current",
    }),
    "current",
  );
});

test("Codex child environment excludes core credentials and user homes", () => {
  const env = codexChildEnv(
    {
      PATH: "/bin",
      HOME: "/Users/private",
      CODEX_HOME: "/Users/private/.codex",
      CORE_SIGNING_SECRET: "signing-secret",
      DATABASE_URL: "postgres://secret",
      ANTHROPIC_API_KEY: "anthropic-secret",
      OPENAI_API_KEY: "openai-needed-by-provider",
      CODEX_ACCESS_TOKEN: "codex-access-token",
    },
    "/tmp/control-jail",
  );

  assert.deepEqual(env, {
    PATH: "/bin",
    HOME: "/tmp/control-jail",
    CODEX_HOME: "/tmp/control-jail/codex-home",
    OPENAI_API_KEY: "openai-needed-by-provider",
    CODEX_ACCESS_TOKEN: "codex-access-token",
  });
});

test("Codex materializes API-key auth into its isolated home, and never an ambient login", (t) => {
  const jail = mkdtempSync(join(tmpdir(), "qm-codex-auth-test-"));
  t.after(() => rmSync(jail, { recursive: true, force: true }));
  const home = prepareCodexHome({ OPENAI_API_KEY: "sk-test" }, jail);
  assert.deepEqual(JSON.parse(readFileSync(join(home, "auth.json"), "utf8")), {
    auth_mode: "apikey",
    OPENAI_API_KEY: "sk-test",
  });

  const bare = mkdtempSync(join(tmpdir(), "qm-codex-auth-bare-"));
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  assert.equal(existsSync(join(prepareCodexHome({ HOME: homedir() }, bare), "auth.json")), false);
});

test("Codex children cannot use parent surface, control, or terminal tools", () => {
  assert.equal(codexChildToolAllowed("history"), true);
  assert.equal(codexChildToolAllowed("execute"), true);
  for (const denied of ["slack", "cron", "guidance", "share", "stay_silent", "finish_silently"]) {
    assert.equal(codexChildToolAllowed(denied), false, denied);
  }
});

test("Codex interrupts the provider after a terminal QM tool", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-stop-test-"));
  const harness = createCodexHarness({
    binaryPath: terminatingCodexBinary(dir),
    env: process.env,
    turnWallClockMs: 2_000,
  });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  const entries: SessionEntry[] = [];
  const scope = { kind: "org", id: "test" } as unknown as ScopeId;
  const result = await harness.turns.runTurn({
    session: { id: "terminal-tool" } as Session,
    input: "poll",
    systemPrompt: "finish silently",
    history: [],
    tools: {} as HarnessTurnInput["tools"],
    scopeLabel: scope,
    orgScopeId: scope,
    pollFire: true,
    emit: async (entry) => {
      const saved = {
        ...entry,
        sessionId: "terminal-tool",
        seq: entries.length + 1,
        createdAt: Date.now(),
      } as SessionEntry;
      entries.push(saved);
      return saved;
    },
    recordModelCall: () => {},
  });

  assert.equal(result.silent, true);
  assert.notEqual(result.reply, "BAD");
  assert.equal(
    entries.some((entry) => entry.type === "assistant"),
    false,
  );
});

test("Codex spawn failure does not hang run or cleanup", async () => {
  const harness = createCodexHarness({ binaryPath: "/definitely/missing/qm-codex" });
  const scope = { kind: "org", id: "test" } as unknown as ScopeId;
  const turn = harness.turns.runTurn({
    session: { id: "missing-binary" } as Session,
    input: "hi",
    systemPrompt: "be concise",
    history: [],
    tools: {} as HarnessTurnInput["tools"],
    scopeLabel: scope,
    orgScopeId: scope,
    emit: async (entry) => ({ ...entry, sessionId: "missing-binary", seq: 1, createdAt: Date.now() }) as SessionEntry,
    recordModelCall: () => {},
  });
  await assert.rejects(
    Promise.race([turn, new Promise((_, reject) => setTimeout(() => reject(new Error("run hung")), 2_000))]),
    /ENOENT|spawn/,
  );
  await Promise.race([
    harness.turns.close?.(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("close hung")), 2_000)),
  ]);
});

test("Codex discards a nonresponsive startup so a later turn can retry", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-startup-test-"));
  const harness = createCodexHarness({
    binaryPath: nonresponsiveCodexBinary(dir),
    env: process.env,
    appServerStartTimeoutMs: 1_000,
    turnWallClockMs: 6_000,
  });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  const scope = { kind: "org", id: "test" } as unknown as ScopeId;
  const turn = (id: string) =>
    harness.turns.runTurn({
      session: { id } as Session,
      input: "hi",
      systemPrompt: "be concise",
      history: [],
      tools: {} as HarnessTurnInput["tools"],
      scopeLabel: scope,
      orgScopeId: scope,
      emit: async (entry) => ({ ...entry, sessionId: id, seq: 1, createdAt: Date.now() }) as SessionEntry,
      recordModelCall: () => {},
    });

  await assert.rejects(turn("first"), /initialization timed out/);
  await assert.rejects(turn("second"), /initialization timed out/);
  assert.equal(readFileSync(join(dir, "starts"), "utf8"), "start\nstart\n");
});

test("cancelling one Codex setup does not kill another active turn", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-concurrent-test-"));
  const harness = createCodexHarness({
    binaryPath: concurrentCodexBinary(dir),
    env: process.env,
    turnWallClockMs: 2_000,
  });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  const scope = { kind: "org", id: "test" } as unknown as ScopeId;
  const makeTurn = (id: string, cancel?: AbortSignal): HarnessTurnInput => ({
    session: { id } as Session,
    input: id,
    systemPrompt: "be concise",
    history: [],
    tools: {} as HarnessTurnInput["tools"],
    scopeLabel: scope,
    orgScopeId: scope,
    ...(cancel ? { cancel } : {}),
    emit: async (entry) => ({ ...entry, sessionId: id, seq: 1, createdAt: Date.now() }) as SessionEntry,
    recordModelCall: () => {},
  });

  const first = harness.turns.runTurn(makeTurn("first"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const controller = new AbortController();
  const second = harness.turns.runTurn(makeTurn("second", controller.signal));
  setTimeout(() => controller.abort(), 50);

  assert.deepEqual(await second, { reply: "", stopped: true });
  assert.equal((await first).reply, "FIRST-OK");
});

test("Codex classifies deterministic provider failures as terminal and leaves transient ones retryable", () => {
  const terminal = [
    "Codex 401: Incorrect API key provided",
    "Codex app-server exited (1): stream error: unauthorized",
    "You exceeded your current quota, please check your plan and billing details",
    "The model `gpt-5.6-sol` does not exist or you do not have access to it",
    "Not logged in. Run `codex login` to authenticate.",
    "Codex -32000: invalid_api_key",
    "403 Forbidden",
    "HTTP 402 Payment Required",
    "Your organization must be verified to stream this model",
    "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
    "You've reached your workspace credit limit",
    "Your workspace is out of credits. Ask your workspace owner to add more.",
    "workspace_owner_credits_depleted",
  ];
  for (const message of terminal) {
    assert.equal(codexNonRetryable(message), true, message);
    assert.ok(codexProviderFailure(message) instanceof NonRetryableTurnError, message);
  }

  const transient = [
    "Rate limit reached for gpt-5.6-sol, please retry",
    "429 Too Many Requests",
    "The server had an error while processing your request",
    "socket hang up",
    "Codex app-server exited (null): ECONNRESET",
    "Codex turn failed",
    "rate_limit_reached",
    "You've hit your usage limit for gpt-5.6-sol",
    "workspace_member_usage_limit_reached",
    "407 Proxy Authentication Required",
  ];
  for (const message of transient) {
    assert.equal(codexNonRetryable(message), false, message);
    assert.ok(!(codexProviderFailure(message) instanceof NonRetryableTurnError), message);
  }
});

test("Codex never classifies its own infrastructure failures as terminal", () => {
  const ours = [
    "permission denied for table session_entries",
    "EACCES: permission denied, open '/data/tape/x.jsonl'",
    "Codex app-server exited (1): thread panicked at src/client.rs:403:9",
    "Codex app-server exited (1): WARN retrying request: 401 Unauthorized (attempt 1); INFO recovered",
    "connect ECONNREFUSED 127.0.0.1:403",
  ];
  for (const message of ours) {
    assert.ok(codexProviderFailure(message) instanceof Error, message);
  }
  assert.equal(codexProviderFailure("Codex turn failed").message, "Codex turn failed");
  assert.ok(!(codexProviderFailure("socket hang up") instanceof NonRetryableTurnError));
});

test("Codex reads cumulative usage totals off the app-server's token notification", () => {
  assert.deepEqual(
    codexUsageTotals({
      tokenUsage: { total: { inputTokens: 400, outputTokens: 90, cachedInputTokens: 120 }, last: { inputTokens: 40 } },
    }),
    { input: 400, output: 90, cacheRead: 120, cacheWrite: 0, totalTokens: 490, costUsd: 0 },
  );
  assert.equal(codexUsageTotals({ tokenUsage: { last: { inputTokens: 40 } } }), null);
  assert.equal(codexUsageTotals(null), null);
});

function failingProviderCodexBinary(dir: string, mode: "turnFailed" | "startRejected"): string {
  const path = join(dir, `failing-codex-${mode}`);
  writeFileSync(
    path,
    `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ id: msg.id, result: {} });
  if (msg.method === "initialized") return;
  if (msg.method === "thread/start") return send({ id: msg.id, result: { thread: { id: "thread-fail" } } });
  if (msg.method === "turn/start") {
    ${
      mode === "startRejected"
        ? `return send({ id: msg.id, error: { code: 401, message: "Incorrect API key provided" } });`
        : `send({ id: msg.id, result: { turn: { id: "turn-fail", status: "inProgress", items: [] } } });
    return send({ method: "turn/completed", params: { threadId: "thread-fail", turn: { id: "turn-fail", status: "failed", error: { message: "You exceeded your current quota" }, items: [] } } });`
    }
  }
  if (msg.method === "turn/interrupt") return send({ id: msg.id, result: {} });
});
`,
  );
  chmodSync(path, 0o755);
  return path;
}

for (const mode of ["turnFailed", "startRejected"] as const) {
  test(`Codex parks the run on a provider auth/quota failure (${mode}) instead of burning retries`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "qm-codex-fail-test-"));
    const harness = createCodexHarness({
      binaryPath: failingProviderCodexBinary(dir, mode),
      env: process.env,
      turnWallClockMs: 5_000,
    });
    t.after(async () => {
      await harness.turns.close?.();
      rmSync(dir, { recursive: true, force: true });
    });
    const scope = { kind: "org", id: "test" } as unknown as ScopeId;
    await assert.rejects(
      harness.turns.runTurn({
        session: { id: "fail-session" } as Session,
        input: "hi",
        systemPrompt: "be concise",
        history: [],
        tools: {} as HarnessTurnInput["tools"],
        scopeLabel: scope,
        orgScopeId: scope,
        emit: async (entry) => ({ ...entry, sessionId: "fail-session", seq: 1, createdAt: Date.now() }) as SessionEntry,
        recordModelCall: () => {},
      }),
      (error: unknown) => error instanceof NonRetryableTurnError,
    );
  });
}

test("Codex records one llm row per turn carrying real timings and usage, even when the turn fails", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-telemetry-test-"));
  const records: HarnessLlmRequestRecord[] = [];
  const scope = { kind: "org", id: "test" } as unknown as ScopeId;
  const runWith = async (binaryPath: string, id: string) => {
    const harness = createCodexHarness({ binaryPath, env: process.env, turnWallClockMs: 5_000 });
    t.after(async () => await harness.turns.close?.());
    return await harness.turns.runTurn({
      session: { id } as Session,
      input: "hi",
      systemPrompt: "be concise",
      history: [],
      tools: {} as HarnessTurnInput["tools"],
      scopeLabel: scope,
      orgScopeId: scope,
      emit: async (entry) => ({ ...entry, sessionId: id, seq: 4, createdAt: Date.now() }) as SessionEntry,
      recordModelCall: () => {},
      recordLlmRequest: (rec) => void records.push(rec),
    });
  };
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  await runWith(fakeCodexBinary(dir), "telemetry-ok");
  assert.equal(records.length, 1);
  const ok = records[0]!;
  assert.equal(ok.turnSeq, 4);
  assert.equal(ok.step, 0);
  assert.equal(ok.truncated, false);
  assert.ok(typeof ok.durationMs === "number" && ok.durationMs >= 0);
  assert.ok(typeof ok.ttftMs === "number" && ok.ttftMs >= 0);
  assert.deepEqual(ok.usage, { input: 320, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 320, costUsd: 0 });

  await assert.rejects(runWith(failingProviderCodexBinary(dir, "turnFailed"), "telemetry-fail"));
  assert.equal(records.length, 2);
  assert.ok(typeof records[1]!.durationMs === "number");
});

const realCodexBinary = (() => {
  try {
    return join(dirname(createRequire(import.meta.url).resolve("@openai/codex/package.json")), "bin/codex.js");
  } catch {
    return null;
  }
})();

test(
  "the installed Codex app-server accepts the exact thread/start this adapter sends",
  { skip: realCodexBinary && existsSync(realCodexBinary) ? false : "@openai/codex is not resolvable" },
  async (t) => {
    const jail = mkdtempSync(join(tmpdir(), "qm-codex-real-"));
    prepareCodexHome({ CODEX_HOME: join(jail, "empty-source") }, jail);
    const requests: string[] = [];
    const server = new CodexAppServer({
      binaryPath: realCodexBinary!,
      cwd: jail,
      env: codexChildEnv({ PATH: process.env.PATH }, jail),
      onNotification: () => {},
      onRequest: async (method) => {
        requests.push(method);
        throw new Error("unexpected request");
      },
    });
    t.after(async () => {
      await server.close();
      rmSync(jail, { recursive: true, force: true });
    });

    await server.initialize();
    const started = await server.request<{ thread: { id: string } }>("thread/start", {
      model: DEFAULT_CODEX_MODEL_ID,
      cwd: jail,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      baseInstructions: "be concise",
      developerInstructions: "use the supplied dynamic tools",
      dynamicTools: [
        {
          type: "function",
          name: "execute",
          description: "run a command",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      experimentalRawEvents: true,
      environments: [],
      config: {
        web_search: "disabled",
        features: {
          shell_tool: false,
          unified_exec: false,
          shell_snapshot: false,
          apps: false,
          plugins: false,
          browser_use: false,
          browser_use_external: false,
          computer_use: false,
          image_generation: false,
          in_app_browser: false,
          multi_agent: true,
          request_permissions_tool: false,
          tool_suggest: false,
        },
      },
    });
    assert.ok(started.thread.id, "the real app-server returned a thread id for our start shape");
    await server.request("thread/inject_items", {
      threadId: started.thread.id,
      items: replaySmokeItems,
    });
    assert.deepEqual(requests, []);
  },
);
