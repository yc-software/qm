import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sessionCwdPath, stripStaleEnvironmentNotes } from "../src/harness/pi-harness.ts";

const env = (body: string): string => `<environment>\n${body}\n</environment>`;
const user = (text: string): { role: "user"; content: string } => ({ role: "user", content: text });
const assistant = (text: string): { role: "assistant"; content: Array<{ type: "text"; text: string }> } => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

test("the cwd pi appends to the system prompt is the same path on every turn of a session", () => {
  const a = sessionCwdPath("pi", "9fd79b52-af00-4ea6-a38f-a363016c32ac");
  assert.equal(a, sessionCwdPath("pi", "9fd79b52-af00-4ea6-a38f-a363016c32ac"));
  assert.equal(a, join(tmpdir(), "pi-cwd-9fd79b52-af00-4ea6-a38f-a363016c32ac"));
  assert.notEqual(a, sessionCwdPath("pi", "other"));
  assert.equal(sessionCwdPath("pi", "web:a@b.c/../x"), join(tmpdir(), "pi-cwd-web_a_b_c____x"));
});

test("only the current turn's user message keeps its environment note", () => {
  const history = [
    user(`what's on today?\n\n${env("It is Monday 9am\n\n## What you remember\nbig notebook")}`),
    assistant("nothing"),
    user(`and tomorrow?\n\n${env("It is Tuesday 9am\n\n## What you remember\nbig notebook")}`),
    assistant("also nothing"),
    user(`ok run it\n\n${env("It is Wednesday 9am")}`),
    user("steer: actually stop"),
  ];
  const out = stripStaleEnvironmentNotes(history) as Array<{ content: string }>;
  assert.equal(out[0]!.content, "what's on today?");
  assert.equal(out[2]!.content, "and tomorrow?");
  assert.equal(out[4]!.content, history[4]!.content);
  assert.equal(out[5]!.content, "steer: actually stop");
  assert.deepEqual(out[1], history[1]);
  assert.equal(String(history[0]!.content).includes("<environment>"), true, "the stored message is not mutated");
});

test("environment notes inside text blocks are stripped; other blocks pass through", () => {
  const image = { type: "image", data: "abc", mimeType: "image/png" };
  const history = [
    { role: "user", content: [{ type: "text", text: `see this\n\n${env("Monday")}` }, image] },
    assistant("ok"),
    { role: "user", content: [{ type: "text", text: `now this\n\n${env("Tuesday")}` }] },
  ];
  const out = stripStaleEnvironmentNotes(history) as Array<{ content: unknown }>;
  assert.deepEqual(out[0]!.content, [{ type: "text", text: "see this" }, image]);
  assert.deepEqual(out[2], history[2]);
});

test("messages without stale notes are returned by reference", () => {
  const history = [user(`hi\n\n${env("Monday")}`), assistant("hello")];
  assert.equal(stripStaleEnvironmentNotes(history), history);
  const plain = [user("hi"), assistant("hello")];
  assert.equal(stripStaleEnvironmentNotes(plain), plain);
  assert.equal(stripStaleEnvironmentNotes(undefined), undefined);
});
