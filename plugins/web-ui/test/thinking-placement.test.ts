import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");

test("thinking is the composer header above background activity, not a transparent dock sibling", () => {
  const dock = chat.slice(chat.indexOf('<div class="chat-bottom-dock">'));
  assert.match(
    dock,
    /composerForm\(agent, html`\$\{glanceTier \? nothing : liveWorkStatus\(agent\)\} \$\{backgroundActivityStrip\(\)\}`\)/,
  );
  assert.ok(dock.indexOf("goalStrip(agent)") < dock.indexOf("ctx.composer.queuedStrip(agent)"));
  assert.ok(dock.indexOf("ctx.composer.queuedStrip(agent)") < dock.indexOf("composerForm(agent"));
  assert.doesNotMatch(css, /\.queued-strip:has\(\+ \.live-work-status\)/);
});

test("stacked composer headers share a solid surface without double negative margins", () => {
  assert.match(
    css,
    /\.composer-wrap > \.live-work-status,\s*\.composer-wrap > \.bg-activity \{[^}]*background: color-mix/,
  );
  assert.match(css, /\.composer-wrap > \.live-work-status:has\(\+ \.bg-activity\) \{\s*margin-bottom: 0;/);
  assert.match(css, /\.composer-wrap > \.live-work-status \+ \.bg-activity \{\s*margin-top: 0;\s*border-radius: 0;/);
  assert.doesNotMatch(css, /\.live-work-status \{[^}]*width: min/);
});

test("model-unavailable composer retains the activity header and approvals", () => {
  assert.match(composer, /<div class="composer-wrap">\s*\$\{header\} \$\{composerApprovalPanel/);
});
