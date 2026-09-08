import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

test("live thinking and tool activity belong to the transcript, not the composer dock", () => {
  const draw = chat.slice(
    chat.indexOf("  function drawActiveChat("),
    chat.indexOf("  function decorateStreamingTail("),
  );
  const transcript = draw.slice(
    draw.indexOf('<section class="chat-scroll">'),
    draw.indexOf('<div class="chat-bottom-dock">'),
  );
  const dock = draw.slice(draw.indexOf('<div class="chat-bottom-dock">'));
  assert.match(transcript, /\$\{liveWorkStatus\(agent\)\}/);
  assert.doesNotMatch(dock, /liveWork(?:Dock|Status)\(agent\)/);
  assert.match(dock, /composerForm\(agent, backgroundActivityStrip\(\)\)/);
});

test("the live-work row aligns with the message column rather than composer gutters", () => {
  const rule = css.match(/\.live-work-status \{[^}]*\}/)?.[0] ?? "";
  assert.match(rule, /width: 100%;/);
  assert.match(rule, /margin: 8px 0 0;/);
  assert.doesNotMatch(css, /live-work-dock/);
});
