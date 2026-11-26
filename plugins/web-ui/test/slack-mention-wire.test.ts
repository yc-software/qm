import { test } from "node:test";
import assert from "node:assert/strict";
import { mentionToken, toSlackWire } from "../src/mention-wire.ts";

test("mention tokens start at a word boundary", () => {
  assert.deepEqual(mentionToken("hi @ali", 7), { start: 3, end: 7, query: "ali" });
  assert.deepEqual(mentionToken("@", 1), { start: 0, end: 1, query: "" });
  assert.equal(mentionToken("a@b.com", 7), null);
});

test("picked mentions become Slack wire tokens", () => {
  const wires = new Map([
    ["Alice Smith", "<@U1234567>"],
    ["here", "<!here>"],
  ]);
  assert.equal(
    toSlackWire("@Alice Smith and @here, see (@Alice Smith)", wires),
    "<@U1234567> and <!here>, see (<@U1234567>)",
  );
  assert.equal(toSlackWire("mail alice@here.com @Alice Smithers", wires), "mail alice@here.com @Alice Smithers");
});
