import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-web-ui";
import { continuableMessages, entriesToMessages, resumeAnchor, runIsTerminal } from "../src/core-bridge.ts";

const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");

const assistant = (text: string): AgentMessage =>
  ({ role: "assistant", content: [{ type: "text", text }] }) as unknown as AgentMessage;
const user = (text: string): AgentMessage => ({ role: "user", content: text }) as unknown as AgentMessage;

test("approval continuation preserves the paused work without seeding its text into the new reply", () => {
  const history = entriesToMessages([
    { type: "user", seq: 0, createdAt: 10, payload: { text: "show help" } },
    { type: "text", seq: 1, createdAt: 11, payload: { text: "Checking help", phase: "commentary" } },
    { type: "tool_call", seq: 2, createdAt: 12, payload: { command: "help" } },
    { type: "tool_result", seq: 3, parentSeq: 2, createdAt: 13, payload: { blocked: "needs_approval" } },
  ]);
  const resumed = continuableMessages(history);
  assert.deepEqual(resumed.messages.slice(0, history.length), history);
  assert.deepEqual(resumed.popped, []);
  assert.deepEqual(resumed.messages.at(-1), resumeAnchor());
  const continuing = continuableMessages([...history, assistant("New continuation")]);
  assert.deepEqual(continuing.messages, resumed.messages);
  assert.deepEqual(continuing.popped, [assistant("New continuation")]);
});

test("a pending run restores its input without consuming the previous reply", () => {
  const earlier = [user("repeat"), assistant("Earlier answer")];
  const restored = continuableMessages(earlier, {
    runId: "pending",
    seq: null,
    text: "repeat",
    createdAt: 20,
    attachments: [{ name: "notes.txt", mimetype: "text/plain", sizeBytes: 50 }],
  });
  assert.deepEqual(restored.messages.slice(0, 2), earlier);
  assert.deepEqual(restored.popped, []);
  assert.deepEqual(restored.messages[2], {
    role: "user",
    runId: "pending",
    content: "repeat",
    timestamp: 20,
    attachments: [{ id: "pending:0", type: "document", fileName: "notes.txt", mimeType: "text/plain", size: 50 }],
  });
});

test("a recorded input wins over an older pending snapshot without text-based deduplication", () => {
  const messages = entriesToMessages([
    { type: "user", seq: 0, createdAt: 20, payload: { text: "original", runId: "run" } },
    { type: "text", seq: 1, createdAt: 21, payload: { text: "Working", phase: "commentary" } },
    { type: "user", seq: 2, createdAt: 22, payload: { text: "steer", runId: "run", steered: true } },
  ]);
  const resumed = continuableMessages(messages, { runId: "run", seq: null, text: "stale", createdAt: 19 });
  assert.equal(resumed.messages.length, 2);
  assert.equal(resumed.popped.length, 1);
  assert.equal((resumed.messages[0] as { content: unknown }).content, "original");
});

test("legacy run boundaries at sequence zero also identify the recorded input", () => {
  const messages = entriesToMessages([{ type: "user", seq: 0, createdAt: 20, payload: { text: "recorded" } }]);
  const resumed = continuableMessages(messages, { runId: "legacy", seq: 0, text: "request", createdAt: 19 });
  assert.deepEqual(resumed.messages, messages);
});

test("a window holding nothing the person said still yields a continuable conversation", () => {
  const { messages, popped } = continuableMessages([assistant("tool churn"), assistant("more churn")]);
  assert.equal(messages.length, 1);
  assert.equal((messages[0] as { role?: string }).role, "user");
  assert.equal((messages[0] as { resumeAnchor?: boolean }).resumeAnchor, true);
  assert.equal(popped.length, 2, "the assistant text is handed back for the live stream to re-seed");
});

test("a window that does hold the person's message is left alone", () => {
  const { messages, popped } = continuableMessages([user("do the thing"), assistant("on it")]);
  assert.deepEqual(
    messages.map((m) => (m as { role?: string }).role),
    ["user"],
  );
  assert.equal((messages[0] as { resumeAnchor?: boolean }).resumeAnchor, undefined);
  assert.equal(popped.length, 1);
});

test("an empty window anchors rather than refusing", () => {
  assert.equal(continuableMessages([]).messages.length, 1);
});

test("the anchor is never drawn", () => {
  assert.match(chat, /const hidden = message as \{ opener\?: boolean; resumeAnchor\?: boolean \};/);
  assert.match(chat, /if \(hidden\.opener \|\| hidden\.resumeAnchor\) return nothing;/);
  assert.equal((resumeAnchor() as { content?: unknown }).content, "");
});

test("neither attach path refuses a live run over the shape of the loaded transcript", () => {
  const resume = chat.slice(chat.indexOf("async function resumeTrackedRun"));
  const body = resume.slice(0, resume.indexOf("agent.streamFn = makeRunResumeStreamFn"));
  assert.doesNotMatch(body, /if \(!msgs\.length\) return false;/, "resume no longer bails on an anchorless window");
  assert.doesNotMatch(body, /if \(!agent\.state\.messages\.length\) return false;/, "nor on an empty one");
  assert.match(
    body,
    /const \{ messages: msgs, popped \} = continuableMessages\(agent\.state\.messages, initialRun\.input\);/,
  );

  const follow = chat.slice(chat.indexOf("async function followNextQueuedRun"));
  const followBody = follow.slice(0, follow.indexOf("agent.streamFn = makeRunResumeStreamFn"));
  assert.doesNotMatch(followBody, /if \(!recorded && !next\) return drawActiveChat/, "following no longer bails");
  assert.match(followBody, /agent\.state\.messages = \[\.\.\.agent\.state\.messages, resumeAnchor\(\)\];/);
});

test("a run whose reply already landed is not something to attach to", () => {
  assert.equal(runIsTerminal({ status: "running", result: null, replyComplete: true }), true);
  assert.equal(runIsTerminal({ status: "done", result: null }), true);
  assert.equal(runIsTerminal({ status: "running", result: null }), false);

  const follow = chat.slice(chat.indexOf("async function followNextQueuedRun"));
  const followBody = follow.slice(0, follow.indexOf("agent.streamFn = makeRunResumeStreamFn"));
  assert.match(
    followBody,
    /if \(!active\.runId \|\| !active\.run \|\| runIsTerminal\(active\.run\)\) return drawActiveChat\(agent\);/,
    "anchoring a finished run would end its stream at once and re-enter this path forever",
  );
  const resume = chat.slice(chat.indexOf("async function resumeTrackedRun"));
  assert.match(resume.slice(0, resume.indexOf("await refreshTranscript")), /runIsTerminal\(activeRun\.run\)/);
});
