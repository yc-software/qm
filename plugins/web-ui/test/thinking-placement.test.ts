import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

test("live thinking and tool activity stay above the composer and background tasks", () => {
  const draw = chat.slice(
    chat.indexOf("  function drawActiveChat("),
    chat.indexOf("  function decorateStreamingTail("),
  );
  const transcript = draw.slice(
    draw.indexOf('<section class="chat-scroll">'),
    draw.indexOf('<div class="chat-bottom-dock">'),
  );
  const dock = draw.slice(draw.indexOf('<div class="chat-bottom-dock">'));
  assert.doesNotMatch(transcript, /liveWorkStatus\(agent\)/);
  assert.match(dock, /\$\{liveWorkStatus\(agent\)\}/);
  assert.ok(dock.indexOf("liveWorkStatus(agent)") < dock.indexOf("composerForm(agent, backgroundActivityStrip())"));
  assert.match(dock, /composerForm\(agent, backgroundActivityStrip\(\)\)/);
});

test("the live-work row uses the floating composer column", () => {
  const rule = css.match(/\.live-work-status \{[^}]*\}/)?.[0] ?? "";
  assert.match(rule, /width: min\(var\(--content-w\), calc\(100% - 32px\)\);/);
  assert.match(rule, /margin: 0 auto 8px;/);
  assert.doesNotMatch(css, /live-work-dock/);
});
