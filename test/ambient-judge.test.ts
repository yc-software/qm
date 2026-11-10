import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAmbientDecision,
  recentWakeMessages,
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

test("other people's @-mentions read as @name; only the assistant's own mention stays a raw id", () => {
  const ask = msg("2.0", "<@U00000003> can you remind me? cc <@U00000004|old label> <@U00000009> <@U00000002>", {
    mentions: { U00000003: "esther", U00000004: "dave", U00000002: "agent" },
  });
  const batch = base({ recent: [ask], messages: [ask] });
  const [wake] = recentWakeMessages(batch);
  assert.equal(wake!.text, "@esther can you remind me? cc @dave <@U00000009> <@U00000002>");
  const line = renderAmbientPrompt(batch)
    .split("\n")
    .find((l) => l.includes("<message "));
  assert.match(line!, />@esther can you remind me\? cc @dave &lt;@U00000009&gt; &lt;@U00000002&gt;</);
});

test("the judge sees earlier messages cut short and new ones whole, while the worker keeps the full text", () => {
  const long = (word: string): string => `${word} `.repeat(200).trim();
  const earlier = msg("1.0", long("earlier"), { bot: true, authorName: "Triage" });
  const fresh = msg("2.0", long("fresh"), { bot: true, authorName: "Triage" });
  const batch = base({ recent: [earlier, fresh], messages: [fresh] });
  const [first, second] = renderAmbientPrompt(batch)
    .split("\n")
    .filter((l) => l.includes("<message "));
  const body = (line: string): string => line.replace(/^.*?>/, "").replace(/<\/message>$/, "");
  assert.ok(body(first!).length < 400, "an earlier message is shortened");
  assert.ok(body(first!).endsWith("…"));
  assert.equal(body(second!), long("fresh"));
  assert.equal(recentWakeMessages(batch)[0]!.text, long("earlier"));
});
