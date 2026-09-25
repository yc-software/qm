import assert from "node:assert/strict";
import { test } from "node:test";
import { slackAdapter } from "../src/loops/sources/slack.ts";

function raw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: "slack",
    sourceKey: "ignored:by:normalization",
    title: "DM with Eve & Alex",
    from: "Alex",
    snippet: "also what about the deck?",
    receivedAt: 1_000,
    slack: { channelId: "G555", ts: "1000.100", isDirectMessage: true },
    ...over,
  };
}

test("DMs and group DMs dedupe on the channel alone — one card per conversation", () => {
  const parsed = slackAdapter.parse(raw());
  assert.ok(!("error" in parsed));
  assert.equal(parsed.dedupeKey, "G555");
  const dm = slackAdapter.parse(raw({ slack: { channelId: "D42", ts: "9.9" } }));
  assert.ok(!("error" in dm));
  assert.equal(dm.dedupeKey, "D42");
});

test("channel asks dedupe per thread", () => {
  const threaded = slackAdapter.parse(raw({ slack: { channelId: "C7", ts: "300.3", threadTs: "100.1" } }));
  assert.ok(!("error" in threaded));
  assert.equal(threaded.dedupeKey, "C7:100.1");
  const topLevel = slackAdapter.parse(raw({ slack: { channelId: "C7", ts: "300.3" } }));
  assert.ok(!("error" in topLevel));
  assert.equal(topLevel.dedupeKey, "C7:300.3");
});

test("G-prefixed private channels are not mistaken for group DMs", () => {
  for (const isDirectMessage of [undefined, false]) {
    const parsed = slackAdapter.parse(raw({ slack: { channelId: "G555", ts: "1000.100", isDirectMessage } }));
    assert.ok(!("error" in parsed));
    assert.equal(parsed.dedupeKey, "G555:1000.100");
  }
});

test("explicit DM threads remain separate from the unthreaded conversation", () => {
  for (const channelId of ["D42", "G555", "C555"]) {
    const parsed = slackAdapter.parse(
      raw({ slack: { channelId, ts: "300.3", threadTs: "100.1", isDirectMessage: true } }),
    );
    assert.ok(!("error" in parsed));
    assert.equal(parsed.dedupeKey, `${channelId}:100.1`);
    const unthreaded = slackAdapter.parse(raw({ slack: { channelId, ts: "300.3", isDirectMessage: true } }));
    assert.ok(!("error" in unthreaded));
    assert.equal(unthreaded.dedupeKey, channelId);
  }
});

test("probablyResolved and image URLs survive parsing", () => {
  const parsed = slackAdapter.parse(
    raw({
      probablyResolved: true,
      images: ["https://files.slack.com/a.png", "ftp://nope", 7],
      context: [{ author: "Eve", text: "look", images: ["https://files.slack.com/b.png"] }],
    }),
  );
  assert.ok(!("error" in parsed));
  const payload = parsed.sourcePayload as Record<string, unknown>;
  assert.equal(payload.probablyResolved, true);
  assert.deepEqual(payload.images, ["https://files.slack.com/a.png"]);
  const context = payload.context as Array<Record<string, unknown>>;
  assert.deepEqual(context[0]!.images, ["https://files.slack.com/b.png"]);
});
