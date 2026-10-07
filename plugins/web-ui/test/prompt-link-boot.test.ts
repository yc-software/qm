import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./deep-link-boot-fixture.ts";

for (const path of ["/new?q=summarize%20my%20inbox", "/?q=summarize%20my%20inbox"]) {
  test(`${path} opens a new chat with the prompt drafted but not sent`, async () => {
    const h = await harness({ path });
    try {
      const booted = h.boot();
      h.releaseSessions();
      await booted;
      assert.equal(h.visibleConversation().composer.state.draft, "summarize my inbox");
      assert.equal(h.visibleConversation().state.sessionId, null, "nothing was sent");
      assert.equal(location.pathname + location.search, "/", "the prompt leaves the address bar");
    } finally {
      await h.close();
    }
  });
}
