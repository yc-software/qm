import test from "node:test";
import assert from "node:assert/strict";
import { conversationWebUrl } from "../src/util/conversation-links.ts";

test("conversation links keep the public base path and encode the session id", () => {
  assert.equal(
    conversationWebUrl("https://portal.example/qm///", "session /?#"),
    "https://portal.example/qm/s/session%20%2F%3F%23",
  );
  for (const unsafe of [
    undefined,
    "portal.example",
    "ftp://portal.example/qm",
    "https://user:secret@portal.example/qm",
    "https://portal.example/qm?tenant=one",
    "https://portal.example/qm#conversation",
  ])
    assert.equal(conversationWebUrl(unsafe, "s1"), undefined);
});
