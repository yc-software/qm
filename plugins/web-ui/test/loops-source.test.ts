import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/loops.ts", import.meta.url), "utf8");
const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
const browse = readFileSync(new URL("../src/browse.ts", import.meta.url), "utf8");

test("unconfirmed loop outputs have confirmation and return controls", () => {
  assert.match(source, /const unconfirmed = outputs\.filter\(\(o\) => o\.state === "unconfirmed"\)/);
  assert.match(source, /Needs confirmation/);
  assert.match(source, /reviewRow\(loop, o, "Confirm shipped"\)/);
  assert.match(source, /decide\(loop, output, "return"\)/);
});

test("loops navigation, routing, and fetching require permission", () => {
  assert.match(browse, /can\("loops"\) \? navRow\("loops"|can\("loops"\)\) list\.push\(to\("loops"/);
  assert.match(shell, /if \(!canView\(v\)\) v = "chats"/);
  assert.match(shell, /isView\(wanted\) && canView\(wanted\)/);
  assert.match(source, /renderLoopsPage[^]*if \(!can\("loops"\)\) return/);
});

test("loop detail derives and renders the autopilot toggle", () => {
  assert.match(source, /shipActions\.length > 0 && loop\.shipActions\.every\(\(policy\) => policy\.gate === "auto"\)/);
  assert.match(source, />Autopilot</);
  assert.match(source, /Ships outputs without review/);
  assert.match(source, /Shipping without review/);
  assert.match(source, /setAutopilot\(loop, !autopilot\)/);
  assert.match(source, /\?disabled=\$\{loopBusy\}/);
  assert.match(source, /loop\.shipActions\.length[^]*class="loop-autopilot/);
});
