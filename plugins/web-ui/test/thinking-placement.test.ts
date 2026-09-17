import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");

test("thinking follows the transcript outside the composer", () => {
  const stack = chat.slice(chat.indexOf('<div class="message-stack'), chat.indexOf('<div class="chat-bottom-dock">'));
  assert.match(stack, /liveWorkStatus\(agent\)/);
  assert.ok(stack.indexOf("messageContent") < stack.indexOf("liveWorkStatus(agent)"));
  const dock = chat.slice(chat.indexOf('<div class="chat-bottom-dock">'), chat.indexOf("decorateStreamingTail();"));
  assert.doesNotMatch(dock, /liveWorkStatus/);
  assert.doesNotMatch(chat, /typingRow|work-thinking/);
  assert.doesNotMatch(css, /\.composer-wrap > \.live-work-status/);
});

test("model-unavailable composer retains the activity header and approvals", () => {
  assert.match(composer, /<div class="composer-wrap">\s*\$\{header\} \$\{composerApprovalPanel/);
});
