import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_OPENED_TEXT,
  INTERRUPTED_TOOL_RESULT,
  recordedMessageTimestamps,
  reconstructMessagesFromHistory,
  renderOverheard,
  seedPriorTurns,
  selectOverheardToImport,
} from "../src/agent/replay.ts";
import type { ConversationTurn, OverheardMessage } from "../src/types.ts";
import { type Item, type NewItem, storedItem } from "../src/sessions/items.ts";

function at(item: NewItem, seq = 0): Item {
  return storedItem(item, { sessionId: "s", seq, createdAt: seq });
}

function entry(kind: "UserMessage" | "AgentMessage", text: string): Item {
  return at({ kind, text });
}

function overheardEntry(ts: string, name: string, text: string, files?: string[]): Item {
  return storedItem(
    { kind: "UserMessage", externalId: ts, text, body: { overheard: true, name, ...(files ? { files } : {}) } },
    { sessionId: "s", seq: 0, createdAt: Number(ts) || 0 },
  );
}

function assertValidWire(msgs: ReturnType<typeof reconstructMessagesFromHistory>): void {
  if (!msgs.length) return;
  assert.equal(msgs[0]!.role, "user", "first message must be user-side");
  const open = new Set<string>();
  for (const m of msgs) {
    if (m.role === "assistant") for (const b of m.content) if (b.type === "toolCall") open.add(b.id);
    if (m.role === "toolResult") {
      assert.ok(open.has(m.toolCallId), "tool_result pairs an open tool_use");
      open.delete(m.toolCallId);
    }
  }
  assert.equal(open.size, 0, "every tool_use has a matching tool_result");
}

test("reconstructMessagesFromHistory rebuilds a faithful tool round — a fact in a tool result survives", () => {
  const history = [
    at({ kind: "UserMessage", text: "sign me up for HN" }, 1),
    at(
      {
        kind: "ToolCall",
        callId: "c1",
        tool: "execute",
        turnId: "0b9d8f6e-5c4a-4e2b-9f1d-7a3c2e1b0a99",
        body: { command: "browse signup" },
      },
      2,
    ),
    at(
      {
        kind: "ToolResult",
        callId: "c1",
        tool: "execute",
        isError: false,
        text: "username: agent42\npassword: hunter2",
      },
      3,
    ),
    at({ kind: "AgentMessage", text: "Done — account created." }, 4),
  ];
  const msgs = reconstructMessagesFromHistory(history);
  assertValidWire(msgs);
  assert.deepEqual(
    msgs.map((m) => m.role),
    ["user", "assistant", "toolResult", "assistant"],
  );
  const call = msgs[1] as {
    role: "assistant";
    content: Array<{ type: string; id?: string; name?: string; arguments?: unknown }>;
  };
  assert.equal(call.content[0]!.type, "toolCall");
  assert.equal(call.content[0]!.id, "c1");
  assert.equal(call.content[0]!.name, "execute");
  assert.deepEqual(call.content[0]!.arguments, { command: "browse signup" });
  const result = msgs[2] as {
    role: "toolResult";
    toolCallId: string;
    content: Array<{ text: string }>;
    isError: boolean;
  };
  assert.equal(result.toolCallId, "c1");
  assert.match(result.content[0]!.text, /password: hunter2/);
  assert.equal(result.isError, false);
});

test("reconstructMessagesFromHistory SKIPS legacy tool entries with no callId (degrades to no tool replay)", () => {
  const history = [
    at({ kind: "UserMessage", text: "hi" }, 1),
    at({ kind: "ToolCall", callId: "", tool: "read", body: { path: "a.txt" } }, 2),
    at({ kind: "ToolResult", callId: "", tool: "read", body: { path: "a.txt", found: true } }, 3),
    at({ kind: "AgentMessage", text: "ok" }, 4),
  ];
  const msgs = reconstructMessagesFromHistory(history);
  assertValidWire(msgs);
  assert.deepEqual(
    msgs.map((m) => m.role),
    ["user", "assistant"],
  );
  assert.ok(!msgs.some((m) => m.role === "assistant" && m.content.some((c) => c.type === "toolCall")));
});

test("a tool call with no recorded result replays with a synthetic interrupted result (turn died mid-call)", () => {
  const history = [
    at({ kind: "UserMessage", text: "build and push the release" }, 1),
    at({ kind: "ToolCall", callId: "c1", tool: "execute", body: { command: "make build" } }, 2),
    at({ kind: "ToolResult", callId: "c1", tool: "execute", isError: false, text: "built ok" }, 3),
    at({ kind: "ToolCall", callId: "c2", tool: "execute", body: { command: "git push" } }, 4),
  ];
  const msgs = reconstructMessagesFromHistory(history);
  assertValidWire(msgs);
  assert.deepEqual(
    msgs.map((m) => m.role),
    ["user", "assistant", "toolResult", "assistant", "toolResult"],
  );
  const synthetic = msgs[4] as {
    role: "toolResult";
    toolCallId: string;
    content: Array<{ text: string }>;
    isError: boolean;
  };
  assert.equal(synthetic.toolCallId, "c2");
  assert.equal(synthetic.isError, true);
  assert.equal(synthetic.content[0]!.text, INTERRUPTED_TOOL_RESULT);
});

test("a user turn that lands right after a tool result stays adjacent — no words put in the assistant's mouth", () => {
  const history = [
    at({ kind: "UserMessage", text: "check the build" }, 1),
    at({ kind: "ToolCall", callId: "c1", tool: "execute", body: { command: "make build" } }, 2),
    at({ kind: "ToolResult", callId: "c1", tool: "execute", isError: false, text: "built ok" }, 3),
    at({ kind: "UserMessage", text: "actually, ship it" }, 4),
  ];
  const msgs = reconstructMessagesFromHistory(history);
  assertValidWire(msgs);
  assert.deepEqual(
    msgs.map((m) => m.role),
    ["user", "assistant", "toolResult", "user"],
  );
  const assistantText = msgs
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.content)
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text);
  assert.deepEqual(assistantText, []);
});

test("reconstructMessagesFromHistory replays a delivery as the agent's deliver call and keeps legacy file notes", () => {
  const history = [
    at({ kind: "UserMessage", text: "make a flag" }, 1),
    at({ kind: "AgentMessage", text: "here you go" }, 2),
    at({ kind: "AgentMessage", variant: "files_delivered", text: "flag.png (image/png, 100 bytes)" }, 3),
    at({ kind: "ToolCall", callId: "cron:1", tool: "deliver", body: { text: "flag.png is ready", via: "cron" } }, 4),
    at({ kind: "ToolResult", callId: "cron:1", tool: "deliver", text: "delivered" }, 5),
    at({ kind: "UserMessage", text: "thanks" }, 6),
  ];
  const msgs = reconstructMessagesFromHistory(history);
  assertValidWire(msgs);
  assert.deepEqual(
    msgs.map((m) => m.role),
    ["user", "assistant", "user", "assistant", "toolResult", "user"],
  );
  assert.deepEqual(msgs[2]!.content, [
    { type: "text", text: "[files delivered to the conversation: flag.png (image/png, 100 bytes)]" },
  ]);
  assert.deepEqual(msgs[3]!.content, [
    { type: "toolCall", id: "cron:1", name: "deliver", arguments: { text: "flag.png is ready", via: "cron" } },
  ]);
  assert.deepEqual(msgs[4]!.content, [{ type: "text", text: "delivered" }]);
});

test("reconstructMessagesFromHistory opens with a fixed user frame when the agent spoke first", () => {
  const msgs = reconstructMessagesFromHistory([
    at({ kind: "AgentMessage", text: "daily digest", body: { deliveryKey: "cron:9" } }, 1),
    at({ kind: "UserMessage", text: "thanks" }, 2),
  ]);
  assertValidWire(msgs);
  assert.deepEqual(
    msgs.map((m) => [m.role, m.content]),
    [
      ["user", [{ type: "text", text: AGENT_OPENED_TEXT }]],
      ["assistant", [{ type: "text", text: "daily digest" }]],
      ["user", [{ type: "text", text: "── Wednesday, December 31, 1969 ──\nthanks" }]],
    ],
  );
});

test("transcript replay can start at recorded assistant work without a synthetic user", () => {
  const messages = reconstructMessagesFromHistory([entry("AgentMessage", "Already worked")], {
    requireUserStart: false,
  });
  assert.deepEqual(
    messages.map((message) => message.role),
    ["assistant"],
  );
});

test("reconstructMessagesFromHistory coalesces consecutive assistant text entries to keep alternation", () => {
  const history = [
    at({ kind: "UserMessage", text: "hi" }, 1),
    at({ kind: "AgentMessage", text: "part one" }, 2),
    at({ kind: "AgentMessage", text: "part two" }, 3),
    at({ kind: "UserMessage", text: "ok" }, 4),
  ];
  const msgs = reconstructMessagesFromHistory(history);
  assertValidWire(msgs);
  assert.deepEqual(
    msgs.map((m) => m.role),
    ["user", "assistant", "user"],
  );
  const assistantText = (msgs[1] as { content: Array<{ text: string }> }).content.map((c) => c.text).join(" ");
  assert.match(assistantText, /part one/);
  assert.match(assistantText, /part two/);
});

test("reconstructMessagesFromHistory replays a context summary as a user turn and stays valid across two tool turns", () => {
  const history = [
    at({ kind: "ContextCompaction", throughSeq: 0, text: "Earlier: set up the project." }, 1),
    at({ kind: "UserMessage", text: "now deploy" }, 2),
    at({ kind: "ToolCall", callId: "d1", tool: "execute", body: { command: "deploy" } }, 3),
    at({ kind: "ToolResult", callId: "d1", tool: "execute", isError: false, text: "deployed v4" }, 4),
    at({ kind: "AgentMessage", text: "shipped v4" }, 5),
    at({ kind: "UserMessage", text: "and the logs?" }, 6),
    at({ kind: "ToolCall", callId: "d2", tool: "execute", body: { command: "logs" } }, 7),
    at({ kind: "ToolResult", callId: "d2", tool: "execute", isError: false, text: "all green" }, 8),
    at({ kind: "AgentMessage", text: "logs are green" }, 9),
  ];
  const msgs = reconstructMessagesFromHistory(history);
  assertValidWire(msgs);
  assert.equal(msgs[0]!.role, "user");
  const summaryText = (msgs[0] as { content: Array<{ text: string }> }).content[0]!.text;
  assert.match(summaryText, /Earlier: set up the project/);
  assert.match(summaryText, /covering entries through seq 0\b/);
  assert.equal(msgs.filter((m) => m.role === "toolResult").length, 2);
});

test("a recorded tool call whose wire arguments no longer parse replays with its recorded arguments", () => {
  const wire = { message: { id: "st1" } };
  const msgs = reconstructMessagesFromHistory([
    at({ kind: "UserMessage", text: "list files" }, 0),
    at(
      {
        kind: "ToolCall",
        callId: "c1",
        tool: "execute",
        step: 0,
        body: { command: "ls", wire: { ...wire, argumentsJson: "{not json" } },
      },
      1,
    ),
    at(
      {
        kind: "ToolResult",
        callId: "c1",
        tool: "execute",
        isError: false,
        text: "a.txt",
        step: 0,
        body: { ok: true, wire },
      },
      2,
    ),
    at({ kind: "AgentMessage", text: "One file.", step: 0, body: { wire: { message: { id: "st2" } } } }, 3),
  ]);
  assertValidWire(msgs);
  const call = msgs.flatMap((m) => (m.role === "assistant" ? m.content : [])).find((b) => b.type === "toolCall");
  assert.deepEqual(call && call.type === "toolCall" ? call.arguments : undefined, { command: "ls" });
});

test("reconstructMessagesFromHistory is empty for empty history (fresh session — nothing to replay)", () => {
  assert.deepEqual(reconstructMessagesFromHistory([]), []);
});

test("seedPriorTurns renders thread history as author-attributed <message> tags (own = from agent)", () => {
  const turns: ConversationTurn[] = [
    { role: "user", name: "alice", text: "[~abc] can you deploy?" },
    { role: "assistant", text: "on it" },
  ];
  const seeded = seedPriorTurns(turns);
  assert.equal(seeded.length, 1);
  assert.equal(seeded[0]!.role, "user");
  assert.match(seeded[0]!.text, /<message from="human" author="alice">\[~abc\] can you deploy\?<\/message>/);
  assert.match(seeded[0]!.text, /<message from="agent">on it<\/message>/);
});

test("seedPriorTurns DEDUPS a turn already present in the session's in-session history", () => {
  const turns: ConversationTurn[] = [
    { role: "user", name: "alice", text: "first message" },
    { role: "assistant", text: "my reply" },
    { role: "user", name: "alice", text: "second message" },
  ];
  const seeded = seedPriorTurns(turns, ["my   reply"]);
  assert.equal(seeded.length, 1);
  assert.equal(seeded[0]!.role, "user");
  assert.match(seeded[0]!.text, /<message from="human" author="alice">first message<\/message>/);
  assert.match(seeded[0]!.text, /<message from="human" author="alice">second message<\/message>/);
  assert.doesNotMatch(seeded[0]!.text, /my reply/);
});

test("seedPriorTurns RECONCILES identity: a named assistant turn (cron/other-instance) is NEVER seeded as assistant", () => {
  const turns: ConversationTurn[] = [
    { role: "user", name: "alice", text: "did the nightly run finish?" },
    { role: "assistant", name: "agent (cron)", text: "nightly backup complete" },
  ];
  const seeded = seedPriorTurns(turns);
  assert.ok(!seeded.some((m) => m.role === "assistant"), "the cron post is never claimed as an assistant turn");
  assert.equal(seeded.length, 1);
  assert.equal(seeded[0]!.role, "user");
  assert.match(seeded[0]!.text, /<message from="human" author="alice">did the nightly run finish\?<\/message>/);
  assert.match(seeded[0]!.text, /<message from="agent" via="agent \(cron\)">nightly backup complete<\/message>/);
});

test("seedPriorTurns renders a lone named assistant turn as a from=agent <message> with via (never assistant)", () => {
  const seeded = seedPriorTurns([{ role: "assistant", name: "agent (cron)", text: "deploy shipped v4" }]);
  assert.deepEqual(seeded, [
    { role: "user", text: '<message from="agent" via="agent (cron)">deploy shipped v4</message>' },
  ]);
});

test("seedPriorTurns re-merges after a downgrade so alternation holds (no two consecutive user turns)", () => {
  const turns: ConversationTurn[] = [
    { role: "user", name: "alice", text: "status?" },
    { role: "assistant", name: "agent (cron)", text: "deploy shipped" },
  ];
  const seeded = seedPriorTurns(turns);
  assert.equal(seeded.length, 1);
  assert.equal(seeded[0]!.role, "user");
  assert.match(seeded[0]!.text, /status\?/);
  assert.match(seeded[0]!.text, /<message from="agent" via="agent \(cron\)">deploy shipped<\/message>/);
});

test("seedPriorTurns skips empty turns and returns [] for an empty input", () => {
  assert.deepEqual(seedPriorTurns([]), []);
  assert.deepEqual(seedPriorTurns([{ role: "user", name: "x", text: "   " }]), []);
});

function triggerEntry(ts: string, text: string): Item {
  return storedItem(
    { kind: "UserMessage", externalId: ts, text },
    { sessionId: "s", seq: 0, createdAt: Number(ts) || 0 },
  );
}

test("recordedMessageTimestamps collects ts from BOTH overheard imports and stamped triggers", () => {
  assert.deepEqual([...recordedMessageTimestamps([])], []);
  const history = [
    triggerEntry("100.002", "what did you ship?"),
    overheardEntry("100.001", "Alice", "deploying now"),
    entry("UserMessage", "a legacy entry with no ts is ignored"),
    entry("AgentMessage", "shipping it"),
    overheardEntry("100.003", "Bob", "lgtm"),
  ];
  assert.deepEqual([...recordedMessageTimestamps(history)].sort(), ["100.001", "100.002", "100.003"]);
});

test("a message answered as a trigger is NOT re-imported as overheard next turn (the duplication fix)", () => {
  const history = [triggerEntry("100.002", "run it now on the first 20 emails")];
  const incoming: OverheardMessage[] = [
    { ts: "100.002", role: "user", name: "Avery", text: "run it now on the first 20 emails" },
    { ts: "100.005", role: "user", name: "Avery", text: "I don't see an approval prompt" },
  ];
  const picked = selectOverheardToImport(incoming, recordedMessageTimestamps(history));
  assert.deepEqual(
    picked.map((p) => p.ts),
    ["100.005"],
  );
});

test("selectOverheardToImport keeps every not-yet-imported message, in order, retaining agent authorship", () => {
  const incoming: OverheardMessage[] = [
    { ts: "100.001", role: "user", name: "Alice", text: "already imported" },
    { ts: "100.005", role: "user", name: "Bob", text: "fresh from bob" },
    { ts: "100.004", role: "self", text: "my own reply" },
    { ts: "100.006", role: "user", name: "Carol", text: "fresh from carol" },
  ];
  const picked = selectOverheardToImport(incoming, new Set(["100.001", "100.003"]));
  assert.deepEqual(
    picked.map((p) => p.ts),
    ["100.004", "100.005", "100.006"],
  );
  assert.equal(picked[0]!.sourceRole, "agent");
  assert.match(renderOverheard(picked[0]!), /from="agent"/);
  assert.equal(picked[1]!.name, "Bob");
  assert.equal(picked[2]!.name, "Carol");
  assert.ok(picked.every((p) => p.overheard === true));
});

test("selectOverheardToImport imports an OUT-OF-ORDER older message on first sight (set, not high-water mark)", () => {
  const incoming: OverheardMessage[] = [
    { ts: "100.005", role: "user", name: "Bob", text: "imported earlier" },
    { ts: "100.002", role: "user", name: "Alice", text: "late-arriving older post" },
  ];
  const picked = selectOverheardToImport(incoming, new Set(["100.005"]));
  assert.deepEqual(
    picked.map((p) => p.ts),
    ["100.002"],
  );
  assert.equal(picked[0]!.name, "Alice");
});

test("selectOverheardToImport drops content-less messages but keeps a bare file caption", () => {
  const incoming: OverheardMessage[] = [
    { ts: "1", role: "user", name: "A", text: "   " },
    { ts: "2", role: "user", name: "B", text: "", files: ["selfie.jpg"] },
  ];
  const picked = selectOverheardToImport(incoming, new Set());
  assert.deepEqual(
    picked.map((p) => p.ts),
    ["2"],
  );
  assert.deepEqual(picked[0]!.files, ["selfie.jpg"]);
});

test("renderOverheard frames the line as a structured overheard <message>, author-labeled, with files", () => {
  const line = renderOverheard({
    overheard: true,
    ts: "1",
    name: "Taylor",
    text: "here's the logo",
    files: ["logo.png"],
  });
  assert.match(line, /^<message overheard="true"/);
  assert.match(line, /author="Taylor"/);
  assert.match(line, /id="1"/);
  assert.match(line, /here's the logo/);
  assert.match(line, /files="logo\.png"/);
});

test("renderOverheard adds a mentions attr when the payload carries resolved mentions", () => {
  const line = renderOverheard({
    overheard: true,
    ts: "2",
    name: "Avery",
    text: "cc @jordan",
    mentions: { U1: "jordan", U2: "avery" },
  });
  assert.match(line, /mentions="U1=jordan,U2=avery"/);
  const bare = renderOverheard({ overheard: true, ts: "3", name: "Avery", text: "no mentions" });
  assert.doesNotMatch(bare, /mentions=/);
});

test("reconstructMessagesFromHistory renders overheard entries as overheard user lines (cold-start survival)", () => {
  const msgs = reconstructMessagesFromHistory([
    overheardEntry("100.001", "Alice", "I posted a photo", ["cat.jpg"]),
    entry("UserMessage", "who has a cat?"),
    entry("AgentMessage", "Alice does — she shared cat.jpg"),
  ]);
  assertValidWire(msgs);
  const flat = msgs.map((m) => m.content.map((c) => (c.type === "text" ? c.text : "")).join("")).join("\n");
  assert.match(flat, /<message overheard="true"[^>]*author="Alice"/);
  assert.match(flat, /I posted a photo/);
  assert.match(flat, /files="cat\.jpg"/);
});

test("reconstructMessagesFromHistory skips an empty overheard marker (no blank line)", () => {
  const msgs = reconstructMessagesFromHistory([overheardEntry("100.001", "", ""), entry("UserMessage", "hi")]);
  assertValidWire(msgs);
  const texts = msgs.flatMap((m) => m.content.map((c) => (c.type === "text" ? c.text : "")));
  assert.ok(texts.some((t) => /hi/.test(t)));
  assert.ok(!texts.some((t) => /overheard/.test(t)));
});

test("a bytes-only surface call (legacy post / reach) replays with stand-in text, never {action,bytes}", () => {
  const msgs = reconstructMessagesFromHistory([
    at({ kind: "UserMessage", text: "hi" }, 0),
    at({ kind: "ToolCall", callId: "c1", tool: "web", body: { action: "post", bytes: 873 } }, 1),
    at(
      {
        kind: "ToolResult",
        callId: "c1",
        tool: "web",
        isError: false,
        text: "[sent]",
        body: { action: "post", ok: true },
      },
      2,
    ),
    at({ kind: "AgentMessage", text: "Replied in thread." }, 3),
  ]);
  assertValidWire(msgs);
  const call = msgs.flatMap((m) => (m.role === "assistant" ? m.content : [])).find((b) => b.type === "toolCall");
  assert.ok(call && call.type === "toolCall");
  const args = call.arguments as Record<string, unknown>;
  assert.equal(args.action, "post");
  assert.equal(args.text, "[sent earlier — text not retained]");
  assert.ok(!("bytes" in args), "the schema-invalid bytes summary must never replay as the model's own call");
});

test("a text-carrying post call replays verbatim (ts/broadcast preserved)", () => {
  const msgs = reconstructMessagesFromHistory([
    at({ kind: "UserMessage", text: "hi" }, 0),
    at(
      {
        kind: "ToolCall",
        callId: "c1",
        tool: "web",
        body: { action: "post", broadcast: true, text: "the actual reply" },
      },
      1,
    ),
    at(
      {
        kind: "ToolResult",
        callId: "c1",
        tool: "web",
        isError: false,
        text: "[sent]",
        body: { action: "post", ok: true },
      },
      2,
    ),
    at({ kind: "AgentMessage", text: "Replied." }, 3),
  ]);
  assertValidWire(msgs);
  const call = msgs.flatMap((m) => (m.role === "assistant" ? m.content : [])).find((b) => b.type === "toolCall");
  assert.ok(call && call.type === "toolCall");
  const args = call.arguments as Record<string, unknown>;
  assert.equal(args.text, "the actual reply");
  assert.equal(args.broadcast, true);
});

test("a legacy call with a numeric files count replays without it (schema wants string[])", () => {
  const msgs = reconstructMessagesFromHistory([
    at({ kind: "UserMessage", text: "hi" }, 0),
    at(
      {
        kind: "ToolCall",
        callId: "c1",
        tool: "web",
        body: { action: "reach", recipient: "bob", bytes: 100, files: 2 },
      },
      1,
    ),
    at(
      {
        kind: "ToolResult",
        callId: "c1",
        tool: "web",
        isError: false,
        text: "[sent]",
        body: { action: "reach", ok: true },
      },
      2,
    ),
    at({ kind: "AgentMessage", text: "Sent." }, 3),
  ]);
  assertValidWire(msgs);
  const call = msgs.flatMap((m) => (m.role === "assistant" ? m.content : [])).find((b) => b.type === "toolCall");
  assert.ok(call && call.type === "toolCall");
  const args = call.arguments as Record<string, unknown>;
  assert.equal(args.recipient, "bob");
  assert.ok(!("files" in args), "numeric files count must not replay");
  assert.ok(!("bytes" in args));
});

test("reconstructMessagesFromHistory replays the environment note the user message was sent with", () => {
  const history = [
    at(
      {
        kind: "UserMessage",
        text: "what's on today?",
        body: { environment: "<environment>\nIt is Monday 9am\n</environment>" },
      },
      1,
    ),
    at({ kind: "AgentMessage", text: "Nothing yet." }, 2),
  ];
  const [user] = reconstructMessagesFromHistory(history);
  assert.deepEqual(user!.content, [
    {
      type: "text",
      text: "── Wednesday, December 31, 1969 ──\nwhat's on today?\n\n<environment>\nIt is Monday 9am\n</environment>",
    },
  ]);
});

test("overheard reconciliation deduplicates IDs within a batch but preserves identical text at different IDs", () => {
  const incoming: OverheardMessage[] = [
    { ts: "100.001", role: "self", text: "Shall I proceed?" },
    { ts: "100.001", role: "self", text: "Shall I proceed?" },
    { ts: "100.002", role: "user", name: "Alex", text: "yes" },
    { ts: "100.003", role: "user", name: "Blair", text: "yes" },
  ];
  const picked = selectOverheardToImport(incoming, new Set());
  assert.deepEqual(
    picked.map((p) => p.ts),
    ["100.001", "100.002", "100.003"],
  );
  assert.deepEqual(selectOverheardToImport(incoming, new Set(picked.map((p) => p.ts))), []);
});

test("a tool_result marked interrupted replays as the interrupted placeholder, not as a real result", () => {
  const items = [
    at({ kind: "UserMessage", text: "run it" }, 1),
    at({ kind: "ToolCall", callId: "c1", tool: "execute", body: { command: "make" } }, 2),
    at({ kind: "ToolResult", callId: "c1", text: "[exit 143]", body: { interrupted: true } }, 3),
  ];
  const result = reconstructMessagesFromHistory(items).find((m) => m.role === "toolResult")!;
  assert.equal(result.role, "toolResult");
  if (result.role !== "toolResult") return;
  assert.deepEqual(result.content, [{ type: "text", text: INTERRUPTED_TOOL_RESULT }]);
  assert.equal(result.isError, true);
});

test("reconstructMessagesFromHistory keeps parallel tool calls in one assistant message", () => {
  const history = [
    at({ kind: "UserMessage", text: "check both" }, 1),
    at({ kind: "ToolCall", callId: "a", tool: "read", body: { path: "/a" } }, 2),
    at({ kind: "ToolCall", callId: "b", tool: "read", body: { path: "/b" } }, 3),
    at({ kind: "ToolResult", callId: "a", tool: "read", text: "A" }, 4),
    at({ kind: "ToolResult", callId: "b", tool: "read", text: "B" }, 5),
    at({ kind: "ToolCall", callId: "c", tool: "read", body: { path: "/c" } }, 6),
    at({ kind: "ToolResult", callId: "c", tool: "read", text: "C" }, 7),
    at({ kind: "AgentMessage", text: "done" }, 8),
  ];
  const msgs = reconstructMessagesFromHistory(history);
  assertValidWire(msgs);
  assert.deepEqual(
    msgs.map((m) =>
      m.role === "assistant" ? m.content.map((c) => (c.type === "toolCall" ? c.id : "text")).join(",") : m.role,
    ),
    ["user", "a,b", "toolResult", "toolResult", "c", "toolResult", "text"],
  );
});

test("reconstructMessagesFromHistory replays a stopped turn as a system note in user voice, after the real partial", () => {
  const history = [
    at({ kind: "UserMessage", text: "write the report" }, 1),
    at({ kind: "AgentMessage", text: "Draft so far", body: { stopped: true } }, 2),
    at({ kind: "Stop", body: { reason: "by the parent agent" } }, 3),
    at({ kind: "UserMessage", text: "carry on" }, 4),
  ];
  const msgs = reconstructMessagesFromHistory(history);
  assertValidWire(msgs);
  assert.deepEqual(
    msgs.map((m) => m.role),
    ["user", "assistant", "user", "user"],
  );
  assert.deepEqual(msgs[1]!.content, [{ type: "text", text: "Draft so far" }]);
  assert.deepEqual(msgs[2]!.content, [{ type: "text", text: "[system] Turn stopped by the parent agent." }]);
});

test("a turn stopped while a tool call ran explains the stop in that call's result, once", () => {
  const history = [
    at({ kind: "UserMessage", text: "deploy it" }, 1),
    at({ kind: "ToolCall", callId: "c1", tool: "execute", body: { command: "make deploy" } }, 2),
    at({ kind: "Stop", body: { reason: "by user" } }, 3),
    at({ kind: "UserMessage", text: "what happened?" }, 4),
  ];
  const msgs = reconstructMessagesFromHistory(history);
  assertValidWire(msgs);
  assert.deepEqual(
    msgs.map((m) => m.role),
    ["user", "assistant", "toolResult", "user"],
  );
  assert.match(JSON.stringify(msgs[2]!.content), /Turn stopped by user while this call was running/);
  assert.ok(!JSON.stringify(msgs).includes("[system] Turn stopped by user."), "no separate stop note");
});

test("overheard traffic between a cut-off call and the stop does not split the stop from that call", () => {
  const history = [
    at({ kind: "UserMessage", text: "deploy it" }, 1),
    at({ kind: "ToolCall", callId: "c1", tool: "execute", body: { command: "make deploy" } }, 2),
    at({ kind: "UserMessage", text: "lunch?", externalId: "3", body: { overheard: true, name: "Alice" } }, 3),
    at({ kind: "Stop", body: { reason: "by user" } }, 4),
  ];
  const text = JSON.stringify(reconstructMessagesFromHistory(history));
  assert.match(text, /Turn stopped by user while this call was running/);
  assert.ok(!text.includes("[system] Turn stopped by user."), "no separate stop note");
});

test("a call killed by a Stop keeps its output and carries the stop in its result, once", () => {
  const history = [
    at({ kind: "UserMessage", text: "deploy it" }, 1),
    at({ kind: "ToolCall", callId: "c1", tool: "execute", body: { command: "make deploy" } }, 2),
    at({ kind: "ToolResult", callId: "c1", text: "[stderr]\nKilled\n\n[exit 137]", body: { stopped: true } }, 3),
    at({ kind: "Stop", body: { reason: "by user" } }, 4),
    at({ kind: "UserMessage", text: "what happened?" }, 5),
  ];
  const msgs = reconstructMessagesFromHistory(history);
  assertValidWire(msgs);
  assert.deepEqual(
    msgs.map((m) => m.role),
    ["user", "assistant", "toolResult", "user"],
  );
  const result = msgs[2] as { content: unknown[] };
  assert.deepEqual(
    result.content.map((c) => (c as { text: string }).text),
    ["[stderr]\nKilled\n\n[exit 137]", "[system] Turn stopped by user."],
    "the recorded output is kept and the stop is part of that call's result",
  );
  assert.equal(JSON.stringify(msgs).split("Turn stopped by user").length, 2, "the stop appears once");
});

test("a result recorded while a Stop fired keeps its text when no stop was recorded", () => {
  const history = [
    at({ kind: "UserMessage", text: "deploy it" }, 1),
    at({ kind: "ToolCall", callId: "c1", tool: "execute", body: { command: "make deploy" } }, 2),
    at({ kind: "ToolResult", callId: "c1", text: "[exit 137]", body: { stopped: true } }, 3),
  ];
  assert.match(JSON.stringify(reconstructMessagesFromHistory(history)), /\[exit 137\]/);
});

test("a tool result cut off by a deploy says so in its replayed result", () => {
  const history = [
    at({ kind: "UserMessage", text: "deploy it" }, 1),
    at({ kind: "ToolCall", callId: "c1", tool: "execute", body: { command: "make deploy" } }, 2),
    at(
      { kind: "ToolResult", callId: "c1", text: "[exit 143]", body: { interrupted: true, stop: { kind: "shutdown" } } },
      3,
    ),
  ];
  const text = JSON.stringify(reconstructMessagesFromHistory(history));
  assert.match(text, /A routine platform deploy interrupted this call/);
});

test("replayed context marks each Pacific calendar day once, dating overheard Slack messages by when they were sent", () => {
  const imported = Date.parse("2026-10-19T18:00:00Z");
  const overheard = (iso: string, text: string): Item => ({
    ...overheardEntry(String(Date.parse(iso) / 1000), "Dana", text),
    createdAt: imported,
  });
  const msgs = reconstructMessagesFromHistory([
    overheard("2026-10-15T20:00:00Z", "kickoff today"),
    overheard("2026-10-16T16:00:00Z", "the deadline is Friday"),
    overheard("2026-10-17T05:30:00Z", "still Friday night here"),
    overheard("2026-10-17T08:00:00Z", "saturday early"),
    { ...at({ kind: "UserMessage", text: "has the deadline passed?" }, 5), createdAt: imported },
  ]);
  const lines = msgs.flatMap((m) =>
    m.content.flatMap((b) => (b.type === "text" ? b.text.split("\n").filter((l) => l.startsWith("──")) : [])),
  );
  assert.deepEqual(lines, [
    "── Thursday, October 15, 2026 ──",
    "── Friday, October 16, 2026 ──",
    "── Saturday, October 17, 2026 ──",
    "── Monday, October 19, 2026 ──",
  ]);
  assert.match((msgs[2]!.content[0] as { text: string }).text, /^<message overheard="true"/);
  assert.equal(
    (msgs[4]!.content[0] as { text: string }).text,
    "── Monday, October 19, 2026 ──\nhas the deadline passed?",
  );
});

test("a scheduled task's post replays as a tagged message, never merged into the agent's own words", () => {
  const history = [
    at({ kind: "UserMessage", text: "post a check here in 3 minutes" }, 1),
    at({ kind: "AgentMessage", text: "Will post once at 9:52." }, 2),
    at({ kind: "AgentMessage", text: "live check 2", body: { via: "cron" } }, 3),
  ];
  const msgs = reconstructMessagesFromHistory(history);
  assertValidWire(msgs);
  assert.deepEqual(
    msgs.map((m) => [m.role, m.content.map((c) => (c as { text?: string }).text).join("")]),
    [
      ["user", msgs[0]!.content.map((c) => (c as { text?: string }).text).join("")],
      ["assistant", "Will post once at 9:52."],
      ["user", '<message from="agent" via="cron">live check 2</message>'],
    ],
  );
});

test("an approved call replayed under its original id pairs each occurrence with its own result", () => {
  const history = [
    at({ kind: "UserMessage", text: "deploy the ledger" }, 1),
    at({ kind: "ToolCall", tool: "execute", callId: "toolu_deploy", body: { command: "deploy ledger" } }, 2),
    at(
      {
        kind: "ToolResult",
        tool: "execute",
        callId: "toolu_deploy",
        isError: true,
        text: "[blocked: needs human approval] deploys need a human",
      },
      3,
    ),
    at(
      {
        kind: "ToolCall",
        tool: "execute",
        callId: "toolu_deploy",
        body: { command: "deploy ledger", approvedRequestId: "req-1" },
      },
      4,
    ),
    at(
      {
        kind: "ToolResult",
        tool: "execute",
        callId: "toolu_deploy",
        isError: false,
        text: "deployed: the harbor ledger balances",
        body: { approvedRequestId: "req-1" },
      },
      5,
    ),
  ];
  const msgs = reconstructMessagesFromHistory(history);
  const results = msgs.filter((m) => m.role === "toolResult");
  assert.deepEqual(
    results.map((m) => (m.content[0] as { text: string }).text),
    ["[blocked: needs human approval] deploys need a human", "deployed: the harbor ledger balances"],
  );
  assert.equal(JSON.stringify(msgs).split("the harbor ledger balances").length - 1, 1, "approved output appears once");
  assertValidWire(msgs);
});
