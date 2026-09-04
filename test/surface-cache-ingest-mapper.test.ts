import { test } from "node:test";
import assert from "node:assert/strict";
import { toEvent } from "../src/api/routes/surface-cache.ts";

test("toEvent passes through mentions, bot, mentionsSelf, and handled", () => {
  const e = toEvent({
    container: "C1",
    ts: "1.0",
    text: "@bot help",
    mentions: { U1: "jordan" },
    bot: true,
    mentionsSelf: true,
    handled: true,
    containerName: "eng",
    kind: "channel",
  });
  assert.ok(e);
  assert.deepEqual(e.mentions, { U1: "jordan" });
  assert.equal(e.bot, true);
  assert.equal(e.mentionsSelf, true);
  assert.equal(e.handled, true, "the direct-path ownership flag reaches the mirror (not dropped at the route)");
  assert.equal(e.containerName, "eng");
  assert.equal(e.kind, "channel", "the container kind reaches the mirror (not dropped at the route)");
});

test("toEvent drops an unknown kind value", () => {
  const e = toEvent({ container: "C1", ts: "3.0", kind: "bogus" });
  assert.ok(e);
  assert.equal(e.kind, undefined, "only channel|dm|group are accepted");
});

test("toEvent omits the flags when absent or false, and keeps only string mention values", () => {
  const e = toEvent({
    container: "C1",
    ts: "2.0",
    text: "hi",
    bot: false,
    mentionsSelf: false,
    handled: false,
    mentions: { U1: "jordan", U2: 5 },
  });
  assert.ok(e);
  assert.equal(e.bot, undefined);
  assert.equal(e.mentionsSelf, undefined);
  assert.equal(e.handled, undefined);
  assert.deepEqual(e.mentions, { U1: "jordan" }, "non-string mention values are dropped");
});

test("toEvent rejects a payload with no container/ts", () => {
  assert.equal(toEvent({ ts: "1.0" }), null);
  assert.equal(toEvent({ container: "C1" }), null);
  assert.equal(toEvent("nope"), null);
});
