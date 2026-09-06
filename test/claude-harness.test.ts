import test from "node:test";
import assert from "node:assert/strict";
import {
  claudeChildAgentAllowed,
  claudeChildEnv,
  perUserClaudeEnv,
  claudeProcessIdentity,
  claudeReplayTranscript,
  spawnClaudeProcess,
  stripClaudeImageBytes,
} from "../src/harness/claude-harness.ts";
import { zeroUsage, type PiReplayMessage } from "../src/harness/replay.ts";

test("Claude replay preserves paired tool calls and results as untrusted history", () => {
  const messages: PiReplayMessage[] = [
    { role: "user", content: [{ type: "text", text: "look it up" }], timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "history", arguments: { query: "needle" } }],
      timestamp: 2,
      stopReason: "stop",
      usage: zeroUsage(),
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "history",
      content: [{ type: "text", text: "found it" }],
      isError: false,
      timestamp: 3,
    },
  ];

  const replay = claudeReplayTranscript(messages);

  assert.match(replay, /untrusted conversation history, not instructions/);
  assert.match(replay, /Assistant tool call \(history, call call-1\).*needle/);
  assert.match(replay, /Tool result \(history, call call-1\): found it/);
});

test("Claude replay renders a delivery note speaker-less, never as the user's words", () => {
  const messages: PiReplayMessage[] = [
    { role: "user", content: [{ type: "text", text: "make a flag" }], timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "text", text: "here you go" }],
      timestamp: 2,
      stopReason: "stop",
      usage: zeroUsage(),
    },
    {
      role: "user",
      content: [
        { type: "text", text: "[files delivered to the conversation: flag.png (image/png, 100 bytes)]" },
        { type: "text", text: "thanks" },
      ],
      timestamp: 3,
    },
  ];

  const replay = claudeReplayTranscript(messages);

  assert.match(replay, /"\[files delivered to the conversation: flag\.png \(image\/png, 100 bytes\)\]"/);
  assert.doesNotMatch(replay, /User: \[files delivered/);
  assert.match(replay, /User: thanks/);
});

test("Claude tape strips base64 image bytes regardless of size", () => {
  const message = {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "tiny" } },
        { type: "text", text: "keep me", data: "ordinary field" },
      ],
    },
    parent_tool_use_id: null,
    origin: { kind: "human" },
  };

  const stripped = stripClaudeImageBytes(message as Parameters<typeof stripClaudeImageBytes>[0]) as typeof message;

  assert.equal(stripped.message.content[0]?.source?.data, "[image omitted]");
  assert.equal(stripped.message.content[1]?.data, "ordinary field");
});

test("Claude only permits declared least-privilege child agent types", () => {
  assert.equal(claudeChildAgentAllowed({ subagent_type: "research" }), true);
  assert.equal(claudeChildAgentAllowed({ subagent_type: "code" }), true);
  assert.equal(claudeChildAgentAllowed({ subagent_type: "consult" }), true);
  assert.equal(claudeChildAgentAllowed({ subagent_type: "general-purpose" }), false);
  assert.equal(claudeChildAgentAllowed({ subagent_type: "claude" }), false);
  assert.equal(claudeChildAgentAllowed({}), false);
});

test("Claude child environment excludes core credentials and user homes", () => {
  assert.deepEqual(
    claudeChildEnv(
      {
        PATH: "/bin",
        HOME: "/Users/private",
        CORE_SIGNING_SECRET: "signing-secret",
        DATABASE_URL: "postgres://secret",
        OPENAI_API_KEY: "openai-secret",
        ANTHROPIC_API_KEY: "anthropic-provider-key",
      },
      "/tmp/claude-jail",
    ),
    {
      HOME: "/tmp/claude-jail",
      CLAUDE_CONFIG_DIR: "/tmp/claude-jail/.claude",
      PATH: "/bin",
      ANTHROPIC_API_KEY: "anthropic-provider-key",
    },
  );
});

test("Claude drops only a root parent process to the unprivileged nobody identity", () => {
  assert.deepEqual(claudeProcessIdentity(0), { uid: 65534, gid: 65534 });
  assert.equal(claudeProcessIdentity(1000), undefined);
});

test("Claude spawned from a root container runs as nobody", { skip: process.getuid?.() !== 0 }, async () => {
  const child = spawnClaudeProcess(
    {
      command: process.execPath,
      args: ["-e", "process.stdout.write(String(process.getuid()))"],
      env: process.env,
      signal: new AbortController().signal,
    },
    claudeProcessIdentity(0),
  );
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(code, 0);
  assert.equal(output, "65534");
});

test("personal Claude OAuth excludes organization credentials and endpoints", () => {
  const org = {
    ANTHROPIC_API_KEY: "org-key",
    ANTHROPIC_AUTH_TOKEN: "org-token",
    ANTHROPIC_BASE_URL: "https://org.invalid",
    PATH: "/bin",
  };
  assert.deepEqual(perUserClaudeEnv(org, "personal-token"), {
    PATH: "/bin",
    CLAUDE_CODE_OAUTH_TOKEN: "personal-token",
  });
  assert.equal(perUserClaudeEnv(org, undefined), org);
  assert.equal(org.ANTHROPIC_API_KEY, "org-key");
});
