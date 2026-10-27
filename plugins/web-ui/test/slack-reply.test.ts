import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./deep-link-boot-fixture.ts";

const session = {
  id: "slack-chat",
  threadRef: "ch:C123:123.456",
  surface: "slack",
  scopeId: "channel:C123",
  type: "channel" as const,
  createdAt: Date.now(),
  title: "Slack discussion",
};
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check());
}

test("Slack chats show a compact account link until the viewer can reply", async () => {
  let linked = false;
  const h = await harness({
    path: "/",
    api: (path) =>
      path.endsWith("/slack/reply-status") ? Response.json({ connected: linked, user: "Alice" }) : undefined,
  });
  try {
    h.releaseSessions();
    await h.boot();
    h.releaseTranscript();
    await h.openSession(session);
    await until(() => !!document.querySelector("qm-slack-reply .slack-connect"));
    assert.equal(document.querySelector("qm-slack-reply textarea"), null);
    assert.match(document.querySelector("qm-slack-reply")!.textContent!, /Send replies here as yourself/);
    linked = true;
    window.dispatchEvent(new window.Event("focus"));
    await until(() => !!document.querySelector("qm-slack-reply textarea"));
    assert.match(
      document.querySelector("qm-slack-reply .composer-input")!.getAttribute("placeholder")!,
      /Reply in Slack as Alice/,
    );
    assert.equal(document.querySelector(".chat-subtitle")!.textContent, "slack");
  } finally {
    await h.close();
  }
});
