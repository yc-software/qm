import assert from "node:assert/strict";
import { test } from "node:test";
import { harness, SESSION } from "./deep-link-boot-fixture.ts";
import { item } from "./item-fixture.ts";

test("a generic-chat conversation opens as a transcript named for its surface, with replies left to that surface", async () => {
  const session = {
    ...SESSION,
    type: "dm" as const,
    createdAt: 1,
    threadRef: "partner-chat:7001:dm:301",
    surface: "partner-chat",
    canContinue: false,
  };
  const h = await harness({
    path: `/s/${session.id}`,
    session,
    listSessions: [session],
    items: [item("UserMessage", { seq: 1, text: "A chat message with a [link](https://example.com)" })],
  });
  try {
    h.releaseSessions();
    await h.boot();
    assert.equal(document.querySelector(".chat-subtitle")!.textContent, "Community chat");
    assert.match(
      document.querySelector(".readonly-banner")!.textContent!,
      /read-only here\. Reply in Community chat\./,
    );
    assert.equal(document.querySelector(".readonly-chat a[href='https://example.com']")?.textContent, "link");
    assert.equal(document.querySelector("qm-slack-reply"), null);
  } finally {
    await h.close();
  }
});
