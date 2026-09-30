import test, { type TestContext } from "node:test";
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
  codexTurnInputText,
  createCodexHarness,
  prepareCodexHome,
  type CodexHarnessOptions,
} from "../src/harness/codex-harness.ts";
import type { Harness, HarnessLlmRequestRecord, HarnessTurnInput } from "../src/harness/harness.ts";
import { createMemoryRunSignalStore } from "../src/runs/run-signal-store.ts";
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

const orgScope = { kind: "org", id: "test" } as unknown as ScopeId;

function executable(path: string, source: string): string {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
  return path;
}

function turnInput(id: string, extra: Partial<HarnessTurnInput> = {}, entries?: SessionEntry[]): HarnessTurnInput {
  return {
    session: { id } as Session,
    input: "hi",
    systemPrompt: "be concise",
    history: [],
    tools: {} as HarnessTurnInput["tools"],
    scopeLabel: orgScope,
    orgScopeId: orgScope,
    emit: async (entry) => {
      const saved = { ...entry, sessionId: id, seq: (entries?.length ?? 0) + 1, createdAt: Date.now() } as SessionEntry;
      entries?.push(saved);
      return saved;
    },
    recordModelCall: () => {},
    ...extra,
  };
}

function codexHarness(t: TestContext, dir: string, options: CodexHarnessOptions): Harness {
  const harness = createCodexHarness(options);
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  return harness;
}

function writeOAuthAuth(path: string, name: string) {
  const auth = {
    auth_mode: "chatgpt",
    tokens: {
      access_token: `${name}-access`,
      refresh_token: `${name}-refresh`,
      account_id: `${name}-account`,
      id_token: oauthIdToken(`${name}-account`),
    },
  };
  writeFileSync(path, JSON.stringify(auth), { mode: 0o600 });
  return auth;
}

async function waitForFile(path: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("Codex replay keeps paired tool ids within the provider's 64-character limit", () => {
  const longId = "tool-call-".repeat(9);
  const normalized = codexReplayCallId(longId);
  assert.equal(normalized.length, 64);
  assert.equal(codexReplayCallId(longId), normalized);
  assert.equal(codexReplayCallId("short-id"), "short-id");
});

function fakeCodexBinary(dir: string, commentary = false, coordinator = false): string {
  return executable(
    join(dir, "fake-codex"),
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
        msg.params.config?.features?.goals !== false ||
        process.env.CORE_SIGNING_SECRET || process.env.DATABASE_URL || process.env.HOME !== msg.params.cwd ||
        !process.env.CODEX_HOME?.startsWith(msg.params.cwd)) {
      return send({ id: msg.id, error: { code: -1, message: "unsafe or missing adapter settings" } });
    }
    if (${coordinator} && (msg.params.config?.features?.multi_agent !== false || msg.params.dynamicTools.some(tool => ["execute", "background"].includes(tool.name)))) {
      return send({ id: msg.id, error: { code: -1, message: "coordinator exposes command or native delegation tools" } });
    }
    return send({ id: msg.id, result: { thread: { id: "thread-1" }, model: "fake-model" } });
  }
  if (msg.method === "thread/inject_items") return send({ id: msg.id, result: {} });
  if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-1", status: "inProgress", items: [] } } });
    if (${commentary}) {
      for (const id of ["ack-1", "ack-2"]) {
        send({ method: "item/started", params: { threadId: "thread-1", item: { type: "agentMessage", id, phase: "commentary" } } });
        send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", itemId: id, delta: "Checking." } });
        send({ method: "item/completed", params: { threadId: "thread-1", item: { type: "agentMessage", id, text: "Checking.", phase: "commentary" } } });
      }
      send({ method: "item/started", params: { threadId: "thread-1", item: { type: "agentMessage", id: "item-1", phase: "final_answer" } } });
    }
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
}

function terminatingCodexBinary(dir: string): string {
  return executable(
    join(dir, "terminating-codex"),
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
}

function concurrentCodexBinary(dir: string): string {
  return executable(
    join(dir, "concurrent-codex"),
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
}

function nonresponsiveCodexBinary(dir: string): string {
  return executable(
    join(dir, "nonresponsive-codex"),
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(join(dir, "starts"))}, "start\\n");
process.stdin.resume();
`,
  );
}

function startupCancellationCodexBinary(dir: string): string {
  return executable(
    join(dir, "startup-cancellation-codex"),
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
}

function pendingThreadStartCodexBinary(dir: string): string {
  return executable(
    join(dir, "pending-thread-start-codex"),
    `#!${process.execPath}
const fs = require("node:fs");
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ id: msg.id, result: {} });
  if (msg.method === "initialized") return;
  if (msg.method === "thread/start") fs.writeFileSync(${JSON.stringify(join(dir, "thread-started"))}, "started");
});
process.on("SIGTERM", () => {
  fs.writeFileSync(${JSON.stringify(join(dir, "closed"))}, "closed");
  process.exit(0);
});
`,
  );
}

function pendingTurnStartCodexBinary(dir: string): string {
  return executable(
    join(dir, "pending-turn-start-codex"),
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
}

function refreshThenNonresponsiveCodexBinary(dir: string): string {
  const accessToken = oauthAccessToken("startup-account", "startup-after");
  return executable(
    join(dir, "refresh-then-nonresponsive-codex"),
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
}

function lineCodexBinary(dir: string, line: string): string {
  return executable(
    join(dir, "line-codex"),
    `#!${process.execPath}
process.stdout.write(${JSON.stringify(`${line}\n`)});
process.stdin.resume();
`,
  );
}

function malformedTurnCompletedCodexBinary(dir: string): string {
  return executable(
    join(dir, "malformed-turn-completed-codex"),
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
}

function oauthTurnBinary(dir: string, token: string, delayMs: number): string {
  const events = join(dir, "oauth-events");
  const accessToken = oauthAccessToken("shared-account", token);
  return executable(
    join(dir, `oauth-${token}`),
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
}

function accountEchoCodexBinary(dir: string, name: string, delayMs = 1): string {
  return executable(
    join(dir, `account-echo-${name}`),
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
    const reply = String(auth.tokens.account_id ?? "none") + ":" + String(Boolean(auth.tokens.refresh_token));
    send({ id: msg.id, result: { turn: { id: "turn-" + process.pid, status: "inProgress", items: [] } } });
    return setTimeout(() => send({ method: "turn/completed", params: { threadId: "thread-" + process.pid, turn: { id: "turn-" + process.pid, status: "completed", items: [{ type: "agentMessage", text: reply, phase: "final_answer" }] } } }), ${delayMs});
  }
  if (msg.method === "turn/interrupt") return send({ id: msg.id, result: {} });
});
`,
  );
}

function exitingCodexBinary(dir: string): string {
  return executable(
    join(dir, "exiting-codex"),
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
}

test("Codex harness drives app-server JSON-RPC with a read-only jail", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-test-"));
  const tasks = createMemoryTaskStore();
  const harness = codexHarness(t, dir, { binaryPath: fakeCodexBinary(dir), env: testHarnessEnv(dir), tasks });
  const entries: SessionEntry[] = [];
  const deltas: string[] = [];
  const modelCalls: number[] = [];
  const result = await harness.turns.runTurn(
    turnInput(
      "session-1",
      {
        recordModelCall: ({ inputTokens }) => modelCalls.push(inputTokens),
        onDelta: (delta) => deltas.push(delta),
      },
      entries,
    ),
  );

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
  assert.equal((childAuth.tokens as Record<string, unknown>).refresh_token, "");
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
  writeOAuthAuth(join(defaultSource, ".codex", "auth.json"), "default");
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
  const written = writeOAuthAuth(authFile, "mode");
  assert.deepEqual(readCodexOAuthAuthFile(authFile), written);
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

const redactsSecret = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  assert.equal(message.includes("oauth-secret-123456789"), false);
  assert.equal(message.includes("[redacted]"), true);
  return true;
};

for (const [name, line, expected] of [
  [
    "Codex diagnostics redact malformed app-server output at the protocol boundary",
    '{"access_token":"oauth-secret-123456789"',
    redactsSecret,
  ],
  ["Codex rejects incomplete JSON-RPC responses", '{"id":1}', /invalid JSON/],
  ["Codex rejects response messages without ids", '{"result":{}}', /invalid JSON/],
  ["Codex rejects JSON arrays at the JSON-RPC boundary", "[]", /invalid JSON/],
  ["Codex rejects malformed JSON-RPC field types", '{"id":true,"result":{}}', /invalid JSON/],
  ["Codex rejects unknown JSON-RPC response ids", '{"id":999,"result":{}}', /unknown response id/],
] as const) {
  test(name, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "qm-codex-json-rpc-test-"));
    const server = new CodexAppServer({
      binaryPath: lineCodexBinary(dir, line),
      cwd: dir,
      env: { PATH: process.env.PATH },
      onNotification: () => {},
      onRequest: async () => ({}),
    });
    t.after(async () => {
      await server.close().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    });
    await assert.rejects(server.initialize(), expected);
  });
}

test("Codex rejects malformed turn completion payloads", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-malformed-turn-test-"));
  const harness = codexHarness(t, dir, {
    binaryPath: malformedTurnCompletedCodexBinary(dir),
    env: testHarnessEnv(dir),
    turnWallClockMs: 2_000,
  });
  await assert.rejects(harness.turns.runTurn(turnInput("malformed-turn")), /invalid turn\/completed payload/);
});

test("Codex children cannot use parent surface, control, or terminal tools", () => {
  assert.equal(codexChildToolAllowed("history"), true);
  assert.equal(codexChildToolAllowed("execute"), true);
  for (const denied of ["slack", "cron", "webhook", "guidance", "share", "finish_silently"]) {
    assert.equal(codexChildToolAllowed(denied), false, denied);
  }
});

for (const surfaceTools of [false, true]) {
  test(`Codex interrupts the provider after finish_silently (surface=${surfaceTools})`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "qm-codex-stop-test-"));
    const harness = codexHarness(t, dir, {
      binaryPath: terminatingCodexBinary(dir),
      env: testHarnessEnv(dir),
      turnWallClockMs: 2_000,
    });
    const entries: SessionEntry[] = [];
    const result = await harness.turns.runTurn(
      turnInput(
        "terminal-tool",
        { input: "poll", systemPrompt: "finish silently", pollFire: !surfaceTools, surfaceTools },
        entries,
      ),
    );

    assert.equal(result.silent, true);
    assert.notEqual(result.reply, "BAD");
    assert.equal(
      entries.some((entry) => entry.type === "assistant"),
      false,
    );
  });
}

test("Codex spawn failure does not hang run or cleanup", async () => {
  const harness = createCodexHarness({ binaryPath: "/definitely/missing/qm-codex" });
  const turn = harness.turns.runTurn(turnInput("missing-binary"));
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
  const harness = codexHarness(t, dir, {
    binaryPath: nonresponsiveCodexBinary(dir),
    env: testHarnessEnv(dir),
    appServerStartTimeoutMs: 1_000,
    turnWallClockMs: 6_000,
  });
  await assert.rejects(harness.turns.runTurn(turnInput("first")), /initialization timed out/);
  await assert.rejects(harness.turns.runTurn(turnInput("second")), /initialization timed out/);
  assert.equal(readFileSync(join(dir, "starts"), "utf8"), "start\nstart\n");
});

test("Codex preserves OAuth auth before discarding a failed startup", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-startup-oauth-test-"));
  const authFile = join(dir, "auth.json");
  writeOAuthAuth(authFile, "startup");
  const harness = codexHarness(t, dir, {
    binaryPath: refreshThenNonresponsiveCodexBinary(dir),
    env: { CODEX_AUTH_FILE: authFile },
    appServerStartTimeoutMs: 1_000,
    turnWallClockMs: 3_000,
  });
  await assert.rejects(harness.turns.runTurn(turnInput("startup-oauth")), (error: unknown) =>
    /timed out|exited|closed/i.test(error instanceof Error ? error.message : String(error)),
  );
  const persisted = JSON.parse(readFileSync(authFile, "utf8")) as Record<string, unknown>;
  assert.equal((persisted.tokens as Record<string, unknown>).access_token, "startup-access");
});

for (const { name, binary, marker, oauth } of [
  {
    name: "cancelling an OAuth startup after spawn closes the provider",
    binary: startupCancellationCodexBinary,
    marker: "starts",
    oauth: true,
  },
  {
    name: "cancelling a pending Codex thread/start is not relabeled as a startup timeout",
    binary: pendingThreadStartCodexBinary,
    marker: "thread-started",
    oauth: false,
  },
  {
    name: "cancelling a pending Codex turn/start stops and closes the runtime",
    binary: pendingTurnStartCodexBinary,
    marker: "turn-started",
    oauth: false,
  },
]) {
  test(name, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "qm-codex-cancel-test-"));
    const authFile = join(dir, "auth.json");
    if (oauth) writeOAuthAuth(authFile, "cancel-child");
    const harness = codexHarness(t, dir, {
      binaryPath: binary(dir),
      env: oauth ? { CODEX_AUTH_FILE: authFile } : testHarnessEnv(dir),
      ...(oauth ? { appServerStartTimeoutMs: 1_000 } : {}),
      turnWallClockMs: 3_000,
    });
    const cancel = new AbortController();
    const turn = harness.turns.runTurn(turnInput(`cancel-${marker}`, { cancel: cancel.signal }));
    await waitForFile(join(dir, marker));
    cancel.abort();
    assert.deepEqual(await turn, { reply: "", stopped: true });
    await waitForFile(join(dir, "closed"));
    assert.equal(readFileSync(join(dir, "closed"), "utf8"), "closed");
  });
}

test("Codex classifies a thread/start deadline as a non-retryable timeout", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-thread-start-timeout-test-"));
  const harness = codexHarness(t, dir, {
    binaryPath: pendingThreadStartCodexBinary(dir),
    env: testHarnessEnv(dir),
    appServerStartTimeoutMs: 500,
    turnWallClockMs: 0,
  });
  await assert.rejects(
    harness.turns.runTurn(turnInput("thread-start-timeout")),
    (error: unknown) =>
      error instanceof NonRetryableTurnError &&
      /thread\/start request timed out/.test(error.message) &&
      error.message !== "Codex app-server request cancelled",
  );
});

test("per-user Codex turns run on their own app-server with derived auth, never the shared jail", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-per-user-test-"));
  const orgAuthFile = join(dir, "auth.json");
  writeOAuthAuth(orgAuthFile, "org");
  const orgAuthBefore = readFileSync(orgAuthFile, "utf8");
  const harness = codexHarness(t, dir, {
    binaryPath: accountEchoCodexBinary(dir, "per-user"),
    env: { CODEX_AUTH_FILE: orgAuthFile },
    turnWallClockMs: 5_000,
  });
  const run = (id: string, accountId?: string) =>
    harness.turns.runTurn(
      turnInput(id, {
        input: id,
        ...(accountId
          ? { codexAuth: { accessToken: `${accountId}-access`, idToken: oauthIdToken(accountId), accountId } }
          : {}),
      }),
    );
  const [alice, bob, org] = await Promise.all([
    run("alice-turn", "acct-alice"),
    run("bob-turn", "acct-bob"),
    run("org-turn"),
  ]);
  assert.equal(alice.reply, "acct-alice:false");
  assert.equal(bob.reply, "acct-bob:false");
  assert.equal(org.reply, "org-account:false");
  assert.equal(readFileSync(orgAuthFile, "utf8"), orgAuthBefore);
});

test("Codex fails closed when OAuth auth is removed after startup", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-oauth-delete-test-"));
  const authFile = join(dir, "auth.json");
  writeOAuthAuth(authFile, "delete");
  const harness = codexHarness(t, dir, {
    binaryPath: oauthTurnBinary(dir, "delete", 1),
    env: { CODEX_AUTH_FILE: authFile },
    turnWallClockMs: 3_000,
  });
  const run = (id: string) => harness.turns.runTurn(turnInput(id, { input: id }));
  assert.equal((await run("before-delete")).reply, "delete");
  rmSync(authFile);
  await assert.rejects(run("after-delete"), /OAuth auth is unavailable/);
});

test("Codex app-server exits reject turns without unhandled rejections", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-exit-test-"));
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  const harness = codexHarness(t, dir, {
    binaryPath: exitingCodexBinary(dir),
    env: testHarnessEnv(dir),
    turnWallClockMs: 3_000,
  });
  await assert.rejects(harness.turns.runTurn(turnInput("exit-turn")), /exited \(17\)/);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(unhandled, []);
});

test("cancelling one Codex setup does not kill another active turn", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-concurrent-test-"));
  const harness = codexHarness(t, dir, {
    binaryPath: concurrentCodexBinary(dir),
    env: testHarnessEnv(dir),
    turnWallClockMs: 2_000,
  });
  const first = harness.turns.runTurn(turnInput("first", { input: "first" }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const controller = new AbortController();
  const second = harness.turns.runTurn(turnInput("second", { input: "second", cancel: controller.signal }));
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
  return executable(
    join(dir, `failing-codex-${mode}`),
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
}

for (const mode of ["turnFailed", "startRejected"] as const) {
  test(`Codex parks the run on a provider auth/quota failure (${mode}) instead of burning retries`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "qm-codex-fail-test-"));
    const harness = codexHarness(t, dir, {
      binaryPath: failingProviderCodexBinary(dir, mode),
      env: testHarnessEnv(dir),
      turnWallClockMs: 5_000,
    });
    await assert.rejects(
      harness.turns.runTurn(turnInput("fail-session")),
      (error: unknown) => error instanceof NonRetryableTurnError,
    );
  });
}

function stopReportsFailedCodexBinary(dir: string, stream = false, final = true): string {
  return executable(
    join(dir, "stop-failed-codex"),
    `#!/usr/bin/env node
const readline = require("node:readline");
const { writeFileSync } = require("node:fs");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ id: msg.id, result: {} });
  if (msg.method === "initialized") return;
  if (msg.method === "thread/start") return send({ id: msg.id, result: { thread: { id: "thread-sf" } } });
  if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-sf", status: "inProgress", items: [] } } });
    if (${stream}) {
      send({ method: "item/started", params: { threadId: "thread-sf", item: { id: "ack", type: "agentMessage", phase: "commentary" } } });
      send({ method: "item/agentMessage/delta", params: { threadId: "thread-sf", itemId: "ack", delta: "Checking." } });
      if (${final}) {
      send({ method: "item/completed", params: { threadId: "thread-sf", item: { id: "ack", type: "agentMessage", phase: "commentary", text: "Checking." } } });
      send({ method: "item/started", params: { threadId: "thread-sf", item: { id: "answer", type: "agentMessage", phase: "final_answer" } } });
      send({ method: "item/agentMessage/delta", params: { threadId: "thread-sf", itemId: "answer", delta: "Partial answer" } });
      }
    }
    return writeFileSync(${JSON.stringify(join(dir, "started"))}, "1");
  }
  if (msg.method === "turn/interrupt") {
    send({ id: msg.id, result: {} });
    if (${stream}) {
      send({ method: "item/agentMessage/delta", params: { threadId: "thread-sf", itemId: "answer", delta: " LATE" } });
      send({ method: "item/completed", params: { threadId: "thread-sf", item: { id: "answer", type: "agentMessage", phase: "final_answer", text: "BAD LATE COMPLETION" } } });
    }
    return send({ method: "turn/completed", params: { threadId: "thread-sf", turn: { id: "turn-sf", status: "failed", error: { message: "turn interrupted" }, items: [] } } });
  }
});
`,
  );
}

test("a user stop whose interrupted turn reports status=failed is a clean stop, and the stop stays pending", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-stop-failed-test-"));
  const signals = createMemoryRunSignalStore();
  const harness = codexHarness(t, dir, {
    binaryPath: stopReportsFailedCodexBinary(dir),
    env: process.env,
    turnWallClockMs: 5_000,
    signals,
  });
  const running = harness.turns.runTurn(turnInput("stop-failed-session", { runId: "run-stop-failed" }));
  await waitForFile(join(dir, "started"));
  await signals.send("run-stop-failed", { kind: "abort" });
  const result = await running;
  assert.equal(result.stopped, true, "an interrupted turn the provider calls failed is still a user stop");
  assert.equal(result.reply, "");
  assert.deepEqual(
    (await signals.takePending("run-stop-failed")).map((s) => s.kind),
    ["abort"],
    "the stop stays pending for the terminal drain",
  );
});

test("Codex records one llm row per turn carrying real timings and usage, even when the turn fails", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-telemetry-test-"));
  const records: HarnessLlmRequestRecord[] = [];
  const runWith = async (binaryPath: string, id: string) => {
    const harness = createCodexHarness({ binaryPath, env: testHarnessEnv(dir), turnWallClockMs: 5_000 });
    t.after(async () => await harness.turns.close?.());
    return await harness.turns.runTurn(
      turnInput(id, {
        emit: async (entry) => ({ ...entry, sessionId: id, seq: 4, createdAt: Date.now() }) as SessionEntry,
        recordLlmRequest: (rec) => void records.push(rec),
      }),
    );
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
  const harness = codexHarness(t, dir, {
    binaryPath: fakeCodexBinary(dir),
    env: testHarnessEnv(dir),
    turnWallClockMs: 5_000,
  });
  let recorded = false;
  const startedAt = Date.now();
  const result = await harness.turns.runTurn(
    turnInput("telemetry-order", {
      recordLlmRequest: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        recorded = true;
      },
    }),
  );
  assert.equal(result.reply, "hello");
  assert.equal(recorded, true);
  assert.ok(Date.now() - startedAt >= 45);
});

test("Codex aborts a durable llm record that exceeds its bound", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-telemetry-timeout-test-"));
  const harness = codexHarness(t, dir, {
    binaryPath: fakeCodexBinary(dir),
    env: testHarnessEnv(dir),
    turnWallClockMs: 12_000,
  });
  let aborted = false;
  const result = await harness.turns.runTurn(
    turnInput("telemetry-timeout", {
      recordLlmRequest: async (_record, signal) => {
        if (!signal) throw new Error("missing record cancellation signal");
        if (!signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        aborted = true;
      },
    }),
  );
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
            goals: false,
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

test("Codex persists repeated public commentary in order with distinct streaming blocks", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-commentary-"));
  const harness = codexHarness(t, dir, { binaryPath: fakeCodexBinary(dir, true), env: testHarnessEnv(dir) });
  const entries: SessionEntry[] = [];
  const streamed: string[] = [];
  const scope = "personal:test" as ScopeId;
  const result = await harness.turns.runTurn(
    turnInput(
      "commentary",
      {
        input: "check",
        scopeLabel: scope,
        orgScopeId: scope,
        onDelta: (delta) => {
          streamed.push(delta);
        },
        onTextBlockStart: async (phase) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          streamed.push(`block:${phase}`);
        },
      },
      entries,
    ),
  );
  assert.equal(result.reply, "hello");
  assert.deepEqual(
    entries.filter((entry) => entry.type === "text").map((entry) => entry.payload),
    [
      { text: "Checking.", phase: "commentary" },
      { text: "Checking.", phase: "commentary" },
    ],
  );
  assert.deepEqual(streamed, [
    "block:commentary",
    "Checking.",
    "block:commentary",
    "Checking.",
    "block:final_answer",
    "hello",
  ]);
});

for (const final of [true, false]) {
  for (const mechanism of ["signal", "cancel", "both"] as const) {
    test(`Codex saves only pre-stop ${final ? "final" : "commentary"} text via ${mechanism}`, async (t) => {
      const dir = mkdtempSync(join(tmpdir(), "qm-codex-partial-stop-"));
      const signals = createMemoryRunSignalStore();
      const harness = codexHarness(t, dir, {
        binaryPath: stopReportsFailedCodexBinary(dir, true, final),
        env: testHarnessEnv(dir),
        signals,
        turnWallClockMs: 5_000,
      });
      const cancel = new AbortController();
      const received = Promise.withResolvers<void>();
      const entries: SessionEntry[] = [];
      const deltas: string[] = [];
      const scope = "personal:test" as ScopeId;
      const running = harness.turns.runTurn(
        turnInput(
          "partial-stop",
          {
            runId: "partial-stop-run",
            input: "check",
            scopeLabel: scope,
            orgScopeId: scope,
            cancel: cancel.signal,
            onDelta: (text) => {
              deltas.push(text);
              if (text === (final ? "Partial answer" : "Checking.")) received.resolve();
            },
          },
          entries,
        ),
      );
      await received.promise;
      if (mechanism === "cancel") cancel.abort();
      else {
        await signals.send("partial-stop-run", { kind: "abort" });
        if (mechanism === "both") cancel.abort();
      }
      const result = await running;
      assert.equal(result.stopped, true);
      assert.equal(result.stoppedByUser, mechanism === "cancel" ? undefined : true);
      assert.deepEqual(
        entries.filter((entry) => entry.type === "text").map((entry) => entry.payload),
        [{ text: "Checking.", phase: "commentary" }],
      );
      assert.equal(result.reply, final ? "Partial answer" : "");
      assert.deepEqual(deltas, final ? ["Checking.", "Partial answer"] : ["Checking."]);
      assert.deepEqual(
        entries.filter((entry) => entry.type === "assistant").map((entry) => entry.payload),
        [{ text: final ? "Partial answer" : "", stopped: true }],
      );
    });
  }
}

test("Codex steers extracted documents into the active turn without copying contents into tape", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-steer-doc-test-"));
  const binary = stopReportsFailedCodexBinary(dir);
  const capture = join(dir, "steered.json");
  const source = readFileSync(binary, "utf8").replace(
    '  if (msg.method === "turn/interrupt") {',
    `
  if (msg.method === "turn/steer") {
    writeFileSync(${JSON.stringify(capture)}, JSON.stringify(msg.params));
    send({ id: msg.id, result: {} });
    setTimeout(() => {
    send({ method: "item/completed", params: { threadId: "thread-sf", item: { id: "steered-user", type: "userMessage", content: msg.params.input } } });
    send({ method: "item/completed", params: { threadId: "thread-sf", item: { id: "steered-user", type: "userMessage", content: msg.params.input } } });
    send({ method: "item/completed", params: { threadId: "thread-sf", item: { id: "answer", type: "agentMessage", phase: "final_answer", text: "document read" } } });
    send({ method: "turn/completed", params: { threadId: "thread-sf", turn: { id: "turn-sf", status: "completed", items: [] } } });
    }, 100);
    return;
  }
  if (msg.method === "turn/interrupt") {`,
  );
  writeFileSync(binary, source);
  const signals = createMemoryRunSignalStore();
  const harness = codexHarness(t, dir, { binaryPath: binary, env: process.env, turnWallClockMs: 10_000, signals });
  const tape: unknown[] = [];
  const entries: SessionEntry[] = [];
  const scope = "personal:tester" as ScopeId;
  const running = harness.turns.runTurn(
    turnInput(
      "steer-document-session",
      {
        input: "wait for a document",
        runId: "steer-document-run",
        systemPrompt: "QA",
        documents: [
          {
            name: "initial.txt",
            mimeType: "text/plain",
            dataBase64: Buffer.from("A".repeat(80_000)).toString("base64"),
          },
        ],
        scopeLabel: scope,
        orgScopeId: scope,
        tape: async (row) => {
          tape.push(row);
        },
        prepareSteer: async (text) => ({
          text,
          documents: [
            {
              name: "private.txt",
              mimeType: "text/plain",
              dataBase64: Buffer.from("STEER-PRIVATE-492" + "Z".repeat(30_000) + "OUTSIDE-BUDGET-492").toString(
                "base64",
              ),
            },
          ],
        }),
      },
      entries,
    ),
  );
  await waitForFile(join(dir, "started"), 5_000);
  await signals.send("steer-document-run", { kind: "steer", text: "read the document", ts: "doc.1" });
  await waitForFile(capture, 5_000);
  assert.equal(entries.filter((entry) => entry.type === "user").length, 1, "turn/steer acceptance is not intake");
  await running;
  assert.equal(entries.filter((entry) => entry.type === "user").length, 2);
  assert.equal((await signals.pending("steer-document-run")).length, 0);
  assert.match(readFileSync(capture, "utf8"), /STEER-PRIVATE-492/);
  assert.doesNotMatch(JSON.stringify(tape), /STEER-PRIVATE-492/);
  assert.doesNotMatch(readFileSync(capture, "utf8"), /OUTSIDE-BUDGET-492/);
  assert.match(readFileSync(capture, "utf8"), /truncated to fit/);
});

test("Codex coordinators expose neither command tools nor native subagents", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-coordinator-"));
  const harness = codexHarness(t, dir, { binaryPath: fakeCodexBinary(dir, false, true), env: testHarnessEnv(dir) });
  const scope = "personal:U1" as ScopeId;
  const result = await harness.turns.runTurn(
    turnInput(
      "coordinator",
      { input: "hello", systemPrompt: "coordinate", scopeLabel: scope, orgScopeId: scope, delegateWork: true },
      [],
    ),
  );
  assert.equal(result.reply, "hello");
});

test("Codex denies a child apps move request before executing the shared tool", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-child-resource-"));
  const binary = executable(
    join(dir, "codex-test"),
    `#!${process.execPath}
const readline = require('node:readline');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send({id:msg.id,result:{}});
  if (msg.method === 'thread/start') send({id:msg.id,result:{thread:{id:'parent'}}});
  if (msg.method === 'turn/start') {
    send({id:msg.id,result:{turn:{id:'turn',status:'inProgress',items:[]}}});
    send({method:'item/started',params:{threadId:'parent',turnId:'turn',item:{type:'collabAgentToolCall',id:'spawn',tool:'spawnAgent',status:'inProgress',senderThreadId:'parent',receiverThreadIds:['child'],agentsStates:{child:{status:'running'}}}}});
    send({id:'child-call',method:'item/tool/call',params:{threadId:'child',callId:'move',tool:'apps',arguments:{action:'move',id:'app',toScope:'personal:bob'}}});
  }
  if (msg.id === 'child-call') {
    const denied = JSON.stringify(msg).includes('child requested unavailable tool apps');
    send({method:'turn/completed',params:{threadId:'parent',turn:{id:'turn',status:'completed',items:[{type:'agentMessage',id:'answer',text:denied?'denied':'NOT DENIED',phase:'final_answer'}]}}});
  }
});
`,
  );
  let shared = false;
  const harness = codexHarness(t, dir, { binaryPath: binary, env: testHarnessEnv(dir), turnWallClockMs: 10000 });
  const scope = "personal:test" as ScopeId;
  const result = await harness.turns.runTurn(
    turnInput("child-resource", {
      input: "delegate",
      systemPrompt: "test",
      tools: {
        async shareArtifact() {
          shared = true;
          throw new Error("must not execute");
        },
      } as unknown as HarnessTurnInput["tools"],
      scopeLabel: scope,
      orgScopeId: scope,
    }),
  );
  assert.equal(result.reply, "denied");
  assert.equal(shared, false);
});
