import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("ambient policy copy: per-channel default explains the real gate — standing orders or an action bot, not channel size", () => {
  assert.match(html, /Default: on when this channel has a standing order or an action-marked bot,\s+off\s+otherwise\./);
  assert.match(html, /<option value="default">Default \(standing order or action bot\)<\/option>/);
});

test("ambient policy copy: org-wide toggle explains the same default and that it overrides an explicit per-channel On", () => {
  assert.match(
    html,
    /Org-wide, default on\. When off, the agent never acts on overheard messages in any channel,\s+regardless of per-channel settings; it only responds to direct @mentions\./,
  );
  assert.match(
    html,
    /ambient defaults on only where there's a\s+standing order or an action-bot trigger, off otherwise\./,
  );
});

test("ambient policy copy: no stale channel-size language remains anywhere in the admin UI", () => {
  assert.doesNotMatch(html, /8 or fewer members/);
  assert.doesNotMatch(html, /by channel size/);
  assert.doesNotMatch(html, /more\s+than 8 members/);
  assert.doesNotMatch(html, /channels with more/);
});
