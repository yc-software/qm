import assert from "node:assert/strict";
import test from "node:test";
import { MentionBook } from "../src/mentions.ts";

test("picked mentions go out as Slack wire tokens, longest label first", () => {
  const book = new MentionBook();
  book.add("eric", "<@U0EXAMPLE01>");
  book.add("eric m", "<@U0ERICM0001>");
  book.add("here", "<!here>");
  assert.equal(book.toWire("hey @eric can you check?"), "hey <@U0EXAMPLE01> can you check?");
  assert.equal(book.toWire("(@eric m) and @here"), "(<@U0ERICM0001>) and <!here>");
});

test("text that only looks like a picked mention stays as typed", () => {
  const book = new MentionBook();
  book.add("eric", "<@U0EXAMPLE01>");
  assert.equal(book.toWire("@erica and me@eric"), "@erica and me@eric");
  assert.equal(new MentionBook().toWire("@eric"), "@eric");
});
