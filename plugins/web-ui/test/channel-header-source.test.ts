import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const panel = readFileSync(new URL("../src/channel-header.ts", import.meta.url), "utf8");
const contexts = readFileSync(new URL("../src/contexts.ts", import.meta.url), "utf8");
const server = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

test("the pinned-header panel exists only for channel scopes and follows the org default", () => {
  assert.match(panel, /scopeId\.startsWith\("channel:"\)/);
  assert.match(panel, /\?selected=\$\{channelHeaderState\.configured === null\}/);
  assert.match(panel, /Default \(\$\{channelHeaderState\.orgDefault \? "on" : "off"\}\)/);
  assert.match(panel, /save\(scopeId, v === "default" \? null : v === "on"\)/);
});

test("the panel writes through the channel-header-pin endpoint and reports both directions", () => {
  assert.match(panel, /api<HeaderPinWire>\("\/api\/channel-header-pin", \{\s*method: "PUT"/);
  assert.match(panel, /Header pinned in the channel\./);
  assert.match(panel, /Pinned header removed\./);
});

test("the server proxies the toggle with the signed-in user as principal", () => {
  assert.match(server, /path: "\/api\/channel-header-pin"/);
  assert.match(server, /\/v1\/channel-header-pin\?\$\{qs\.toString\(\)\}/);
});

test("every context loads and resets the pinned-header setting with the page", () => {
  assert.match(contexts, /loadChannelHeader\(contextsState\.selected, drawContexts\)/);
  assert.match(contexts, /resetChannelHeader\(\)/);
  assert.match(contexts, /channelHeaderSection\(c\.scopeId\)/);
});

test("pinned-header panel styles use the shell theme contract", () => {
  const block = css.slice(css.indexOf(".channel-header {"), css.indexOf("\n.ambient-policy {"));
  assert.match(block, /color: var\(--muted-foreground\)/);
});
