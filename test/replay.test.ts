import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INTERRUPTED_TOOL_RESULT,
  recordedMessageTimestamps,
  planColdStartSeed,
  reconstructMessagesFromHistory,
  renderOverheard,
  replayPreamble,
  seedPriorTurns,
  selectOverheardToImport,
} from "../src/harness/replay.ts";
import type { ConversationTurn, OverheardMessage, SessionEntry } from "../src/types.ts";

function entry(type: SessionEntry["type"], text: string): SessionEntry {
  return {
    sessionId: "s",
    seq: 0,
    parentSeq: null,
    type,
    payload: { text },
    scopeLabel: "org:default-org",
    createdAt: 0,
  };
}

function overheardEntry(ts: string, name: string, text: string, files?: string[]): SessionEntry {
  return {
    sessionId: "s",
    seq: 0,
    parentSeq: null,
    type: "user",
    payload: { overheard: true, ts, name, text, ...(files ? { files } : {}) },
    scopeLabel: "org:default-org",
    createdAt: Number(ts) || 0,
  };
}

function ent(type: SessionEntry["type"], payload: unknown, seq = 0): SessionEntry {
  return { sessionId: "s", seq, parentSeq: null, type, payload, scopeLabel: "org:default-org", createdAt: seq };
}

function assertValidWire(msgs: ReturnType<typeof reconstructMessagesFromHistory>): void {
  if (!msgs.length) return;
  assert.equal(msgs[0]!.role, "user", "first message must be user-side");
  const wire = (m: (typeof msgs)[number]) => (m.role === "assistant" ? "a" : "u");
  let prevWire: string | null = null;
  let prevWasToolResult = false;
  const open = new Set<string>();
  for (const m of msgs) {
    const w = wire(m);
    if (prevWire === w)
      assert.ok(
        prevWasToolResult && m.role === "toolResult",
        `no two consecutive ${w} turns (except grouped tool results)`,
      );
    if (m.role === "assistant") for (const b of m.content) if (b.type === "toolCall") open.add(b.id);
    if (m.role === "toolResult") {
      assert.ok(open.has(m.toolCallId), "tool_result pairs an open tool_use");
      open.delete(m.toolCallId);
    }
    prevWire = w;
    prevWasToolResult = m.role === "toolResult";
  }
  assert.equal(open.size, 0, "every tool_use has a matching tool_result");
}

test("replayPreamble renders user, assistant, and delivered-file entries", () => {
  const out = replayPreamble([
    entry("user", "send me a pirate flag"),
    entry("assistant", "done!"),
    entry("delivery", "pirate_flag.png (image/png, 142 bytes)"),
  ]);
  assert.match(out, /User: send me a pirate flag/);
  assert.match(out, /Assistant: done!/);
  assert.match(out, /Assistant delivered file\(s\) to the conversation: pirate_flag\.png \(image\/png, 142 bytes\)/);
});

test("replayPreamble is empty when there is nothing to replay", () => {
  assert.equal(replayPreamble([]), "");
});

test("replayPreamble EXCLUDES thinking from cold-start context (signature is stored but never replayed)", () => {
  const thinking: SessionEntry = {
    sessionId: "s",
    seq: 1,
    parentSeq: null,
    type: "thinking",
    payload: { thinking: "secret chain of thought", thinkingSignature: "OPAQUE-SIG-BYTES" },
    scopeLabel: "org:default-org",
    createdAt: 0,
  };
  const out = replayPreamble([entry("user", "hi"), thinking, entry("assistant", "hello")]);
  assert.match(out, /User: hi/);
  assert.match(out, /Assistant: hello/);
  assert.doesNotMatch(out, /secret chain of thought/);
  assert.doesNotMatch(out, /OPAQUE-SIG-BYTES/);
});

test("reconstructMessagesFromHistory rebuilds a faithful tool round — a fact in a tool result survives", () => {
  const history: SessionEntry[] = [
    ent("user", { text: "sign me up for HN" }, 1),
    ent("tool_call", { tool: "execute", command: "browse signup", callId: "c1" }, 2),
    ent(
      "tool_result",
      { tool: "execute", callId: "c1", result: "username: agent42\npassword: hunter2", isError: false },
      3,
    ),
    ent("assistant", { text: "Done — account created." }, 4),
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
  const history: SessionEntry[] = [
    ent("user", { text: "hi" }, 1),
    ent("tool_call", { tool: "read", path: "a.txt" }, 2),
    ent("tool_result", { tool: "read", path: "a.txt", found: true }, 3),
    ent("assistant", { text: "ok" }, 4),
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
  const history: SessionEntry[] = [
    ent("user", { text: "build and push the release" }, 1),
    ent("tool_call", { tool: "execute", command: "make build", callId: "c1" }, 2),
    ent("tool_result", { tool: "execute", callId: "c1", result: "built ok", isError: false }, 3),
    ent("tool_call", { tool: "execute", command: "git push", callId: "c2" }, 4),
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

test("reconstructMessagesFromHistory coalesces consecutive assistant turns (reply + delivery) to keep alternation", () => {
  const history: SessionEntry[] = [
    ent("user", { text: "make a flag" }, 1),
    ent("assistant", { text: "here you go" }, 2),
    ent("delivery", { text: "flag.png (image/png, 100 bytes)" }, 3),
    ent("user", { text: "thanks" }, 4),
  ];
  const msgs = reconstructMessagesFromHistory(history);
  assertValidWire(msgs);
  assert.deepEqual(
    msgs.map((m) => m.role),
    ["user", "assistant", "user"],
  );
  const joined = (msgs[1] as { content: Array<{ text: string }> }).content.map((c) => c.text).join(" ");
  assert.match(joined, /here you go/);
  assert.match(joined, /delivered file/);
});

test("reconstructMessagesFromHistory replays a context summary as a user turn and stays valid across two tool turns", () => {
  const history: SessionEntry[] = [
    ent("system", { kind: "context_summary", throughSeq: 0, text: "Earlier: set up the project." }, 1),
    ent("user", { text: "now deploy" }, 2),
    ent("tool_call", { tool: "execute", command: "deploy", callId: "d1" }, 3),
    ent("tool_result", { tool: "execute", callId: "d1", result: "deployed v4", isError: false }, 4),
    ent("assistant", { text: "shipped v4" }, 5),
    ent("user", { text: "and the logs?" }, 6),
    ent("tool_call", { tool: "execute", command: "logs", callId: "d2" }, 7),
    ent("tool_result", { tool: "execute", callId: "d2", result: "all green", isError: false }, 8),
    ent("assistant", { text: "logs are green" }, 9),
  ];
  const msgs = reconstructMessagesFromHistory(history);
  assertValidWire(msgs);
  assert.equal(msgs[0]!.role, "user");
  assert.match((msgs[0] as { content: Array<{ text: string }> }).content[0]!.text, /Earlier: set up the project/);
  assert.equal(msgs.filter((m) => m.role === "toolResult").length, 2);
});

test("reconstructMessagesFromHistory is empty for empty history (fresh session — nothing to replay)", () => {
  assert.deepEqual(reconstructMessagesFromHistory([]), []);
});

test("planColdStartSeed prefers the faithful rebuild; priorTurns only bootstraps an empty durable log", () => {
  const oneMsg = [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }], timestamp: 0 }];
  assert.equal(planColdStartSeed(oneMsg, true), "structured");
  assert.equal(planColdStartSeed(oneMsg, false), "structured");
  assert.equal(planColdStartSeed([], true), "priorTurns");
  assert.equal(planColdStartSeed(null, true), "priorTurns");
  assert.equal(planColdStartSeed(null, false), "preamble");
  assert.equal(planColdStartSeed([], false), "none");
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

function triggerEntry(ts: string, text: string): SessionEntry {
  return {
    sessionId: "s",
    seq: 0,
    parentSeq: null,
    type: "user",
    payload: { text, ts },
    scopeLabel: "org:default-org",
    createdAt: Number(ts) || 0,
  };
}

test("recordedMessageTimestamps collects ts from BOTH overheard imports and stamped triggers", () => {
  assert.deepEqual([...recordedMessageTimestamps([])], []);
  const history = [
    triggerEntry("100.002", "what did you ship?"),
    overheardEntry("100.001", "Alice", "deploying now"),
    entry("user", "a legacy entry with no ts is ignored"),
    entry("assistant", "shipping it"),
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

test("selectOverheardToImport keeps every not-yet-imported message, in order, dropping the bot's own", () => {
  const incoming: OverheardMessage[] = [
    { ts: "100.001", role: "user", name: "Alice", text: "already imported" },
    { ts: "100.005", role: "user", name: "Bob", text: "fresh from bob" },
    { ts: "100.004", role: "self", text: "my own reply" },
    { ts: "100.006", role: "user", name: "Carol", text: "fresh from carol" },
  ];
  const picked = selectOverheardToImport(incoming, new Set(["100.001", "100.003"]));
  assert.deepEqual(
    picked.map((p) => p.ts),
    ["100.005", "100.006"],
  );
  assert.equal(picked[0]!.name, "Bob");
  assert.equal(picked[1]!.name, "Carol");
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
    entry("user", "who has a cat?"),
    entry("assistant", "Alice does — she shared cat.jpg"),
  ]);
  assertValidWire(msgs);
  const flat = msgs.map((m) => m.content.map((c) => (c.type === "text" ? c.text : "")).join("")).join("\n");
  assert.match(flat, /<message overheard="true"[^>]*author="Alice"/);
  assert.match(flat, /I posted a photo/);
  assert.match(flat, /files="cat\.jpg"/);
});

test("reconstructMessagesFromHistory skips an empty overheard marker (no blank line)", () => {
  const msgs = reconstructMessagesFromHistory([overheardEntry("100.001", "", ""), entry("user", "hi")]);
  assertValidWire(msgs);
  const texts = msgs.flatMap((m) => m.content.map((c) => (c.type === "text" ? c.text : "")));
  assert.ok(texts.some((t) => /hi/.test(t)));
  assert.ok(!texts.some((t) => /overheard/.test(t)));
});

test("replayPreamble renders an overheard entry distinctly from a normal user line", () => {
  const out = replayPreamble([overheardEntry("1", "Bob", "saw this go by"), entry("user", "thanks")]);
  assert.match(out, /Overheard \(Bob\): saw this go by/);
  assert.match(out, /User: thanks/);
});

test("a bytes-only surface call (legacy post / reach) replays with stand-in text, never {action,bytes}", () => {
  const msgs = reconstructMessagesFromHistory([
    ent("user", { text: "hi" }, 0),
    ent("tool_call", { tool: "web", action: "post", bytes: 873, callId: "c1" }, 1),
    ent("tool_result", { tool: "web", action: "post", ok: true, callId: "c1", isError: false, result: "[sent]" }, 2),
    ent("assistant", { text: "Replied in thread." }, 3),
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
    ent("user", { text: "hi" }, 0),
    ent("tool_call", { tool: "web", action: "post", broadcast: true, text: "the actual reply", callId: "c1" }, 1),
    ent("tool_result", { tool: "web", action: "post", ok: true, callId: "c1", isError: false, result: "[sent]" }, 2),
    ent("assistant", { text: "Replied." }, 3),
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
    ent("user", { text: "hi" }, 0),
    ent("tool_call", { tool: "web", action: "reach", recipient: "bob", bytes: 100, files: 2, callId: "c1" }, 1),
    ent("tool_result", { tool: "web", action: "reach", ok: true, callId: "c1", isError: false, result: "[sent]" }, 2),
    ent("assistant", { text: "Sent." }, 3),
  ]);
  assertValidWire(msgs);
  const call = msgs.flatMap((m) => (m.role === "assistant" ? m.content : [])).find((b) => b.type === "toolCall");
  assert.ok(call && call.type === "toolCall");
  const args = call.arguments as Record<string, unknown>;
  assert.equal(args.recipient, "bob");
  assert.ok(!("files" in args), "numeric files count must not replay");
  assert.ok(!("bytes" in args));
});
