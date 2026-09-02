import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

test("a running browser_use row with an https live view URL expands into an open, sandboxed iframe", () => {
  const guard = /if \(tool === "browser_use" && kind === "running" && call\.liveViewUrl\?\.startsWith\("https:\/\/"\)\) \{/;
  assert.match(chat, guard);
  const branch = chat.match(new RegExp(guard.source + "[\\s\\S]*?\\n {4}\\}"))?.[0];
  assert.ok(branch, "the browser_use live-view branch exists");
  assert.match(branch, /<details class="\$\{classes\} tool-expandable" open>/);
  assert.match(branch, /class="live-view"/);
  assert.match(branch, /src=\$\{call\.liveViewUrl\}/);
  assert.match(branch, /sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock"/);
  assert.match(branch, /referrerpolicy="no-referrer"/);
  assert.match(branch, /allow="autoplay"/);
});

test("a settled browser_use row never renders the iframe — the live URL is dead on replay", () => {
  const iframes = chat.match(/class="live-view"/g) ?? [];
  assert.equal(iframes.length, 2, "the live-view iframe renders only in the running-guarded row and the live dock");
});

test("the live work dock shows the browser while streaming, open by default and collapsible", () => {
  assert.match(chat, /function liveWorkViewUrl\(work: WorkBlock\): string \| null \{/);
  assert.match(chat, /call\.tool === "browser_use" && call\.liveViewUrl\?\.startsWith\("https:\/\/"\) \? call\.liveViewUrl : null/);
  const dock = chat.match(/function liveWorkDock\(agent: Agent\)[\s\S]*?\n {2}\}/)?.[0];
  assert.ok(dock, "liveWorkDock exists");
  assert.match(dock, /liveViewUrl && !liveViewHidden/);
  assert.match(dock, /sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock"/);
  assert.match(dock, /referrerpolicy="no-referrer"/);
  assert.match(chat, /if \(work && liveWorkViewUrl\(work\)\) liveViewHidden = !liveViewHidden;/);
  assert.match(css, /\.live-work-dock \.live-view \{[\s\S]{0,120}?height: min\(48vh, 460px\);/);
});

test("browser_use rows get a globe icon, Browsing verb, and the task as detail", () => {
  assert.match(chat, /browser_use: \{ icon: Globe, active: "Browsing", done: "Browsed", attempted: "Tried browsing" \}/);
  assert.match(chat, /case "browser_use":\s*\n\s*return call\.task \? firstLine\(call\.task\) : "";/);
});

test("the live view fills the card at 16:9 with no border", () => {
  assert.match(css, /\.live-view \{[\s\S]{0,200}?width: 100%;/);
  assert.match(css, /\.live-view \{[\s\S]{0,200}?aspect-ratio: 16 \/ 9;/);
  assert.match(css, /\.live-view \{[\s\S]{0,200}?border: 0;/);
});
