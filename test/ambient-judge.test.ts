import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ambientWindow,
  parseAmbientDecision,
  renderAmbientPrompt,
  type AmbientBatch,
} from "../src/surface-cache/ambient-judge.ts";
import type { CachedMessage } from "../src/surface-cache/surface-cache.ts";

const base = (over: Partial<AmbientBatch>): AmbientBatch => ({
  container: "C1",
  surface: "slack",
  orders: "",
  self: { name: "agent", mentionId: "U00000002" },
  messages: [],
  recent: [],
  ...over,
});

const msg = (ts: string, text: string, over: Partial<CachedMessage> = {}): CachedMessage => ({
  container: "C1",
  ts,
  authorId: "U1",
  authorName: "alice",
  text,
  createdAt: Number(ts),
  ...over,
});

test("the judge reads the recent messages as the worker does: new ones are triggers, its own posts are from the agent", () => {
  const offer = msg("2.0", "Want me to draft the memo?", { self: true, authorName: "agent", authorId: "U00000002" });
  const hold = msg("3.0", "hold off on that");
  const prompt = renderAmbientPrompt(
    base({ recent: [msg("1.0", "let's back Example Co"), offer, hold], messages: [hold] }),
  );
  const lines = prompt.split("\n").filter((l) => l.includes("<message "));
  assert.equal(lines.length, 3, "earlier context, the assistant's own reply and the new message all appear");
  assert.match(lines[0]!, /id="1\.0" from="human" author="alice"(?:(?!trigger)[^>])*>let's back Example Co</);
  assert.match(lines[1]!, /id="2\.0" from="agent"(?:(?!trigger)[^>])*>Want me to draft the memo\?</);
  assert.match(lines[2]!, /id="3\.0" from="human"[^>]*trigger="true">hold off on that</);
});

test("the ambient window keeps ten messages before the first new one and everything after it", () => {
  const all = Array.from({ length: 14 }, (_v, i) => msg(`${i + 1}.0`, `m${i + 1}`));
  const own = msg("13.5", "already answered", { self: true });
  const withExtras = [...all.slice(0, 12), all[12]!, own, all[13]!];
  const window = ambientWindow(withExtras, [all[12]!, all[13]!]);
  assert.deepEqual(
    window.map((m) => m.ts),
    ["3.0", "4.0", "5.0", "6.0", "7.0", "8.0", "9.0", "10.0", "11.0", "12.0", "13.0", "13.5", "14.0"],
  );
  assert.deepEqual(
    ambientWindow(all, []).map((m) => m.ts),
    all.slice(-10).map((m) => m.ts),
    "a scheduled check-in with nothing new shows the last ten",
  );
});

test("parseAmbientDecision reads asked_by (only on an engage)", () => {
  assert.deepEqual(parseAmbientDecision('{"act": true, "reason": "bob asked", "asked_by": "2.0"}'), {
    act: true,
    reason: "bob asked",
    askedBy: "2.0",
  });
  assert.deepEqual(parseAmbientDecision('{"act": true, "reason": "standing order"}'), {
    act: true,
    reason: "standing order",
  });
  assert.deepEqual(parseAmbientDecision('{"act": false, "asked_by": "2.0"}'), { act: false });
  assert.deepEqual(parseAmbientDecision('{"act": true, "asked_by": "   "}'), { act: true });
  assert.deepEqual(parseAmbientDecision('{"act": true, "asked_by": "[2.0]"}'), { act: true, askedBy: "2.0" });
});

test("parseAmbientDecision reads the outermost object and stays linear-time on a brace flood", () => {
  assert.deepEqual(parseAmbientDecision('Sure. {"act": true, "reason": "asked for a digest"} done'), {
    act: true,
    reason: "asked for a digest",
  });
  const started = performance.now();
  assert.deepEqual(parseAmbientDecision("{".repeat(60_000)), { act: false });
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1_000, `brace flood took ${Math.round(elapsed)}ms`);
});
