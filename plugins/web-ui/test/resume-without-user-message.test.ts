import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-web-ui";
import { continuableMessages, resumeAnchor, runIsTerminal } from "../src/core-bridge.ts";

const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");

const assistant = (text: string): AgentMessage =>
  ({ role: "assistant", content: [{ type: "text", text }] }) as unknown as AgentMessage;
const user = (text: string): AgentMessage => ({ role: "user", content: text }) as unknown as AgentMessage;

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
  assert.match(body, /const \{ messages: msgs, popped \} = continuableMessages\(agent\.state\.messages\);/);

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
