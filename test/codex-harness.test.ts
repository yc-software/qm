import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
import { CodexAppServer, redactCodexDiagnostics } from "../src/harness/codex-app-server.ts";
import { DEFAULT_CODEX_MODEL_ID } from "../src/model/pi-models.ts";
import { readCodexOAuthAuthFile } from "../src/harness/codex-auth.ts";
import { acquireCodexOAuthAuthLock } from "../src/harness/codex-auth.ts";

const replaySmokeItems = [
  { type: "message", role: "user", content: [{ type: "input_text", text: "earlier question" }] },
  { type: "message", role: "assistant", content: [{ type: "output_text", text: "earlier answer" }] },
  { type: "function_call", call_id: "call-1", name: "execute", arguments: JSON.stringify({ command: "true" }) },
  { type: "function_call_output", call_id: "call-1", output: "[exit 0]" },
];

function testHarnessEnv(home: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home, CODEX_HOME: join(home, "codex-home") };
}

function oauthIdToken(accountId: string, marker = ""): string {
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId }, marker }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

function oauthAccessToken(accountId: string, marker = "access"): string {
  return oauthIdToken(accountId, marker);
}

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

function startupCancellationCodexBinary(dir: string): string {
  const path = join(dir, "startup-cancellation-codex");
  writeFileSync(
    path,
    `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(join(dir, "starts"))}, "start\\n");
process.on("SIGTERM", () => {
  fs.writeFileSync(${JSON.stringify(join(dir, "closed"))}, "closed");
  process.exit(0);
});
process.stdin.resume();
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function pendingTurnStartCodexBinary(dir: string): string {
  const path = join(dir, "pending-turn-start-codex");
  writeFileSync(
    path,
    `#!${process.execPath}
const fs = require("node:fs");
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ id: msg.id, result: {} });
  if (msg.method === "initialized") return;
  if (msg.method === "thread/start") return send({ id: msg.id, result: { thread: { id: "thread-pending" } } });
  if (msg.method === "turn/start") fs.writeFileSync(${JSON.stringify(join(dir, "turn-started"))}, "started");
});
process.on("SIGTERM", () => {
  fs.writeFileSync(${JSON.stringify(join(dir, "closed"))}, "closed");
  process.exit(0);
});
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function refreshThenNonresponsiveCodexBinary(dir: string): string {
  const path = join(dir, "refresh-then-nonresponsive-codex");
  const accessToken = oauthAccessToken("startup-account", "startup-after");
  writeFileSync(
    path,
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const authPath = path.join(process.env.CODEX_HOME, "auth.json");
const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
auth.tokens.access_token = ${JSON.stringify(accessToken)};
fs.writeFileSync(authPath, JSON.stringify(auth));
process.stdin.resume();
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function malformedCodexBinary(dir: string): string {
  const path = join(dir, "malformed-codex");
  writeFileSync(
    path,
    `#!${process.execPath}
process.stdout.write('{"access_token":"oauth-secret-123456789"\\n');
process.stdin.resume();
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function incompleteResponseCodexBinary(dir: string): string {
  const path = join(dir, "incomplete-response-codex");
  writeFileSync(
    path,
    `#!${process.execPath}
process.stdout.write('{"id":1}\\n');
process.stdin.resume();
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function arrayMessageCodexBinary(dir: string): string {
  const path = join(dir, "array-message-codex");
  writeFileSync(
    path,
    `#!${process.execPath}
process.stdout.write('[]\\n');
process.stdin.resume();
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function invalidJsonRpcBinary(dir: string): string {
  const path = join(dir, "invalid-json-rpc-codex");
  writeFileSync(
    path,
    `#!${process.execPath}
process.stdout.write('{"id":true,"result":{}}\\n');
process.stdin.resume();
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function noIdResponseCodexBinary(dir: string): string {
  const path = join(dir, "no-id-response-codex");
  writeFileSync(
    path,
    `#!${process.execPath}
process.stdout.write('{"result":{}}\\n');
process.stdin.resume();
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function unknownResponseCodexBinary(dir: string): string {
  const path = join(dir, "unknown-response-codex");
  writeFileSync(
    path,
    `#!${process.execPath}
process.stdout.write('{"id":999,"result":{}}\\n');
process.stdin.resume();
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function malformedTurnCompletedCodexBinary(dir: string): string {
  const path = join(dir, "malformed-turn-completed-codex");
  writeFileSync(
    path,
    `#!${process.execPath}
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", line => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ id: msg.id, result: {} });
  if (msg.method === "initialized") return;
  if (msg.method === "thread/start") return send({ id: msg.id, result: { thread: { id: "malformed-thread" } } });
  if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "malformed-turn", status: "inProgress", items: [] } } });
    return send({ method: "turn/completed", params: { threadId: "malformed-thread", turn: {} } });
  }
});
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function oauthTurnBinary(dir: string, token: string, delayMs: number): string {
  const path = join(dir, `oauth-${token}`);
  const events = join(dir, "oauth-events");
  const accessToken = oauthAccessToken("shared-account", token);
  writeFileSync(
    path,
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const authPath = path.join(process.env.CODEX_HOME, "auth.json");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ id: msg.id, result: {} });
  if (msg.method === "initialized") return;
  if (msg.method === "thread/start") return send({ id: msg.id, result: { thread: { id: "thread-${token}" } } });
  if (msg.method === "turn/start") {
    const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
    auth.tokens.access_token = ${JSON.stringify(accessToken)};
    fs.writeFileSync(authPath, JSON.stringify(auth));
    fs.appendFileSync(${JSON.stringify(events)}, ${JSON.stringify(`${token}\n`)});
    send({ id: msg.id, result: { turn: { id: "turn-${token}", status: "inProgress", items: [] } } });
    return setTimeout(() => send({ method: "turn/completed", params: { threadId: "thread-${token}", turn: { id: "turn-${token}", status: "completed", items: [{ type: "agentMessage", text: ${JSON.stringify(token)}, phase: "final_answer" }] } } }), ${delayMs});
  }
  if (msg.method === "turn/interrupt") return send({ id: msg.id, result: {} });
});
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function accountEchoCodexBinary(dir: string, name: string, delayMs = 1): string {
  const path = join(dir, `account-echo-${name}`);
  writeFileSync(
    path,
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const authPath = path.join(process.env.CODEX_HOME, "auth.json");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ id: msg.id, result: {} });
  if (msg.method === "initialized") return;
  if (msg.method === "thread/start") return send({ id: msg.id, result: { thread: { id: "thread-" + process.pid } } });
  if (msg.method === "turn/start") {
    const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
    const reply = String(auth.tokens.account_id ?? "none") + ":" + String("refresh_token" in auth.tokens);
    send({ id: msg.id, result: { turn: { id: "turn-" + process.pid, status: "inProgress", items: [] } } });
    return setTimeout(() => send({ method: "turn/completed", params: { threadId: "thread-" + process.pid, turn: { id: "turn-" + process.pid, status: "completed", items: [{ type: "agentMessage", text: reply, phase: "final_answer" }] } } }), ${delayMs});
  }
  if (msg.method === "turn/interrupt") return send({ id: msg.id, result: {} });
});
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function exitingCodexBinary(dir: string): string {
  const path = join(dir, "exiting-codex");
  writeFileSync(
    path,
    `#!${process.execPath}
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ id: msg.id, result: {} });
  if (msg.method === "initialized") return;
  if (msg.method === "thread/start") return send({ id: msg.id, result: { thread: { id: "thread-exit" } } });
  if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-exit", status: "inProgress", items: [] } } });
    setTimeout(() => process.exit(17), 50);
  }
});
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
  const harness = createCodexHarness({ binaryPath: fakeCodexBinary(dir), env: testHarnessEnv(dir), tasks });
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
  const home = prepareCodexHome({ CODEX_HOME: join(jail, "empty-source"), OPENAI_API_KEY: "sk-test" }, jail);
  assert.deepEqual(JSON.parse(readFileSync(join(home, "auth.json"), "utf8")), {
    auth_mode: "apikey",
    OPENAI_API_KEY: "sk-test",
  });

  const bare = mkdtempSync(join(tmpdir(), "qm-codex-auth-bare-"));
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  assert.equal(
    existsSync(join(prepareCodexHome({ CODEX_HOME: join(bare, "empty-source") }, bare), "auth.json")),
    false,
  );
});

test("Codex materializes ChatGPT OAuth auth as ephemeral child material without the refresh token", async (t) => {
  const source = mkdtempSync(join(tmpdir(), "qm-codex-oauth-source-"));
  const jail = mkdtempSync(join(tmpdir(), "qm-codex-oauth-jail-"));
  t.after(() => {
    rmSync(source, { recursive: true, force: true });
    rmSync(jail, { recursive: true, force: true });
  });
  const authFile = join(source, "auth.json");
  writeFileSync(
    authFile,
    JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: "ambient-api-key",
      tokens: {
        access_token: oauthAccessToken("account-before", "before"),
        refresh_token: "refresh-before",
        account_id: "account-before",
        id_token: oauthIdToken("account-before"),
      },
    }),
  );
  chmodSync(authFile, 0o600);
  const sourceEnv = {
    CODEX_AUTH_FILE: authFile,
    OPENAI_API_KEY: "ambient-api-key",
    OPENAI_BASE_URL: "https://untrusted.example/v1",
    CODEX_ACCESS_TOKEN: "ambient-codex-token",
  };
  assert.deepEqual(codexChildEnv(sourceEnv, jail), {
    HOME: jail,
    CODEX_HOME: join(jail, "codex-home"),
  });
  const home = prepareCodexHome(sourceEnv, jail);
  const childAuthFile = join(home, "auth.json");
  const childAuth = JSON.parse(readFileSync(childAuthFile, "utf8")) as Record<string, unknown>;
  assert.equal(childAuth.OPENAI_API_KEY, undefined);
  assert.equal(
    (childAuth.tokens as Record<string, unknown>).access_token,
    oauthAccessToken("account-before", "before"),
  );
  assert.equal((childAuth.tokens as Record<string, unknown>).account_id, "account-before");
  // The child never receives the long-lived credential: only the store refreshes.
  assert.equal((childAuth.tokens as Record<string, unknown>).refresh_token, undefined);
  // Nothing a child writes ever flows back to the source of truth.
  writeFileSync(
    childAuthFile,
    JSON.stringify({
      ...childAuth,
      tokens: {
        access_token: oauthAccessToken("account-before", "after"),
        refresh_token: "refresh-forged",
        account_id: "account-before",
        id_token: oauthIdToken("account-before"),
      },
    }),
  );
  const persisted = JSON.parse(readFileSync(authFile, "utf8")) as Record<string, unknown>;
  assert.equal((persisted.tokens as Record<string, unknown>).refresh_token, "refresh-before");
  assert.equal(
    (persisted.tokens as Record<string, unknown>).access_token,
    oauthAccessToken("account-before", "before"),
  );
  // A stale lock left behind by a dead process is recovered, not honored forever.
  const liveLock = `${authFile}.lock`;
  writeFileSync(liveLock, String(process.pid));
  utimesSync(liveLock, new Date(0), new Date(0));
  const recoveredLock = await acquireCodexOAuthAuthLock(authFile, undefined, 1_000);
  assert.equal(recoveredLock.isHeld(), true);
  await recoveredLock.release();
  assert.equal(existsSync(liveLock), false);

  const defaultSource = mkdtempSync(join(tmpdir(), "qm-codex-oauth-default-source-"));
  const defaultJail = mkdtempSync(join(tmpdir(), "qm-codex-oauth-default-jail-"));
  t.after(() => {
    rmSync(defaultSource, { recursive: true, force: true });
    rmSync(defaultJail, { recursive: true, force: true });
  });
  mkdirSync(join(defaultSource, ".codex"), { recursive: true });
  writeFileSync(
    join(defaultSource, ".codex", "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "default-access",
        refresh_token: "default-refresh",
        account_id: "default-account",
        id_token: oauthIdToken("default-account"),
      },
    }),
  );
  chmodSync(join(defaultSource, ".codex", "auth.json"), 0o600);
  const defaultEnv = { HOME: defaultSource, OPENAI_API_KEY: "ambient-default-api-key" };
  assert.equal(codexChildEnv(defaultEnv, defaultJail).OPENAI_API_KEY, undefined);
  assert.equal(existsSync(join(prepareCodexHome(defaultEnv, defaultJail), "auth.json")), true);
});

test("Codex diagnostics redact credential-shaped stderr", () => {
  assert.equal(
    redactCodexDiagnostics(
      '{"access_token":"access-secret","refresh_token":"refresh-secret"} Bearer bearer-secret-123456789 sk-secret-value',
    ),
    '{"access_token":"[redacted]","refresh_token":"[redacted]"} Bearer [redacted] [redacted]',
  );
  const diagnostics = redactCodexDiagnostics(
    "Authorization: Basic basic-secret-123456 Cookie: session-cookie-secret; Set-Cookie: refresh-cookie-secret; X-Api-Key: api-secret-123456 accessToken=camel-secret-123456 token=generic-secret-123456",
  );
  for (const secret of [
    "basic-secret-123456",
    "session-cookie-secret",
    "refresh-cookie-secret",
    "api-secret-123456",
    "camel-secret-123456",
    "generic-secret-123456",
  ])
    assert.equal(diagnostics.includes(secret), false, secret);
  const structured = redactCodexDiagnostics('authorization=["Bearer array-secret"] access_token="unterminated-secret');
  assert.equal(structured.includes("array-secret"), false);
  assert.equal(structured.includes("unterminated-secret"), false);
  const arrayDiagnostics = redactCodexDiagnostics('access_token=["first-array-secret","second-array-secret"]');
  assert.equal(arrayDiagnostics.includes("first-array-secret"), false);
  assert.equal(arrayDiagnostics.includes("second-array-secret"), false);
  const malformedArray = redactCodexDiagnostics('access_token=["first-array-secret",\n"second-array-secret"');
  assert.equal(malformedArray.includes("first-array-secret"), false);
  assert.equal(malformedArray.includes("second-array-secret"), false);
  const malformedObject = redactCodexDiagnostics('access_token={"a":"first-object-secret","b":"second-object-secret"}');
  assert.equal(malformedObject.includes("first-object-secret"), false);
  assert.equal(malformedObject.includes("second-object-secret"), false);
  const nested = redactCodexDiagnostics(
    JSON.stringify({
      nested: { authorization: { header: "Bearer nested-secret" } },
      tokens: { access_token: ["one-secret"] },
    }),
  );
  assert.equal(nested.includes("nested-secret"), false);
  assert.equal(nested.includes("one-secret"), false);
  assert.equal(redactCodexDiagnostics("id_token=header.payload.signature").includes("header.payload.signature"), false);
  const generic = redactCodexDiagnostics(
    JSON.stringify({
      secret: "generic-secret",
      password: "generic-password",
      opaque: "opaque-secret-value-123456789012345678901234",
    }),
  );
  assert.equal(generic.includes("generic-secret"), false);
  assert.equal(generic.includes("generic-password"), false);
  assert.equal(generic.includes("opaque-secret-value-123456789012345678901234"), false);
});

test("Codex ignores OAuth auth files that are readable by other users", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-oauth-mode-test-"));
  const authFile = join(dir, "auth.json");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    authFile,
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "mode-access",
        refresh_token: "mode-refresh",
        account_id: "mode-account",
        id_token: oauthIdToken("mode-account"),
      },
    }),
    { mode: 0o600 },
  );
  assert.deepEqual(readCodexOAuthAuthFile(authFile), {
    auth_mode: "chatgpt",
    tokens: {
      access_token: "mode-access",
      refresh_token: "mode-refresh",
      account_id: "mode-account",
      id_token: oauthIdToken("mode-account"),
    },
  });
  chmodSync(authFile, 0o644);
  assert.equal(readCodexOAuthAuthFile(authFile), null);
});

test("Codex rejects OAuth auth files without a trusted account claim", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-oauth-optional-account-test-"));
  const authFile = join(dir, "auth.json");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    authFile,
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: "optional-access", refresh_token: "optional-refresh" },
    }),
    { mode: 0o600 },
  );
  assert.equal(readCodexOAuthAuthFile(authFile), null);
});

test("Codex diagnostics redact malformed app-server output at the protocol boundary", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-malformed-test-"));
  const server = new CodexAppServer({
    binaryPath: malformedCodexBinary(dir),
    cwd: dir,
    env: { PATH: process.env.PATH },
    onNotification: () => {},
    onRequest: async () => ({}),
  });
  t.after(async () => {
    await server.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });
  await assert.rejects(server.initialize(), (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    assert.equal(message.includes("oauth-secret-123456789"), false);
    assert.equal(message.includes("[redacted]"), true);
    return true;
  });
});

test("Codex rejects incomplete JSON-RPC responses", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-incomplete-response-test-"));
  const server = new CodexAppServer({
    binaryPath: incompleteResponseCodexBinary(dir),
    cwd: dir,
    env: { PATH: process.env.PATH },
    onNotification: () => {},
    onRequest: async () => ({}),
  });
  t.after(async () => {
    await server.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });
  await assert.rejects(server.initialize(), /invalid JSON/);
});

test("Codex rejects response messages without ids", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-no-id-response-test-"));
  const server = new CodexAppServer({
    binaryPath: noIdResponseCodexBinary(dir),
    cwd: dir,
    env: { PATH: process.env.PATH },
    onNotification: () => {},
    onRequest: async () => ({}),
  });
  t.after(async () => {
    await server.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });
  await assert.rejects(server.initialize(), /invalid JSON/);
});

test("Codex rejects JSON arrays at the JSON-RPC boundary", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-array-message-test-"));
  const server = new CodexAppServer({
    binaryPath: arrayMessageCodexBinary(dir),
    cwd: dir,
    env: { PATH: process.env.PATH },
    onNotification: () => {},
    onRequest: async () => ({}),
  });
  t.after(async () => {
    await server.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });
  await assert.rejects(server.initialize(), /invalid JSON/);
});

test("Codex rejects malformed JSON-RPC field types", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-invalid-json-rpc-test-"));
  const server = new CodexAppServer({
    binaryPath: invalidJsonRpcBinary(dir),
    cwd: dir,
    env: { PATH: process.env.PATH },
    onNotification: () => {},
    onRequest: async () => ({}),
  });
  t.after(async () => {
    await server.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });
  await assert.rejects(server.initialize(), /invalid JSON/);
});

test("Codex rejects unknown JSON-RPC response ids", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-unknown-response-test-"));
  const server = new CodexAppServer({
    binaryPath: unknownResponseCodexBinary(dir),
    cwd: dir,
    env: { PATH: process.env.PATH },
    onNotification: () => {},
    onRequest: async () => ({}),
  });
  t.after(async () => {
    await server.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });
  await assert.rejects(server.initialize(), /unknown response id/);
});

test("Codex rejects malformed turn completion payloads", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-malformed-turn-test-"));
  const harness = createCodexHarness({
    binaryPath: malformedTurnCompletedCodexBinary(dir),
    env: testHarnessEnv(dir),
    turnWallClockMs: 2_000,
  });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  const scope = { kind: "org", id: "test" } as unknown as ScopeId;
  await assert.rejects(
    harness.turns.runTurn({
      session: { id: "malformed-turn" } as Session,
      input: "hi",
      systemPrompt: "be concise",
      history: [],
      tools: {} as HarnessTurnInput["tools"],
      scopeLabel: scope,
      orgScopeId: scope,
      emit: async (entry) => ({ ...entry, sessionId: "malformed-turn", seq: 1, createdAt: Date.now() }) as SessionEntry,
      recordModelCall: () => {},
    }),
    /invalid turn\/completed payload/,
  );
});

test("Codex children cannot use parent surface, control, or terminal tools", () => {
  assert.equal(codexChildToolAllowed("history"), true);
  assert.equal(codexChildToolAllowed("execute"), true);
  for (const denied of ["slack", "cron", "webhook", "guidance", "share", "stay_silent", "finish_silently"]) {
    assert.equal(codexChildToolAllowed(denied), false, denied);
  }
});

test("Codex interrupts the provider after a terminal QM tool", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-stop-test-"));
  const harness = createCodexHarness({
    binaryPath: terminatingCodexBinary(dir),
    env: testHarnessEnv(dir),
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
    env: testHarnessEnv(dir),
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

test("Codex preserves OAuth auth before discarding a failed startup", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-startup-oauth-test-"));
  const authFile = join(dir, "auth.json");
  writeFileSync(
    authFile,
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "startup-access-before",
        refresh_token: "startup-refresh-before",
        account_id: "startup-account",
        id_token: oauthIdToken("startup-account"),
      },
    }),
  );
  chmodSync(authFile, 0o600);
  const harness = createCodexHarness({
    binaryPath: refreshThenNonresponsiveCodexBinary(dir),
    env: { CODEX_AUTH_FILE: authFile },
    appServerStartTimeoutMs: 1_000,
    turnWallClockMs: 3_000,
  });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  const scope = { kind: "org", id: "test" } as unknown as ScopeId;
  await assert.rejects(
    harness.turns.runTurn({
      session: { id: "startup-oauth" } as Session,
      input: "hi",
      systemPrompt: "be concise",
      history: [],
      tools: {} as HarnessTurnInput["tools"],
      scopeLabel: scope,
      orgScopeId: scope,
      emit: async (entry) => ({ ...entry, sessionId: "startup-oauth", seq: 1, createdAt: Date.now() }) as SessionEntry,
      recordModelCall: () => {},
    }),
    (error: unknown) => /timed out|exited|closed/i.test(error instanceof Error ? error.message : String(error)),
  );
  const persisted = JSON.parse(readFileSync(authFile, "utf8")) as Record<string, unknown>;
  assert.equal((persisted.tokens as Record<string, unknown>).access_token, "startup-access-before");
});

test("cancelling an OAuth startup after spawn closes the provider", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-cancel-startup-child-test-"));
  const authFile = join(dir, "auth.json");
  writeFileSync(
    authFile,
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "cancel-child-access",
        refresh_token: "cancel-child-refresh",
        account_id: "cancel-child-account",
        id_token: oauthIdToken("cancel-child-account"),
      },
    }),
    { mode: 0o600 },
  );
  const harness = createCodexHarness({
    binaryPath: startupCancellationCodexBinary(dir),
    env: { CODEX_AUTH_FILE: authFile },
    appServerStartTimeoutMs: 1_000,
    turnWallClockMs: 3_000,
  });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  const cancel = new AbortController();
  const scope = { kind: "org", id: "test" } as unknown as ScopeId;
  const turn = harness.turns.runTurn({
    session: { id: "cancel-startup-child" } as Session,
    input: "hi",
    systemPrompt: "be concise",
    history: [],
    tools: {} as HarnessTurnInput["tools"],
    scopeLabel: scope,
    orgScopeId: scope,
    cancel: cancel.signal,
    emit: async (entry) =>
      ({ ...entry, sessionId: "cancel-startup-child", seq: 1, createdAt: Date.now() }) as SessionEntry,
    recordModelCall: () => {},
  });
  for (let attempt = 0; attempt < 50 && !existsSync(join(dir, "starts")); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(existsSync(join(dir, "starts")), true);
  cancel.abort();
  assert.deepEqual(await turn, { reply: "", stopped: true });
  for (let attempt = 0; attempt < 100 && !existsSync(join(dir, "closed")); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(readFileSync(join(dir, "closed"), "utf8"), "closed");
});

test("cancelling a pending Codex turn/start stops and closes the runtime", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-cancel-turn-start-test-"));
  const harness = createCodexHarness({
    binaryPath: pendingTurnStartCodexBinary(dir),
    env: testHarnessEnv(dir),
    turnWallClockMs: 3_000,
  });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  const cancel = new AbortController();
  const scope = { kind: "org", id: "test" } as unknown as ScopeId;
  const turn = harness.turns.runTurn({
    session: { id: "cancel-turn-start" } as Session,
    input: "hi",
    systemPrompt: "be concise",
    history: [],
    tools: {} as HarnessTurnInput["tools"],
    scopeLabel: scope,
    orgScopeId: scope,
    cancel: cancel.signal,
    emit: async (entry) =>
      ({ ...entry, sessionId: "cancel-turn-start", seq: 1, createdAt: Date.now() }) as SessionEntry,
    recordModelCall: () => {},
  });
  for (let attempt = 0; attempt < 100 && !existsSync(join(dir, "turn-started")); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(existsSync(join(dir, "turn-started")), true);
  cancel.abort();
  assert.deepEqual(await turn, { reply: "", stopped: true });
  for (let attempt = 0; attempt < 100 && !existsSync(join(dir, "closed")); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(readFileSync(join(dir, "closed"), "utf8"), "closed");
});

test("per-user Codex turns run on their own app-server with derived auth, never the shared jail", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-per-user-test-"));
  const orgAuthFile = join(dir, "auth.json");
  writeFileSync(
    orgAuthFile,
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "org-access",
        refresh_token: "org-refresh",
        account_id: "org-account",
        id_token: oauthIdToken("org-account"),
      },
    }),
    { mode: 0o600 },
  );
  const orgAuthBefore = readFileSync(orgAuthFile, "utf8");
  const harness = createCodexHarness({
    binaryPath: accountEchoCodexBinary(dir, "per-user"),
    env: { CODEX_AUTH_FILE: orgAuthFile },
    turnWallClockMs: 5_000,
  });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  const scope = { kind: "org", id: "test" } as unknown as ScopeId;
  const run = (id: string, accountId?: string) =>
    harness.turns.runTurn({
      session: { id } as Session,
      input: id,
      systemPrompt: "be concise",
      history: [],
      tools: {} as HarnessTurnInput["tools"],
      scopeLabel: scope,
      orgScopeId: scope,
      ...(accountId
        ? {
            codexAuth: {
              accessToken: `${accountId}-access`,
              idToken: oauthIdToken(accountId),
              accountId,
            },
          }
        : {}),
      emit: async (entry) => ({ ...entry, sessionId: id, seq: 1, createdAt: Date.now() }) as SessionEntry,
      recordModelCall: () => {},
    });
  // Two different users' turns and an org turn, all concurrent.
  const [alice, bob, org] = await Promise.all([
    run("alice-turn", "acct-alice"),
    run("bob-turn", "acct-bob"),
    run("org-turn"),
  ]);
  // Each per-user turn saw its OWN account, and no jail ever held a refresh token.
  assert.equal(alice.reply, "acct-alice:false");
  assert.equal(bob.reply, "acct-bob:false");
  assert.equal(org.reply, "org-account:false");
  // The org credential on disk was never touched by per-user turns.
  assert.equal(readFileSync(orgAuthFile, "utf8"), orgAuthBefore);
});

test("Codex fails closed when OAuth auth is removed after startup", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-oauth-delete-test-"));
  const authFile = join(dir, "auth.json");
  writeFileSync(
    authFile,
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "delete-access",
        refresh_token: "delete-refresh",
        account_id: "delete-account",
        id_token: oauthIdToken("delete-account"),
      },
    }),
    { mode: 0o600 },
  );
  const harness = createCodexHarness({
    binaryPath: oauthTurnBinary(dir, "delete", 1),
    env: { CODEX_AUTH_FILE: authFile },
    turnWallClockMs: 3_000,
  });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  const scope = { kind: "org", id: "test" } as unknown as ScopeId;
  const run = (id: string) =>
    harness.turns.runTurn({
      session: { id } as Session,
      input: id,
      systemPrompt: "be concise",
      history: [],
      tools: {} as HarnessTurnInput["tools"],
      scopeLabel: scope,
      orgScopeId: scope,
      emit: async (entry) => ({ ...entry, sessionId: id, seq: 1, createdAt: Date.now() }) as SessionEntry,
      recordModelCall: () => {},
    });
  assert.equal((await run("before-delete")).reply, "delete");
  rmSync(authFile);
  await assert.rejects(run("after-delete"), /OAuth auth is unavailable/);
});

test("Codex app-server exits reject turns without unhandled rejections", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-exit-test-"));
  const harness = createCodexHarness({
    binaryPath: exitingCodexBinary(dir),
    env: testHarnessEnv(dir),
    turnWallClockMs: 3_000,
  });
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  t.after(async () => {
    process.off("unhandledRejection", onUnhandled);
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  const scope = { kind: "org", id: "test" } as unknown as ScopeId;
  await assert.rejects(
    harness.turns.runTurn({
      session: { id: "exit-turn" } as Session,
      input: "hi",
      systemPrompt: "be concise",
      history: [],
      tools: {} as HarnessTurnInput["tools"],
      scopeLabel: scope,
      orgScopeId: scope,
      emit: async (entry) => ({ ...entry, sessionId: "exit-turn", seq: 1, createdAt: Date.now() }) as SessionEntry,
      recordModelCall: () => {},
    }),
    /exited \(17\)/,
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(unhandled, []);
});

test("cancelling one Codex setup does not kill another active turn", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-concurrent-test-"));
  const harness = createCodexHarness({
    binaryPath: concurrentCodexBinary(dir),
    env: testHarnessEnv(dir),
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
  assert.equal(
    codexProviderFailure("401 access_token=provider-secret-123456").message.includes("provider-secret"),
    false,
  );
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
      env: testHarnessEnv(dir),
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
    const harness = createCodexHarness({ binaryPath, env: testHarnessEnv(dir), turnWallClockMs: 5_000 });
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

test("Codex waits for the bounded durable llm record before completing a turn", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-telemetry-order-test-"));
  const scope = { kind: "org", id: "test" } as unknown as ScopeId;
  const harness = createCodexHarness({
    binaryPath: fakeCodexBinary(dir),
    env: testHarnessEnv(dir),
    turnWallClockMs: 5_000,
  });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  let recorded = false;
  const startedAt = Date.now();
  const result = await harness.turns.runTurn({
    session: { id: "telemetry-order" } as Session,
    input: "hi",
    systemPrompt: "be concise",
    history: [],
    tools: {} as HarnessTurnInput["tools"],
    scopeLabel: scope,
    orgScopeId: scope,
    emit: async (entry) => ({ ...entry, sessionId: "telemetry-order", seq: 1, createdAt: Date.now() }) as SessionEntry,
    recordModelCall: () => {},
    recordLlmRequest: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      recorded = true;
    },
  });
  assert.equal(result.reply, "hello");
  assert.equal(recorded, true);
  assert.ok(Date.now() - startedAt >= 45);
});

test("Codex aborts a durable llm record that exceeds its bound", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-telemetry-timeout-test-"));
  const scope = { kind: "org", id: "test" } as unknown as ScopeId;
  const harness = createCodexHarness({
    binaryPath: fakeCodexBinary(dir),
    env: testHarnessEnv(dir),
    turnWallClockMs: 12_000,
  });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  let aborted = false;
  const result = await harness.turns.runTurn({
    session: { id: "telemetry-timeout" } as Session,
    input: "hi",
    systemPrompt: "be concise",
    history: [],
    tools: {} as HarnessTurnInput["tools"],
    scopeLabel: scope,
    orgScopeId: scope,
    emit: async (entry) =>
      ({ ...entry, sessionId: "telemetry-timeout", seq: 1, createdAt: Date.now() }) as SessionEntry,
    recordModelCall: () => {},
    recordLlmRequest: async (_record, signal) => {
      if (!signal) throw new Error("missing record cancellation signal");
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          aborted = true;
          resolve();
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        );
      });
    },
  });
  assert.equal(result.reply, "hello");
  assert.equal(aborted, true);
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
      env: codexChildEnv({ PATH: process.env.PATH, CODEX_HOME: join(jail, "empty-source") }, jail),
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
    const started = await server.request(
      "thread/start",
      {
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
      },
      (value: unknown): value is { thread: { id: string } } => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const thread = (value as Record<string, unknown>).thread;
        return Boolean(
          thread &&
          typeof thread === "object" &&
          !Array.isArray(thread) &&
          typeof (thread as Record<string, unknown>).id === "string",
        );
      },
    );
    assert.ok(started.thread.id, "the real app-server returned a thread id for our start shape");
    await server.request("thread/inject_items", {
      threadId: started.thread.id,
      items: replaySmokeItems,
    });
    assert.deepEqual(requests, []);
  },
);
